#!/bin/bash
set -e

WORKSPACE_DIR="/Users/harshbhardwaj/Desktop/Harsh/Apps/Hidely_new"
TOOLS_DIR="$WORKSPACE_DIR/.local_tools"
DATA_DIR="$TOOLS_DIR/data"
PG_BIN="$TOOLS_DIR/postgres/16/bin"

# Export PostgreSQL bin to PATH
export PATH="$PG_BIN:$PATH"

echo "Using PostgreSQL binaries from: $PG_BIN"

# 1. Initialize DB cluster if not exists
if [ ! -d "$DATA_DIR" ]; then
    echo "Initializing new database cluster in $DATA_DIR..."
    initdb -D "$DATA_DIR" -U harshbhardwaj --auth-host=trust --auth-local=trust
else
    echo "Database cluster already initialized."
fi

# 2. Check if Postgres is already running, if not start it
if ! pg_ctl -D "$DATA_DIR" status > /dev/null 2>&1; then
    echo "Starting PostgreSQL server locally on port 5432..."
    pg_ctl -D "$DATA_DIR" -l "$DATA_DIR/logfile" -o "-p 5432 -h localhost" start
    sleep 3
else
    echo "PostgreSQL server is already running."
fi

# 3. Create the database if it doesn't exist
echo "Checking if database 'hidely' exists..."
if ! psql -p 5432 -h localhost -U harshbhardwaj -lqt | cut -d \| -f 1 | grep -qw hidely; then
    echo "Creating database 'hidely'..."
    createdb -p 5432 -h localhost -U harshbhardwaj hidely
else
    echo "Database 'hidely' already exists."
fi

# 4. Import consolidated schema
echo "Applying database schema..."
psql -p 5432 -h localhost -U harshbhardwaj -d hidely -f "$WORKSPACE_DIR/backend/src/models/consolidated_schema.sql"

# 5. Import default seeds
echo "Seeding default data (wonders)..."
psql -p 5432 -h localhost -U harshbhardwaj -d hidely -f "$WORKSPACE_DIR/backend/src/models/seedWonders.sql"

echo "--------------------------------------------------------"
echo "PostgreSQL initialization complete and running!"
echo "--------------------------------------------------------"
