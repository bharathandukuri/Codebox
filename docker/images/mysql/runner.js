const mysql = require('mysql2/promise');
const fs = require('fs');

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB limit
const OVERFLOW_MARKER = '\n[Output limit of 1MB exceeded]\n';

function capOutput(output) {
  if (Buffer.byteLength(output, 'utf8') <= MAX_OUTPUT_BYTES) {
    return output;
  }
  const maxContentBytes = MAX_OUTPUT_BYTES - Buffer.byteLength(OVERFLOW_MARKER, 'utf8');
  const buf = Buffer.from(output, 'utf8').subarray(0, maxContentBytes);
  return buf.toString('utf8') + OVERFLOW_MARKER;
}

function formatTable(colNames, rows) {
  if (!colNames || colNames.length === 0) return '';

  const colWidths = colNames.map(name => (name ? String(name).length : 0));

  const stringRows = rows.map(row => {
    return colNames.map((_, idx) => {
      const val = row[idx];
      let strVal = (val === null || val === undefined) ? 'NULL' : (val instanceof Date ? val.toISOString() : String(val));
      if (strVal.length > 50) {
        strVal = strVal.slice(0, 50); // Consistent cell truncation
      }
      if (strVal.length > colWidths[idx]) {
        colWidths[idx] = strVal.length;
      }
      return strVal;
    });
  });

  const header = colNames.map((col, idx) => String(col).padEnd(colWidths[idx])).join('  ');
  const separator = colWidths.map(w => '-'.repeat(Math.max(w, 1))).join('  ');
  let table = header + '\n' + separator + '\n';

  for (const row of stringRows) {
    const rowStr = row.map((cell, idx) => cell.padEnd(colWidths[idx])).join('  ');
    table += rowStr + '\n';
  }

  return table;
}

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

  // Host/runner wall-clock watchdog (exit code 124 on timeout)
  const wallTimer = setTimeout(() => {
    process.stderr.write('canceling statement due to statement timeout\n', () => {
      process.exit(124);
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
      rowsAsArray: true, // Output rows as arrays to preserve duplicate column names
      connectTimeout: 3000,
      dateStrings: true,
    });

    // Set MySQL execution timeout for SELECT statements
    await connection.query(`SET SESSION max_execution_time = ${timeoutMs};`);

    // Execute SQL text with rowsAsArray: true
    const [rawResults, rawFields] = await connection.query({ sql, rowsAsArray: true });

    clearTimeout(wallTimer);

    let output = '';

    // Normalize single vs multi-statement result shapes
    const isMulti = Array.isArray(rawResults) && (
      (rawResults.length > 0 && rawResults[0]?.constructor?.name === 'ResultSetHeader') ||
      (Array.isArray(rawFields) && rawFields.length > 0 && Array.isArray(rawFields[0]))
    );

    if (isMulti) {
      // Multi-statement: rawResults is array of statement results, rawFields is array of statement fields
      for (let i = 0; i < rawResults.length; i++) {
        const stmtResult = rawResults[i];
        const stmtFields = rawFields ? rawFields[i] : null;

        if (Array.isArray(stmtResult)) {
          // SELECT statement
          const colNames = (stmtFields || []).map(f => f.name);
          output += formatTable(colNames, stmtResult);
        } else if (stmtResult && stmtResult.affectedRows !== undefined) {
          // DML / DDL statement
          output += `Query OK, ${stmtResult.affectedRows} row${stmtResult.affectedRows === 1 ? '' : 's'} affected\n`;
        }

        if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
          output = capOutput(output);
          await connection.end().catch(() => {});
          process.stdout.write(output, () => {
            process.exit(0);
          });
          return;
        }
      }
    } else {
      // Single statement
      if (Array.isArray(rawResults)) {
        // SELECT statement
        const colNames = (rawFields || []).map(f => f.name);
        output += formatTable(colNames, rawResults);
      } else if (rawResults && rawResults.affectedRows !== undefined) {
        // DML / DDL statement
        output += `Query OK, ${rawResults.affectedRows} row${rawResults.affectedRows === 1 ? '' : 's'} affected\n`;
      }
    }

    output = capOutput(output);
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
