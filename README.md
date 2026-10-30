# CodeBox

A high-performance, sandboxed code execution engine built with Node.js, Express, Docker, and Linux sandboxing (Isolate / cgroups v2). 

CodeBox is designed strictly as a **pure code execution engine**—it compiles code, executes it inside hardened sandboxes with resource limits (CPU, memory, wall time), and returns execution telemetry (`stdout`, `stderr`, execution duration, peak memory, and exit codes) without forced grading or output comparison.

> Credits: Based upon the original CodeBox project by Chai aur Code / Hitesh Choudhary, updated and enhanced with pure execution semantics, native multi-file JSON orchestration, and simplified language management.

---

## Key Features

- **Pure Execution Focus**: Decouples code execution from test case evaluation. Executes untrusted code and returns raw outputs and process metrics.
- **Single & Multi-File Execution**:
  - `POST /submissions`: Standard single-file code runs.
  - `POST /submissions/multi`: Native JSON multi-file orchestration. Compiles all files once and executes multiple entry points sequentially inside the same sandbox.
- **Batch Processing**: Run multiple independent single-file or multi-file submissions in a single request.
- **Hardened Sandboxing**:
  - Drops all Linux capabilities (`CapDrop: ALL`), enforces `no-new-privileges`.
  - Read-only root filesystem with isolated in-memory `tmpfs` mounts for `/box` and `/tmp`.
  - Resource limits: strict CPU quotas, memory caps with swap disabled, and PID limits.
  - Supports both **Docker** and **Isolate** (Linux namespaces/cgroups v2) execution backends.
- **Clean Sequential Language IDs**:
  - `1`: C (GCC 9.4.0)
  - `2`: C++ (GCC 9.4.0)
  - `3`: Java (OpenJDK 17)
  - `4`: JavaScript (Node.js 18.15.0)
  - `5`: Python (3.8.10)
  - `6`: TypeScript (5.0.3)
- **Production Architecture**: Asynchronous Redis job queue (BullMQ), Prometheus telemetry (`/metrics`), and Caddy / Nginx reverse proxy support.

---

## System Architecture

```
┌────────────────┐      ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
│  API Clients   │─────▶│  CodeBox API   │─────▶│  Redis Queue   │─────▶│ Worker Service │
│  (Frontend/IDE)│      │  (Port 3000)   │      │   (BullMQ)     │      │ (Concurrency)  │
└────────────────┘      └────────────────┘      └────────────────┘      └───────┬────────┘
                                                                                │
                                                                 ┌──────────────┴──────────────┐
                                                                 │                             │
                                                          ┌──────▼──────┐               ┌──────▼──────┐
                                                          │   Isolate   │      OR       │   Docker    │
                                                          │  (cgroups)  │               │ (Container) │
                                                          └──────┬──────┘               └──────┬──────┘
                                                                 │                             │
                                                                 └──────────────┬──────────────┘
                                                                                │
                                                                 ┌──────────────▼──────────────┐
                                                                 │  Sandboxed Code Execution   │
                                                                 │  (CPU/RAM/Time Restricted)  │
                                                                 └─────────────────────────────┘
```

---

## Quick Start (Local Development)

### Prerequisites
- Docker & Docker Compose
- Node.js 20+

### Setup & Run

1. **Clone the repository**:
   ```bash
   git clone https://github.com/bharathandukuri/Codebox.git
   cd Codebox
   npm install
   ```

2. **Build the language runtime images**:
   ```bash
   ./scripts/build-images.sh
   ```

3. **Start the stack** (API, Worker, Redis):
   ```bash
   docker compose up -d
   ```

4. **Verify Health**:
   ```bash
   curl http://localhost:3000/health
   ```

---

## API Usage Examples

Default development authentication token: `dev-token` (header: `X-Auth-Token: dev-token`).

### 1. Single-File Code Execution
```bash
curl -X POST "http://localhost:3000/submissions?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "language_id": 5,
    "source_code": "import sys\nprint(f\"Hello, {sys.stdin.read().strip()}!\")",
    "stdin": "CodeBox"
  }'
```

**Response**:
```json
{
  "token": "4a7b3c2d-...",
  "type": "single",
  "source_code": "import sys\n...",
  "language_id": 5,
  "stdin": "CodeBox",
  "stdout": "Hello, CodeBox!\n",
  "stderr": null,
  "compile_output": null,
  "status": { "id": 3, "description": "Accepted" },
  "time": "0.035",
  "wall_time": "0.040",
  "memory": 12480,
  "exit_code": 0
}
```

