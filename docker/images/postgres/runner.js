const pg = require('pg');
const fs = require('fs');

const { Client } = pg;

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

  const client = new Client({
    user: 'runner',
    password: 'codebox_runner_secret',
    database: 'codebox',
    host: '/box/socket', // Unix domain socket directory
    connectionTimeoutMillis: 3000,
  });

  // Host/runner wall-clock watchdog (exit code 124 on timeout)
  const wallTimer = setTimeout(() => {
    client.end().catch(() => {});
    process.stderr.write('canceling statement due to statement timeout\n', () => {
      process.exit(124);
    });
  }, timeoutMs);

  try {
    await client.connect();

    // Set PostgreSQL statement timeout in milliseconds
    await client.query(`SET statement_timeout = ${timeoutMs};`);

    // Execute multi-statement SQL text with rowMode: 'array'
    // Preserves duplicate column names and accurate indices
    const res = await client.query({ text: sql, rowMode: 'array' });

    clearTimeout(wallTimer);

    // Format output
    let output = '';
    const results = Array.isArray(res) ? res : [res];

    for (const r of results) {
      if (!r) continue;

      if (r.fields && r.fields.length > 0) {
        // Tabular output (preserves duplicate column names, prints header for 0 rows, NULL as NULL)
        const colNames = r.fields.map(f => f.name);
        output += formatTable(colNames, r.rows || []);
      } else if (r.command) {
        // Non-SELECT statements (INSERT, CREATE TABLE, etc.)
        if (r.command === 'INSERT') {
          output += `INSERT 0 ${r.rowCount || 0}\n`;
        } else if (r.rowCount !== null && r.rowCount !== undefined && r.command !== 'SELECT') {
          output += `${r.command} ${r.rowCount}\n`;
        } else {
          output += `${r.command}\n`;
        }
      }

      if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
        output = capOutput(output);
        await client.end().catch(() => {});
        process.stdout.write(output, () => {
          process.exit(0);
        });
        return;
      }
    }

    output = capOutput(output);
    await client.end().catch(() => {});
    process.stdout.write(output, () => {
      process.exit(0);
    });
  } catch (err) {
    clearTimeout(wallTimer);
    await client.end().catch(() => {});

    // Code 57014 is PostgreSQL's query_canceled (statement_timeout)
    if (err.code === '57014') {
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
