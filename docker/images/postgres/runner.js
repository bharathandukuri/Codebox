const pg = require('pg');
const fs = require('fs');

const { Client } = pg;

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB limit

async function main() {
  const filePath = process.argv[2];
  const timeoutSecs = parseFloat(process.argv[3]) || 5;

  if (!filePath || !fs.existsSync(filePath)) {
    process.stderr.write(`Error: SQL file not found: ${filePath}\n`);
    process.exit(1);
  }

  const sql = fs.readFileSync(filePath, 'utf-8');
  if (!sql.trim()) {
    process.exit(0);
  }

  const client = new Client({
    user: 'runner',
    password: 'codebox_runner_secret',
    database: 'codebox',
    host: '/box/socket', // Unix domain socket directory
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();

    // Set statement timeout in milliseconds
    const timeoutMs = Math.max(Math.floor(timeoutSecs * 1000), 500);
    await client.query(`SET statement_timeout = ${timeoutMs};`);

    // Execute multi-statement SQL text
    const res = await client.query(sql);

    // Format output
    let output = '';
    const results = Array.isArray(res) ? res : [res];

    for (const r of results) {
      if (!r) continue;

      if (r.fields && r.fields.length > 0 && r.rows) {
        // Tabular output (like psql -A / psql -c)
        const colNames = r.fields.map(f => f.name);
        const colWidths = colNames.map(name => name.length);

        // Calculate max column widths
        const stringRows = r.rows.map(row => {
          return colNames.map((col, idx) => {
            const val = row[col];
            const strVal = val === null ? '' : (val instanceof Date ? val.toISOString() : String(val));
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
            await client.end().catch(() => {});
            process.stdout.write(output, () => {
              process.exit(0);
            });
            return;
          }
        }
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
    }

    if (output.length > MAX_OUTPUT_BYTES) {
      output = output.substring(0, MAX_OUTPUT_BYTES - 64) + '\n[Output limit of 1MB exceeded]\n';
    }

    await client.end().catch(() => {});
    process.stdout.write(output, () => {
      process.exit(0);
    });
  } catch (err) {
    await client.end().catch(() => {});

    // Code 57014 is PostgreSQL's query_canceled (statement_timeout)
    if (err.code === '57014') {
      process.stderr.write('canceling statement due to statement timeout\n', () => {
        process.exit(124); // Standard exit code for timeout
      });
      return;
    }

    process.stderr.write(`ERROR: ${err.message}\n`, () => {
      process.exit(1);
    });
  }
}

main();
