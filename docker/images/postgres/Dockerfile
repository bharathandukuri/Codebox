FROM alpine:3.20

# Install postgresql16, bash, su-exec, nodejs, npm
RUN apk add --no-cache postgresql16 postgresql16-contrib bash su-exec nodejs npm

# Create runner user (UID 1001)
RUN adduser -D -u 1001 -s /bin/bash runner

# Prepare runner directory and install pg driver
WORKDIR /opt/runner
COPY runner.js /opt/runner/runner.js
RUN npm init -y && npm install pg --production && chmod -R 755 /opt/runner

# Initialize template database cluster under postgres (UID 70)
RUN mkdir -p /var/lib/postgresql/template && \
    chown -R postgres:postgres /var/lib/postgresql && \
    echo "codebox_admin_secret" > /tmp/pw.txt && \
    chown postgres:postgres /tmp/pw.txt && \
    su-exec postgres initdb -D /var/lib/postgresql/template \
      --auth=scram-sha-256 \
      --username=postgres \
      --pwfile=/tmp/pw.txt && \
    rm /tmp/pw.txt

# Configure postgresql.conf for sandbox execution
RUN echo "listen_addresses = ''" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "unix_socket_directories = '/box/socket'" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "fsync = off" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "synchronous_commit = off" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "full_page_writes = off" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "shared_buffers = 32MB" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "max_connections = 15" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "autovacuum = off" >> /var/lib/postgresql/template/postgresql.conf && \
    echo "logging_collector = off" >> /var/lib/postgresql/template/postgresql.conf

# Configure pg_hba.conf
# runner connects to 'codebox' via scram-sha-256
# postgres connects to all via scram-sha-256
RUN echo "local codebox runner scram-sha-256" > /var/lib/postgresql/template/pg_hba.conf && \
    echo "local all postgres scram-sha-256" >> /var/lib/postgresql/template/pg_hba.conf && \
    echo "local all all reject" >> /var/lib/postgresql/template/pg_hba.conf

# Boot temporary cluster to create database and unprivileged runner user
RUN su-exec postgres pg_ctl -D /var/lib/postgresql/template -o "-k /tmp" start -w && \
    PGPASSWORD=codebox_admin_secret psql -h /tmp -U postgres -d postgres -c "CREATE USER runner WITH PASSWORD 'codebox_runner_secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;" && \
    PGPASSWORD=codebox_admin_secret psql -h /tmp -U postgres -d postgres -c "CREATE DATABASE codebox OWNER runner;" && \
    PGPASSWORD=codebox_admin_secret psql -h /tmp -U postgres -d postgres -c "REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC, runner;" && \
    PGPASSWORD=codebox_admin_secret psql -h /tmp -U postgres -d codebox -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO runner;" && \
    su-exec postgres pg_ctl -D /var/lib/postgresql/template stop -w

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /box
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
