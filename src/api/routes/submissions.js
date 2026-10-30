import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  validateSubmission,
  validateBatchSubmission,
  validateMultiSubmission,
  validateBatchMultiSubmission,
  sanitizeCompilerOptions,
  sanitizeCommandLineArgs,
} from '../middleware/validation.js';
import { addSubmission, getSubmission, deleteSubmission } from '../../queue/producer.js';
import { getLanguageById, getStatusById } from '../../languages/index.js';
import { decodeIfNeeded, encodeIfNeeded } from '../../utils/base64.js';
import logger from '../../utils/logger.js';

const router = Router();

/**
 * Parse fields query parameter
 */
function parseFields(fields) {
  if (!fields) return null;
  return fields.split(',').map(f => f.trim()).filter(Boolean);
}

/**
 * Filter response to only include specified fields
 */
function filterFields(result, fields) {
  if (!fields) return result;
  const filtered = {};
  for (const field of fields) {
    if (field in result) {
      filtered[field] = result[field];
    }
  }
  return filtered;
}

/**
 * Format single-file submission for response
 */
function formatSingleSubmission(submission, options = {}) {
  const { base64Encoded = false, fields = null } = options;

  const result = {
    token: submission.token,
    type: 'single',
    source_code: encodeIfNeeded(submission.source_code, base64Encoded),
    language_id: submission.language_id,
    stdin: encodeIfNeeded(submission.stdin, base64Encoded),
    stdout: encodeIfNeeded(submission.stdout, base64Encoded),
    stderr: encodeIfNeeded(submission.stderr, base64Encoded),
    compile_output: encodeIfNeeded(submission.compile_output, base64Encoded),
    message: submission.message,
    status: submission.status,
    created_at: submission.created_at,
    finished_at: submission.finished_at,
    time: submission.time,
    wall_time: submission.wall_time,
    memory: submission.memory,
    exit_code: submission.exit_code,
    exit_signal: submission.exit_signal,
  };

  return filterFields(result, fields);
}

/**
 * Format multi-file submission for response
 */
function formatMultiSubmission(submission, options = {}) {
  const { base64Encoded = false, fields = null } = options;

  const result = {
    token: submission.token,
    type: 'multi',
    language_id: submission.language_id,
    status: submission.status,
    compile: submission.compile
      ? {
          status: submission.compile.status,
          output: encodeIfNeeded(submission.compile.output, base64Encoded),
          time: submission.compile.time,
          wall_time: submission.compile.wall_time,
        }
      : null,
    executions: (submission.executions || []).map((exec) => ({
      entryPoint: exec.entryPoint,
      status: exec.status,
      stdout: encodeIfNeeded(exec.stdout, base64Encoded),
      stderr: encodeIfNeeded(exec.stderr, base64Encoded),
      exit_code: exec.exit_code,
      exit_signal: exec.exit_signal,
      time: exec.time,
      wall_time: exec.wall_time,
      memory: exec.memory,
    })),
    message: submission.message,
    created_at: submission.created_at,
    finished_at: submission.finished_at,
  };

  return filterFields(result, fields);
}

/**
 * Format submission (dispatch based on submission.type)
 */
function formatSubmission(submission, options = {}) {
  if (submission.type === 'multi') {
    return formatMultiSubmission(submission, options);
  }
  return formatSingleSubmission(submission, options);
}

/**
 * Wait for submission result with polling
 */
async function waitForResult(token, maxWait = 30000) {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < maxWait) {
    const result = await getSubmission(token);
    if (result && result.status && result.status.id > 2) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return await getSubmission(token);
}

/**
 * POST /submissions/multi/batch
 * Submit multiple multi-file programs
 */
