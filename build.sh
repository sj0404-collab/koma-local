#!/bin/bash
# Сборка читалки: один самодостаточный html из частей.
#
#   bash build.sh            # собрать koma-web.html
#
# Проверки те же, что в CI: файл не должен быть обрезан, версия на месте,
# ни одной кнопки без обработчика.
set -e
cd -- "$(dirname -- "$0")"

# Две сборки из одних и тех же частей:
#   koma-web.html  — полная: страница + движок WASM (для браузера и стенда);
#   koma-lite.html — без onnxruntime-web (7,8 МБ): её кладём в АПК, потому что
#                    на телефоне всё равно считает нативный ONNX Runtime.
# Просьба 4.11: «библиотеку полностью нативно, без wasm, раз разницы нет».
PARTS_FULL="part1.html part0-ort.js part0-wasm.js part0-dict.js part2.js part3.js part4a-edge.js part4.js part5.js"
PARTS_LITE="part1.html part0-dict.js part2.js part3.js part4a-edge.js part4.js part5.js"
PARTS="$PARTS_FULL"
for f in $PARTS; do
  [ -f "$f" ] || { echo "НЕТ части $f"; exit 1; }
done

cat $PARTS > koma-web.html
VER=$(grep -o "VERSION = 'v[0-9.]*'" koma-web.html | head -1 | grep -o "v[0-9.]*")
SZ=$(stat -c%s koma-web.html)
echo "версия читалки: ${VER:-НЕТ}"
echo "размер: $SZ Б"

[ -n "$VER" ] || { echo "ВЕРСИИ НЕТ — сборка битая"; exit 1; }
[ "$SZ" -gt 5000000 ] || { echo "ФАЙЛ ОБРЕЗАН ($SZ Б)"; exit 1; }

# Ни одной кнопки без обработчика: это уже случалось и давало «мёртвый» экран.
miss=$(python3 - <<'PY'
import re
html = open('koma-web.html', encoding='utf-8').read()
ids = set(re.findall(r'id="(btn[A-Za-z0-9_]+)"', html))
used = set(re.findall(r"\$\('#(btn[A-Za-z0-9_]+)'\)", html)) | set(re.findall(r"getElementById\('(btn[A-Za-z0-9_]+)'\)", html))
print(' '.join(sorted(ids - used)))
PY
)
if [ -n "$miss" ]; then echo "кнопки без обработчика: $miss"; exit 1; fi
echo "проверки: ок"
# ── Сборка для АПК: без WASM ────────────────────────────────────────────────
cat $PARTS_LITE > koma-lite.html
LZ=$(stat -c%s koma-lite.html)
echo "лёгкая сборка (без WASM): $LZ Б"
if ! grep -q "VERSION = 'v" koma-lite.html; then echo "ЛЁГКАЯ СБОРКА БИТАЯ"; exit 1; fi
cp koma-lite.html apk/app/src/main/assets/koma-web.html

# ── PWA: та же полная сборка + манифест, service worker, иконки и модели ─────
# Ставится на главный экран и работает без сети. Модели кладём рядом, чтобы не
# выбирать файлы руками: страница сама находит папку models/ (см. loadBundledModels).
mkdir -p pwa
cp koma-web.html pwa/index.html
cp apk/app/src/main/assets/models/det.onnx        pwa/models/det.onnx
cp apk/app/src/main/assets/models/rec.onnx        pwa/models/rec.onnx
cp apk/app/src/main/assets/models/charset.txt     pwa/models/charset.txt
cp apk/app/src/main/assets/models/best_finetuned_r4.onnx pwa/models/rec2.onnx
for f in pwa/index.html pwa/manifest.webmanifest pwa/sw.js pwa/models/det.onnx pwa/models/rec.onnx pwa/models/charset.txt pwa/models/rec2.onnx; do
  [ -s "$f" ] || { echo "PWA: нет $f"; exit 1; }
done
PZ=$(du -sm pwa | cut -f1)
echo "PWA готова: pwa/ (${PZ} МБ)"
