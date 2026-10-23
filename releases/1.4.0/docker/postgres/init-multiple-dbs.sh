#!/bin/bash
# ==============================================================================
# Cria múltiplos bancos de dados no PostgreSQL durante a inicialização
# ==============================================================================

set -e
set -u

function create_user_and_database() {
  local database=$1
  echo "  Creating database '$database'"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE "$database";
    GRANT ALL PRIVILEGES ON DATABASE "$database" TO "$POSTGRES_USER";
EOSQL
}

if [ -n "$POSTGRES_MULTIPLE_DATABASES" ]; then
  echo "Multiple database creation requested: $POSTGRES_MULTIPLE_DATABASES"
  for db in $(echo $POSTGRES_MULTIPLE_DATABASES | tr ',' ' '); do
    # Skip if it's the default database (already created)
    if [ "$db" != "$POSTGRES_DB" ] && [ "$db" != "$POSTGRES_USER" ]; then
      create_user_and_database $db
    fi
  done
  echo "Multiple databases created"
fi