router.post('/multi/batch', validateBatchMultiSubmission, async (req, res, next) => {
  try {
    const runs = req.validatedBody.runs || req.validatedBody.submissions;
    const results = [];

    for (const data of runs) {
      const language = getLanguageById(data.language_id);

      const submission = {
        token: uuidv4(),
        type: 'multi',
        language_id: data.language_id,
        language,
        files: data.files,
        compileOrder: data.compileOrder || null,
        executions: data.executions.map(e => ({
          entryPoint: e.entryPoint,
          stdin: e.stdin || '',
          args: e.args || [],
          cpu_time_limit: e.cpu_time_limit,
          cpu_extra_time: e.cpu_extra_time,
          wall_time_limit: e.wall_time_limit,
          memory_limit: e.memory_limit,
          stack_limit: e.stack_limit,
          max_processes_and_or_threads: e.max_processes_and_or_threads,
          max_file_size: e.max_file_size,
        })),
        compiler_options: sanitizeCompilerOptions(data.compiler_options),
        redirect_stderr_to_stdout: data.redirect_stderr_to_stdout,
        enable_network: data.enable_network,
        callback_url: data.callback_url,
        status: getStatusById(1), // In Queue
        created_at: new Date().toISOString(),
        finished_at: null,
        compile: null,
        message: null,
      };

      await addSubmission(submission);
      results.push({ token: submission.token });
    }

    logger.info({
      event: 'batch_multi_submission_created',
      count: results.length,
    });

    res.status(201).json(results);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /submissions/multi
 * Submit a multi-file program
 */
router.post('/multi', validateMultiSubmission, async (req, res, next) => {
  try {
    const data = req.validatedBody;
    const base64Encoded = req.query.base64_encoded === 'true';
    const wait = req.query.wait === 'true';
    const fields = parseFields(req.query.fields);

    const language = getLanguageById(data.language_id);

    const submission = {
      token: uuidv4(),
      type: 'multi',
      language_id: data.language_id,
      language,
      files: data.files,
      compileOrder: data.compileOrder || null,
      executions: data.executions.map(e => ({
        entryPoint: e.entryPoint,
        stdin: e.stdin || '',
        args: e.args || [],
        cpu_time_limit: e.cpu_time_limit,
        cpu_extra_time: e.cpu_extra_time,
        wall_time_limit: e.wall_time_limit,
        memory_limit: e.memory_limit,
        stack_limit: e.stack_limit,
        max_processes_and_or_threads: e.max_processes_and_or_threads,
        max_file_size: e.max_file_size,
      })),
      compiler_options: sanitizeCompilerOptions(data.compiler_options),
      redirect_stderr_to_stdout: data.redirect_stderr_to_stdout,
      enable_network: data.enable_network,
      callback_url: data.callback_url,
      status: getStatusById(1), // In Queue
      created_at: new Date().toISOString(),
      finished_at: null,
      compile: null,
      message: null,
    };

    await addSubmission(submission);

    logger.info({
      event: 'multi_submission_created',
      token: submission.token,
      language_id: submission.language_id,
      files_count: submission.files.length,
      executions_count: submission.executions.length,
    });

    if (wait) {
      const result = await waitForResult(submission.token);
      res.status(201).json(formatSubmission(result, { base64Encoded, fields }));
    } else {
      res.status(201).json({ token: submission.token });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /submissions/batch
 * Submit multiple single-file programs
 */
router.post('/batch', validateBatchSubmission, async (req, res, next) => {
  try {
    const submissions = req.validatedBody.runs || req.validatedBody.submissions;
    const base64Encoded = req.query.base64_encoded === 'true';

    const results = [];

    for (const data of submissions) {
      const sourceCode = decodeIfNeeded(data.source_code, base64Encoded);
      const stdin = decodeIfNeeded(data.stdin, base64Encoded);
      const language = getLanguageById(data.language_id);

      const submission = {
        token: uuidv4(),
        type: 'single',
        source_code: sourceCode,
        language_id: data.language_id,
        language,
        stdin: stdin || '',
        cpu_time_limit: data.cpu_time_limit,
        cpu_extra_time: data.cpu_extra_time,
        wall_time_limit: data.wall_time_limit,
        memory_limit: data.memory_limit,
        stack_limit: data.stack_limit,
        max_processes_and_or_threads: data.max_processes_and_or_threads,
        max_file_size: data.max_file_size,
        compiler_options: sanitizeCompilerOptions(data.compiler_options),
        command_line_arguments: sanitizeCommandLineArgs(data.command_line_arguments),
        redirect_stderr_to_stdout: data.redirect_stderr_to_stdout,
        enable_network: data.enable_network,
        callback_url: data.callback_url,
        additional_files: data.additional_files || null,
        status: getStatusById(1), // In Queue
        created_at: new Date().toISOString(),
        finished_at: null,
        time: null,
        wall_time: null,
        memory: null,
        stdout: null,
        stderr: null,
        compile_output: null,
        message: null,
        exit_code: null,
        exit_signal: null,
      };

      await addSubmission(submission);
      results.push({ token: submission.token });
    }

    logger.info({
      event: 'batch_submission_created',
      count: results.length,
    });

    res.status(201).json(results);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /submissions/batch
 * Get multiple submissions by tokens
 */
router.get('/batch', async (req, res, next) => {
  try {
    const tokens = req.query.tokens;
    const base64Encoded = req.query.base64_encoded === 'true';
    const fields = parseFields(req.query.fields);

    if (!tokens) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing tokens query parameter',
      });
    }

    const tokenList = tokens.split(',').map(t => t.trim()).filter(Boolean);

    if (tokenList.length > 20) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Maximum 20 tokens allowed',
      });
    }

    const results = await Promise.all(
      tokenList.map(async (token) => {
        const submission = await getSubmission(token);
        if (submission) {
          return formatSubmission(submission, { base64Encoded, fields });
        }
        return { token, error: 'Not found' };
      })
    );

    res.json({ submissions: results, runs: results });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /submissions
 * Submit a single-file program
 */
router.post('/', validateSubmission, async (req, res, next) => {
  try {
    const data = req.validatedBody;
    const base64Encoded = req.query.base64_encoded === 'true';
    const wait = req.query.wait === 'true';
    const fields = parseFields(req.query.fields);

    const sourceCode = decodeIfNeeded(data.source_code, base64Encoded);
    const stdin = decodeIfNeeded(data.stdin, base64Encoded);
    const language = getLanguageById(data.language_id);

    const submission = {
      token: uuidv4(),
      type: 'single',
      source_code: sourceCode,
      language_id: data.language_id,
      language,
      stdin: stdin || '',
      cpu_time_limit: data.cpu_time_limit,
      cpu_extra_time: data.cpu_extra_time,
      wall_time_limit: data.wall_time_limit,
      memory_limit: data.memory_limit,
      stack_limit: data.stack_limit,
      max_processes_and_or_threads: data.max_processes_and_or_threads,
      max_file_size: data.max_file_size,
      compiler_options: sanitizeCompilerOptions(data.compiler_options),
      command_line_arguments: sanitizeCommandLineArgs(data.command_line_arguments),
      redirect_stderr_to_stdout: data.redirect_stderr_to_stdout,
      enable_network: data.enable_network,
      callback_url: data.callback_url,
      additional_files: data.additional_files || null,
      status: getStatusById(1), // In Queue
      created_at: new Date().toISOString(),
      finished_at: null,
      time: null,
      wall_time: null,
      memory: null,
      stdout: null,
      stderr: null,
      compile_output: null,
      message: null,
      exit_code: null,
      exit_signal: null,
    };

    await addSubmission(submission);

    logger.info({
      event: 'submission_created',
      token: submission.token,
      language_id: submission.language_id,
    });

    if (wait) {
      const result = await waitForResult(submission.token);
      res.status(201).json(formatSubmission(result, { base64Encoded, fields }));
    } else {
      res.status(201).json({ token: submission.token });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * GET /submissions/:token
 * Get submission by token (works for both single and multi-file)
 */
router.get('/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const base64Encoded = req.query.base64_encoded === 'true';
    const fields = parseFields(req.query.fields);

    const submission = await getSubmission(token);

    if (!submission) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Submission with token ${token} not found`,
      });
    }

    res.json(formatSubmission(submission, { base64Encoded, fields }));
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /submissions/:token
 * Delete submission
 */
router.delete('/:token', async (req, res, next) => {
  try {
    const { token } = req.params;

    const deleted = await deleteSubmission(token);

    if (!deleted) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Submission with token ${token} not found`,
      });
    }

    res.status(200).json({ message: 'Submission deleted' });
  } catch (error) {
    next(error);
  }
});

export default router;

