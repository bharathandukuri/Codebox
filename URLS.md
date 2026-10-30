# CodeBox - Important URLs & API Reference

## Local Development

| Service | URL | Description |
|---|---|---|
| **API Server** | http://localhost:3000 | Main API server |
| **Health Check** | http://localhost:3000/health | Health status |
| **Prometheus Metrics** | http://localhost:3000/metrics | Scrape metrics endpoint |
| **Redis** | localhost:6379 | In-memory job queue & cache |

---

## API Endpoints Reference

### System & Health
```
GET  /health        - Health check (no auth required)
GET  /about         - System & version info
GET  /system_info   - Detailed CPU & host memory telemetry
GET  /config_info   - Default and maximum execution limits
GET  /workers       - Worker pool status
GET  /statistics    - Queue statistics
GET  /metrics       - Prometheus scrape endpoint
GET  /executor      - Sandbox executor info
```

### Languages & Statuses
```
GET  /languages      - List active supported languages
GET  /languages/all  - List all language profiles
GET  /languages/:id  - Get configuration for specific language ID (1-7)
GET  /statuses       - List all execution status codes
```

### Submissions
```
POST   /submissions                     - Create single-file submission
POST   /submissions?wait=true           - Create and wait for execution results
GET    /submissions/:token              - Retrieve submission result by token
DELETE /submissions/:token              - Remove submission from cache
POST   /submissions/batch               - Batch submit single-file runs (up to 20)
GET    /submissions/batch?tokens=t1,t2  - Batch retrieve results

POST   /submissions/multi               - Create multi-file submission
POST   /submissions/multi?wait=true     - Create multi-file submission and wait for results
POST   /submissions/multi/batch         - Batch submit multi-file submissions (up to 20)
```

---

## Quick Testing Examples

### 1. Health Check
```bash
curl http://localhost:3000/health
```

### 2. List Supported Languages
```bash
curl http://localhost:3000/languages \
  -H "X-Auth-Token: dev-token"
```

### 3. Run Single-File Python Code (Language ID: 5)
```bash
curl -X POST "http://localhost:3000/submissions?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{"source_code": "print(1 + 1)", "language_id": 5}'
```

### 4. Run Single-File JavaScript Code (Language ID: 4)
```bash
curl -X POST "http://localhost:3000/submissions?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{"source_code": "console.log(2 * 3)", "language_id": 4}'
```

### 5. Run Multi-File Java Project (Language ID: 3)
```bash
curl -X POST "http://localhost:3000/submissions/multi?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "language_id": 3,
    "files": [
      {
        "path": "Greeter.java",
        "content": "public class Greeter { public static String greet() { return \"Hello from Greeter!\"; } }"
      },
      {
        "path": "Main.java",
        "content": "public class Main { public static void main(String[] args) { System.out.println(Greeter.greet()); } }"
      }
    ],
    "executions": [
      { "entryPoint": "Main.java" }
    ]
  }'
```

### 6. Run Single-File SQLite Query (Language ID: 7)
```bash
curl -X POST "http://localhost:3000/submissions?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "source_code": "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES (\x27Alice\x27), (\x27Bob\x27); SELECT * FROM users;",
    "language_id": 7
  }'
```

### 7. Run Multi-File SQLite Project (Language ID: 7)
```bash
curl -X POST "http://localhost:3000/submissions/multi?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "language_id": 7,
    "files": [
      {
        "path": "schema.sql",
        "content": "CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, salary INT); INSERT INTO employees VALUES (1, \x27John\x27, 50000), (2, \x27Sarah\x27, 65000);"
      },
      {
        "path": "query.sql",
        "content": "SELECT name, salary FROM employees WHERE salary > 55000;"
      }
    ],
    "executions": [
      { "entryPoint": "schema.sql" },
      { "entryPoint": "query.sql" }
    ]
  }'
```
