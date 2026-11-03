#!/bin/bash
# Сборка читалки: один самодостаточный html из частей.
#
#   bash build.sh            # собрать koma-web.html
#
# Проверки те же, что в CI: файл не должен быть обрезан, версия на месте,
# ни одной кнопки без обработчика.
set -e
cd -- "$(dirname -- "$0")"

PARTS="part1.html part0-ort.js part0-wasm.js part0-dict.js part2.js part3.js part4.js part5.js"
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
cp koma-web.html apk/app/src/main/assets/koma-web.html
