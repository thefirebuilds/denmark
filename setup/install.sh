#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f ".env" ]]; then
  echo "[install] missing .env next to docker-compose.yml" >&2
  echo "[install] copy .env.example to .env and fill in secrets first" >&2
  exit 1
fi

env_value() {
  local key="$1"
  local fallback="$2"
  local value
  value="$(grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  if [[ -z "$value" ]]; then
    printf '%s' "$fallback"
  else
    printf '%s' "$value"
  fi
}

PGUSER_VALUE="$(env_value PGUSER postgres)"
PGDATABASE_VALUE="$(env_value PGDATABASE denmark)"

print_failure_logs() {
  local phase="$1"

  echo "[install] ${phase} failed; Denmark was not started" >&2
  echo "[install] recent postgres logs:" >&2
  docker compose logs --tail=100 db >&2 || true
  echo "[install] recent app logs:" >&2
  docker compose logs --tail=100 app >&2 || true
}

run_install_step() {
  local phase="$1"
  shift

  if ! "$@"; then
    print_failure_logs "$phase"
    exit 1
  fi
}

echo "[install] starting postgres"
docker compose up -d db

echo "[install] waiting for postgres to accept connections"
for attempt in $(seq 1 30); do
  if docker compose exec -T db pg_isready \
    -U "$PGUSER_VALUE" \
    -d "$PGDATABASE_VALUE" >/dev/null 2>&1; then
    echo "[install] postgres is ready"
    break
  fi

  if [[ "$attempt" == "30" ]]; then
    echo "[install] postgres did not become ready within 60 seconds" >&2
    docker compose logs --tail=80 db >&2
    exit 1
  fi

  echo "[install] waiting for postgres... (${attempt}/30)"
  sleep 2
done

echo "[install] pulling app image"
docker compose pull app

echo "[install] bootstrapping database; this can take a minute on first install"
run_install_step "database bootstrap" docker compose run --rm app npm run db:bootstrap

echo "[install] verifying database"
run_install_step "database verification" docker compose run --rm app npm run db:verify

echo "[install] starting Denmark"
docker compose up -d

echo "[install] complete"
