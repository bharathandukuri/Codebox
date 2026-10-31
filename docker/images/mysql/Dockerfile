FROM node:20-slim AS runner-builder

WORKDIR /opt/runner
COPY runner.js /opt/runner/runner.js
RUN npm init -y && npm install mysql2 --production && chmod -R 755 /opt/runner

FROM mysql:8.4

# Create runner user (UID 1001)
RUN useradd -u 1001 -m -s /bin/bash runner

# Copy Node.js binary and runner
COPY --from=runner-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=runner-builder /opt/runner /opt/runner

# Copy configuration
COPY my.cnf /etc/my.cnf
RUN chmod 644 /etc/my.cnf

# Initialize template database cluster under mysql (UID 999)
RUN mkdir -p /var/lib/mysql/template /var/run/mysqld && \
    chown -R mysql:mysql /var/lib/mysql /var/run/mysqld && \
    mysqld --no-defaults \
      --datadir=/var/lib/mysql/template \
      --socket=/tmp/mysqld.sock \
      --innodb-flush-method=O_DIRECT_NO_FSYNC \
      --innodb-doublewrite=0 \
      --performance-schema=OFF \
      --innodb-buffer-pool-size=32M \
      --innodb-redo-log-capacity=16M \
      --skip-networking \
      --initialize-insecure --user=mysql && \
    mysqld --no-defaults \
      --datadir=/var/lib/mysql/template \
      --socket=/tmp/mysqld.sock \
      --innodb-flush-method=O_DIRECT_NO_FSYNC \
      --innodb-doublewrite=0 \
      --performance-schema=OFF \
      --innodb-buffer-pool-size=32M \
      --innodb-redo-log-capacity=16M \
      --skip-networking \
      --user=mysql & \
    PID=$! && \
    while ! mysqladmin --socket=/tmp/mysqld.sock -u root ping 2>/dev/null; do sleep 0.05; done && \
    mysql --socket=/tmp/mysqld.sock -u root -e "\
      CREATE USER 'runner'@'localhost' IDENTIFIED BY 'codebox_runner_secret'; \
      CREATE DATABASE codebox; \
      GRANT ALL ON codebox.* TO 'runner'@'localhost'; \
      ALTER USER 'root'@'localhost' IDENTIFIED BY 'codebox_admin_secret';" && \
    mysqladmin --socket=/tmp/mysqld.sock -u root -pcodebox_admin_secret shutdown && \
    wait $PID

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /box
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

