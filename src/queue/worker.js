import { Worker } from 'bullmq';
import Redis from 'ioredis';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { executeCode } from './jobs/executeCode.js';
import { executeMultiCode } from './jobs/executeMultiCode.js';
import { getStatusById } from '../languages/index.js';
import { getDatabasePool } from '../executor/pool/DatabaseContainerPool.js';

let redis = null;
let activeWorkers = [];

/**
 * Update submission result in Redis
 */
async function updateSubmissionResult(token, result) {
  await redis.setex(
    `submission:${token}`,
    config.cache.resultTtl,
    JSON.stringify(result)
  );
}

/**
 * Send callback to URL if configured
 */
async function sendCallback(callbackUrl, submission) {
  if (!callbackUrl) return;

  try {
    const response = await fetch(callbackUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
    });

    logger.info({
      event: 'callback_sent',
      token: submission.token,
      url: callbackUrl,
      status: response.status,
    });
  } catch (error) {
    logger.error({
      event: 'callback_failed',
      token: submission.token,
      url: callbackUrl,
      error: error.message,
    });
  }
}

/**
 * Process a submission job
 */
async function processJob(job) {
  const submission = job.data;
  const token = submission.token;

  logger.info({
    event: 'job_started',
    token,
    jobId: job.id,
  });

  // Update status to Processing
  await updateSubmissionResult(token, {
    ...submission,
    status: getStatusById(2), // Processing
  });

  // Execute the code (dispatch based on submission.type)
  let result;
  if (submission.type === 'multi') {
    result = await executeMultiCode(submission);
  } else {
    result = await executeCode(submission);
  }

  // Store final result
  await updateSubmissionResult(token, result);

  // Send callback if configured
  if (submission.callback_url) {
    await sendCallback(submission.callback_url, result);
  }

  logger.info({
    event: 'job_completed',
    token,
    jobId: job.id,
    status: result.status.id,
  });

  return result;
}

/**
 * Start the worker
 */
export async function startWorker() {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'Worker Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Worker connected to Redis');
  });

  const workerType = process.env.WORKER_TYPE;
  const queueNames = [];

  if (workerType === 'db') {
    queueNames.push('submissions-db');
  } else if (workerType === 'isolate' || workerType === 'code') {
    queueNames.push('submissions');
  } else {
    // Standalone / default mode: consume from both queues
    queueNames.push('submissions', 'submissions-db');
  }

  activeWorkers = queueNames.map((queueName) => {
    const w = new Worker(queueName, processJob, {
      connection: redis,
      concurrency: config.worker.concurrency,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 1000 },
    });

    w.on('completed', (job, result) => {
      logger.debug({
        event: 'worker_job_completed',
        queue: queueName,
        jobId: job.id,
        token: job.data.token,
      });
    });

    w.on('failed', (job, err) => {
      logger.error({
        event: 'worker_job_failed',
        queue: queueName,
        jobId: job?.id,
        token: job?.data?.token,
        error: err.message,
      });
    });

    w.on('error', (err) => {
      logger.error({ err, queue: queueName }, 'Worker error');
    });

    return w;
  });

  logger.info({
    event: 'worker_started',
    workerType: workerType || 'all',
    queues: queueNames,
    concurrency: config.worker.concurrency,
  });

  // Pre-warm database pool for DB or standalone worker
  if (workerType !== 'isolate' && workerType !== 'code') {
    try {
      const pool = getDatabasePool();
      pool.warmPool().catch((err) => {
        logger.error({ event: 'pool_warmup_error', error: err.message });
      });
    } catch (poolErr) {
      logger.warn({ event: 'pool_init_skipped', message: poolErr.message });
    }
  }

  return activeWorkers[0];
}

/**
 * Stop the worker gracefully:
 * 1. worker.close() first (drain active jobs)
 * 2. pool.shutdown()
 * 3. redis.quit()
 */
export async function stopWorker() {
  for (const w of activeWorkers) {
    try {
      await w.close();
      logger.info('Worker drained and closed');
    } catch (err) {
      logger.warn({ event: 'worker_close_error', error: err.message });
    }
  }
  activeWorkers = [];

  try {
    const pool = getDatabasePool();
    await pool.shutdown();
  } catch (poolErr) {
    logger.warn({ event: 'pool_shutdown_error', message: poolErr.message });
  }

  if (redis) {
    await redis.quit();
  }
}

// Run as main script
if (process.argv[1] && process.argv[1].endsWith('worker.js')) {
  startWorker().catch((err) => {
    logger.error({ err }, 'Failed to start worker');
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await stopWorker();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    await stopWorker();
    process.exit(0);
  });
}

export default {
  startWorker,
  stopWorker,
};
