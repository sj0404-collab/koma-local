# -*- coding: utf-8 -*-
"""Проверка одного файла: открыт с диска (file://), без сервера и без сети.
Смотрим, что модели берутся из самого файла и что распознавание идёт полным путём."""
import json, os, time
from playwright.sync_api import sync_playwright

SHOTS = '/home/user/agon-test'
OUT = []


def log(*a):
    line = ' '.join(str(x) for x in a)
    print(line, flush=True)
    OUT.append(line)


t0 = time.time()
with sync_playwright() as pw:
    br = pw.chromium.launch(args=['--no-sandbox', '--allow-file-access-from-files'])
    pg = br.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
    errs = []
    pg.on('console', lambda m: errs.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.goto('file:///home/user/koma-standalone.html', wait_until='load', timeout=180000)
    log('файл открылся с диска за', round(time.time() - t0, 1), 'с')
    pg.wait_for_function('typeof OCR !== "undefined" && typeof recognizePage === "function"', timeout=120000)
    st = pg.evaluate("""async () => {
      const t = performance.now();
      const ok = await OCR.loadModels();
      return { ok, engine: OCR.engine, hasDet: !!OCR.det, hasRec: !!OCR.rec,
               sec: +((performance.now() - t) / 1000).toFixed(1),
               words: (typeof Words !== 'undefined' && Words.ready) ? Words.size : 0,
               sw: ('serviceWorker' in navigator) };
    }""")
    log('модели из файла:', json.dumps(st, ensure_ascii=False))
    pg.screenshot(path=os.path.join(SHOTS, 'standalone-01.png'))
    res = pg.evaluate("""async () => {
      const img = new Image(); img.src = 'file:///home/user/_probe-page.jpg';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const t = performance.now();
      const r = await recognizePage(c, RULES, () => {}, null, null);
      let lines = [];
      try { lines = readingOrder(r.regions, true, true, RULES).map(l => String(l.text || '')); } catch (e) {}
      return { sec: +((performance.now() - t) / 1000).toFixed(1), boxes: r.boxes || 0, crops: r.crops || 0, lines };
    }""")
    log('распознавание с диска:', json.dumps({k: res[k] for k in ('sec', 'boxes', 'crops')}, ensure_ascii=False))
    for i, t in enumerate(res['lines'], 1):
        log(f'  {i}. {t}')
    log('ошибки:', json.dumps(errs[:6], ensure_ascii=False))
    br.close()

open(os.path.join(SHOTS, 'standalone-result.txt'), 'w', encoding='utf-8').write('\n'.join(OUT))
print('готово')
