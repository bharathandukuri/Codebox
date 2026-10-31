#!/bin/bash

# Build all language runtime images

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Building from: $PROJECT_DIR"
echo ""

echo "Building Python 3.8 image..."
docker build -t codebox/python:3.8 "$PROJECT_DIR/docker/images/python/"

echo "Building Node.js 18 image..."
docker build -t codebox/node:18 "$PROJECT_DIR/docker/images/node/"

echo "Building GCC 9 image..."
docker build -t codebox/gcc:9 "$PROJECT_DIR/docker/images/gcc/"

echo "Building Java 17 image..."
docker build -t codebox/java:17 "$PROJECT_DIR/docker/images/java/"

echo "Building TypeScript 5 image..."
docker build -t codebox/typescript:5 "$PROJECT_DIR/docker/images/typescript/"

echo "Building SQLite 3 image..."
docker build -t codebox/sqlite:3 "$PROJECT_DIR/docker/images/sqlite/"

echo "Building PostgreSQL 16 image..."
docker build -t codebox/postgres:16 "$PROJECT_DIR/docker/images/postgres/"

echo "Building MySQL 8.4 LTS image..."
docker build -t codebox/mysql:8.4 "$PROJECT_DIR/docker/images/mysql/"

echo "Building Multi-runtime image..."
docker build -t codebox/multi:latest "$PROJECT_DIR/docker/images/multi/"

echo ""
echo "All images built successfully!"
echo ""
echo "Images:"
docker images | grep codebox
