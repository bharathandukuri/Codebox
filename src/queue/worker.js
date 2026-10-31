import { Worker } from 'bullmq';
import Redis from 'ioredis';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { executeCode } from './jobs/executeCode.js';
import { executeMultiCode } from './jobs/executeMultiCode.js';
import { getStatusById } from '../languages/index.js';
import { getDatabasePool } from '../executor/pool/DatabaseContainerPool.js';

let redis = null;
let worker = null;

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

  worker = new Worker('submissions', processJob, {
    connection: redis,
    concurrency: config.worker.concurrency,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 1000 },
  });

  worker.on('completed', (job, result) => {
    logger.debug({
      event: 'worker_job_completed',
      jobId: job.id,
      token: job.data.token,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error({
      event: 'worker_job_failed',
      jobId: job?.id,
      token: job?.data?.token,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  logger.info({
    event: 'worker_started',
    concurrency: config.worker.concurrency,
  });

  // Pre-warm database pool for worker
  try {
    const pool = getDatabasePool();
    pool.warmPool().catch(err => {
      logger.error({ event: 'pool_warmup_error', error: err.message });
    });
  } catch (poolErr) {
    logger.warn({ event: 'pool_init_skipped', message: poolErr.message });
  }

  return worker;
}

/**
 * Stop the worker gracefully
 */
export async function stopWorker() {
  try {
    const pool = getDatabasePool();
    await pool.shutdown();
  } catch (poolErr) {
    logger.warn({ event: 'pool_shutdown_error', message: poolErr.message });
  }

  if (worker) {
    await worker.close();
    logger.info('Worker stopped');
  }
  if (redis) {
    await redis.quit();
  }
}

// Run as main script
if (process.argv[1].endsWith('worker.js')) {
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
