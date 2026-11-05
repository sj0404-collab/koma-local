# -*- coding: utf-8 -*-
"""Один файл: страница + движок WASM + модели внутри.

Нужен для случая «некуда ставить»: файл открывается прямо с диска телефона,
без сервера, без установки, без сети. Модели вшиты в base64 — страница берёт их
из window.__KOMA_BUNDLED (см. OCR.loadBundledModels).
"""
import base64, os, sys

KL = '/home/user/kl'
OUT = '/home/user/koma-standalone.html'
MODELS = os.path.join(KL, 'apk/app/src/main/assets/models')


def main():
    html = open(os.path.join(KL, 'koma-web.html'), encoding='utf-8').read()
    det = base64.b64encode(open(os.path.join(MODELS, 'det.onnx'), 'rb').read()).decode()
    rec = base64.b64encode(open(os.path.join(MODELS, 'rec.onnx'), 'rb').read()).decode()
    r4 = base64.b64encode(open(os.path.join(MODELS, 'best_finetuned_r4.onnx'), 'rb').read()).decode()
    charset = open(os.path.join(MODELS, 'charset.txt'), encoding='utf-8').read()
    inject = ('<script>window.__KOMA_BUNDLED={det:"' + det + '",rec:"' + rec
              + '",rec2:"' + r4 + '",charset:' + __import__('json').dumps(charset) + '};</script>\n')
    marker = '<link rel="manifest"'
    assert marker in html
    html = html.replace(marker, inject + marker, 1)
    open(OUT, 'w', encoding='utf-8').write(html)
    print('готово', OUT, os.path.getsize(OUT), 'Б')


if __name__ == '__main__':
    main()
