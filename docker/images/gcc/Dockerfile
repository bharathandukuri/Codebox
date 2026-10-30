FROM gcc:9

# Create non-root user (use UID 1001 to avoid conflicts)
RUN useradd -m -u 1001 -s /bin/bash runner

# Create working directory
RUN mkdir -p /box && chown runner:runner /box

# Install additional tools.
# gcc:9 is based on Debian Bullseye. Debian moved bullseye and bullseye-security
# package updates to archive.debian.org, so deb.debian.org returns 404 for updates.
RUN sed -i 's|deb.debian.org/debian-security|archive.debian.org/debian-security|g' /etc/apt/sources.list \
    && sed -i 's|deb.debian.org/debian|archive.debian.org/debian|g' /etc/apt/sources.list \
    && sed -i '/bullseye-updates/d' /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
    time \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /box

# Switch to non-root user
USER runner

# Keep container alive (will be overridden at runtime)
CMD ["sleep", "infinity"]
