import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token';

const headers = {
  'Content-Type': 'application/json',
  'X-Auth-Token': AUTH_TOKEN,
};

describe('CodeBox API', () => {
  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.status, 'healthy');
    });
  });

  describe('Languages', () => {
    it('should list active languages', async () => {
      const res = await fetch(`${BASE_URL}/languages`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(Array.isArray(data));
      assert.strictEqual(data.length, 9);
      assert(data.some(l => l.id === 5)); // Python (ID 5)
      assert(data.some(l => l.id === 7)); // SQLite (ID 7)
      assert(data.some(l => l.id === 8)); // PostgreSQL (ID 8)
      assert(data.some(l => l.id === 9)); // MySQL (ID 9)
    });

    it('should get language by ID', async () => {
      const res = await fetch(`${BASE_URL}/languages/5`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.id, 5);
      assert(data.name.includes('Python'));
    });

    it('should return 404 for unknown language', async () => {
      const res = await fetch(`${BASE_URL}/languages/999`, { headers });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('Statuses', () => {
    it('should list all statuses', async () => {
      const res = await fetch(`${BASE_URL}/statuses`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(Array.isArray(data));
      assert(data.some(s => s.id === 3 && s.description === 'Accepted'));
    });
  });

  describe('Submissions (/submissions)', () => {
    let submissionToken;

    it('should create a Python submission', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'print("Hello, World!")',
          language_id: 5,
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(data.token);
      submissionToken = data.token;
    });

    it('should get submission by token', async () => {
      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      const res = await fetch(`${BASE_URL}/submissions/${submissionToken}`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.token, submissionToken);
      assert(data.status);
    });

    it('should create submission with wait=true', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'print(1 + 1)',
          language_id: 5,
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(data.token);
      assert(data.status);
      if (data.status.id === 3) {
        assert(data.stdout.includes('2'));
      }
    });

    it('should validate required fields', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 5,
        }),
      });

      assert.strictEqual(res.status, 422);
    });

    it('should validate language_id', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'print("test")',
          language_id: 9999,
        }),
      });

      assert.strictEqual(res.status, 422);
    });
  });

  describe('Batch Submissions', () => {
    it('should create batch submissions', async () => {
      const res = await fetch(`${BASE_URL}/submissions/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          submissions: [
            { source_code: 'print(1)', language_id: 5 },
            { source_code: 'print(2)', language_id: 5 },
          ],
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(Array.isArray(data));
      assert.strictEqual(data.length, 2);
      assert(data[0].token);
      assert(data[1].token);
    });
  });

  describe('Multi-File Submissions', () => {
    it('should create a multi-file Python submission with wait=true', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 5,
          files: [
            { path: 'helper.py', content: 'def greet():\n    return "Hello from helper"' },
            { path: 'main.py', content: 'from helper import greet\nprint(greet())' },
            { path: 'test.py', content: 'print("Testing 123")' },
          ],
          executions: [
            { entryPoint: 'main.py' },
            { entryPoint: 'test.py' },
          ],
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(data.token);
      assert.strictEqual(data.type, 'multi');
      assert(Array.isArray(data.executions));
      assert.strictEqual(data.executions.length, 2);
    });

    it('should validate multi-file missing required fields', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 5,
          // Missing files and executions
        }),
      });

      assert.strictEqual(res.status, 422);
    });

    it('should reject path traversal in multi-file paths', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 5,
          files: [
            { path: '../evil.py', content: 'print("exploit")' },
          ],
          executions: [
            { entryPoint: 'evil.py' },
          ],
        }),
      });

      assert.strictEqual(res.status, 422);
    });

    it('should reject absolute paths in multi-file paths', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 5,
          files: [
            { path: '/etc/passwd.py', content: 'print("exploit")' },
          ],
          executions: [
            { entryPoint: 'passwd.py' },
          ],
        }),
      });

      assert.strictEqual(res.status, 422);
    });

    it('should create batch multi-file submissions', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          submissions: [
            {
              language_id: 5,
              files: [{ path: 'main.py', content: 'print(1)' }],
              executions: [{ entryPoint: 'main.py' }],
            },
            {
              language_id: 5,
              files: [{ path: 'main.py', content: 'print(2)' }],
              executions: [{ entryPoint: 'main.py' }],
            },
          ],
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(Array.isArray(data));
      assert.strictEqual(data.length, 2);
      assert(data[0].token);
      assert(data[1].token);
    });
  });

  describe('SQLite Execution (Language ID: 7)', () => {
    it('should execute single-file SQLite query', async () => {
      const sql = "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('apple'), ('banana'); SELECT * FROM items;";
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: sql,
          language_id: 7,
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('apple'));
      assert(data.stdout.includes('banana'));
    });

    it('should execute multi-file SQLite project with state persistence across executions', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 7,
          files: [
            {
              path: 'schema.sql',
              content: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);\nINSERT INTO users (email) VALUES ('alice@example.com');",
            },
            {
              path: 'query.sql',
              content: 'SELECT * FROM users;',
            },
          ],
          executions: [
            { entryPoint: 'schema.sql' },
            { entryPoint: 'query.sql' },
          ],
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert.strictEqual(data.executions.length, 2);
      assert.strictEqual(data.executions[0].status.id, 3);
      assert.strictEqual(data.executions[1].status.id, 3);
      assert(data.executions[1].stdout.includes('alice@example.com'));
    });

    it('should support SQLite with timelimit and no memory_limit', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 7,
          timelimit: 5,
          source_code: "CREATE TABLE t (v INT); INSERT INTO t VALUES (100); SELECT * FROM t;",
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert.strictEqual(data.memory, null);
      assert(data.stdout.includes('100'));
    });

    it('should enforce time_limit for long-running SQLite queries (TLE)', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 7,
          time_limit: 1,
          source_code: "WITH RECURSIVE r(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM r WHERE i < 100000000) SELECT count(*) FROM r;",
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 5); // Time Limit Exceeded
    });

    it('should reject dangerous SQLite statements', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: '.shell whoami',
          language_id: 7,
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.status.id, 6);
      assert(data.compile_output.includes('Rejected'));
    });
  });

  describe('PostgreSQL Execution (Language ID: 8)', () => {
    it('should execute single-file PostgreSQL query', async () => {
      const sql = "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('Alice'), ('Bob'); SELECT * FROM users;";
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: sql,
          language_id: 8,
          time_limit: 5,
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('Alice'));
      assert(data.stdout.includes('Bob'));
    });

    it('should execute multi-file PostgreSQL project with state persistence', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 8,
          time_limit: 5,
          files: [
            {
              path: 'schema.sql',
              content: "CREATE TABLE depts (id INT, dept_name TEXT); INSERT INTO depts VALUES (1, 'Engineering'), (2, 'Finance');",
            },
            {
              path: 'query.sql',
              content: "SELECT * FROM depts WHERE id = 1;",
            },
          ],
          executions: [
            { entryPoint: 'schema.sql' },
            { entryPoint: 'query.sql' },
          ],
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert.strictEqual(data.executions.length, 2);
      assert.strictEqual(data.executions[0].status.id, 3);
      assert.strictEqual(data.executions[1].status.id, 3);
      assert(data.executions[1].stdout.includes('Engineering'));
    });

    it('should enforce statement_timeout on long-running PostgreSQL queries (TLE)', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 8,
          time_limit: 1,
          source_code: "SELECT pg_sleep(5);",
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 5); // Time Limit Exceeded
    });

    it('should reject dangerous PostgreSQL statements in code analyzer', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: '\\! whoami',
          language_id: 8,
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.status.id, 6);
      assert(data.compile_output.includes('Rejected'));
    });

    it('should enforce 1MB output cap on large SELECT result sets', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 8,
          time_limit: 5,
          source_code: "SELECT generate_series(1, 100000);",
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('[Output limit of 1MB exceeded]'));
    });

    it('should preserve duplicate column names in PostgreSQL output', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'SELECT 1 AS id, 2 AS id;',
          language_id: 8,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('id') && data.stdout.includes('1') && data.stdout.includes('2'));
    });

    it('should format empty SELECT result set with headers in PostgreSQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'SELECT 1 AS num WHERE 1 = 0;',
          language_id: 8,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('num') && data.stdout.includes('---'));
    });

    it('should render NULL as NULL in PostgreSQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: "SELECT NULL AS null_col, 'val' AS not_null;",
          language_id: 8,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('NULL'));
      assert(data.stdout.includes('val'));
    });

    it('should handle multi-statement scripts in PostgreSQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: `
            CREATE TABLE t_multi (x INT);
            INSERT INTO t_multi VALUES (10), (20);
            SELECT * FROM t_multi ORDER BY x;
          `,
          language_id: 8,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('10') && data.stdout.includes('20'));
    });

    it('should reject COPY ... PROGRAM attempts in PostgreSQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: "COPY (SELECT 1) TO PROGRAM 'whoami';",
          language_id: 8,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert(data.status.id === 6 || data.status.id === 11);
    });

    it('should enforce TLE on infinite loop recursive CTE in PostgreSQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'WITH RECURSIVE loop AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM loop) SELECT * FROM loop;',
          language_id: 8,
          time_limit: 1,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 5); // TLE
    });

    it('should enforce TLE even when user resets statement_timeout=0 in PostgreSQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: "SET statement_timeout = 0; SELECT pg_sleep(4);",
          language_id: 8,
          time_limit: 1,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 5); // TLE via runner watchdog or host grace kill
    });

    it('should safely handle tmpfs fill attempts in PostgreSQL without leaking containers', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: "CREATE TABLE fill (data TEXT); ALTER TABLE fill ALTER COLUMN data SET STORAGE EXTERNAL; INSERT INTO fill SELECT repeat('x', 10000000) FROM generate_series(1, 40);",
          language_id: 8,
          time_limit: 5,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert(data.status.id !== 3);
    });

    it('should handle 20-request burst on PostgreSQL (Language ID: 8)', async () => {
      const burst = Array.from({ length: 20 }, (_, i) =>
        fetch(`${BASE_URL}/submissions?wait=true`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source_code: `SELECT ${i} AS burst_idx;`,
            language_id: 8,
          }),
        }).then(r => r.json())
      );

      const results = await Promise.all(burst);
      assert.strictEqual(results.length, 20);
      for (let i = 0; i < 20; i++) {
        assert.strictEqual(results[i].status.id, 3);
        assert(results[i].stdout.includes(String(i)));
      }
    });
  });

  describe('MySQL Execution (Language ID: 9)', () => {
    it('should execute single-file MySQL query', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: `
            CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), age INT);
            INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25);
            SELECT * FROM users ORDER BY id;
          `,
          language_id: 9,
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.status.id, 3); // Accepted
      assert(data.stdout.includes('Alice'));
      assert(data.stdout.includes('Bob'));
      assert(data.stdout.includes('30'));
    });

    it('should execute multi-file MySQL project with state persistence', async () => {
      const res = await fetch(`${BASE_URL}/submissions/multi?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 9,
          files: [
            {
              path: 'schema.sql',
              content: `
                CREATE TABLE departments (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50));
                INSERT INTO departments (name) VALUES ('Engineering'), ('Design');
              `,
            },
            {
              path: 'query.sql',
              content: 'SELECT * FROM departments ORDER BY id;',
            },
          ],
          executions: [
            { entryPoint: 'schema.sql' },
            { entryPoint: 'query.sql' },
          ],
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.status.id, 3);
      assert.strictEqual(data.executions.length, 2);
      assert.strictEqual(data.executions[0].status.id, 3);
      assert.strictEqual(data.executions[1].status.id, 3);
      assert(data.executions[1].stdout.includes('Engineering'));
    });

    it('should enforce statement_timeout on long-running MySQL queries (TLE)', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 9,
          time_limit: 1,
          source_code: "SELECT SLEEP(5);",
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 5); // Time Limit Exceeded
    });

    it('should reject dangerous MySQL statements in code analyzer', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: '\\! whoami',
          language_id: 9,
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.status.id, 6);
      assert(data.compile_output.includes('Rejected'));
    });

    it('should enforce 1MB output cap on large SELECT result sets', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 9,
          time_limit: 5,
          source_code: "SET SESSION cte_max_recursion_depth = 200000; WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 150000) SELECT * FROM cte;",
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('[Output limit of 1MB exceeded]'));
    });

    it('should preserve duplicate column names in MySQL output', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'SELECT 1 AS id, 2 AS id;',
          language_id: 9,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('id') && data.stdout.includes('1') && data.stdout.includes('2'));
    });

    it('should format empty SELECT result set with headers in MySQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'SELECT 1 AS num WHERE 1 = 0;',
          language_id: 9,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('num') && data.stdout.includes('---'));
    });

    it('should render NULL as NULL in MySQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: "SELECT NULL AS null_col, 'val' AS not_null;",
          language_id: 9,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('NULL'));
      assert(data.stdout.includes('val'));
    });

    it('should handle multi-statement scripts in MySQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: `
            CREATE TABLE t_multi_m (x INT);
            INSERT INTO t_multi_m VALUES (10), (20);
            SELECT * FROM t_multi_m ORDER BY x;
          `,
          language_id: 9,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 3);
      assert(data.stdout.includes('10') && data.stdout.includes('20'));
    });

    it('should enforce TLE on infinite loop in MySQL', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: "SELECT BENCHMARK(1000000000, MD5('test'));",
          language_id: 9,
          time_limit: 1,
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 201);
      assert.strictEqual(data.status.id, 5); // TLE
    });

    it('should reject time_limit <= 0 with 422', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'SELECT 1;',
          language_id: 9,
          time_limit: 0,
        }),
      });
      assert.strictEqual(res.status, 422);
    });

    it('should reject time_limit exceeding language max_time_limit with 422', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'SELECT 1;',
          language_id: 9,
          time_limit: 35,
        }),
      });
      assert.strictEqual(res.status, 422);
      const data = await res.json();
      assert(data.message.includes('must be less than or equal to') || data.message.includes('exceeds maximum allowed'));
    });

    it('should reject multi-file submission exceeding total wall-time budget with 422', async () => {
      const executions = Array.from({ length: 15 }, () => ({
        entryPoint: 'query.sql',
        time_limit: 5,
      }));
      const res = await fetch(`${BASE_URL}/submissions/multi`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 9,
          files: [{ path: 'query.sql', content: 'SELECT 1;' }],
          executions,
        }),
      });
      assert.strictEqual(res.status, 422);
      const data = await res.json();
      assert(data.message.includes('budget') && data.message.includes('exceeds'));
    });
  });

  describe('Authentication & Security', () => {
    it('should reject requests without auth token on protected routes', async () => {
      const res = await fetch(`${BASE_URL}/languages`);
      assert.strictEqual(res.status, 401);
    });

    it('should reject requests with invalid auth token', async () => {
      const res = await fetch(`${BASE_URL}/languages`, {
        headers: {
          'X-Auth-Token': 'invalid-token-12345',
        },
      });
      assert.strictEqual(res.status, 401);
    });

    it('should reject SSRF attempts in callback_url', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'print(1)',
          language_id: 5,
          callback_url: 'http://169.254.169.254/latest/meta-data',
        }),
      });

      assert.strictEqual(res.status, 422);
    });
  });

  describe('Delete Submission', () => {
    it('should return 404 when deleting non-existent submission', async () => {
      const res = await fetch(`${BASE_URL}/submissions/non-existent-token-1234`, {
        method: 'DELETE',
        headers,
      });

      assert.strictEqual(res.status, 404);
    });
  });

  describe('System Info', () => {
    it('should return about info', async () => {
      const res = await fetch(`${BASE_URL}/about`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(data.version);
    });

    it('should return config info', async () => {
      const res = await fetch(`${BASE_URL}/config_info`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(data.max_cpu_time_limit);
      assert(data.max_memory_limit);
    });

    it('should return system info', async () => {
      const res = await fetch(`${BASE_URL}/system_info`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(data.system);
      assert(data.cpu);
      assert(data.memory);
    });
  });
});
