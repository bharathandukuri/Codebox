#!/bin/bash

# Build Firecracker rootfs images for each language
# These are minimal Alpine-based filesystems

set -e

ROOTFS_DIR="/var/lib/codebox/firecracker/rootfs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'
NC='\033[0m'

mkdir -p "$ROOTFS_DIR"

# Function to build a rootfs from Docker image
build_rootfs() {
    local name=$1
    local docker_image=$2
    local rootfs_path="$ROOTFS_DIR/${name}.ext4"

    if [ -f "$rootfs_path" ]; then
        echo -e "${GREEN}✓ $name rootfs already exists${NC}"
        return 0
    fi

    echo "Building $name rootfs from $docker_image..."

    # Create a container and export filesystem
    local container_id=$(docker create "$docker_image" /bin/true)

    # Create a temporary directory
    local tmp_dir=$(mktemp -d)

    # Export container filesystem
    docker export "$container_id" | tar -xf - -C "$tmp_dir"

    # Remove the container
    docker rm "$container_id" > /dev/null

    # Create ext4 filesystem image (512MB should be enough)
    dd if=/dev/zero of="$rootfs_path" bs=1M count=512 status=progress
    mkfs.ext4 -F "$rootfs_path"

    # Mount and copy files
    local mount_dir=$(mktemp -d)
    sudo mount -o loop "$rootfs_path" "$mount_dir"
    sudo cp -a "$tmp_dir"/* "$mount_dir"/

    # Create necessary directories
    sudo mkdir -p "$mount_dir"/{box,tmp,proc,sys,dev}
    sudo chmod 1777 "$mount_dir"/tmp
    sudo mkdir -p "$mount_dir"/box
    sudo chmod 777 "$mount_dir"/box

    # Create runner user in the rootfs
    echo "runner:x:1001:1001:Runner:/home/runner:/bin/sh" | sudo tee -a "$mount_dir"/etc/passwd > /dev/null
    echo "runner:x:1001:" | sudo tee -a "$mount_dir"/etc/group > /dev/null
    sudo mkdir -p "$mount_dir"/home/runner
    sudo chown 1001:1001 "$mount_dir"/home/runner "$mount_dir"/box

    # Unmount and cleanup
    sudo umount "$mount_dir"
    rmdir "$mount_dir"
    rm -rf "$tmp_dir"

    echo -e "${GREEN}✓ $name rootfs created${NC}"
}

# First, ensure Docker images are built
echo "Ensuring Docker images are built..."
"$PROJECT_DIR/scripts/build-images.sh"

echo ""
echo "Building Firecracker rootfs images..."
echo ""

# Build rootfs for each language
build_rootfs "python" "codebox/python:3.8"
build_rootfs "node" "codebox/node:18"
build_rootfs "gcc" "codebox/gcc:9"
build_rootfs "java" "codebox/java:17"
build_rootfs "typescript" "codebox/typescript:5"
build_rootfs "sqlite" "codebox/sqlite:3"

echo ""
echo -e "${GREEN}All rootfs images built successfully!${NC}"
echo ""
echo "Images location: $ROOTFS_DIR"
ls -lh "$ROOTFS_DIR"
