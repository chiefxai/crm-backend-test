#!/usr/bin/env bash
set -euo pipefail

ENV=prod
BUILD=false
PULL=false
DETACH=true
DRY_RUN=false
TRACE=false
FORCE_RECREATE=false
ALL_LOGS=false
FOLLOW_LOGS=false
SERVICE=""

usage() {
  echo "Usage: $0 [--dev|--uat|--prod] [--pull] [--build] [--service NAME] [--force-recreate] [--trace] [--all-logs] [--follow-logs] [--foreground] [--dry-run]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) ENV=dev; shift ;;
    --uat) ENV=uat; shift ;;
    --prod) ENV=prod; shift ;;
    --build) BUILD=true; shift ;;
    --pull) PULL=true; shift ;;
    --foreground) DETACH=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --trace) TRACE=true; shift ;;
    --force-recreate) FORCE_RECREATE=true; shift ;;
    --all-logs) ALL_LOGS=true; shift ;;
    --follow-logs) FOLLOW_LOGS=true; shift ;;
    --service)
      [[ $# -ge 2 && -n "$2" ]] || { echo "ERROR: --service requires a Compose service name."; usage; exit 1; }
      SERVICE="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

case "$ENV" in
  dev) ENV_FILE=.env.dev; COMPOSE=( -f docker-compose.yml -f docker-compose.keycloak.yml -f docker-compose.keycloak.dev.yml ) ;;
  uat) ENV_FILE=.env.uat; COMPOSE=( -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.caddy.uat.yml ) ;;
  prod) ENV_FILE=.env; COMPOSE=( -f docker-compose.yml -f docker-compose.caddy.yml ) ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found."
  if [[ "$ENV" == prod && -f .env.production.example ]]; then echo "Create it from .env.production.example and fill in secrets."; fi
  exit 1
fi

if [[ "$ENV" == prod ]] && grep -n 'CHANGE_ME' "$ENV_FILE" >/tmp/chiefvoice_change_me 2>/dev/null; then
  echo "ERROR: Production .env still contains CHANGE_ME placeholders:"
  cat /tmp/chiefvoice_change_me
  exit 1
fi

COMPOSE_CMD=(docker compose --env-file "$ENV_FILE" "${COMPOSE[@]}")

if $TRACE; then
  set -x
fi

if ! "${COMPOSE_CMD[@]}" config -q; then
  echo "ERROR: Docker Compose configuration is invalid."
  exit 1
fi

if $DRY_RUN; then
  echo "Compose configuration is valid for $ENV."
  "${COMPOSE_CMD[@]}" config >/dev/null
  exit 0
fi

if $PULL; then
  echo "Pulling latest source..."
  git pull --ff-only
fi

ARGS=(up)
$BUILD && ARGS+=(--build)
$FORCE_RECREATE && ARGS+=(--force-recreate)
$DETACH && ARGS+=(-d)
[[ -n "$SERVICE" ]] && ARGS+=("$SERVICE")

printf 'Deploying %s...\n' "$ENV"
"${COMPOSE_CMD[@]}" "${ARGS[@]}"

if command -v curl >/dev/null 2>&1; then
  for i in {1..30}; do
    if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
      echo "API health check: OK"
      break
    fi
    if [[ $i -eq 30 ]]; then
      echo "API health check failed. Showing recent app logs:"
      "${COMPOSE_CMD[@]}" logs --tail=100 app || true
      exit 1
    fi
    sleep 2
  done
fi

"${COMPOSE_CMD[@]}" ps

echo "Recent deployment logs:"
LOG_ARGS=(logs --tail=200)
$FOLLOW_LOGS && LOG_ARGS+=(-f)
if ! $ALL_LOGS; then
  LOG_ARGS+=("${SERVICE:-app}")
fi
"${COMPOSE_CMD[@]}" "${LOG_ARGS[@]}"
