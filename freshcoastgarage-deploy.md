# Deploy Denmark and Fresh Coast Garage

A push to `main` builds the shared image and deploys both Compose services to `159.223.151.27`. Denmark stays on the bare IP. The garage container stays bound to `127.0.0.1:5080`. Nginx routes only the two garage hostnames to it.

## One-time authorization

The existing Actions account can deploy with Docker. Its noninteractive sudo attempt returned `sudo: a password is required`. A droplet administrator must grant it these four exact commands on a **root-owned copy** of the provisioning helper. The workflow never elevates a script from the deploy user's checkout. No general passwordless sudo is needed.

Cloudflare is authoritative for `freshcoastgarage.com` (`aragorn.ns.cloudflare.com` and `mary.ns.cloudflare.com`). Create a Cloudflare API token with **Zone → DNS → Edit**, scoped to **Include → Specific zone → freshcoastgarage.com**. Certbot creates and removes the DNS-01 TXT records for both names. Keep the apex and www website records on 1&1/IONOS until the explicit cutover. No TXT delegation or manual challenge records are required.

An administrator can provision the authorization and credential in a single session. Run the following from the Denmark checkout after reviewing `docker/provision-freshcoastgarage.sh`. Replace `DEPLOY_LOGIN` in the sudoers line with the Linux username from the existing GitHub production `DEPLOY_USER` secret.

```sh
sudo install -o root -g root -m 0755 docker/provision-freshcoastgarage.sh /usr/local/sbin/freshcoastgarage-provision
sudo visudo -f /etc/sudoers.d/freshcoastgarage-deploy
```

```sudoers
DEPLOY_LOGIN ALL=(root) NOPASSWD: /usr/local/sbin/freshcoastgarage-provision check, /usr/local/sbin/freshcoastgarage-provision apply, /usr/local/sbin/freshcoastgarage-provision commit, /usr/local/sbin/freshcoastgarage-provision rollback
```

Store the token directly on the droplet in the root-only file below. Paste it at the hidden prompt. The value stays out of shell history, process arguments, GitHub Actions, and Git.

```sh
sudo bash -c '
  set -eu
  umask 077
  install -d -m 0755 /etc/letsencrypt
  read -rsp "Cloudflare DNS API token: " token
  printf "\n" >&2
  test -n "$token"
  file=/etc/letsencrypt/freshcoastgarage-cloudflare.ini
  temp=$(mktemp /etc/letsencrypt/.freshcoastgarage-cloudflare.XXXXXX)
  printf "dns_cloudflare_api_token = %s\n" "$token" >"$temp"
  mv -T "$temp" "$file"
'
```

Keep inbound TCP 443 available to the internet through the droplet firewall and any DigitalOcean Cloud Firewall. The deploy tests this from GitHub Actions. The installer checks the credential file and the workflow fails before restarting the apps when permission or the file is missing. If the privileged helper itself needs a future policy or template change, an administrator reviews and replaces the root-owned copy.

## Push to deploy

1. Push to `main`. The production workflow checks the exact sudo grants, deploys both containers under the existing account, and verifies the loopback garage listener.
2. The root-owned helper installs Certbot and the Cloudflare DNS plugin if needed. It obtains a publicly trusted certificate for both names or reuses an existing valid certificate from the managed lineage. It enables `certbot.timer` and installs a deploy hook that validates and reloads Nginx after this certificate renews. Nginx gets the same managed HTTPS configuration on each deploy, including upgrades from the old HTTP-only file.
3. The helper backs up the previous garage virtual host and runs `nginx -t` before reload. A failed configuration or reload restores the previous file. If the runner checks fail, Actions also restores the previous virtual host and reports a failed deployment. Denmark's Nginx site is outside the managed file.

## Pre-cutover checks

The workflow runs `bash docker/check-freshcoastgarage-origin.sh` from the GitHub runner. It uses `curl --resolve` with normal certificate validation against the droplet, checks both homepages and fleet feeds, checks 404 for private routes, and verifies that the bare HTTP IP still serves Denmark. Run the same script locally to repeat the full checks, or open the URLs through a local DNS override after the certificate is in place.

```sh
curl --fail --resolve freshcoastgarage.com:443:159.223.151.27 https://freshcoastgarage.com/
curl --fail --resolve www.freshcoastgarage.com:443:159.223.151.27 https://www.freshcoastgarage.com/api/public/availability
curl --resolve www.freshcoastgarage.com:443:159.223.151.27 -sS -o /dev/null -w '%{http_code}\n' https://www.freshcoastgarage.com/api/vehicles
curl --fail http://159.223.151.27/
```

After the checks pass and you explicitly choose to cut over, update both website records at Cloudflare and verify both domains over normal DNS. Keep 1&1 and the legacy snapshot push available through the rollback window.
