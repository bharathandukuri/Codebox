import Docker from 'dockerode';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import config from '../../utils/config.js';
import logger from '../../utils/logger.js';

export class DatabaseContainerPool {
  constructor(docker, options = {}) {
    this.docker = docker || new Docker();
    this.customRedis = !!options.redis;
    this.redis = options.redis || (config.redis?.url ? new Redis(config.redis.url) : null);

    this.instanceId = options.instanceId || process.env.INSTANCE_ID || `worker-${uuidv4().slice(0, 8)}`;
    this.workerSlotId = this.instanceId;

    const defaultConcurrency = parseInt(process.env.WORKER_CONCURRENCY || options.concurrency || '2', 10);
    this.postgresPoolSize = parseInt(process.env.POSTGRES_POOL_SIZE || options.postgresPoolSize || defaultConcurrency, 10);
    this.mysqlPoolSize = parseInt(process.env.MYSQL_POOL_SIZE || options.mysqlPoolSize || defaultConcurrency, 10);
    this.targetPoolSize = options.poolSize ? parseInt(options.poolSize, 10) : defaultConcurrency;

    this.maxWaiters = parseInt(process.env.POOL_MAX_WAITERS || options.maxWaiters || '16', 10);
    this.acquireTimeoutMs = parseInt(process.env.POOL_ACQUIRE_TIMEOUT_MS || options.acquireTimeoutMs || '10000', 10);

    this.trackedContainerIds = new Set();
    this.inFlightBoots = new Set();
    this.pendingRemovals = new Set();
    this.isShuttingDown = false;

    this.pools = {
      8: {
        available: [],
        waiters: [],
        activeBoots: 0,
        consecutiveFailures: 0,
        circuitState: 'closed', // 'closed' | 'open' | 'half-open'
        circuitOpenUntil: 0,
        targetPoolSize: this.postgresPoolSize,
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
        circuitState: 'closed',
        circuitOpenUntil: 0,
        targetPoolSize: this.mysqlPoolSize,
        image: 'codebox/mysql:8.4',
        name: 'mysql',
        user: '999:999',
        pidsLimit: 128,
        readySignal: 'CODEBOX_DAEMON_READY',
      },
    };

    // Setup Redis heartbeat (EX 30, refreshed every 10s)
    if (this.redis) {
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat().catch(() => {});
      }, 10000);
      this.heartbeatTimer.unref();
      this.sendHeartbeat().catch(() => {});

