import Docker from 'dockerode';
import logger from '../../utils/logger.js';

class DatabaseContainerPool {
  constructor(docker, options = {}) {
    this.docker = docker || new Docker();

    const slotId = process.env.WORKER_SLOT_ID || options.workerSlotId;
    if (!slotId) {
      throw new Error('WORKER_SLOT_ID environment variable is required for DatabaseContainerPool');
    }
    this.workerSlotId = slotId;

    this.targetPoolSize = parseInt(process.env.POSTGRES_POOL_SIZE || options.poolSize || '2', 10);
    this.maxWaiters = parseInt(process.env.POOL_MAX_WAITERS || options.maxWaiters || '16', 10);
    this.acquireTimeoutMs = parseInt(process.env.POOL_ACQUIRE_TIMEOUT_MS || options.acquireTimeoutMs || '10000', 10);

    this.trackedContainerIds = new Set();
    this.isShuttingDown = false;

    this.pools = {
      8: {
        available: [],
        waiters: [],
        activeBoots: 0,
        consecutiveFailures: 0,
        circuitOpenUntil: 0,
        image: 'codebox/postgres:16',
        name: 'postgres',
        user: '70:70',
        pidsLimit: 64,
        readySignal: 'CODEBOX_DAEMON_READY',
      },
      9: {
        available: [],
        waiters: [],
        activeBoots: 0,
        consecutiveFailures: 0,
        circuitOpenUntil: 0,
        image: 'codebox/mysql:8.4',
        name: 'mysql',
        user: '999:999',
        pidsLimit: 128,
        readySignal: 'CODEBOX_DAEMON_READY',
      },
    };
  }

