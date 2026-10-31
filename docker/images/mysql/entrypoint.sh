#!/bin/bash
set -e

# Setup working directory, socket dir, and cluster in tmpfs (/box)
mkdir -p /box/data /box/socket
cp -a /var/lib/mysql/template/* /box/data/
chmod 700 /box/data
chmod 1777 /box/socket

# Start mysqld daemon in the background
mysqld --defaults-file=/etc/my.cnf &
DAEMON_PID=$!

# Await daemon socket readiness
while ! mysqladmin --socket=/box/socket/mysqld.sock ping 2>/dev/null; do
  if ! kill -0 $DAEMON_PID 2>/dev/null; then
    echo "ERROR: mysqld process died unexpectedly during startup" >&2
    exit 1
  fi
  sleep 0.02
done

# Signal readiness directly via filesystem marker and stdout
touch /box/.ready
echo "CODEBOX_DAEMON_READY"

# Keep container alive
exec sleep infinity

