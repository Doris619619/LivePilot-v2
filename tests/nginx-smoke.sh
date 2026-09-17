#!/usr/bin/env bash
# 在临时目录用真实 Nginx 检查生成的 HTTP/HTTPS 配置，不监听端口、不修改系统站点。
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cd "$tmp"
node "$root/scripts/setup-deployment.mjs" cloud --domain smoke.example.com
node "$root/scripts/deployment/render.mjs" --env "$tmp/.env.cloud" --out "$tmp/rendered"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 1 -subj /CN=smoke.example.com >/dev/null 2>&1
for mode in http https; do
  sed -e "s|/etc/letsencrypt/live/smoke.example.com/fullchain.pem|$tmp/cert.pem|" -e "s|/etc/letsencrypt/live/smoke.example.com/privkey.pem|$tmp/key.pem|" "$tmp/rendered/nginx-$mode.conf" > "$tmp/site.conf"
  printf 'error_log stderr; pid %s/nginx.pid; events {} http { access_log off; client_body_temp_path %s/body; proxy_temp_path %s/proxy; include %s/site.conf; }\n' "$tmp" "$tmp" "$tmp" "$tmp" > "$tmp/nginx.conf"
  nginx -t -e stderr -p "$tmp" -c "$tmp/nginx.conf"
done
