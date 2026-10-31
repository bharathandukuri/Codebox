import { Queue } from 'bullmq';
import Redis from 'ioredis';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

// Redis connection
let redis = null;
let submissionQueue = null;
let dbSubmissionQueue = null;

export const SUBMISSIONS_QUEUE = 'submissions';
export const DB_SUBMISSIONS_QUEUE = 'submissions-db';

/**
 * Initialize Redis and BullMQ queues
 */
export async function initializeQueue() {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Connected to Redis');
  });

  const defaultJobOptions = {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      count: 100,
    },
    removeOnFail: {
      count: 1000,
    },
  };

  submissionQueue = new Queue(SUBMISSIONS_QUEUE, {
    connection: redis,
    defaultJobOptions,
  });

  dbSubmissionQueue = new Queue(DB_SUBMISSIONS_QUEUE, {
    connection: redis,
    defaultJobOptions,
  });

  logger.info('BullMQ queues initialized');
  return submissionQueue;
}

/**
 * Get Redis connection
 */
export function getRedis() {
  return redis;
}

/**
 * Get submission queue
 */
export function getQueue(languageId) {
  if (languageId === 8 || languageId === 9) {
    return dbSubmissionQueue || submissionQueue;
  }
  return submissionQueue;
}

/**
 * Add submission to queue and cache
 */
export async function addSubmission(submission) {
  if (!redis || !submissionQueue) {
    throw new Error('Queue not initialized');
  }

  // Store initial submission state in Redis
  await redis.setex(
    `submission:${submission.token}`,
    config.cache.resultTtl,
    JSON.stringify(submission)
  );

  const isDb = submission.language_id === 8 || submission.language_id === 9;
  const targetQueue = (isDb && dbSubmissionQueue) ? dbSubmissionQueue : submissionQueue;

  // Add job to target queue
  await targetQueue.add('execute', submission, {
    jobId: submission.token,
  });

  logger.debug({
    event: 'submission_queued',
    token: submission.token,
    queue: isDb ? DB_SUBMISSIONS_QUEUE : SUBMISSIONS_QUEUE,
  });

  return submission;
}

/**
 * Get submission from cache
 */
export async function getSubmission(token) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const data = await redis.get(`submission:${token}`);
  if (!data) return null;

  return JSON.parse(data);
}

/**
 * Update submission in cache
 */
export async function updateSubmission(token, updates) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const existing = await getSubmission(token);
  if (!existing) return null;

  const updated = { ...existing, ...updates };

  await redis.setex(
    `submission:${token}`,
    config.cache.resultTtl,
    JSON.stringify(updated)
  );

  return updated;
}

/**
 * Delete submission from cache
 */
export async function deleteSubmission(token) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const exists = await redis.exists(`submission:${token}`);
  if (!exists) return false;

  await redis.del(`submission:${token}`);
  return true;
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  if (!submissionQueue) {
    return { submissions: { total: 0, in_queue: 0, processing: 0, completed: 0 } };
  }

  const queues = [submissionQueue];
  if (dbSubmissionQueue) queues.push(dbSubmissionQueue);

  let totalWaiting = 0;
  let totalActive = 0;
  let totalCompleted = 0;
  let totalFailed = 0;

  for (const q of queues) {
    const [waiting, active, completed, failed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
    ]);
    totalWaiting += waiting;
    totalActive += active;
    totalCompleted += completed;
    totalFailed += failed;
  }

  return {
    submissions: {
      total: totalWaiting + totalActive + totalCompleted + totalFailed,
      in_queue: totalWaiting,
      processing: totalActive,
      completed: totalCompleted,
      failed: totalFailed,
    },
  };
}

/**
 * Get worker statistics
 */
export async function getWorkerStats() {
  if (!submissionQueue) {
    return [];
  }

  const queues = [submissionQueue];
  if (dbSubmissionQueue) queues.push(dbSubmissionQueue);

  const allWorkers = [];
  for (const q of queues) {
    const workers = await q.getWorkers();
    allWorkers.push(...workers.map(w => ({
      id: w.id,
      name: w.name,
      active: true,
    })));
  }

  return allWorkers;
}

/**
 * Close Redis connection
 */
export async function closeQueue() {
  if (submissionQueue) {
    await submissionQueue.close();
  }
  if (dbSubmissionQueue) {
    await dbSubmissionQueue.close();
  }
  if (redis) {
    await redis.quit();
  }
  logger.info('Queue connections closed');
}

export default {
  initializeQueue,
  getRedis,
  getQueue,
  addSubmission,
  getSubmission,
  updateSubmission,
  deleteSubmission,
  getQueueStats,
  getWorkerStats,
  closeQueue,
};
