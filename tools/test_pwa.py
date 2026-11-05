# -*- coding: utf-8 -*-
"""Проверка PWA: страница открывается, service worker встаёт, модели берутся из
папки models/ сами, и распознавание идёт ПОЛНЫМ путём страницы в WASM (детектор →
резка → чтец), без мока моста и без АПК.

Пишет снимки экрана в /home/user/agon-test/pwa-*.png и печатает строки, которые
распознались на настоящей странице манги.
"""
import json, os, shutil, subprocess, sys, time

ROOT = '/home/user/kl/pwa'
SITE_PORT = 8791
SHOTS = '/home/user/agon-test'
OUT = []


def log(*a):
    line = ' '.join(str(x) for x in a)
    print(line, flush=True)
    OUT.append(line)


def main():
    # тестовая страница кладётся рядом, чтобы её можно было взять fetch'ем
    os.makedirs(os.path.join(ROOT, 'test'), exist_ok=True)
    shutil.copy('/home/user/mieruko/mieruko-ch01-p05.jpg', os.path.join(ROOT, 'test', 'page.jpg'))

    LIVE = 'https://sj0404-collab.github.io/koma-local/index.html'
    live = len(sys.argv) > 1 and sys.argv[1] == 'live'
    srv = None
    if not live:
        srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(SITE_PORT)],
                               cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.2)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            br = pw.chromium.launch(args=['--no-sandbox'])
            pg = br.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
            errs = []
            pg.on('console', lambda m: errs.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))

            pg.goto(LIVE if live else f'http://127.0.0.1:{SITE_PORT}/index.html', wait_until='load')
            pg.wait_for_function('typeof OCR !== "undefined" && typeof recognizePage === "function"', timeout=60000)
            log('страница PWA открылась, скрипт читалки на месте')

            # 1) service worker
            pg.wait_for_timeout(2500)
            sw = pg.evaluate("""async () => {
              let r = await navigator.serviceWorker.getRegistration();
              let err = '';
              if (!r) {
                try { r = await navigator.serviceWorker.register('sw.js', { scope: './' }); }
                catch (e) { err = String((e && e.message) || e); }
              }
              return { ok: !!r, scope: r ? r.scope : '', active: !!(r && r.active),
                       err, secure: window.isSecureContext, proto: location.protocol };
            }""")
            log('service worker:', json.dumps(sw, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'pwa-01-start.png'))

            # 2) модели из папки
            st = pg.evaluate("""async () => {
              const t0 = performance.now();
              const ok = await OCR.loadModels();
              return {
                ok, engine: OCR.engine, reason: OCR.reason || '',
                sec: +((performance.now() - t0) / 1000).toFixed(2),
                hasDet: !!OCR.det, hasRec: !!OCR.rec, rec2: OCR.rec2Note || '',
                dict: (OCR.dict ? OCR.dict.length : 0),
                words: (typeof Words !== 'undefined' && Words.ready) ? Words.size : 0,
              };
            }""")
            log('модели:', json.dumps(st, ensure_ascii=False))
            if not st.get('hasDet'):
                log('ПРОВАЛ: модели из папки models/ не поднялись')
            if not st.get('words'):
                log('ПРОВАЛ: словарь не загрузился')

            # 3) настоящее распознавание страницы в WASM
            import base64 as _b64
            src = ('data:image/jpeg;base64,' + _b64.b64encode(open('/home/user/mieruko/mieruko-ch01-p05.jpg','rb').read()).decode()) if live else 'test/page.jpg'
            res = pg.evaluate("""async (src) => {
              const img = new Image();
              img.src = src;
              await img.decode();
              const c = document.createElement('canvas');
              c.width = img.naturalWidth; c.height = img.naturalHeight;
              c.getContext('2d').drawImage(img, 0, 0);
              const t0 = performance.now();
              const r = await recognizePage(c, RULES, () => {}, null, null);
              let lines = [];
              try {
                const ordered = readingOrder(r.regions, true, true, RULES);
                lines = ordered.map(l => String(l.text || ''));
              } catch (e) { lines = ['ОШИБКА порядка: ' + String(e)]; }
              return {
                keys: Object.keys(r),
                texts: (r.regions || []).length,
                sec: +((performance.now() - t0) / 1000).toFixed(1),
                plan: r.plan || '', crops: r.crops || 0, boxes: r.boxes || 0,
                lines,
              };
            }""", src)
            log('распознавание:', json.dumps({k: res[k] for k in ('sec', 'plan', 'crops', 'boxes')}, ensure_ascii=False))
            log('поля ответа:', json.dumps(res.get('keys', []), ensure_ascii=False),
                'регионов:', (res.get('texts') if isinstance(res.get('texts'), int) else '?'))
            for i, t in enumerate(res['lines'], 1):
                log(f'  {i}. {t}')
            pg.screenshot(path=os.path.join(SHOTS, 'pwa-02-loaded.png'))

            pg.screenshot(path=os.path.join(SHOTS, 'pwa-02-live.png'))
            # 4) офлайн: отключаем сеть и перезагружаем
            pg.context.set_offline(True)
            try:
                pg.reload(wait_until='load', timeout=60000)
                ok = pg.evaluate('typeof OCR !== "undefined"')
                log('без сети страница открылась:', ok)
                pg.screenshot(path=os.path.join(SHOTS, 'pwa-03-offline.png'))
                off = pg.evaluate("""async () => {
                  const ok = await OCR.loadModels();
                  return { ok, hasDet: !!OCR.det, words: (typeof Words !== 'undefined' && Words.ready) ? Words.size : 0 };
                }""")
                log('без сети модели:', json.dumps(off, ensure_ascii=False))
            except Exception as e:
                log('без сети открыть не удалось:', str(e)[:200])
            pg.context.set_offline(False)

            log('ошибки консоли:', json.dumps(errs[:8], ensure_ascii=False))
            br.close()
    finally:
        if srv: srv.terminate()
        try:
            os.remove(os.path.join(ROOT, 'test', 'page.jpg'))
            os.rmdir(os.path.join(ROOT, 'test'))
        except Exception:
            pass
    open(os.path.join(SHOTS, 'pwa-result.txt'), 'w', encoding='utf-8').write('\n'.join(OUT))
    print('готово')


if __name__ == '__main__':
    main()
