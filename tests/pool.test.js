import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { DatabaseContainerPool, _resetDatabasePool } from '../src/executor/pool/DatabaseContainerPool.js';

class MockStream extends EventEmitter {
  resume() {}
}

function createMockDocker(options = {}) {
  let containerCount = 0;
  const createdContainers = [];

  const docker = {
    createdContainers,
    failBootTimes: options.failBootTimes || 0,
    bootDelayMs: options.bootDelayMs || 5,
    createContainer: async (opts) => {
      containerCount++;
      const id = `mock-container-${containerCount}`;

      const container = {
        id,
        Id: id,
        opts,
        running: false,
        removed: false,
        removeOpts: null,
        start: async () => {
          if (docker.failBootTimes > 0) {
            docker.failBootTimes--;
            throw new Error('Simulated Docker start failure');
          }
          if (docker.bootDelayMs > 0) {
            await new Promise(r => setTimeout(r, docker.bootDelayMs));
          }
          container.running = true;
        },
        remove: async (removeOpts) => {
          container.removed = true;
          container.running = false;
          container.removeOpts = removeOpts;
          return { id };
        },
        inspect: async () => ({
          State: { Running: container.running },
        }),
        exec: async () => ({
          start: (execOpts, callback) => {
            const stream = new MockStream();
            setImmediate(() => {
              callback(null, stream);
              setImmediate(() => stream.emit('end'));
            });
          },
          inspect: async () => ({ ExitCode: 0 }),
        }),
      };

      createdContainers.push(container);
      return container;
    },
    listContainers: async () => [],
    getContainer: (id) => {
      const found = createdContainers.find(c => c.id === id);
      return found || {
        id,
        remove: async (opts) => ({ id, opts }),
      };
    },
  };

  return docker;
}

function createMockRedis() {
  const store = new Map();
  return {
    store,
    set: async (key, val) => { store.set(key, val); return 'OK'; },
    get: async (key) => store.get(key) || null,
    exists: async (key) => (store.has(key) ? 1 : 0),
    del: async (key) => { store.delete(key); return 1; },
    quit: async () => 'OK',
  };
}

