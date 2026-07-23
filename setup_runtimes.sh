#!/bin/bash
set -e

WORKSPACE_DIR="/Users/harshbhardwaj/Desktop/Harsh/Apps/Hidely_new"
TOOLS_DIR="$WORKSPACE_DIR/.local_tools"
TEMP_DIR="$TOOLS_DIR/temp"

echo "Creating tools directory..."
mkdir -p "$TOOLS_DIR"
mkdir -p "$TEMP_DIR"

cd "$TEMP_DIR"

# 1. Download and set up Node.js
if [ ! -d "$TOOLS_DIR/node" ]; then
    echo "Downloading Node.js v20.15.1..."
    curl -L -o node.tar.gz "https://nodejs.org/dist/v20.15.1/node-v20.15.1-darwin-x64.tar.gz"
    
    echo "Extracting Node.js..."
    mkdir -p "$TOOLS_DIR/node"
    tar -xzf node.tar.gz -C "$TOOLS_DIR/node" --strip-components=1
    echo "Node.js installed locally at $TOOLS_DIR/node"
else
    echo "Node.js is already installed locally."
fi

# 2. Download and set up PostgreSQL
if [ ! -d "$TOOLS_DIR/postgres" ]; then
    echo "Downloading Postgres.app v2.9.5 (with PG 16)..."
    curl -L -o postgres.dmg "https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.5/Postgres-2.9.5-16.dmg"
    
    echo "Mounting Postgres DMG..."
    # Mount DMG and capture the mount point path
    MOUNT_INFO=$(hdiutil attach -nobrowse -readonly postgres.dmg)
    # The last line/column typically contains the mount path under /Volumes/
    MOUNT_POINT=$(echo "$MOUNT_INFO" | grep -o '/Volumes/Postgres-[^[:space:]]*' | head -n 1)
    
    if [ -z "$MOUNT_POINT" ]; then
        echo "Failed to identify mount point. Trying wildcard..."
        MOUNT_POINT="/Volumes/Postgres-2.9.5-16"
    fi
    
    echo "Mount point: $MOUNT_POINT"
    
    echo "Copying PostgreSQL binaries..."
    mkdir -p "$TOOLS_DIR/postgres"
    cp -R "$MOUNT_POINT/Postgres.app/Contents/Versions/16" "$TOOLS_DIR/postgres/"
    
    echo "Detaching DMG..."
    hdiutil detach "$MOUNT_POINT" || hdiutil detach -force "$MOUNT_POINT"
    echo "PostgreSQL binaries installed locally at $TOOLS_DIR/postgres/16"
else
    echo "PostgreSQL is already installed locally."
fi

# Clean up
echo "Cleaning up temp files..."
cd "$WORKSPACE_DIR"
rm -rf "$TEMP_DIR"

echo "--------------------------------------------------------"
echo "Local tools download and configuration complete!"
echo "Node.js binary: $TOOLS_DIR/node/bin/node"
echo "PostgreSQL bin: $TOOLS_DIR/postgres/16/bin/postgres"
echo "--------------------------------------------------------"
