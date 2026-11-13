#!/bin/sh
# The document server (api/) behind the app's origin, off unless OPENFLOWKIT_API_UPSTREAM is set (its base URL, e.g.
# http://api:8787). /api/ goes there with the visitor's address in X-Real-IP / X-Forwarded-For; start the API with
# OPENFLOWKIT_TRUST_PROXY=1 so its public-page rate limit counts visitors, not nginx. OPENFLOWKIT_CLERK_ORIGIN (the
# Clerk Frontend API, e.g. https://clerk.example.com) is added to script-src and frame-src so the sign-in can load.
# Runs from /docker-entrypoint.d before nginx starts.
set -eu
dir="${OFK_NGINX_DIR:-/etc/nginx/ofk}"
conf="${OFK_NGINX_SITE:-/etc/nginx/conf.d/default.conf}"
mkdir -p "$dir"
out="$dir/api-proxy.conf"
upstream="${OPENFLOWKIT_API_UPSTREAM:-}"
upstream="${upstream%/}"
clerk="${OPENFLOWKIT_CLERK_ORIGIN:-}"
clerk="${clerk%/}"

if [ -n "$clerk" ]; then
  case "$clerk" in
    https://*) ;;
    *) echo "OPENFLOWKIT_CLERK_ORIGIN must be an https:// origin, got: $clerk" >&2; exit 1 ;;
  esac
  case "${clerk#https://}" in
    ''|*[!a-zA-Z0-9.:-]*) echo "OPENFLOWKIT_CLERK_ORIGIN must be a bare origin (no path), got: $clerk" >&2; exit 1 ;;
  esac
  sed "s#script-src 'self'#script-src 'self' $clerk#g; s#frame-src https://challenges.cloudflare.com#frame-src https://challenges.cloudflare.com $clerk#g" "$conf" > "$conf.tmp"
  cat "$conf.tmp" > "$conf" && rm "$conf.tmp"
  echo "openflowkit: CSP allows Clerk at $clerk"
fi

if [ -z "$upstream" ]; then
  cat > "$out" <<'CONF'
location ^~ /api/ {
    default_type application/json;
    return 503 '{"error":"This server has no document API. Start it with OPENFLOWKIT_API_UPSTREAM set."}';
}
CONF
  exit 0
fi

case "$upstream" in
  http://?*|https://?*) ;;
  *) echo "OPENFLOWKIT_API_UPSTREAM must be an http:// or https:// URL, got: $upstream" >&2; exit 1 ;;
esac
case "$upstream" in
  *[[:space:]\;\'\"\{\}\$\\]*) echo "OPENFLOWKIT_API_UPSTREAM has a character nginx config cannot take: $upstream" >&2; exit 1 ;;
esac

cat > "$out" <<CONF
location ^~ /api/ {
    proxy_pass $upstream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Cookie "";
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_cache off;
    # The API answers 413 itself past 16 MiB; nginx only stops what it would refuse anyway.
    client_max_body_size 17m;
}
CONF
echo "openflowkit: document API on, /api/ -> $upstream"