describe('DatabaseContainerPool Unit Tests (Mocked Docker)', () => {
  beforeEach(() => {
    _resetDatabasePool();
  });

  it('1. Handoff order: First-Ready Handoff delivers container to earliest waiting request', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 20 });
    const mockRedis = createMockRedis();

    const pool = new DatabaseContainerPool(mockDocker, {
      redis: mockRedis,
      postgresPoolSize: 0, // don't pre-warm
      mysqlPoolSize: 0,
      acquireTimeoutMs: 1000,
    });

    const received = [];
    const p1 = pool.acquire(8).then(c => received.push({ waiter: 1, id: c.id }));
    const p2 = pool.acquire(8).then(c => received.push({ waiter: 2, id: c.id }));

    await Promise.all([p1, p2]);

    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].waiter, 1, 'Waiter 1 should receive container first');
    assert.strictEqual(received[1].waiter, 2, 'Waiter 2 should receive container second');

    await pool.shutdown();
  });

  it('2. Acquire timeout: rejects with acquire timeout when no container becomes available', async () => {
    const mockDocker = createMockDocker();
    // Simulate container boot never succeeding by having it hang or taking longer than timeout
    mockDocker.createContainer = async () => {
      await new Promise(r => setTimeout(r, 500));
      throw new Error('Boot too slow');
    };

    const pool = new DatabaseContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 0,
      acquireTimeoutMs: 50,
      maxWaiters: 5,
    });

    await assert.rejects(
      async () => {
        await pool.acquire(8);
      },
      /Timed out waiting for database container/
    );

    await pool.shutdown();
  });

  it('3. Queue-full: rejects immediately when waiters reach maxWaiters limit', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 200 });
    const pool = new DatabaseContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 0,
      maxWaiters: 2,
      acquireTimeoutMs: 500,
    });

    const p1 = pool.acquire(8).catch(() => {});
    const p2 = pool.acquire(8).catch(() => {});

    await assert.rejects(
      async () => {
        await pool.acquire(8);
      },
      /Database execution pool queue is full/
    );

    await pool.shutdown();
    await Promise.allSettled([p1, p2]);
  });

  it('4. Boot failure + retry: retries boot without rejecting waiting request', async () => {
    // 1 failure then success
    const mockDocker = createMockDocker({ failBootTimes: 1, bootDelayMs: 5 });
    const pool = new DatabaseContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 0,
      acquireTimeoutMs: 1500,
    });

    // Acquire should succeed after the retry boot completes!
    const container = await pool.acquire(8);
    assert(container);
    assert.strictEqual(container.running, true);

    await pool.shutdown();
  });

  it('5. Circuit breaker: trips after 3 consecutive failures and half-open probes ONE boot', async () => {
    const mockDocker = createMockDocker({ failBootTimes: 10 });
    const pool = new DatabaseContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 0,
      acquireTimeoutMs: 500,
    });

    // Trigger replenishments to fail 3 times
    pool.pools[8].targetPoolSize = 1;
    await pool.replenish(8); // fail 1
    await pool.replenish(8); // fail 2
    await pool.replenish(8); // fail 3 -> trips circuit breaker

    assert.strictEqual(pool.pools[8].circuitState, 'open');
    assert(pool.pools[8].circuitOpenUntil > Date.now());

    // Subsequent acquire rejects immediately with degraded message
    await assert.rejects(
      async () => {
        await pool.acquire(8);
      },
      /temporarily degraded/
    );

    // Fast-forward backoff time to test half-open probe
    pool.pools[8].circuitOpenUntil = Date.now() - 1;
    mockDocker.failBootTimes = 0; // next boot will succeed

    // CheckReplenish in half-open state should trigger ONE probe boot
    pool.checkReplenish(8);
    assert.strictEqual(pool.pools[8].circuitState, 'half-open');

    // Wait for the probe to finish
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(pool.pools[8].circuitState, 'closed');
    assert.strictEqual(pool.pools[8].available.length, 1);

    await pool.shutdown();
  });

  it('6. Shutdown awaits removals and rejects waiters', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 10 });
    const pool = new DatabaseContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      acquireTimeoutMs: 1000,
    });

    // Let 1 container become available
    await pool.replenish(8);
    assert.strictEqual(pool.pools[8].available.length, 1);

    // Queue a waiter
    const waiterPromise = pool.acquire(9);

    // Now call shutdown
    const shutdownPromise = pool.shutdown();

    // Waiter should reject
    await assert.rejects(
      async () => {
        await waiterPromise;
      },
      /Database pool is shutting down/
    );

    await shutdownPromise;

    // Available container must be removed with force: true, v: true
    const removedContainers = mockDocker.createdContainers.filter(c => c.removed);
    assert(removedContainers.length >= 1);
    for (const c of removedContainers) {
      assert.deepStrictEqual(c.removeOpts, { force: true, v: true });
    }
  });

  it('7. Boot-after-shutdown is destroyed, not pooled', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 50 });
    const pool = new DatabaseContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 0,
      acquireTimeoutMs: 1000,
    });

    // Start a slow boot
    const slowBootPromise = pool.replenish(8);

    // Immediately initiate shutdown while boot is in flight
    await new Promise(r => setTimeout(r, 10));
    await pool.shutdown();
    await slowBootPromise;

    // The container that finished booting must NOT be in available
    assert.strictEqual(pool.pools[8].available.length, 0);

    // It must be removed with force: true, v: true
    const booted = mockDocker.createdContainers[0];
    assert(booted.removed, 'In-flight container must be removed');
    assert.deepStrictEqual(booted.removeOpts, { force: true, v: true });
  });

  it('8. updateOptions updates pool sizes and options without ignoring them', async () => {
    const mockDocker = createMockDocker();
    const pool = new DatabaseContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 2,
      mysqlPoolSize: 2,
    });

    assert.strictEqual(pool.pools[8].targetPoolSize, 2);
    assert.strictEqual(pool.pools[9].targetPoolSize, 2);

    pool.updateOptions({ postgresPoolSize: 5, mysqlPoolSize: 4, maxWaiters: 32 });

    assert.strictEqual(pool.pools[8].targetPoolSize, 5);
    assert.strictEqual(pool.pools[9].targetPoolSize, 4);
    assert.strictEqual(pool.maxWaiters, 32);

    await pool.shutdown();
  });
});