      // Sweep orphaned containers on startup and every 60s
      this.sweepTimer = setInterval(() => {
        this.sweepOrphans().catch(() => {});
      }, 60000);
      this.sweepTimer.unref();
    }
  }

  /**
   * Update pool configuration dynamically
   */
  updateOptions(options = {}) {
    if (options.postgresPoolSize !== undefined) {
      this.postgresPoolSize = parseInt(options.postgresPoolSize, 10);
      this.pools[8].targetPoolSize = this.postgresPoolSize;
    }
    if (options.mysqlPoolSize !== undefined) {
      this.mysqlPoolSize = parseInt(options.mysqlPoolSize, 10);
      this.pools[9].targetPoolSize = this.mysqlPoolSize;
    }
    if (options.poolSize !== undefined) {
      const ps = parseInt(options.poolSize, 10);
      this.targetPoolSize = ps;
      if (options.postgresPoolSize === undefined) this.pools[8].targetPoolSize = ps;
      if (options.mysqlPoolSize === undefined) this.pools[9].targetPoolSize = ps;
    }
    if (options.maxWaiters !== undefined) {
      this.maxWaiters = parseInt(options.maxWaiters, 10);
    }
    if (options.acquireTimeoutMs !== undefined) {
      this.acquireTimeoutMs = parseInt(options.acquireTimeoutMs, 10);
    }

    if (!this.isShuttingDown) {
      this.checkReplenish(8);
      this.checkReplenish(9);
    }
  }

  /**
   * Send heartbeat to Redis
   */
  async sendHeartbeat() {
    if (!this.redis || this.isShuttingDown) return;
    try {
      await this.redis.set(`worker:heartbeat:${this.instanceId}`, 'alive', 'EX', 30);
    } catch (err) {
      logger.warn({ event: 'heartbeat_failed', instanceId: this.instanceId, error: err.message });
    }
  }

  /**
   * Sweep orphaned containers older than 60s without an active Redis heartbeat
   */
  async sweepOrphans() {
    if (!this.docker || !this.docker.listContainers) return;
    try {
      const list = await this.docker.listContainers({
        all: true,
        filters: {
          label: ['com.codebox.pool=true'],
        },
      });

      const now = Date.now();
      for (const info of list) {
        const labels = info.Labels || {};
        const createdAt = parseInt(labels['com.codebox.created_at'] || '0', 10) || (info.Created ? info.Created * 1000 : 0);
        const ageMs = now - createdAt;

        if (ageMs > 60000) {
          const instId = labels['com.codebox.instance_id'] || labels['com.codebox.worker_slot'];
          let isDead = true;

          if (instId && this.redis) {
            try {
              const alive = await this.redis.exists(`worker:heartbeat:${instId}`);
              if (alive) isDead = false;
            } catch {
              // Ignore redis check error
            }
          }

          if (isDead) {
            logger.info({ event: 'sweep_removing_orphan', id: info.Id, instId, ageMs });
            const c = this.docker.getContainer(info.Id);
            await c.remove({ force: true, v: true }).catch(() => {});
          }
        }
      }
    } catch (err) {
      logger.error({ event: 'sweep_orphans_error', error: err.message });
    }
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
      try {
        const inspect = await container.inspect();
        if (inspect.State.Running) {
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
    const now = Date.now();
    if (pool.circuitState === 'open') {
      if (now < pool.circuitOpenUntil) {
        throw new Error(`Database service for ${pool.name} is temporarily degraded. Please retry shortly.`);
      }
      // Backoff elapsed: transition to half-open to allow ONE probe boot
      pool.circuitState = 'half-open';
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

      this.checkReplenish(languageId);
    });
  }

  /**
   * Safe release & disposal of an ephemeral container
   */
  release(container) {
    if (!container) return Promise.resolve();
    return this.destroy(container);
  }

  /**
   * Destroy container off the critical path, tracking pending removals
   * Returns removal promise
   */
  destroy(container) {
    if (!container) return Promise.resolve();
    const containerId = container.id || container.Id;
    if (containerId) {
      this.trackedContainerIds.delete(containerId);
    }

    const removePromise = (async () => {
      try {
        await container.remove({ force: true, v: true });
      } catch (err) {
        logger.warn({ event: 'container_destroy_failed', id: containerId, error: err.message });
      }
    })();

    this.pendingRemovals.add(removePromise);
    removePromise.finally(() => {
      this.pendingRemovals.delete(removePromise);
    });

    return removePromise;
  }

  /**
   * Check and trigger replenishments up to target capacity
   */
  checkReplenish(languageId) {
    const pool = this.pools[languageId];
    if (this.isShuttingDown) return;

    const now = Date.now();
    if (pool.circuitState === 'open') {
      if (now < pool.circuitOpenUntil) return;
      pool.circuitState = 'half-open';
    }

    // In half-open state, probe ONE boot at a time
    if (pool.circuitState === 'half-open') {
      if (pool.activeBoots > 0) return;
      this.replenish(languageId).catch(() => {});
      return;
    }

    const target = pool.targetPoolSize;
    const currentSlots = pool.available.length + pool.activeBoots;
    const needed = Math.max(0, target - currentSlots);

    for (let i = 0; i < needed; i++) {
      this.replenish(languageId).catch(() => {});
    }
  }

  /**
   * Replenish container with exponential backoff on failure and First-Ready Handoff
   */
  async replenish(languageId) {
    const pool = this.pools[languageId];
    if (this.isShuttingDown) return;

    if (pool.circuitState === 'half-open' && pool.activeBoots > 0) return;
    if (pool.available.length + pool.activeBoots >= pool.targetPoolSize && pool.waiters.length === 0) return;

    pool.activeBoots++;

    let bootPromise = null;
    let container = null;

    try {
      bootPromise = this.createAndBootDaemon(languageId);
      this.inFlightBoots.add(bootPromise);

      container = await bootPromise;

      if (this.isShuttingDown) {
        if (container) {
          this.destroy(container);
        }
        return;
      }

      // Success: reset failures and close circuit
      pool.consecutiveFailures = 0;
      pool.circuitState = 'closed';
      pool.circuitOpenUntil = 0;
    } catch (err) {
      pool.activeBoots--;
      pool.consecutiveFailures++;

      if (pool.circuitState === 'half-open' || pool.consecutiveFailures >= 3) {
        // Trip circuit breaker
        pool.circuitState = 'open';
        const backoffMs = Math.min(1000 * Math.pow(2, pool.consecutiveFailures - 3), 30000);
        pool.circuitOpenUntil = Date.now() + backoffMs;

        logger.error({
          event: 'circuit_breaker_tripped',
          language: pool.name,
          backoffMs,
          error: err.message,
        });

        // Fail fast currently waiting requests
        while (pool.waiters.length > 0) {
          const w = pool.waiters.shift();
          w.reject(new Error(`Database infrastructure error (${pool.name}): ${err.message}`));
        }
      } else {
        // Boot failure before circuit trip: retry with exponential backoff instead of rejecting waiter
        const retryDelay = Math.min(100 * Math.pow(2, pool.consecutiveFailures), 2000);
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.checkReplenish(languageId);
          }
        }, retryDelay).unref();
      }
      return;
    } finally {
      if (bootPromise) {
        this.inFlightBoots.delete(bootPromise);
      }
    }

    pool.activeBoots--;
    if (container && container.id) {
      this.trackedContainerIds.add(container.id);
    }

    // First-Ready Handoff: deliver to earliest waiting request
    if (pool.waiters.length > 0) {
      const waiter = pool.waiters.shift();
      waiter.resolve(container);
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
        User: pool.user || '70:70',
        WorkingDir: '/box',
        NetworkDisabled: true,
        Labels: {
          'com.codebox.pool': 'true',
          'com.codebox.instance_id': this.instanceId,
          'com.codebox.worker_slot': this.instanceId,
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
          Memory: 512 * 1024 * 1024,
          MemorySwap: 512 * 1024 * 1024,
          CpuPeriod: 100000,
          CpuQuota: 100000,
          PidsLimit: pool.pidsLimit || 64,
        },
      });

      await container.start();
      await this.awaitReadySignal(container);
      return container;
    } catch (err) {
      if (container) {
        await container.remove({ force: true, v: true }).catch(() => {});
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

      await new Promise(r => setTimeout(r, 25));
    }

    throw new Error(`Timeout waiting for daemon readiness (/box/.ready) after ${maxWaitMs}ms`);
  }

  /**
   * Startup sweep: purge orphaned containers older than 60s
   */
  async startupSweep() {
    await this.sweepOrphans();
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
   * Graceful shutdown: awaits removal of all tracked, available, in-flight boots, and pending removals
   */
  async shutdown() {
    this.isShuttingDown = true;
    logger.info({ event: 'database_pool_shutdown_started', instanceId: this.instanceId });

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);

    if (this.redis) {
      try {
        await this.redis.del(`worker:heartbeat:${this.instanceId}`);
      } catch {
        // Ignore redis cleanup error
      }
    }

    // Reject all waiting requests immediately
    for (const id of Object.keys(this.pools)) {
      const pool = this.pools[id];
      while (pool.waiters.length > 0) {
        pool.waiters.shift().reject(new Error('Database pool is shutting down'));
      }
    }

    // Trigger removal of all available containers
    for (const id of Object.keys(this.pools)) {
      const pool = this.pools[id];
      while (pool.available.length > 0) {
        const container = pool.available.pop();
        this.destroy(container);
      }
    }

    // Trigger removal of remaining tracked containers
    for (const containerId of this.trackedContainerIds) {
      if (this.docker && this.docker.getContainer) {
        this.destroy(this.docker.getContainer(containerId));
      }
    }
    this.trackedContainerIds.clear();

    // Await all in-flight boots and all pending removals
    await Promise.allSettled([
      ...Array.from(this.inFlightBoots),
      ...Array.from(this.pendingRemovals),
    ]);

    if (!this.customRedis && this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // Ignore quit error
      }
    }

    logger.info({ event: 'database_pool_shutdown_completed' });
  }
}

// Singleton instance
let poolInstance = null;

export function getDatabasePool(docker, options = {}) {
  if (!poolInstance) {
    poolInstance = new DatabaseContainerPool(docker, options);
  } else if (options && Object.keys(options).length > 0) {
    poolInstance.updateOptions(options);
  }
  return poolInstance;
}

export function _resetDatabasePool() {
  poolInstance = null;
}

export default { DatabaseContainerPool, getDatabasePool, _resetDatabasePool };
