#!/bin/bash
# Восстановление того, что не попадает в снапшот рабочего места:
# .git, вендоренные движки (part0-*), модели АПК/PWA и иконки.
set -e
cd -- "$(dirname -- "$0")"
rm -rf /tmp/klq
git clone -q https://github.com/sj0404-collab/koma-local /tmp/klq
cp /tmp/klq/part0-ort.js /tmp/klq/part0-wasm.js /tmp/klq/part0-dict.js .
[ -d .git ] || cp -r /tmp/klq/.git .
mkdir -p apk/app/src/main/assets pwa
cp -r /tmp/klq/apk/app/src/main/assets/models /tmp/klq/apk/app/src/main/assets/plugins apk/app/src/main/assets/ 2>/dev/null || true
cp -r /tmp/klq/pwa/icons pwa/ 2>/dev/null || true
cp /tmp/klq/pwa/manifest.webmanifest pwa/ 2>/dev/null || true
[ -f pwa/sw.js ] && [ -s pwa/sw.js ] && echo "sw.js на месте" || cp /tmp/klq/pwa/sw.js pwa/sw.js
echo "восстановлено"
