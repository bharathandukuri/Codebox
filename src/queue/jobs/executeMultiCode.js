import { getStatusById } from '../../languages/index.js';
import { getExecutor, getExecutorType } from '../../executor/ExecutorFactory.js';
import { analyzeCode } from '../../security/codeAnalyzer.js';
import logger from '../../utils/logger.js';

/**
 * Execute multi-file submission job
 * @param {object} submission - The multi-file submission data
 * @returns {object} Multi-file execution result
 */
export async function executeMultiCode(submission) {
  const executor = getExecutor(submission.language_id);
  const executorType = getExecutorType(submission.language_id);

  // Pre-execution security scan on all source files
  for (const file of submission.files) {
    const scan = analyzeCode(file.content, submission.language_id);
    if (scan.rejected) {
      logger.warn({
        event: 'code_rejected_multifile',
        token: submission.token,
        language_id: submission.language_id,
        path: file.path,
        reason: scan.reason,
      });

      return {
        ...submission,
        status: getStatusById(6), // Compilation Error
        compile: {
          status: getStatusById(6),
          output: `Security Rejected (${file.path}): ${scan.reason}`,
          time: null,
          wall_time: null,
        },
        executions: [],
        finished_at: new Date().toISOString(),
      };
    }
  }

  logger.info({
    event: 'multi_execution_started',
    token: submission.token,
    language_id: submission.language_id,
    file_count: submission.files.length,
    execution_count: submission.executions.length,
    executor: executorType,
  });

  const startTime = Date.now();

  try {
    const result = await executor.executeMulti(submission);
    const executionTime = Date.now() - startTime;

    logger.info({
      event: 'multi_execution_completed',
      token: submission.token,
      status: result.status.id,
      executionTime,
      executor: executorType,
    });

    return {
      ...submission,
      ...result,
      finished_at: new Date().toISOString(),
    };
  } catch (error) {
    logger.error({
      event: 'multi_execution_failed',
      token: submission.token,
      error: error.message,
      executor: executorType,
    });

    return {
      ...submission,
      status: getStatusById(13), // Internal Error
      message: error.message,
      compile: {
        status: getStatusById(13),
        output: error.message,
        time: null,
        wall_time: null,
      },
      executions: [],
      finished_at: new Date().toISOString(),
    };
  }
}

export default executeMultiCode;