---

### 2. Multi-File Code Execution (`POST /submissions/multi`)
Send multiple files as JSON. All files are compiled once inside a single sandbox, and multiple entry points are run sequentially in the same environment.

```bash
curl -X POST "http://localhost:3000/submissions/multi?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "language_id": 3,
    "files": [
      {
        "path": "models/User.java",
        "content": "package models;\npublic class User {\n  public String name;\n  public User(String name) { this.name = name; }\n}"
      },
      {
        "path": "Main.java",
        "content": "import models.User;\npublic class Main {\n  public static void main(String[] args) {\n    User u = new User(\"Alice\");\n    System.out.println(\"User: \" + u.name);\n  }\n}"
      },
      {
        "path": "Test.java",
        "content": "public class Test {\n  public static void main(String[] args) {\n    System.out.println(\"Tests passed\");\n  }\n}"
      }
    ],
    "compileOrder": [
      "models/User.java",
      "Main.java",
      "Test.java"
    ],
    "executions": [
      { "entryPoint": "Main.java", "stdin": "" },
      { "entryPoint": "Test.java", "stdin": "" }
    ]
  }'
```

**Response**:
```json
{
  "token": "d8e9f0a1-...",
  "type": "multi",
  "language_id": 3,
  "status": { "id": 3, "description": "Accepted" },
  "compile": {
    "status": { "id": 3, "description": "Accepted" },
    "output": null,
    "wall_time": "0.450"
  },
  "executions": [
    {
      "entryPoint": "Main.java",
      "status": { "id": 3, "description": "Accepted" },
      "stdout": "User: Alice\n",
      "stderr": null,
      "exit_code": 0,
      "time": "0.080",
      "wall_time": "0.085"
    },
    {
      "entryPoint": "Test.java",
      "status": { "id": 3, "description": "Accepted" },
      "stdout": "Tests passed\n",
      "stderr": null,
      "exit_code": 0,
      "time": "0.050",
      "wall_time": "0.055"
    }
  ]
}
```

---

### 3. Batch Submissions
- `POST /submissions/batch`: Run up to 20 single-file submissions in parallel.
- `POST /submissions/multi/batch`: Run up to 20 multi-file submissions in parallel.
- `GET /submissions/batch?tokens=token1,token2`: Retrieve results for multiple submissions.

---

## Supported Languages

| ID | Language | Standard Compiler / Interpreter | Command |
|---|---|---|---|
| **1** | C | GCC 9.4.0 | `gcc -O2 -std=c11 -o main *.c` |
| **2** | C++ | GCC 9.4.0 | `g++ -O2 -std=c++17 -I/usr/local/include -o main *.cpp` |
| **3** | Java | OpenJDK 17 | `javac -cp . Main.java` $\rightarrow$ `java -cp . Main` |
| **4** | JavaScript | Node.js 18.15.0 | `node main.js` |
| **5** | Python | Python 3.8.10 | `python3 main.py` |
| **6** | TypeScript | TypeScript 5.0.3 | `tsc main.ts --outDir .` $\rightarrow$ `node main.js` |
| **7** | SQL (SQLite 3) | SQLite 3 | `sqlite3 -header -column /box/db.sqlite < query.sql` |

---

## Execution Status Codes

| ID | Status Description | Notes |
|---|---|---|
| **1** | In Queue | Waiting in Redis / BullMQ |
| **2** | Processing | Actively executing inside sandbox |
| **3** | Accepted | Process finished cleanly (exit code 0) |
| **5** | Time Limit Exceeded | Exceeded CPU or wall time limit |
| **6** | Compilation Error | Compilation failed (check `compile_output`) |
| **7** | Runtime Error (SIGSEGV) | Segmentation fault |
| **8** | Runtime Error (SIGXFSZ) | File size limit exceeded |
| **9** | Runtime Error (SIGFPE) | Floating point exception / division by zero |
| **10** | Runtime Error (SIGABRT) | Process aborted |
| **11** | Runtime Error (NZEC) | Non-zero exit code |
| **13** | Internal Error | Infrastructure or sandbox initialization failure |

---

## Production Deployment

A production `docker-compose.prod.yml` configuration is provided with resource constraints, automatic TLS via Caddy, and Prometheus metrics protection:

```bash
# Set secure secrets
export AUTH_TOKEN=$(openssl rand -hex 32)
export METRICS_TOKEN=$(openssl rand -hex 16)
export DOMAIN=codebox.yourdomain.com

docker compose -f docker-compose.prod.yml up -d
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
