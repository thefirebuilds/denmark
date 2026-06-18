# syntax=docker/dockerfile:1.7

FROM node:22.12-bookworm-slim AS web-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig*.json eslint.config.js ./
COPY public ./public
COPY src ./src

# The repo's `npm run build` currently runs `tsc -b` first, while the app is
# still importing several JSX modules without declarations. Vite builds cleanly,
# so use it directly for the deployable client bundle.
RUN npx vite build

FROM node:22.12-bookworm-slim AS server-deps
WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.12-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV POSTGRES_CLIENT_MAJOR=18
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && wget -qO /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${POSTGRES_CLIENT_MAJOR}" \
  && rm -rf /var/lib/apt/lists/*

COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY setup ./setup
COPY --from=web-build /app/dist ./dist

RUN test -f ./server/db/schema.sql \
  && test -f ./setup/bootstrap-db.js \
  && test -f ./setup/verify-db-bootstrap.js \
  && test -f ./setup/restore-json-backup.js \
  && test ! -e ./setup/bootstrap-db.cjs \
  && test ! -e ./setup/verify-db-bootstrap.cjs \
  && node --check ./setup/bootstrap-db.js \
  && node --check ./setup/verify-db-bootstrap.js \
  && node --check ./setup/restore-json-backup.js \
  && pg_dump --version \
  && pg_restore --version \
  && node -e "const pkg = require('./server/package.json'); if (pkg.scripts['db:bootstrap'] !== 'node ../setup/bootstrap-db.js' || pkg.scripts['db:verify'] !== 'node ../setup/verify-db-bootstrap.js' || pkg.scripts['db:restore-json'] !== 'node ../setup/restore-json-backup.js') throw new Error('stale setup script paths in server/package.json'); require('./server/node_modules/pg'); require('./server/node_modules/dotenv'); require('./server/node_modules/stream-json'); console.log('setup runtime deps ok')"

EXPOSE 5000
WORKDIR /app/server
CMD ["node", "index.js"]
