import Docker from 'dockerode';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { getStatusById } from '../languages/index.js';
import ResultParser from './ResultParser.js';

const MULTI_FILE_LANGUAGE_ID = 89;

class DockerExecutor {
  constructor() {
    this.docker = new Docker({ socketPath: config.docker.socketPath });
    this.resultParser = new ResultParser();
  }

  /**
   * Execute a submission
   * @param {object} submission - The submission object
   * @returns {object} Execution result
   */
  async execute(submission) {
    const { language } = submission;
    let container = null;

    try {
      // Create container with security limits
      container = await this.createContainer(submission);

      // Start container
      await container.start();

      if (language.id === MULTI_FILE_LANGUAGE_ID) {
        // Multi-file program: extract ZIP, then run compile/run scripts
        await this.copyAdditionalFiles(container, submission);
        return await this.executeMultiFile(container, submission);
      }

      // Copy source code to container
      await this.copySourceCode(container, submission);

      // Copy additional files if provided
      if (submission.additional_files) {
        await this.copyAdditionalFiles(container, submission);
      }

      // If compiled language, run compilation first
      if (language.compile_cmd) {
        const compileResult = await this.runCommand(
          container,
          language.compile_cmd,
          submission.compiler_options,
          submission.cpu_time_limit + submission.cpu_extra_time,
          ''
        );

        if (compileResult.exitCode !== 0) {
          return {
            status: getStatusById(6), // Compilation Error
            compile_output: compileResult.stderr || compileResult.stdout,
            time: null,
            wall_time: null,
            memory: null,
            stdout: null,
            stderr: null,
            exit_code: compileResult.exitCode,
            exit_signal: null,
          };
        }
      }

      // Run the program
      const runCmd = this.buildRunCommand(language.run_cmd, submission.command_line_arguments);
      const result = await this.runCommand(
        container,
        runCmd,
        null,
        submission.wall_time_limit,
        submission.stdin
      );

      // Parse and return result
      return this.resultParser.parse(result, submission);
    } catch (error) {
      logger.error({
        event: 'execution_error',
        token: submission.token,
        error: error.message,
      });

      return {
        status: getStatusById(13), // Internal Error
        message: error.message,
        time: null,
        wall_time: null,
        memory: null,
        stdout: null,
        stderr: null,
        compile_output: null,
        exit_code: null,
        exit_signal: null,
      };
    } finally {
      // Cleanup container
      if (container) {
        try {
          await container.stop({ t: 1 }).catch(() => {});
          await container.remove({ force: true });
        } catch (err) {
          logger.warn({ err }, 'Failed to cleanup container');
        }
      }
    }
  }

  /**
   * Execute a multi-file program (language_id 89)
   */
  async executeMultiFile(container, submission) {
    // Verify /box/run script exists
    const checkRun = await this.runCommand(container, 'test -f /box/run', null, 5, '');
    if (checkRun.exitCode !== 0) {
      return {
        status: getStatusById(6), // Compilation Error (used for setup errors)
        compile_output: 'Multi-file program requires a "run" script in the ZIP archive',
        time: null,
        wall_time: null,
        memory: null,
        stdout: null,
        stderr: null,
        exit_code: null,
        exit_signal: null,
      };
    }

    // If /box/compile exists, run it
    const checkCompile = await this.runCommand(container, 'test -f /box/compile', null, 5, '');
    if (checkCompile.exitCode === 0) {
      const compileResult = await this.runCommand(
        container,
        'bash /box/compile',
        null,
        submission.cpu_time_limit + submission.cpu_extra_time,
        ''
      );

      if (compileResult.exitCode !== 0) {
        return {
          status: getStatusById(6), // Compilation Error
          compile_output: compileResult.stderr || compileResult.stdout,
          time: null,
          wall_time: null,
          memory: null,
          stdout: null,
          stderr: null,
          exit_code: compileResult.exitCode,
          exit_signal: null,
        };
      }
    }

    // Run the program
    const result = await this.runCommand(
      container,
      'bash /box/run',
      null,
      submission.wall_time_limit,
      submission.stdin
    );

    return this.resultParser.parse(result, submission);
  }

