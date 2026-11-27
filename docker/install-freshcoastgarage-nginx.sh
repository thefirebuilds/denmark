#!/usr/bin/env bash
set -euo pipefail

source_file="$(dirname "${BASH_SOURCE[0]}")/freshcoastgarage.nginx.conf"
target=/etc/nginx/sites-enabled/zz-freshcoastgarage-denmark

if [[ $(id -u) -eq 0 ]]; then
  admin=()
else
  admin=(sudo -n)
fi

verify_routes() {
  curl --fail --silent --show-error --max-time 15 \
    -H 'Host: 159.223.151.27' http://127.0.0.1/ |
    grep -F '<title>Trip Dispatch Console</title>' >/dev/null || return 1
  for hostname in freshcoastgarage.com www.freshcoastgarage.com; do
    curl --fail --silent --show-error --max-time 15 \
      --resolve "$hostname:80:127.0.0.1" "http://$hostname/" |
      grep -F '<title>Fresh Coast Garage</title>' >/dev/null || return 1
    curl --fail --silent --show-error --max-time 15 \
      --resolve "$hostname:80:127.0.0.1" "http://$hostname/api/public/availability" >/dev/null || return 1
  done
}

wait_for_routes() {
  for attempt in 1 2 3 4 5; do
    if verify_routes; then return 0; fi
    sleep 1
  done
  return 1
}

"${admin[@]}" nginx -t
if "${admin[@]}" test -e "$target"; then
  if ! "${admin[@]}" cmp -s "$source_file" "$target"; then
    echo "Existing garage configuration differs at $target. Review it before deploying." >&2
    exit 1
  fi
  verify_routes
else
  "${admin[@]}" install -m 0644 "$source_file" "$target"
  if ! "${admin[@]}" nginx -t || ! "${admin[@]}" systemctl reload nginx || ! wait_for_routes; then
    "${admin[@]}" rm -f "$target"
    "${admin[@]}" systemctl reload nginx
    echo "Restored the previous Nginx configuration after garage route verification failed." >&2
    exit 1
  fi
fi
