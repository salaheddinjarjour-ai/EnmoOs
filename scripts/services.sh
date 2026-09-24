#!/usr/bin/env bash
# Local Postgres 16 (:54329) and Redis (:63799) for dev and tests.
#
#   scripts/services.sh up|down|status|env|createdb <name>
#   eval "$(scripts/services.sh env)"
#
# Uses the system binaries when present (Postgres runs as the `postgres` user when invoked as
# root, because initdb refuses to run as root) and falls back to docker-compose.dev.yml otherwise.
# Every subcommand is idempotent.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${ENMO_PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_DIR="${ENMO_PG_DIR:-/tmp/enmo-pg}"
PG_DATA="$PG_DIR/data"
PG_LOG="$PG_DIR/postgres.log"
PG_PORT=54329
PG_HOST=127.0.0.1
PG_SOCKET_DIR=/tmp
REDIS_PORT=63799
REDIS_DIR="${ENMO_REDIS_DIR:-/tmp/enmo-redis}"
DATABASES=(enmo_dev enmo_test)
COMPOSE_FILE="$ROOT_DIR/docker-compose.dev.yml"

log() { printf '[services] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

have_native_pg() { [[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" ]]; }
have_native_redis() { command -v redis-server >/dev/null 2>&1 && command -v redis-cli >/dev/null 2>&1; }

# Runs a Postgres binary as the postgres user when we are root.
as_pg() {
  if [[ "$(id -u)" -eq 0 ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

compose() {
  [[ -f "$COMPOSE_FILE" ]] || die "native binaries missing and $COMPOSE_FILE not found"
  command -v docker >/dev/null 2>&1 || die "native binaries missing and docker is not installed"
  docker compose -f "$COMPOSE_FILE" "$@"
}

# ── Postgres ────────────────────────────────────────────────────────────────

pg_running() {
  have_native_pg && [[ -f "$PG_DATA/PG_VERSION" ]] && as_pg "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1
}

pg_psql() {
  if have_native_pg; then
    as_pg "$PG_BIN/psql" -h "$PG_HOST" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"
  else
    compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"
  fi
}

pg_wait_ready() {
  for _ in $(seq 1 60); do
    if pg_psql -c 'SELECT 1' >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  die "Postgres did not become ready on :$PG_PORT"
}

pg_createdb() {
  local name="$1"
  [[ "$name" =~ ^[a-z_][a-z0-9_]*$ ]] || die "invalid database name: $name"
  if [[ "$(pg_psql -c "SELECT 1 FROM pg_database WHERE datname = '$name'")" != "1" ]]; then
    pg_psql -c "CREATE DATABASE \"$name\"" >/dev/null
    log "created database $name"
  fi
}

pg_up() {
  if ! have_native_pg; then
    log "Postgres binaries not found in $PG_BIN; using docker compose"
    compose up -d postgres >/dev/null
    pg_wait_ready
    return
  fi

  mkdir -p "$PG_DIR"
  if [[ "$(id -u)" -eq 0 ]]; then chown postgres:postgres "$PG_DIR"; fi

  if [[ ! -f "$PG_DATA/PG_VERSION" ]]; then
    log "initialising cluster in $PG_DATA"
    as_pg "$PG_BIN/initdb" -D "$PG_DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 \
      --no-sync >/dev/null
  fi

  if pg_running; then
    log "Postgres already running on :$PG_PORT"
  else
    log "starting Postgres on $PG_HOST:$PG_PORT"
    # fsync & co. are off: this cluster only ever holds disposable dev/test data.
    as_pg "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -w -t 60 start -o \
      "-p $PG_PORT -c listen_addresses=$PG_HOST -c unix_socket_directories=$PG_SOCKET_DIR \
       -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" \
      >/dev/null || die "Postgres failed to start; see $PG_LOG"
  fi
  pg_wait_ready
}

pg_down() {
  if have_native_pg; then
    if pg_running; then
      as_pg "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast -w stop >/dev/null
      log "Postgres stopped"
    else
      log "Postgres not running"
    fi
  elif [[ -f "$COMPOSE_FILE" ]] && command -v docker >/dev/null 2>&1; then
    compose stop postgres >/dev/null
    log "Postgres container stopped"
  fi
}

# ── Redis ───────────────────────────────────────────────────────────────────

redis_ping() {
  if have_native_redis; then
    [[ "$(redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null)" == "PONG" ]]
  else
    [[ "$(compose exec -T redis redis-cli ping 2>/dev/null | tr -d '\r')" == "PONG" ]]
  fi
}

redis_up() {
  if ! have_native_redis; then
    log "redis-server not found; using docker compose"
    compose up -d redis >/dev/null
  elif redis_ping; then
    log "Redis already running on :$REDIS_PORT"
    return
  else
    mkdir -p "$REDIS_DIR"
    log "starting Redis on 127.0.0.1:$REDIS_PORT"
    # BullMQ requires noeviction; persistence is off because the data is disposable.
    redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no \
      --daemonize yes --maxmemory-policy noeviction --dir "$REDIS_DIR" \
      --pidfile "$REDIS_DIR/redis.pid" --logfile "$REDIS_DIR/redis.log"
  fi
  for _ in $(seq 1 40); do
    if redis_ping; then return 0; fi
    sleep 0.25
  done
  die "Redis did not become ready on :$REDIS_PORT"
}

redis_down() {
  if have_native_redis; then
    if redis_ping; then
      redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
      log "Redis stopped"
    else
      log "Redis not running"
    fi
  elif [[ -f "$COMPOSE_FILE" ]] && command -v docker >/dev/null 2>&1; then
    compose stop redis >/dev/null
    log "Redis container stopped"
  fi
}

# ── Commands ────────────────────────────────────────────────────────────────

cmd_up() {
  pg_up
  for db in "${DATABASES[@]}"; do pg_createdb "$db"; done
  redis_up
  log "ready — run: eval \"\$(scripts/services.sh env)\""
}

cmd_down() {
  redis_down
  pg_down
}

cmd_status() {
  local ok=0
  if pg_psql -c 'SELECT 1' >/dev/null 2>&1; then
    echo "postgres: up ($PG_HOST:$PG_PORT)"
  else
    echo "postgres: down"
    ok=1
  fi
  if redis_ping; then
    echo "redis:    up (127.0.0.1:$REDIS_PORT)"
  else
    echo "redis:    down"
    ok=1
  fi
  return "$ok"
}

cmd_env() {
  local base="postgresql://postgres@$PG_HOST:$PG_PORT"
  echo "export DATABASE_URL=$base/enmo_dev"
  echo "export TEST_DATABASE_URL=$base/enmo_test"
  echo "export REDIS_URL=redis://127.0.0.1:$REDIS_PORT"
}

usage() {
  echo "usage: scripts/services.sh up|down|status|env|createdb <name>" >&2
  exit 2
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  env) cmd_env ;;
  createdb)
    [[ -n "${2:-}" ]] || usage
    pg_createdb "$2"
    ;;
  *) usage ;;
esac
