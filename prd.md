# Product Requirements Document: CodeBox

## Executive Summary

CodeBox is an asynchronous, high-performance sandboxed code execution engine built on Node.js/Express, Redis/BullMQ, Docker, and Linux cgroup sandboxes (Isolate). It provides pure code execution semantics—compiling, running, and isolating untrusted code, and returning execution telemetry (`stdout`, `stderr`, duration, memory, and exit codes) without embedded grading side-effects.

> Credits: Based on the foundational CodeBox project by Chai aur Code / Hitesh Choudhary, updated and customized for pure code execution and native multi-file orchestration.

---

## Product Vision

Deliver a secure, low-latency code execution engine capable of executing arbitrary untrusted code across major programming languages with strong sandboxing guarantees, supporting both single-file executions and multi-file projects.

---

## Core Capabilities

### 1. Pure Execution Model
- Accepts source code, standard input (`stdin`), and resource limits.
- Executes code inside a restricted sandbox environment.
- Returns process execution results (`stdout`, `stderr`, `time`, `wall_time`, `memory`, `exit_code`, `status`).
- Does not compare outputs or assign grading judgments like "Wrong Answer"—evaluation belongs in client/consumer applications.

### 2. Multi-File Project Orchestration (`POST /submissions/multi`)
- Accepts a collection of files in structured JSON (`path`, `content`).
- Compiles the project once inside a single dedicated sandbox environment.
- Preserves relative subdirectories (`models/User.java`, `src/app.py`).
- Sequentially executes multiple entry points against the same compiled environment.
- Implements fail-fast isolation: if an execution crashes or times out, the container is terminated immediately.

### 3. Hardened Sandboxing
- Multi-engine support: **Docker** container sandboxing and **Isolate** Linux cgroups namespaces.
- Enforces `ReadonlyRootfs`, dropped Linux capabilities (`CapDrop: ALL`), and `no-new-privileges`.
- Memory isolation with swap disabled, CPU quota limits, and PID execution bounds.
- Path traversal defense preventing writes outside the working `/box` directory.

### 4. Language Support
- Clean sequential language identifiers:
  - `1`: C (GCC 9.4.0)
  - `2`: C++ (GCC 9.4.0)
  - `3`: Java (OpenJDK 17)
  - `4`: JavaScript (Node.js 18.15.0)
  - `5`: Python (3.8.10)
  - `6`: TypeScript (5.0.3)

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check endpoint |
| `GET` | `/languages` | List all supported languages |
| `GET` | `/statuses` | List all execution status codes |
| `POST` | `/submissions` | Execute a single-file code submission |
| `POST` | `/submissions/batch` | Batch submit single-file executions (up to 20) |
| `POST` | `/submissions/multi` | Execute a multi-file project with multiple entry points |
| `POST` | `/submissions/multi/batch` | Batch submit multi-file projects (up to 20) |
| `GET` | `/submissions/:token` | Retrieve status and outputs for any submission |
| `GET` | `/submissions/batch` | Retrieve status and outputs for multiple tokens |
| `DELETE` | `/submissions/:token` | Delete a submission from the cache |
| `GET` | `/metrics` | Prometheus observability metrics |

---

## Execution Status Codes

- `1`: In Queue
- `2`: Processing
- `3`: Accepted (Process exited with code 0)
- `5`: Time Limit Exceeded (CPU or wall-clock timeout)
- `6`: Compilation Error
- `7`: Runtime Error (SIGSEGV)
- `8`: Runtime Error (SIGXFSZ)
- `9`: Runtime Error (SIGFPE)
- `10`: Runtime Error (SIGABRT)
- `11`: Runtime Error (NZEC - Non-zero exit code)
- `13`: Internal Error
