#!/bin/bash
# Build Docker image using LOCAL openclaw source (for development/testing).
# Usage: ./build-local.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_DIR="${SCRIPT_DIR}/../openclaw"

if [ ! -d "$OPENCLAW_DIR/src" ]; then
  echo "ERROR: Expected openclaw repo at $OPENCLAW_DIR"
  exit 1
fi

# Create a temp build context with just what we need
BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

echo "=== Assembling build context ==="

# Copy openclaw source (exclude node_modules, .git, dist to keep it fast)
rsync -a --exclude='node_modules' --exclude='.git' --exclude='dist' \
  "$OPENCLAW_DIR/" "$BUILD_DIR/openclaw/"

# Copy railway template files
cp "$SCRIPT_DIR/package.json" "$BUILD_DIR/"
cp -r "$SCRIPT_DIR/src" "$BUILD_DIR/src"

# Write a Dockerfile into the build context
cat > "$BUILD_DIR/Dockerfile" << 'DOCKERFILE'
FROM node:22-bookworm AS openclaw-build

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /openclaw
COPY openclaw/ .

RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build

# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install && npm cache clean --force

COPY --from=openclaw-build /openclaw /openclaw

RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src

ENV OPENCLAW_BUNDLED_PLUGINS_DIR=/openclaw/extensions
ENV OPENCLAW_PUBLIC_PORT=8080
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
DOCKERFILE

echo "=== Building Docker image ==="
docker build -t clawdbot-pool-test "$BUILD_DIR"
echo "=== Done ==="
