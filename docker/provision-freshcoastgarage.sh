#!/bin/bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

state=/var/lib/freshcoastgarage-provision
site=/etc/nginx/sites-enabled/zz-freshcoastgarage-denmark
credentials=/etc/letsencrypt/freshcoastgarage-cloudflare.ini
lineage=/etc/letsencrypt/live/freshcoastgarage-denmark
hook=/etc/letsencrypt/renewal-hooks/deploy/freshcoastgarage-nginx
names=(freshcoastgarage.com www.freshcoastgarage.com)

[[ $EUID == 0 && $# == 1 ]] || exit 2
case "$1" in
  check|apply|commit|rollback) ;;
  *) exit 2 ;;
esac

validate_credentials() {
  if [[ ! -f $credentials || -L $credentials ]] ||
      [[ $(stat -c '%u:%g:%a' "$credentials") != 0:0:600 ]] ||
      ! grep -Eq '^dns_cloudflare_api_token[[:space:]]*=[[:space:]]*[A-Za-z0-9_-]+$' "$credentials"; then
    echo "Missing or invalid root-owned Cloudflare token file: $credentials (expected root:root mode 0600)." >&2
    exit 1
  fi
}

if [[ $1 == check ]]; then
  validate_credentials
  exit 0
fi

install -d -m 0700 "$state"
exec 9>"$state/lock"
flock -x 9

rollback() {
  [[ -f $state/pending ]] || return 0
  if [[ -e $state/previous || -L $state/previous ]]; then
    cp -a --remove-destination "$state/previous" "$site"
  else
    rm -f "$site"
  fi
  nginx -t && systemctl reload nginx || return 1
  rm -f "$state/pending" "$state/previous"
  echo "Restored the previous garage Nginx configuration."
}

case "$1" in
  rollback) rollback; exit ;;
  commit) rm -f "$state/pending" "$state/previous"; exit ;;
esac

validate_credentials
rollback
nginx -t
if ! dpkg-query -W -f='${db:Status-Status}\n' certbot python3-certbot-dns-cloudflare 2>/dev/null |
    grep -cx installed | grep -qx 2; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-dns-cloudflare
fi

valid_certificate() {
  [[ -s $lineage/fullchain.pem && -s $lineage/privkey.pem &&
     -f /etc/letsencrypt/renewal/freshcoastgarage-denmark.conf ]] &&
    openssl x509 -in "$lineage/fullchain.pem" -noout -checkend 1209600 >/dev/null &&
    for name in "${names[@]}"; do
      openssl verify -purpose sslserver -verify_hostname "$name" \
        -untrusted "$lineage/fullchain.pem" "$lineage/fullchain.pem" >/dev/null || return 1
    done
}

if ! valid_certificate; then
  certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --dns-cloudflare --dns-cloudflare-credentials "$credentials" \
    --dns-cloudflare-propagation-seconds 60 --cert-name freshcoastgarage-denmark \
    --force-renewal -d "${names[0]}" -d "${names[1]}"
  valid_certificate || { echo 'Issued certificate failed validation.' >&2; exit 1; }
fi

install -d -m 0755 "$(dirname "$hook")"
cat >"$state/renew-hook" <<'HOOK'
#!/bin/sh
set -eu
[ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/freshcoastgarage-denmark ] || exit 0
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
HOOK
install -m 0755 "$state/renew-hook" "$hook"
systemctl enable --now certbot.timer

cat >"$state/nginx.conf" <<'NGINX'
server {
    listen 80;
    server_name freshcoastgarage.com www.freshcoastgarage.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name freshcoastgarage.com www.freshcoastgarage.com;
    ssl_certificate /etc/letsencrypt/live/freshcoastgarage-denmark/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/freshcoastgarage-denmark/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:5080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX

rm -f "$state/previous"
if [[ -e $site || -L $site ]]; then cp -a "$site" "$state/previous"; fi
touch "$state/pending"
trap 'code=$?; if ! rollback; then echo "Automatic Nginx rollback failed." >&2; fi; exit "$code"' ERR
if ! cmp -s "$state/nginx.conf" "$site"; then
  install -m 0644 "$state/nginx.conf" /etc/nginx/.freshcoastgarage-denmark.new
  mv -T /etc/nginx/.freshcoastgarage-denmark.new "$site"
fi
nginx -t
systemctl reload nginx
trap - ERR
echo "Garage HTTPS configuration loaded and awaiting external verification."
