#!/usr/bin/env bash
# Deploy only the standalone HTTP MCP portal.
#
# Usage:
#   ./scripts/deploy-mcp.sh

set -euo pipefail

log() {
    printf '\n\033[1;34m==> %s\033[0m\n' "$1"
}

fail() {
    printf '\n\033[1;31mMCP deployment failed: %s\033[0m\n' "$1" >&2
    exit 1
}

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_DIR="$PROJECT_DIR/demos/sciencediscovery-plane-mcp"
ENV_FILE="$MCP_DIR/.env"
COMPOSE_FILE="$MCP_DIR/compose.http.yml"
NETWORK_OVERRIDE="$PROJECT_DIR/.runtime/plane-mcp/mcp.override.yml"
CONFIG_FILE="$MCP_DIR/http.local.json"
SERVICE="plane-mcp-http"
PROJECT_NAME="plane-mcp"

for command in docker curl; do
    command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done

docker compose version >/dev/null 2>&1 || fail "Docker Compose is not installed"

[[ -f "$ENV_FILE" ]] || fail "missing private environment file: $ENV_FILE"
[[ -f "$CONFIG_FILE" ]] || fail "missing private MCP configuration: $CONFIG_FILE"
[[ -f "$NETWORK_OVERRIDE" ]] || fail "missing MCP network override: $NETWORK_OVERRIDE"

compose() {
    env -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME \
        docker compose --env-file "$ENV_FILE" -p "$PROJECT_NAME" \
        -f "$COMPOSE_FILE" -f "$NETWORK_OVERRIDE" "$@"
}

log "Validating MCP Compose configuration"
compose config --quiet

log "Building and recreating the standalone MCP service"
compose up -d --build --force-recreate "$SERVICE"

log "Waiting for MCP health check"
for attempt in $(seq 1 20); do
    status="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8765/healthz || true)"
    if [[ "$status" == "200" ]]; then
        break
    fi
    [[ "$attempt" -lt 20 ]] && sleep 3
done

[[ "$status" == "200" ]] || {
    compose ps
    compose logs --tail=100 "$SERVICE" || true
    fail "health check returned HTTP ${status:-000}"
}

log "MCP deployment completed"
compose ps
printf '  OK  MCP health (http://127.0.0.1:8765/healthz) -> 200\n'
