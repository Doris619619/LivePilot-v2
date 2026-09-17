#!/usr/bin/env bash
# Ubuntu 24.04 单机部署：本地 Linux 构建、配置备份、ACME、原子发布及失败回退。
set -Eeuo pipefail
umask 077
if [[ ${EUID} != 0 ]]; then echo '请使用 sudo bash deploy/install-cloud.sh ...'; exit 1; fi
if [[ $# != 3 || $3 != --agree-acme-terms ]]; then
  echo '用法：sudo bash deploy/install-cloud.sh /absolute/path/.env.cloud email@example.com --agree-acme-terms'
  echo '先阅读 docs/从零部署.md；该选项表示你接受证书机构服务条款。'; exit 1
fi
config_file=$(realpath "$1")
email=$2
[[ $email =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo '证书联系邮箱格式无效'; exit 1; }
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for cmd in node npm nginx certbot curl git tar runuser; do command -v "$cmd" >/dev/null || { echo "缺少 $cmd，先按部署文档安装依赖。"; exit 1; }; done
node_bin=$(command -v node)
certbot_bin=$(command -v certbot)
[[ $node_bin == /usr/* || $node_bin == /opt/* ]] || { echo 'Node 必须安装在 /usr 或 /opt，不能使用 root 家目录内的 nvm。'; exit 1; }
[[ -f "$source_root/package-lock.json" && -d "$source_root/.git" ]] || { echo '请从完整 Git checkout 发布。'; exit 1; }
[[ -z $(git -c safe.directory="$source_root" -C "$source_root" status --porcelain) ]] || { echo '工作区有未提交改动，拒绝发布。'; exit 1; }
commit=$(git -c safe.directory="$source_root" -C "$source_root" rev-parse --short=12 HEAD)
release="/opt/livepilot/releases/${commit}-$(date -u +%Y%m%dT%H%M%S)"
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
node "$source_root/scripts/deployment/render.mjs" --env "$config_file" --out "$stage" --node "$node_bin" --certbot "$certbot_bin" > "$stage/domain"
domain=$(cat "$stage/domain")
[[ -n $domain ]] || exit 1
[[ ! -e /opt/livepilot/current || -L /opt/livepilot/current ]] || { echo "current 必须是发行目录的符号链接，拒绝覆盖普通目录。"; exit 1; }
if [[ -f /etc/livepilot/cloud.env ]]; then
  node --input-type=module - "$config_file" <<'JS'
import {readFileSync} from 'node:fs'; import {parseEnv} from 'node:util';
const old=parseEnv(readFileSync('/etc/livepilot/cloud.env','utf8')), next=parseEnv(readFileSync(process.argv[2],'utf8'));
for(const k of ['LIVEPILOT_ORIGIN','LIVEPILOT_DATA_ROOT','LIVEPILOT_ENCRYPTION_KEY']) if(old[k]!==next[k]) {console.error('现有部署的 '+k+' 不匹配；停止自动部署，按文档先迁移。');process.exit(1);}
JS
fi
id livepilot >/dev/null 2>&1 || useradd --system --home /var/lib/livepilot --shell /usr/sbin/nologin livepilot
install -d -m 755 /opt/livepilot/releases /etc/livepilot /var/www/livepilot-acme
install -d -m 750 -o livepilot -g livepilot /var/lib/livepilot
install -d -m 700 -o livepilot -g livepilot /var/lib/livepilot/data
install -d -m 755 -o livepilot -g livepilot "$release"
# git archive 只复制受版本控制的文件，不复制开发电脑的 .env/.data/node_modules。
git -c safe.directory="$source_root" -C "$source_root" archive HEAD | tar -x -C "$release"
chown -R livepilot:livepilot "$release"
runuser -u livepilot -- env -u NODE_ENV PATH="$PATH" NEXT_TELEMETRY_DISABLED=1 bash -seu -- "$release" <<'BUILD'
cd "$1"
npm ci
npm run verify
BUILD
backup="/var/backups/livepilot/$(date -u +%Y%m%dT%H%M%S)"
install -d -m 700 "$backup"
old_release=$(readlink -f /opt/livepilot/current || true)
for file in /etc/livepilot/cloud.env /etc/nginx/sites-available/livepilot /etc/systemd/system/livepilot.service /etc/systemd/system/livepilot-cert-renew.service /etc/systemd/system/livepilot-cert-renew.timer; do
  [[ ! -f $file ]] || cp -a "$file" "$backup/$(basename "$file")"
done
was_active=false
systemctl is-active --quiet livepilot && was_active=true
# 同目录 rename 原子替换符号链接，读者不会看到缺失的 current。
switch_release() {
  ln -sfn "$1" /opt/livepilot/current.next
  mv -Tf /opt/livepilot/current.next /opt/livepilot/current
}
# 部署失败只回退程序/配置，不覆盖更新后的任务数据。
rollback() {
  local status=$?
  trap - ERR
  if [[ -n $old_release && -d $old_release ]]; then switch_release "$old_release"; fi
  [[ ! -f "$backup/cloud.env" ]] || cp -a "$backup/cloud.env" /etc/livepilot/cloud.env
  [[ ! -f "$backup/livepilot" ]] || cp -a "$backup/livepilot" /etc/nginx/sites-available/livepilot
  [[ ! -f "$backup/livepilot.service" ]] || cp -a "$backup/livepilot.service" /etc/systemd/system/livepilot.service
  [[ ! -f "$backup/livepilot-cert-renew.service" ]] || cp -a "$backup/livepilot-cert-renew.service" /etc/systemd/system/livepilot-cert-renew.service
  [[ ! -f "$backup/livepilot-cert-renew.timer" ]] || cp -a "$backup/livepilot-cert-renew.timer" /etc/systemd/system/livepilot-cert-renew.timer
  systemctl daemon-reload
  if $was_active; then systemctl restart livepilot || true; else systemctl stop livepilot || true; fi
  if nginx -t; then systemctl reload nginx || true; fi
  echo "发布失败，已尝试恢复旧服务；保留发行目录与备份供检查：$backup"; exit "$status"
}
trap rollback ERR
# 首次签证仅安装精确域名的 HTTP 站点，保留服务器其他站点。
if [[ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
  install -m 644 "$stage/nginx-http.conf" /etc/nginx/sites-available/livepilot
  ln -sfn /etc/nginx/sites-available/livepilot /etc/nginx/sites-enabled/livepilot
  nginx -t; systemctl reload nginx
  "$certbot_bin" certonly --webroot -w /var/www/livepilot-acme -d "$domain" --cert-name "$domain" --non-interactive --agree-tos --email "$email"
fi
if $was_active; then systemctl stop livepilot; fi
tar -czf "$backup/data.tgz" -C /var/lib/livepilot data
# 输入可以就是现有 cloud.env；经临时副本安装，避免 same-file 错误。
install -m 600 "$config_file" "$stage/cloud.env"
install -m 640 -o root -g livepilot "$stage/cloud.env" /etc/livepilot/cloud.env
install -m 644 "$stage/livepilot.service" /etc/systemd/system/livepilot.service
install -m 644 "$stage/livepilot-cert-renew.service" /etc/systemd/system/livepilot-cert-renew.service
install -m 644 "$source_root/deploy/livepilot-cert-renew.timer" /etc/systemd/system/livepilot-cert-renew.timer
install -m 644 "$stage/nginx-https.conf" /etc/nginx/sites-available/livepilot
ln -sfn /etc/nginx/sites-available/livepilot /etc/nginx/sites-enabled/livepilot
switch_release "$release"
systemctl daemon-reload
systemctl enable --now livepilot livepilot-cert-renew.timer
nginx -t; systemctl reload nginx
healthy=false
for ((i=0;i<30;i++)); do
  if curl --fail --silent --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" | grep -q '"ok":true'; then healthy=true; break; fi
  sleep 2
done
$healthy || { echo '健康检查未通过'; false; }
"$certbot_bin" renew --cert-name "$domain" --dry-run
trap - ERR
printf '\n部署完成：https://%s\n版本：%s\n回退备份：%s\n' "$domain" "$commit" "$backup"
echo '还需创建成员、设备配对，并由频道持有人完成 Google 授权。见 docs/从零部署.md。'