  /**
   * Acquire a pre-warmed container with timeout and queue depth controls
   */
  async acquire(languageId) {
    if (this.isShuttingDown) {
      throw new Error('Database pool is shutting down');
    }

    const pool = this.pools[languageId];
    if (!pool) {
      throw new Error(`No container pool configured for language ${languageId}`);
    }

    // 1. Instant Warm Hit: Check available containers
    while (pool.available.length > 0) {
      const container = pool.available.pop();
      // Verify container is still running
      try {
        const inspect = await container.inspect();
        if (inspect.State.Running) {
          // Replenish consumed slot asynchronously
          this.checkReplenish(languageId);
          return container;
        }
      } catch {
        // Container died or gone
      }

      this.destroy(container);
      this.checkReplenish(languageId);
    }

    // 2. Circuit Breaker Check
    if (Date.now() < pool.circuitOpenUntil) {
      throw new Error(`Database service for ${pool.name} is temporarily degraded. Please retry shortly.`);
    }

    // 3. Queue Depth Bounds
    if (pool.waiters.length >= this.maxWaiters) {
      throw new Error(`Database execution pool queue is full (max: ${this.maxWaiters}).`);
    }

    // 4. Register in Waiters Queue with Hard Timeout
    return new Promise((resolve, reject) => {
      let timeoutId = null;

      const waiter = {
        resolve: (container) => {
          clearTimeout(timeoutId);
          resolve(container);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      };

      timeoutId = setTimeout(() => {
        const idx = pool.waiters.indexOf(waiter);
        if (idx !== -1) pool.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for database container (${this.acquireTimeoutMs}ms)`));
      }, this.acquireTimeoutMs);

      pool.waiters.push(waiter);

      // Trigger replenishment if needed
      this.checkReplenish(languageId);
    });
  }

  /**
   * Safe release & disposal of an ephemeral container
   */
  release(container) {
    if (!container) return;
    this.destroy(container);
  }

  /**
   * Destroy container off the critical path
   */
  destroy(container) {
    const containerId = container.id || container.Id;
    this.trackedContainerIds.delete(containerId);

    setImmediate(async () => {
      try {
        await container.remove({ force: true });
      } catch (err) {
        logger.warn({ event: 'container_destroy_failed', id: containerId, error: err.message });
      }
    });
  }

  /**
   * Check and trigger replenishments up to target capacity
   */
  checkReplenish(languageId) {
    const pool = this.pools[languageId];
    if (this.isShuttingDown || Date.now() < pool.circuitOpenUntil) return;

    const currentSlots = pool.available.length + pool.activeBoots;
    if (currentSlots < this.targetPoolSize) {
      const needed = this.targetPoolSize - currentSlots;
      for (let i = 0; i < needed; i++) {
        this.replenish(languageId).catch(logger.error);
      }
    }
  }

  /**
   * Replenish container with leak-proof error handling and First-Ready Handoff
   */
  async replenish(languageId) {
    const pool = this.pools[languageId];
    if (pool.available.length + pool.activeBoots >= this.targetPoolSize) return;

    pool.activeBoots++;
    let container = null;

    try {
      container = await this.createAndBootDaemon(languageId);
      pool.consecutiveFailures = 0;
    } catch (err) {
      // Decrement boot count on failure
      pool.activeBoots--;
      pool.consecutiveFailures++;

      // Trip circuit breaker after 3 consecutive failures
      if (pool.consecutiveFailures >= 3) {
        const backoffMs = Math.min(1000 * Math.pow(2, pool.consecutiveFailures - 3), 30000);
        pool.circuitOpenUntil = Date.now() + backoffMs;
        logger.error({
          event: 'circuit_breaker_tripped',
          language: pool.name,
          backoffMs,
          error: err.message,
        });

        // Fail fast all currently waiting requests
        while (pool.waiters.length > 0) {
          const w = pool.waiters.shift();
          w.reject(new Error(`Database infrastructure error (${pool.name}): ${err.message}`));
        }
      } else if (pool.waiters.length > 0) {
        const waiter = pool.waiters.shift();
        waiter.reject(new Error(`Failed to initialize database container: ${err.message}`));
      }
      return;
    }

    // Decrement counter BEFORE handoff or pushing to available
    pool.activeBoots--;
    this.trackedContainerIds.add(container.id);

    // First-Ready Handoff: deliver to earliest waiting request
    if (pool.waiters.length > 0) {
      const waiter = pool.waiters.shift();
      waiter.resolve(container);
      // Immediately replenish consumed slot
      this.checkReplenish(languageId);
    } else {
      pool.available.push(container);
    }
  }

  /**
   * Create, start, and await daemon readiness with leak-proof cleanup on failure
   */
  async createAndBootDaemon(languageId) {
    const pool = this.pools[languageId];
    let container = null;

    try {
      container = await this.docker.createContainer({
        Image: pool.image,
        User: pool.user || '70:70', // Daemon runs under UID 70 (postgres) or UID 999 (mysql); user queries run as 1001 via exec
        WorkingDir: '/box',
        NetworkDisabled: true, // Complete network isolation
        Labels: {
          'com.codebox.pool': 'true',
          'com.codebox.worker_slot': this.workerSlotId,
          'com.codebox.created_at': Date.now().toString(),
        },
        HostConfig: {
          Tmpfs: {
            '/box': 'rw,exec,nosuid,size=256m,mode=1777',
            '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777',
          },
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Memory: 512 * 1024 * 1024,      // 512MB RAM cap
          MemorySwap: 512 * 1024 * 1024,  // Swap disabled
          CpuPeriod: 100000,
          CpuQuota: 100000,               // 1 vCPU
          PidsLimit: pool.pidsLimit || 64, // 64 for PG, 128 for MySQL
        },
      });

      await container.start();
      await this.awaitReadySignal(container);
      return container;
    } catch (err) {
      // LEAK-PROOF: If start or probe fails, immediately destroy container
      if (container) {
        await container.remove({ force: true }).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Poll readiness marker (/box/.ready) until daemon startup completes
   */
  async awaitReadySignal(container, maxWaitMs = 10000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const exec = await container.exec({
          Cmd: ['test', '-f', '/box/.ready'],
          AttachStdout: false,
          AttachStderr: false,
        });

        await new Promise((resolve) => {
          exec.start({}, (err, stream) => {
            if (err) return resolve();
            stream.on('end', resolve);
            stream.resume();
          });
        });

        const inspect = await exec.inspect();
        if (inspect.ExitCode === 0) {
          return;
        }
      } catch {
        // Container might still be starting
      }

      await new Promise(r => setTimeout(r, 25)); // 25ms polling intervals
    }

    throw new Error(`Timeout waiting for daemon readiness (/box/.ready) after ${maxWaitMs}ms`);
  }

  /**
   * Startup sweep: purge orphaned containers belonging strictly to this worker slot
   */
  async startupSweep() {
    try {
      const list = await this.docker.listContainers({
        all: true,
        filters: {
          label: [
            'com.codebox.pool=true',
            `com.codebox.worker_slot=${this.workerSlotId}`,
          ],
        },
      });

      logger.info({
        event: 'startup_sweep_scan',
        slot: this.workerSlotId,
        count: list.length,
      });

      for (const info of list) {
        logger.info({ event: 'purging_orphaned_container', id: info.Id });
        await this.docker.getContainer(info.Id).remove({ force: true }).catch(() => {});
      }
    } catch (err) {
      logger.error({ event: 'startup_sweep_error', error: err.message });
    }
  }

  /**
   * Pre-warm pool up to target capacity
   */
  async warmPool() {
    await this.startupSweep();
    for (const languageId of Object.keys(this.pools)) {
      this.checkReplenish(parseInt(languageId, 10));
    }
  }

  /**
   * Graceful shutdown: awaits removal of all tracked and available containers
   */
  async shutdown() {
    this.isShuttingDown = true;
    logger.info({ event: 'database_pool_shutdown_started', slot: this.workerSlotId });

    // Reject all waiting requests immediately
    for (const id of Object.keys(this.pools)) {
      const pool = this.pools[id];
      while (pool.waiters.length > 0) {
        pool.waiters.shift().reject(new Error('Database pool is shutting down'));
      }
    }

    // Await removal of all available and tracked containers
    const removals = [];
    for (const id of Object.keys(this.pools)) {
      const pool = this.pools[id];
      while (pool.available.length > 0) {
        const container = pool.available.pop();
        removals.push(
          container.remove({ force: true }).catch(err => {
            logger.warn({ event: 'shutdown_container_remove_error', error: err.message });
          })
        );
      }
    }

    // Also remove any remaining tracked containers
    for (const containerId of this.trackedContainerIds) {
      removals.push(
        this.docker.getContainer(containerId).remove({ force: true }).catch(() => {})
      );
    }
    this.trackedContainerIds.clear();

    await Promise.all(removals);
    logger.info({ event: 'database_pool_shutdown_completed' });
  }
}

// Singleton instance
let poolInstance = null;

export function getDatabasePool(docker, options) {
  if (!poolInstance) {
    poolInstance = new DatabaseContainerPool(docker, options);
  }
  return poolInstance;
}

export default { DatabaseContainerPool, getDatabasePool };

