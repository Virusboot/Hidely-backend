#!/bin/bash
set -e

WORKSPACE_DIR="/Users/harshbhardwaj/Desktop/Harsh/Apps/Hidely_new"
TOOLS_DIR="$WORKSPACE_DIR/.local_tools"
NODE_BIN="$TOOLS_DIR/node/bin"
PG_BIN="$TOOLS_DIR/postgres/16/bin"
DATA_DIR="$TOOLS_DIR/data"

# Add local tools to PATH
export PATH="$NODE_BIN:$PG_BIN:$PATH"

echo "Using Node.js from: $NODE_BIN"
echo "Using PostgreSQL from: $PG_BIN"

# Ensure local PostgreSQL is running
if ! pg_ctl -D "$DATA_DIR" status > /dev/null 2>&1; then
    echo "Starting local PostgreSQL server..."
    pg_ctl -D "$DATA_DIR" -l "$DATA_DIR/logfile" -o "-p 5432 -h localhost" start
    sleep 3
else
    echo "PostgreSQL is already running."
fi

# Verify Node.js and npm work
node -v
npm -v

# Run the backend dev server
echo "Starting backend dev server..."
npm run dev
