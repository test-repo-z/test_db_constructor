#!/bin/bash
# Runs once, when the MariaDB volume is first initialised (official image entrypoint).
# The entrypoint already created $MARIADB_DATABASE and $MARIADB_USER with full rights on it.
# Here we add: a separate database for integration tests, and an optional SELECT-only
# account for the web server (least privilege: the web tier can never modify history).
set -euo pipefail

mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_TEST_NAME}\` CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON \`${DB_TEST_NAME}\`.* TO '${MARIADB_USER}'@'%';
-- Read-only access to the trx-id <-> time map of transaction-precise history (npm run explore).
GRANT SELECT ON mysql.transaction_registry TO '${MARIADB_USER}'@'%';
SQL

if [ -n "${DB_WEB_PASSWORD:-}" ]; then
  mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS '${DB_WEB_USER}'@'%' IDENTIFIED BY '${DB_WEB_PASSWORD}';
GRANT SELECT ON \`${MARIADB_DATABASE}\`.* TO '${DB_WEB_USER}'@'%';
GRANT SELECT ON \`${DB_TEST_NAME}\`.* TO '${DB_WEB_USER}'@'%';
SQL
fi
