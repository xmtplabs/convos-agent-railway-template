#!/bin/bash
# Test script for pool mode
# Usage: ./test-pool-mode.sh
#
# Prerequisites:
#   - Docker image built: docker build -t clawdbot-pool-test .
#   - An LLM API key set in environment:
#     ANTHROPIC_API_KEY=sk-ant-...  (default, uses Claude)
#     OPENAI_API_KEY=sk-...         (uses GPT)

set -e

POOL_API_KEY="test-pool-secret-123"
CONTAINER_NAME="clawdbot-pool-test"
PORT=8080

# Detect which API key is available (prefer Anthropic)
if [ -n "$ANTHROPIC_API_KEY" ]; then
  AUTH_CHOICE="apiKey"
  ENV_FLAG="-e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  echo "Using Anthropic API key (Claude)"
elif [ -n "$OPENAI_API_KEY" ]; then
  AUTH_CHOICE="openai-api-key"
  ENV_FLAG="-e OPENAI_API_KEY=$OPENAI_API_KEY"
  echo "Using OpenAI API key"
else
  echo "ERROR: Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment"
  echo ""
  echo "Usage:"
  echo "  ANTHROPIC_API_KEY=sk-ant-... ./test-pool-mode.sh"
  echo "  OPENAI_API_KEY=sk-...        ./test-pool-mode.sh"
  exit 1
fi

# Clean up any previous test container
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo "=== Starting container in pool mode ==="
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "$PORT:8080" \
  -e POOL_MODE=true \
  -e POOL_API_KEY="$POOL_API_KEY" \
  -e POOL_AUTH_CHOICE="$AUTH_CHOICE" \
  $ENV_FLAG \
  -e XMTP_ENV=dev \
  clawdbot-pool-test

echo ""
echo "=== Waiting for container to boot ==="
echo ""

# Poll /setup/healthz until container is up
for i in $(seq 1 60); do
  if curl -sf http://localhost:$PORT/setup/healthz > /dev/null 2>&1; then
    echo "Health check passed!"
    break
  fi
  echo "  Waiting for container... ($i/60)"
  sleep 2
done

echo ""
echo "=== Checking pool status ==="
curl -s http://localhost:$PORT/pool/status \
  -H "Authorization: Bearer $POOL_API_KEY" | python3 -m json.tool

echo ""
echo "=== Ready! ==="
echo ""
echo "To provision with instructions:"
echo "  curl -X POST http://localhost:$PORT/pool/provision \\"
echo "    -H 'Authorization: Bearer $POOL_API_KEY' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"instructions\": \"You are a helpful trip planner for Tokyo.\"}'"
echo ""
echo "To check status:"
echo "  curl -s http://localhost:$PORT/pool/status -H 'Authorization: Bearer $POOL_API_KEY' | python3 -m json.tool"
echo ""
echo "To view logs:"
echo "  docker logs -f $CONTAINER_NAME"
echo ""
echo "To stop:"
echo "  docker rm -f $CONTAINER_NAME"
