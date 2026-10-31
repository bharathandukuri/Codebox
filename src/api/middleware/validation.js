import Joi from 'joi';
import config from '../../utils/config.js';
import { isValidLanguageId } from '../../languages/index.js';
import logger from '../../utils/logger.js';

// Run validation schema (single file execution)
const runSchema = Joi.object({
  source_code: Joi.string().max(config.execution.maxSourceSize).required(),
  language_id: Joi.number().integer().required().custom((value, helpers) => {
    if (!isValidLanguageId(value)) {
      return helpers.error('any.invalid');
    }
    return value;
  }),
  stdin: Joi.string().allow('', null).default(''),
  time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  timelimit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  cpu_time_limit: Joi.number().greater(0).max(config.execution.maxCpuTimeLimit).allow(null),
  cpu_extra_time: Joi.number().min(0).max(5).default(1),
  wall_time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  memory_limit: Joi.number().min(0).max(config.execution.maxMemoryLimit).allow(null),
  stack_limit: Joi.number().min(0).max(config.execution.defaultStackLimit)
    .default(config.execution.defaultStackLimit),
  max_processes_and_or_threads: Joi.number().min(1).max(config.execution.maxProcesses)
    .default(config.execution.maxProcesses),
  max_file_size: Joi.number().min(0).max(4096).default(1024),
  compiler_options: Joi.string().allow('', null).default(null),
  command_line_arguments: Joi.string().allow('', null).default(null),
  redirect_stderr_to_stdout: Joi.boolean().default(false),
  enable_network: Joi.any().strip().default(false),
  callback_url: Joi.string().uri().allow('', null).default(null).custom((value, helpers) => {
    if (!value) return value;
    try {
      const url = new URL(value);
      // Block internal/private networks (SSRF protection)
      const hostname = url.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('172.') ||
        hostname.startsWith('192.168.') ||
        hostname === '169.254.169.254' ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local')
      ) {
        return helpers.error('any.invalid');
      }
      // Only allow http/https
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return helpers.error('any.invalid');
      }
      return value;
    } catch {
      return helpers.error('any.invalid');
    }
  }),
  additional_files: Joi.string().allow('', null).default(null),
});

// Batch run validation
const batchRunSchema = Joi.object({
  runs: Joi.array().items(runSchema).min(1).max(20),
  submissions: Joi.array().items(runSchema).min(1).max(20),
}).or('runs', 'submissions');

// Multi-file run schema
const multiFileRunSchema = Joi.object({
  language_id: Joi.number().integer().required().custom((value, helpers) => {
    if (!isValidLanguageId(value)) {
      return helpers.error('any.invalid');
    }
    return value;
  }),
  time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  timelimit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  cpu_time_limit: Joi.number().greater(0).max(config.execution.maxCpuTimeLimit).allow(null),
  wall_time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  memory_limit: Joi.number().min(0).max(config.execution.maxMemoryLimit).allow(null),
  files: Joi.array().items(
    Joi.object({
      path: Joi.string().required().custom((value, helpers) => {
        const normalized = value.trim();
        if (
          !normalized ||
          normalized.startsWith('/') ||
          normalized.startsWith('\\') ||
          normalized.includes('..') ||
          /^[a-zA-Z]:/.test(normalized)
        ) {
          return helpers.error('any.invalid');
        }
        return normalized;
      }),
      content: Joi.string().allow('').required(),
    })
  ).min(1).required(),
  compileOrder: Joi.array().items(Joi.string()).default(null),
  executions: Joi.array().items(
    Joi.object({
      entryPoint: Joi.string().required(),
      stdin: Joi.string().allow('', null).default(''),
      args: Joi.array().items(Joi.string()).default([]),
      time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
      timelimit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
      cpu_time_limit: Joi.number().greater(0).max(config.execution.maxCpuTimeLimit).allow(null),
      cpu_extra_time: Joi.number().min(0).max(5).default(1),
      wall_time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
      memory_limit: Joi.number().min(0).max(config.execution.maxMemoryLimit).allow(null),
      stack_limit: Joi.number().min(0).max(config.execution.defaultStackLimit)
        .default(config.execution.defaultStackLimit),
      max_processes_and_or_threads: Joi.number().min(1).max(config.execution.maxProcesses)
        .default(config.execution.maxProcesses),
      max_file_size: Joi.number().min(0).max(4096).default(1024),
    })
  ).min(1).max(20).required(),
  compiler_options: Joi.string().allow('', null).default(null),
  redirect_stderr_to_stdout: Joi.boolean().default(false),
  enable_network: Joi.any().strip().default(false),
  callback_url: Joi.string().uri().allow('', null).default(null).custom((value, helpers) => {
    if (!value) return value;
    try {
      const url = new URL(value);
      const hostname = url.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('172.') ||
        hostname.startsWith('192.168.') ||
        hostname === '169.254.169.254' ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local')
      ) {
        return helpers.error('any.invalid');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return helpers.error('any.invalid');
      }
      return value;
    } catch {
      return helpers.error('any.invalid');
    }
  }),
});

// Batch multi-file run validation
const batchMultiFileRunSchema = Joi.object({
  runs: Joi.array().items(multiFileRunSchema).min(1).max(20),
  submissions: Joi.array().items(multiFileRunSchema).min(1).max(20),
}).or('runs', 'submissions');

/**
 * Validate run request
 */
export function validateRun(req, res, next) {
  const { error, value } = runSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = value;
  next();
}

export const validateSubmission = validateRun;

/**
 * Validate batch run request
 */
export function validateBatchRun(req, res, next) {
  const { error, value } = batchRunSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const list = req.body?.runs || req.body?.submissions;
    logger.warn({
      event: 'batch_validation_error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
      count: list?.length,
      languageIds: list?.map(s => s.language_id),
    });
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  // Normalize to runs
  req.validatedBody = {
    runs: value.runs || value.submissions,
  };
  next();
}

export const validateBatchSubmission = validateBatchRun;
export const validateMultiSubmission = validateMultiRun;
export const validateBatchMultiSubmission = validateBatchMultiRun;

/**
 * Validate multi-file run request
 */
export function validateMultiRun(req, res, next) {
  const { error, value } = multiFileRunSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = value;
  next();
}

/**
 * Validate batch multi-file run request
 */
export function validateBatchMultiRun(req, res, next) {
  const { error, value } = batchMultiFileRunSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const list = req.body?.runs || req.body?.submissions;
    logger.warn({
      event: 'batch_multi_validation_error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
      count: list?.length,
    });
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = {
    runs: value.runs || value.submissions,
  };
  next();
}

/**
 * Sanitize compiler options to prevent command injection.
 * Whitelist approach: only allow alphanumeric, hyphens, dots, equals, slashes,
 * plus, underscores, and spaces. Reject everything else including newlines.
 */
export function sanitizeCompilerOptions(options) {
  if (!options) return null;
  // Strip any character not in the safe set
  const sanitized = options.replace(/[^a-zA-Z0-9\s\-_.=+/]/g, '');
  // Collapse multiple spaces and trim
  return sanitized.replace(/\s+/g, ' ').trim() || null;
}

/**
 * Sanitize command line arguments to prevent command injection.
 * Same whitelist approach as compiler options.
 */
export function sanitizeCommandLineArgs(args) {
  if (!args) return null;
  const sanitized = args.replace(/[^a-zA-Z0-9\s\-_.=+/]/g, '');
  return sanitized.replace(/\s+/g, ' ').trim() || null;
}

export default {
  validateSubmission,
  validateBatchSubmission,
  sanitizeCompilerOptions,
  sanitizeCommandLineArgs,
};
