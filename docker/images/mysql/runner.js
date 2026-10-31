const mysql = require('mysql2/promise');
const fs = require('fs');

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB limit

async function main() {
  const filePath = process.argv[2];
  const timeoutSecs = parseFloat(process.argv[3]) || 5;

  if (!filePath || !fs.existsSync(filePath)) {
    process.stderr.write(`Error: SQL file not found: ${filePath}\n`, () => {
      process.exit(1);
    });
    return;
  }

  const sql = fs.readFileSync(filePath, 'utf-8');
  if (!sql.trim()) {
    process.exit(0);
  }

  const timeoutMs = Math.max(Math.floor(timeoutSecs * 1000), 500);

  // Hard wall-time watchdog for the runner
  const wallTimer = setTimeout(() => {
    process.stderr.write('canceling statement due to statement timeout\n', () => {
      process.exit(124); // TLE
    });
  }, timeoutMs);

  let connection = null;

  try {
    connection = await mysql.createConnection({
      user: 'runner',
      password: 'codebox_runner_secret',
      database: 'codebox',
      socketPath: '/box/socket/mysqld.sock',
      multipleStatements: true,
      connectTimeout: 3000,
      dateStrings: true,
    });

    // Set MySQL execution timeout for SELECT statements
    await connection.query(`SET SESSION max_execution_time = ${timeoutMs};`);

    // Execute multi-statement SQL text
    const [rawResults] = await connection.query(sql);

    clearTimeout(wallTimer);

    // Format output
    let output = '';
    const results = Array.isArray(rawResults) && (rawResults.length === 0 || Array.isArray(rawResults[0]) || rawResults[0]?.constructor?.name === 'ResultSetHeader')
      ? rawResults
      : [rawResults];

    for (const r of results) {
      if (!r) continue;

      if (Array.isArray(r)) {
        if (r.length === 0) continue;

        // SELECT query results
        const firstRow = r[0];
        const colNames = Object.keys(firstRow);
        const colWidths = colNames.map(name => name.length);

        const stringRows = r.map(row => {
          return colNames.map((col, idx) => {
            const val = row[col];
            const strVal = val === null || val === undefined ? 'NULL' : String(val);
            if (strVal.length > colWidths[idx]) {
              colWidths[idx] = Math.min(strVal.length, 50); // Cap column width at 50 for formatting
            }
            return strVal;
          });
        });

        // Format header
        const header = colNames.map((col, idx) => col.padEnd(colWidths[idx])).join('  ');
        const separator = colWidths.map(w => '-'.repeat(w)).join('  ');
        output += header + '\n' + separator + '\n';

        // Format rows
        for (const row of stringRows) {
          const rowStr = row.map((cell, idx) => cell.padEnd(colWidths[idx])).join('  ');
          output += rowStr + '\n';

          if (output.length > MAX_OUTPUT_BYTES) {
            output = output.substring(0, MAX_OUTPUT_BYTES - 64) + '\n[Output limit of 1MB exceeded]\n';
            await connection.end().catch(() => {});
            process.stdout.write(output, () => {
              process.exit(0);
            });
            return;
          }
        }
      } else if (r.affectedRows !== undefined) {
        // DML / DDL statement (INSERT, UPDATE, DELETE, CREATE)
        output += `Query OK, ${r.affectedRows} row${r.affectedRows === 1 ? '' : 's'} affected\n`;
      }
    }

    if (output.length > MAX_OUTPUT_BYTES) {
      output = output.substring(0, MAX_OUTPUT_BYTES - 64) + '\n[Output limit of 1MB exceeded]\n';
    }

    await connection.end().catch(() => {});
    process.stdout.write(output, () => {
      process.exit(0);
    });
  } catch (err) {
    clearTimeout(wallTimer);
    if (connection) {
      await connection.end().catch(() => {});
    }

    // ER_QUERY_TIMEOUT (code 3024) or ER_STATEMENT_TIMEOUT (code 1907)
    if (err.errno === 3024 || err.errno === 1907 || err.code === 'PROTOCOL_TIMEOUT' || err.message?.includes('exceeded')) {
      process.stderr.write('canceling statement due to statement timeout\n', () => {
        process.exit(124);
      });
      return;
    }

    process.stderr.write(`ERROR: ${err.message}\n`, () => {
      process.exit(1);
    });
  }
}

main();

