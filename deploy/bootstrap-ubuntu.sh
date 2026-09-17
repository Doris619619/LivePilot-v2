#!/usr/bin/env bash
# 安装 Ubuntu 云端依赖；Node 仅取自 nodejs.org 并校验官方 SHA256，不创建云资源。
set -Eeuo pipefail
[[ ${EUID} == 0 ]] || { echo '使用 sudo bash deploy/bootstrap-ubuntu.sh [Node版本]'; exit 1; }
version=${1:-22.23.1}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '版本格式应为 22.23.1'; exit 1; }
case $(uname -m) in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo '仅支持 x64/arm64'; exit 1;; esac
apt-get update
apt-get install -y ca-certificates curl xz-utils git nginx certbot python3
archive="node-v${version}-linux-${arch}.tar.xz"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
curl --fail --silent --show-error --location "https://nodejs.org/dist/v${version}/$archive" -o "$tmp/$archive"
curl --fail --silent --show-error --location "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
(cd "$tmp" && grep "  $archive\$" SHASUMS256.txt | sha256sum --check --strict)
# 不覆盖正在使用的 Node：升级现有主机前先在维护窗口人工选择版本。
if command -v node >/dev/null; then
  echo '主机已有 Node，保留原版本。若低于 22.23，请按文档在维护窗口升级。'
else
  tar -xJf "$tmp/$archive" -C /usr/local --strip-components=1
fi
node --version
systemctl enable --now nginx