  /**
   * Create a Docker container with security limits
   */
  async createContainer(submission) {
    const { language, memory_limit, max_processes_and_or_threads, enable_network } = submission;

    // Use at least the language's minimum memory (e.g. tsc needs ~400MB)
    const effectiveMemory = memory_limit ? Math.max(memory_limit, language.min_memory || 0) : (language.min_memory || 0);

    const boxSize = effectiveMemory > 0 ? Math.max(Math.ceil(effectiveMemory / 1024), 128) : 256; // at least 128MB for /box

    const containerConfig = {
      Image: language.image,
      Cmd: ['/bin/sh', '-c', 'sleep 3600'], // Keep container alive
      WorkingDir: '/box',
      // User is set in Dockerfile for each language image
      NetworkDisabled: !enable_network,
      HostConfig: {
        Memory: effectiveMemory > 0 ? effectiveMemory * 1024 : 0, // Convert KB to bytes, or 0 for unlimited
        MemorySwap: effectiveMemory > 0 ? effectiveMemory * 1024 : 0, // Disable swap, or 0 for unlimited
        CpuPeriod: 100000,
        CpuQuota: 100000, // 1 CPU
        PidsLimit: max_processes_and_or_threads,
        NetworkMode: enable_network ? 'bridge' : 'none',
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        MaskedPaths: [
          '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow',
          '/etc/hostname', '/etc/hosts', '/etc/resolv.conf',
          '/proc/kcore', '/proc/keys', '/proc/latency_stats',
          '/proc/timer_list', '/proc/timer_stats', '/proc/sched_debug',
          '/proc/scsi', '/proc/acpi', '/proc/bus',
          '/proc/1/environ', '/proc/1/cmdline', '/proc/1/maps',
          '/sys/firmware', '/sys/devices',
        ],
        ReadonlyPaths: ['/proc', '/sys'],
        // mode=1777 is required: every language image runs as a non-root user
        // (see docker/images/*/Dockerfile), and a tmpfs defaults to root-owned
        // 0755 — without this the sandbox user cannot write its source file or
        // its compile artifacts into /box.
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777',
          '/box': `rw,exec,nosuid,size=${boxSize}m,mode=1777`,
          '/home': 'rw,noexec,nosuid,size=16m,mode=1777',
        },
        Binds: [],
      },
      Tty: false,
      OpenStdin: true,
      StdinOnce: true,
    };

