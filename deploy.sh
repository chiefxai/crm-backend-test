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
SERVICE="app"
ALWAYS_BUILD=false
APPLICATION_SERVICES=false
BACKUP_DB=false
MIGRATE=false

usage() {
  echo "Usage: $0 [--dev|--uat|--prod] [--pull] [--build] [--service NAME|--all-services] [--application-services] [--backup-db] [--migrate] [--force-recreate] [--always-build] [--trace] [--all-logs] [--follow-logs] [--foreground] [--dry-run]"
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
    --always-build) ALWAYS_BUILD=true; shift ;;
    --application-services) APPLICATION_SERVICES=true; SERVICE=""; shift ;;
    --backup-db) BACKUP_DB=true; shift ;;
    --migrate) MIGRATE=true; shift ;;
    --all-services) APPLICATION_SERVICES=false; SERVICE=""; shift ;;
    --service)
      [[ $# -ge 2 && -n "$2" ]] || { echo "ERROR: --service requires a Compose service name."; usage; exit 1; }
      APPLICATION_SERVICES=false
      SERVICE="$2"
      [[ "$SERVICE" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "ERROR: Invalid Compose service name: $SERVICE"; exit 1; }
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

TARGET_SERVICES=()
if $APPLICATION_SERVICES; then
  TARGET_SERVICES=(app scheduler callback-scheduler retention-worker)
elif [[ -n "$SERVICE" ]]; then
  TARGET_SERVICES=("$SERVICE")
fi

migrate_database() {
  if $BACKUP_DB || $MIGRATE; then "${COMPOSE_CMD[@]}" up -d --wait --wait-timeout 120 mysql; fi
  if $BACKUP_DB; then
    local backup_dir backup_file
    backup_dir="$(git rev-parse --git-path chiefvoice-db-backups)"
    mkdir -p "$backup_dir"
    chmod 700 "$backup_dir"
    backup_file="$backup_dir/$(date -u +%Y%m%dT%H%M%SZ)-$$.sql"
    echo "Saving database backup to $backup_file"
    # Do not trace the dump output or interpolate credentials on the host.
    if ! (umask 077; "${COMPOSE_CMD[@]}" exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --user="$MYSQL_USER" --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE"' > "$backup_file"); then
      rm -f "$backup_file"
      echo "ERROR: Backup failed; deployment stopped."
      exit 1
    fi
    [[ -s "$backup_file" ]] || { echo "ERROR: Database backup is empty."; exit 1; }
  fi
  if $MIGRATE; then
    "${COMPOSE_CMD[@]}" run --rm --no-deps app node scripts/migrate.js
  fi
}

check_api_ready() {
  # Probe this Compose project's API, never an unrelated process publishing
  # the same host port. Node is guaranteed to exist in the application image.
  "${COMPOSE_CMD[@]}" exec -T app node -e 'fetch("http://127.0.0.1:3000/ready", {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1
}

show_status_and_logs() {
  "${COMPOSE_CMD[@]}" ps
  if check_api_ready; then
    echo "API container readiness check: OK"
  else
    echo "API container readiness check: unavailable"
  fi
  echo "Recent deployment logs:"
  LOG_ARGS=(logs --tail=200)
  $FOLLOW_LOGS && LOG_ARGS+=(-f)
  if ! $ALL_LOGS; then
    if [[ ${#TARGET_SERVICES[@]} -gt 0 ]]; then LOG_ARGS+=("${TARGET_SERVICES[@]}"); else LOG_ARGS+=(app); fi
  fi
  "${COMPOSE_CMD[@]}" "${LOG_ARGS[@]}"
}

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
  if ! "${COMPOSE_CMD[@]}" config -q; then
    echo "ERROR: Updated Docker Compose configuration is invalid."
    exit 1
  fi
fi

# Remember successful deployments per environment and target so an API-only
# rollout does not incorrectly mark the rest of the stack as deployed.
DEPLOY_TARGET=${SERVICE:-all}
$APPLICATION_SERVICES && DEPLOY_TARGET=applications
DEPLOY_MARKER="$(git rev-parse --git-path "chiefvoice-last-deployed-${ENV}-${DEPLOY_TARGET}")"
if $PULL && ! $ALWAYS_BUILD && ! $FORCE_RECREATE; then
  CURRENT_COMMIT="$(git rev-parse HEAD)"
  if [[ -f "$DEPLOY_MARKER" ]] && [[ "$(cat "$DEPLOY_MARKER")" == "$CURRENT_COMMIT" ]]; then
    printf 'No new commit to deploy for %s/%s (%s); skipping build and restart.\n' "$ENV" "$DEPLOY_TARGET" "${CURRENT_COMMIT:0:12}"
    $MIGRATE && migrate_database
    show_status_and_logs
    exit 0
  fi
fi

# Build sequentially to bound peak disk/memory on smaller VMs. Services
# using the same Dockerfile reuse cached layers from the preceding build.
if $BUILD; then
  if [[ ${#TARGET_SERVICES[@]} -gt 0 ]]; then
    for target in "${TARGET_SERVICES[@]}"; do "${COMPOSE_CMD[@]}" build "$target"; done
  else
    for target in $("${COMPOSE_CMD[@]}" config --services); do
      "${COMPOSE_CMD[@]}" build "$target"
    done
  fi
fi
migrate_database
ARGS=(up --no-build)
$FORCE_RECREATE && ARGS+=(--force-recreate)
$DETACH && ARGS+=(-d)
ARGS+=("${TARGET_SERVICES[@]}")

printf 'Deploying %s...\n' "$ENV"
if ! "${COMPOSE_CMD[@]}" "${ARGS[@]}"; then
  echo "ERROR: Compose startup failed; deployment has not been marked successful."
  echo "Published container ports (check for another service owning the API port):"
  docker ps --format 'table {{.Names}}\t{{.Ports}}' || true
  echo "To use another API host port, set APP_HOST_PORT=3001 in the environment file."
  echo "Caddy continues to reach app:3000 on the internal Docker network."
  exit 1
fi

for i in {1..90}; do
  if check_api_ready; then
    echo "API readiness check: OK"
    break
  fi
  if [[ $i -eq 90 ]]; then
    echo "API readiness check failed. Showing recent app logs:"
    "${COMPOSE_CMD[@]}" logs --tail=100 app || true
    exit 1
  fi
  sleep 2
done

"${COMPOSE_CMD[@]}" ps
for target in "${TARGET_SERVICES[@]}"; do
  if ! "${COMPOSE_CMD[@]}" ps --status running --services "$target" | grep -Fxq "$target"; then
    echo "ERROR: $target is not running; deployment will not be marked successful."
    "${COMPOSE_CMD[@]}" logs --tail=100 "$target" || true
    exit 1
  fi
done

# Record success after Compose reports the stack and the health check above
# has passed. Store under .git so the marker never appears as a source change.
mkdir -p "$(dirname "$DEPLOY_MARKER")"
git rev-parse HEAD > "$DEPLOY_MARKER"

show_status_and_logs
