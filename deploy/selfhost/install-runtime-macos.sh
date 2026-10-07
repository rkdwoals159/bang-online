#!/bin/bash
set -euo pipefail
umask 077
base="$HOME/.bang-online"
mkdir -p "$base/runtime" "$base/downloads" "$base/logs" "$base/config" "$base/releases" "$base/backups"
cd "$base/downloads"
download() { [ -f "$2" ] || curl --fail --location --retry 3 "$1" --output "$2"; }
download https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz node.tar.gz
echo '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53  node.tar.gz' | shasum -a 256 -c -
if [ ! -d "$base/runtime/node" ]; then
  tar -xzf node.tar.gz -C "$base/runtime"
  mv "$base/runtime/node-v22.23.3-darwin-arm64" "$base/runtime/node"
fi
download https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_mac_arm64.tar.gz caddy_2.11.7_mac_arm64.tar.gz
download https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_checksums.txt caddy_checksums.txt
grep 'caddy_2.11.7_mac_arm64.tar.gz$' caddy_checksums.txt | shasum -a 256 -c -
tar -xzf caddy_2.11.7_mac_arm64.tar.gz -C "$base/runtime" caddy
download https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-darwin-arm64.tgz cloudflared.tgz
tar -xzf cloudflared.tgz -C "$base/runtime"
if [ ! -d "$base/runtime/Postgres.app" ]; then
  download https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-18.dmg postgres.dmg
  mkdir -p "$base/downloads/pg-mount"
  hdiutil attach postgres.dmg -readonly -nobrowse -mountpoint "$base/downloads/pg-mount"
  trap 'hdiutil detach "$base/downloads/pg-mount" >/dev/null 2>&1 || true' EXIT
  ditto "$base/downloads/pg-mount/Postgres.app" "$base/runtime/Postgres.app"
  hdiutil detach "$base/downloads/pg-mount"
  trap - EXIT
fi
"$base/runtime/node/bin/node" --version
"$base/runtime/caddy" version
"$base/runtime/cloudflared" --version
"$base/runtime/Postgres.app/Contents/Versions/18/bin/postgres" --version