    return await this.docker.createContainer(containerConfig);
  }

  /**
   * Copy source code into the container
   */
  async copySourceCode(container, submission) {
    const { language, source_code } = submission;

    await this.writeFileToBox(container, language.source_file, source_code);
  }

  /**
   * Write a single file into /box from inside the container.
   *
   * putArchive() cannot be used for this. Docker resolves archive destination
   * paths against the container's rootfs and does not follow tmpfs mounts, so
   * an archive sent to /box is extracted into the rootfs directory that the
   * tmpfs is mounted over -- invisible to any process in the container. With
   * ReadonlyRootfs set, the daemon refuses the write outright:
   *   (HTTP code 400) container rootfs is marked read-only
   * Piping the content in over exec stdin writes to the real tmpfs instead, and
   * works while the rootfs stays read-only.
   */
  async writeFileToBox(container, fileName, content) {
    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');

    // Ensure parent directory exists inside /box if fileName contains subdirectories
    const lastSlash = fileName.lastIndexOf('/');
    if (lastSlash !== -1) {
      const dirPath = fileName.substring(0, lastSlash);
      await this.runCommand(container, `mkdir -p '/box/${dirPath}'`, null, 10, '');
    }

    const result = await this.runCommand(
      container,
      `base64 -d > '/box/${fileName}'`,
      null,
      30,
      contentBuffer.toString('base64')
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write ${fileName} into container: ${result.stderr || `exit code ${result.exitCode}`}`
      );
    }
  }

  /**
   * Copy additional files (base64-encoded ZIP) into the container
   */
  async copyAdditionalFiles(container, submission) {
    const { additional_files } = submission;

    try {
      const zipBuffer = Buffer.from(additional_files, 'base64');

      await this.writeFileToBox(container, '_additional.zip', zipBuffer);

      // Check for path traversal and extract ZIP inside container
      const checkResult = await this.runCommand(
        container,
        'unzip -l /box/_additional.zip | grep -q "\\.\\./\\|/\\.\\." && echo TRAVERSAL_FOUND || echo OK',
        null,
        10,
        ''
      );

      if (checkResult.stdout.trim().includes('TRAVERSAL_FOUND')) {
        await this.runCommand(container, 'rm /box/_additional.zip', null, 5, '');
        throw new Error('ZIP archive contains path traversal entries');
      }

      const extractResult = await this.runCommand(
        container,
        'unzip -n -qq /box/_additional.zip -d /box && rm /box/_additional.zip',
        null,
        10,
        ''
      );

      if (extractResult.exitCode !== 0) {
        throw new Error(extractResult.stderr || 'Failed to extract ZIP archive');
      }

      logger.info({
        event: 'additional_files_copied',
        token: submission.token,
        size: zipBuffer.length,
      });
    } catch (error) {
      logger.error({
        event: 'additional_files_copy_failed',
        token: submission.token,
        error: error.message,
      });
      throw new Error(`Failed to copy additional files: ${error.message}`);
    }
  }

  /**
   * Build run command with arguments
   */
  buildRunCommand(baseCmd, args) {
    if (!args) return baseCmd;
    return `${baseCmd} ${args}`;
  }

  /**
   * Run a command inside the container
   */
  async runCommand(container, command, extraOptions, timeoutSecs, stdin) {
    const startTime = Date.now();

    // Create exec instance
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: !!stdin,
      WorkingDir: '/box',
    });

    return new Promise((resolve, reject) => {
      const timeoutMs = timeoutSecs * 1000;
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        // Kill the container to stop execution
        container.kill().catch(() => {});
      }, timeoutMs);

      exec.start({ hijack: true, stdin: !!stdin }, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          return reject(err);
        }

        // Send stdin if provided
        if (stdin) {
          stream.write(stdin);
          stream.end();
        }

        // Demux stdout and stderr
        const stdoutChunks = [];
        const stderrChunks = [];

        stream.on('data', (chunk) => {
          // Docker multiplexes stdout/stderr with 8-byte header
          // Header: [stream type (1 byte), 0, 0, 0, size (4 bytes)]
          let offset = 0;
          while (offset < chunk.length) {
            if (offset + 8 > chunk.length) break;

            const streamType = chunk[offset];
            const size = chunk.readUInt32BE(offset + 4);

            if (offset + 8 + size > chunk.length) break;

            const data = chunk.slice(offset + 8, offset + 8 + size);

            if (streamType === 1) {
              stdoutChunks.push(data);
            } else if (streamType === 2) {
              stderrChunks.push(data);
            }

            offset += 8 + size;
          }
        });

        stream.on('end', async () => {
          clearTimeout(timeout);

          stdout = Buffer.concat(stdoutChunks).toString('utf-8');
          stderr = Buffer.concat(stderrChunks).toString('utf-8');

          const endTime = Date.now();
          const wallTime = (endTime - startTime) / 1000;

          // Get exit code
          let exitCode = 0;
          try {
            const inspection = await exec.inspect();
            exitCode = inspection.ExitCode;
          } catch (e) {
            exitCode = timedOut ? 124 : -1;
          }

          resolve({
            stdout,
            stderr,
            exitCode,
            wallTime,
            time: wallTime, // Approximate CPU time
            memory: null, // Would need cgroup stats for accurate memory
            timedOut,
          });
        });

        stream.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });
  }
  /**
   * Execute a multi-file submission in a single sandbox
   * @param {object} submission - The multi-file submission
   * @returns {object} Multi-file execution result
   */
  async executeMulti(submission) {
    const { language, files, executions, compileOrder, compiler_options } = submission;
    let container = null;

    try {
      // 1. Create and start a single container for the entire lifecycle
      // Pass the language and limits of the first execution / overall submission
      const baseLimits = executions[0] || {};
      const isSqlite = language.id === 7;
      const memLimits = executions.map(e => e.memory_limit).filter(m => m != null);
      const effectiveMultiMemory = memLimits.length > 0 ? Math.max(...memLimits) : (isSqlite ? null : 256000);

      const containerSubmission = {
        language,
        memory_limit: effectiveMultiMemory,
        max_processes_and_or_threads: Math.max(...executions.map(e => e.max_processes_and_or_threads || 64), 64),
        enable_network: submission.enable_network || false,
      };

      container = await this.createContainer(containerSubmission);
      await container.start();

      // 2. Write all files to /box
      for (const file of files) {
        await this.writeFileToBox(container, file.path, file.content);
      }

      // 3. Optional compilation step if the language requires it
      let compileResultSummary = null;
      if (language.compile_cmd) {
        // Determine compile file order
        let compileFiles = [];
        if (compileOrder && Array.isArray(compileOrder) && compileOrder.length > 0) {
          compileFiles = compileOrder;
        } else {
          // Use files array preserving order, filtered by relevant source extensions
          const sourceExts = ['.java', '.cpp', '.c', '.cc', '.cxx', '.ts'];
          compileFiles = files
            .map(f => f.path)
            .filter(p => sourceExts.some(ext => p.endsWith(ext)));
        }

        let compileCmd = '';
        if (language.id === 3) {
          // Java
          compileCmd = `javac -cp .:/usr/local/lib/java/* ${compileFiles.map(f => `'${f}'`).join(' ')}`;
        } else if (language.id === 2) {
          // C++
          compileCmd = `g++ -O2 -std=c++17 -I/usr/local/include -o main ${compileFiles.map(f => `'${f}'`).join(' ')}`;
        } else if (language.id === 1) {
          // C
          compileCmd = `gcc -O2 -std=c11 -o main ${compileFiles.map(f => `'${f}'`).join(' ')}`;
        } else if (language.id === 6) {
          // TypeScript
          compileCmd = `tsc ${compileFiles.map(f => `'${f}'`).join(' ')} --outDir . --esModuleInterop --skipLibCheck`;
        } else {
          compileCmd = language.compile_cmd;
        }

        if (compiler_options) {
          compileCmd += ` ${compiler_options}`;
        }

        const maxCompileTime = Math.max(...executions.map(e => (e.cpu_time_limit || 5) + (e.cpu_extra_time || 1)));
        const compileRes = await this.runCommand(container, compileCmd, null, maxCompileTime, '');

        if (compileRes.exitCode !== 0) {
          // Compilation failed - short-circuit immediately
          return {
            status: getStatusById(6), // Compilation Error
            compile: {
              status: getStatusById(6),
              output: compileRes.stderr || compileRes.stdout,
              time: compileRes.time,
              wall_time: compileRes.wallTime,
            },
            executions: executions.map(e => ({
              entryPoint: e.entryPoint,
              status: getStatusById(6),
              stdout: null,
              stderr: null,
              exit_code: null,
              exit_signal: null,
              time: null,
              wall_time: null,
              memory: null,
            })),
          };
        }

        compileResultSummary = {
          status: getStatusById(3), // Accepted
          output: compileRes.stdout || null,
          time: compileRes.time,
          wall_time: compileRes.wallTime,
        };
      }

      // 4. Run each execution sequentially in the same sandbox
      const executionResults = [];
      let overallStatus = getStatusById(3); // Default Accepted

      for (const execConfig of executions) {
        const { entryPoint, stdin = '', args = [], wall_time_limit = 5 } = execConfig;

        // Build execution command for entryPoint
        let runCmd = '';
        const argsStr = args.map(a => `'${a}'`).join(' ');

        if (language.id === 3) {
          // Java: entryPoint could be "Main.java" or "Main" or "pkg/Main.java"
          let className = entryPoint.replace(/\.java$/, '').replace(/\//g, '.');
          runCmd = `java -cp .:/usr/local/lib/java/* ${className} ${argsStr}`.trim();
        } else if (language.id === 2 || language.id === 1) {
          // C / C++: compiled binary is ./main
          runCmd = `./main ${argsStr}`.trim();
        } else if (language.id === 5) {
          // Python
          runCmd = `python3 '${entryPoint}' ${argsStr}`.trim();
        } else if (language.id === 4) {
          // JavaScript
          runCmd = `node '${entryPoint}' ${argsStr}`.trim();
        } else if (language.id === 6) {
          // TypeScript (compiled to .js)
          const jsFile = entryPoint.replace(/\.ts$/, '.js');
          runCmd = `node '${jsFile}' ${argsStr}`.trim();
        } else if (language.id === 7) {
          // SQLite
          runCmd = `sqlite3 -header -column /box/db.sqlite < '${entryPoint}'`.trim();
        } else {
          runCmd = `${language.run_cmd} ${argsStr}`.trim();
        }

        const runResult = await this.runCommand(container, runCmd, null, wall_time_limit, stdin);
        const parsed = this.resultParser.parse(runResult, {
          redirect_stderr_to_stdout: submission.redirect_stderr_to_stdout,
        });

        const executionItem = {
          entryPoint,
          status: parsed.status,
          stdout: parsed.stdout,
          stderr: parsed.stderr,
          exit_code: parsed.exit_code,
          exit_signal: parsed.exit_signal,
          time: parsed.time,
          wall_time: parsed.wall_time,
          memory: parsed.memory,
        };

        executionResults.push(executionItem);

        // Per requirement: If an execution times out or crashes fatally (non-zero or timed out),
        // kill container and fail the remaining executions
        if (runResult.timedOut || parsed.status.id !== 3) {
          overallStatus = parsed.status;
          break;
        }
      }

      return {
        status: overallStatus,
        compile: compileResultSummary,
        executions: executionResults,
      };
    } catch (error) {
      logger.error({
        event: 'multi_execution_docker_error',
        token: submission.token,
        error: error.message,
      });

      return {
        status: getStatusById(13), // Internal Error
        message: error.message,
        compile: null,
        executions: [],
      };
    } finally {
      if (container) {
        try {
          await container.stop({ t: 1 }).catch(() => {});
          await container.remove({ force: true }).catch(() => {});
        } catch (err) {
          logger.warn({ err }, 'Failed to cleanup multi-file container');
        }
      }
    }
  }
}

export default DockerExecutor;
