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
DENMARK_SWAP_SIZE_VALUE="$(env_value DENMARK_SWAP_SIZE 4G)"

run_privileged() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

ensure_swap() {
  local swap_size="$1"
  local swap_file="/swapfile"

  if [[ "$swap_size" == "0" || "$swap_size" == "false" || "$swap_size" == "off" ]]; then
    echo "[install] swap setup disabled by DENMARK_SWAP_SIZE=${swap_size}"
    return
  fi

  if ! command -v swapon >/dev/null 2>&1; then
    echo "[install] swapon is not available; skipping swap setup"
    return
  fi

  if swapon --show --noheadings | grep -q .; then
    echo "[install] swap already enabled"
    swapon --show || true
    return
  fi

  echo "[install] no active swap detected; creating ${swap_size} swap at ${swap_file}"

  if [[ -e "$swap_file" && ! -f "$swap_file" ]]; then
    echo "[install] ${swap_file} exists but is not a regular file; cannot configure swap" >&2
    exit 1
  fi

  if [[ ! -f "$swap_file" ]]; then
    if ! run_privileged fallocate -l "$swap_size" "$swap_file"; then
      echo "[install] fallocate failed; retrying swapfile creation with dd"
      run_privileged dd if=/dev/zero of="$swap_file" bs=1M count="$(
        case "$swap_size" in
          *G|*g) echo $(( ${swap_size%[Gg]} * 1024 )) ;;
          *M|*m) echo "${swap_size%[Mm]}" ;;
          *) echo "4096" ;;
        esac
      )" status=progress
    fi
  fi

  run_privileged chmod 600 "$swap_file"

  if ! run_privileged mkswap "$swap_file" >/dev/null; then
    echo "[install] failed to initialize ${swap_file} as swap" >&2
    exit 1
  fi

  run_privileged swapon "$swap_file"

  if ! grep -Eq "^[[:space:]]*${swap_file}[[:space:]]+none[[:space:]]+swap[[:space:]]" /etc/fstab; then
    echo "[install] persisting ${swap_file} in /etc/fstab"
    echo "${swap_file} none swap sw 0 0" | run_privileged tee -a /etc/fstab >/dev/null
  fi

  echo "[install] swap enabled"
  swapon --show || true
}

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

ensure_swap "$DENMARK_SWAP_SIZE_VALUE"

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
