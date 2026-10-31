#!/bin/bash
set -e

# Setup working directory, socket dir, and cluster in tmpfs (/box)
mkdir -p /box/data /box/socket
cp -a /var/lib/postgresql/template/* /box/data/
chmod 700 /box/data
chmod 1777 /box/socket

# Start PostgreSQL daemon in the background with -w (waits for startup)
pg_ctl -D /box/data -o "-k /box/socket" -l /box/postgres.log -w start

# Signal readiness directly via filesystem marker and stdout
touch /box/.ready
echo "CODEBOX_DAEMON_READY"

# Keep container alive
exec sleep infinity
