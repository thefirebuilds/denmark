# Deploying Denmark From GHCR

## What The Workflow Does

The GitHub Actions workflow in `.github/workflows/publish-container.yml` runs whenever code is pushed to the `main` branch.

It checks out the repo, logs in to GitHub Container Registry using GitHub's built-in `GITHUB_TOKEN`, builds the repo's `Dockerfile`, and pushes the image to GHCR.

The image is published with two tags:

```text
ghcr.io/thefirebuilds/denmark:latest
ghcr.io/thefirebuilds/denmark:<commit-sha>
```

The workflow lowercases the image name before publishing because container image names must be lowercase.

## Private Image Access

If the package is private, the server needs permission to pull it.

Create a GitHub personal access token:

1. Go to GitHub `Settings` -> `Developer settings` -> `Personal access tokens`.
2. Create a token with `read:packages`.
3. If the repo/package is private, make sure the token's account has access to the repository/package.
4. Store the token somewhere private. Treat it like a password.

## Log In From The Server

On the server, log in to GHCR:

```bash
echo YOUR_GITHUB_PAT | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

For a public image, login may not be required.

## Configure Environment

Copy your production `.env` file to the same directory as `docker-compose.yml`.

Do not commit production secrets to git.

At minimum, production needs a real `SESSION_SECRET` and database connection settings such as `PGHOST`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`.

For Google/OIDC login in the container deployment, set these to the public URL users open in their browser:

```dotenv
FRONTEND_BASE_URL=https://your-denmark-domain.example
OIDC_REDIRECT_URI=https://your-denmark-domain.example/api/auth/callback
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_PROVIDER_NAME=google
OIDC_SCOPES=openid profile email
```

Then add the exact `OIDC_REDIRECT_URI` value to the Google Cloud Console OAuth client under **Authorized redirect URIs**.

If `FRONTEND_BASE_URL` is missing, the app will try to redirect back to the request origin. Setting it explicitly is still recommended behind reverse proxies.

If Google asks which account to use on every login, check `OIDC_PROMPT`. Leave it empty for normal login behavior; `select_account` intentionally asks every time.

## Start The App

From the directory containing `docker-compose.yml` and `.env`:

```bash
docker compose up -d
```

The app listens on port `5000`.

## Update Later

After a new push to `main` publishes a new image:

```bash
docker compose pull
docker compose up -d
```

Docker Compose will pull `ghcr.io/thefirebuilds/denmark:latest` and restart the app with the new image.
