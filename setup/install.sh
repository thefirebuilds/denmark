#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f ".env" ]]; then
  echo "[install] missing .env next to docker-compose.yml" >&2
  echo "[install] copy .env.example to .env and fill in secrets first" >&2
  exit 1
fi

echo "[install] starting postgres"
docker compose up -d db

echo "[install] pulling app image"
docker compose pull app

echo "[install] bootstrapping database"
docker compose run --rm app npm run db:bootstrap

echo "[install] verifying database"
docker compose run --rm app npm run db:verify

echo "[install] starting Denmark"
docker compose up -d

echo "[install] complete"
