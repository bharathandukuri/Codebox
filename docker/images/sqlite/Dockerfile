FROM alpine:3.20

# Install sqlite and bash
RUN apk add --no-cache sqlite bash

# Create non-root runner user (use UID 1001 to avoid conflicts)
RUN adduser -D -u 1001 runner

# Create working directory
RUN mkdir -p /box && chown runner:runner /box

WORKDIR /box
USER runner

CMD ["sleep", "infinity"]
