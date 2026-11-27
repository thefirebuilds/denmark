#!/usr/bin/env bash
set -euo pipefail

origin=159.223.151.27
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl_origin() {
  curl --silent --show-error --noproxy '*' --connect-timeout 5 --max-time 15 "$@"
}

curl_origin --fail "http://$origin/" >"$work/denmark"
grep -Fq '<title>Trip Dispatch Console</title>' "$work/denmark"

for name in freshcoastgarage.com www.freshcoastgarage.com; do
  resolve=(--resolve "$name:443:$origin")
  curl_origin "${resolve[@]}" --fail "https://$name/" >"$work/home"
  curl_origin "${resolve[@]}" --fail "https://$name/api/public/availability" >"$work/feed"
  node - "$work/home" "$work/feed" <<'NODE'
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const [home, feed] = process.argv.slice(2).map(path => readFileSync(path, "utf8"));
assert.match(home, /<title>Fresh Coast Garage<\/title>/);
const roster = new Set(Array.from(home.matchAll(/turoVehicleId: "(\d+)"/g), match => match[1]));
const data = JSON.parse(feed);
assert.equal(data.ok, true);
assert.ok(Array.isArray(data.vehicles), "Invalid fleet feed");
assert.ok(roster.size && data.vehicles.every(row => roster.has(String(row.turoVehicleId))), "Unapproved listing");
NODE

  for path in /api/vehicles /api/settings /api/vehicle-availability-ingest.php; do
    status=$(curl_origin "${resolve[@]}" --output /dev/null --write-out '%{http_code}' "https://$name$path")
    if [[ $status != 404 ]]; then
      echo "Expected 404 from $name$path, received $status." >&2
      exit 1
    fi
  done
  echo "Verified $name HTTPS, homepage, public fleet feed and private route isolation."
done
