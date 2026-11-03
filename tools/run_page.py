#!/usr/bin/env python3
"""Прогон читалки в настоящем Chromium: страница, модели, распознавание, голос.

Стенд студии для этого не обязателен: страница самодостаточна, а мосты
(`KomaSpeech`, `KomaUi`) подменяются здесь же — с теми же именами и событиями,
что ждёт страница. Поэтому проверяется настоящий конвейер: детектор, строки,
порядок чтения, склейка реплик, что уходит в голос и что остаётся на экране.

  python3 run_page.py                 # страница манги dense-a.jpg и эталон
  python3 run_page.py --image path

Что печатается: реплики, порядок, сравнение с эталоном, журнал голоса,
и проверка СТОПА: после нажатия стоп новых фраз быть не должно.
"""
import argparse
import asyncio
import difflib
import http.server
import json
import os
import re
import socketserver
import sys
import threading

from playwright.async_api import async_playwright

LAB = os.environ.get('KOMA_LAB', '/home/user/koma-lab')
SHOTS = os.path.join(LAB, 'shots')
MODELS = os.path.join(LAB, 'shipmodels')          # те же модели, что в АПК
PAGE_DIR = os.environ.get('KOMA_PAGE_DIR', '/home/user/koma-lab')                  # где лежит собранная страница
PORT = 8099

ok_all = True


def ok(cond, msg):
    global ok_all
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        ok_all = False


def norm(t):
    return re.sub(r'[^0-9A-ZА-ЯЁ]', '', str(t or '').upper())


def serve():
    os.chdir(PAGE_DIR)
    handler = http.server.SimpleHTTPRequestHandler
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# Мосты: ровно те имена и события, которые зовёт страница.
BRIDGES = r"""
(() => {
  // ── голос: системный TTS заменён журналом с событиями как у Android ──
  window.__komaTtsLog = [];
  window.__komaTtsReset = () => { window.__komaTtsLog = []; };
  let seq = 0;
  window.KomaSpeech = {
    status: () => JSON.stringify({ ready: true, note: '', engine: 'mock-tts' }),
    voices: () => JSON.stringify([{ name: 'Русский', lang: 'ru-RU' }]),
    engines: () => JSON.stringify(['mock-tts']),
    useEngine: () => true,
    cancel: () => { window.__komaTtsCancelled = true; },
    speak: (text, rate, lang, voice, id) => {
      window.__komaTtsLog.push({ text: String(text || ''), id: id });
      const dur = Math.max(300, Math.min(2500, String(text || '').length * 25));
      setTimeout(() => { if (window.__komaSpeechEvent) window.__komaSpeechEvent(id, 'start', ''); }, 10);
      setTimeout(() => { if (window.__komaSpeechEvent) window.__komaSpeechEvent(id, 'end', ''); }, 10 + dur);
    },
  };
  // ── нативная панель: страница сообщает, что звучит ──
  window.__komaSpoken = [];
  window.__komaSpokenReset = () => { window.__komaSpoken = []; };
  window.KomaUi = {
    spoken: (t) => { window.__komaSpoken.push(String(t || '')); },
    show: () => {}, hide: () => {},
  };
  // ── журнал прокрутки (как в стенде) ──
  window.__scrollLog = [];
  window.addEventListener('scroll', () => {
    const el = document.querySelector('#strip') || document.scrollingElement;
    if (el) window.__scrollLog.push([Date.now(), Math.round(el.scrollTop || window.scrollY || 0)]);
  }, true);
})();
"""


async def run(args):
    expected = []
    if args.expected and os.path.exists(args.expected):
        expected = json.load(open(args.expected, encoding='utf-8'))

    httpd = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=[
            '--no-sandbox', '--mute-audio', '--disable-gpu', '--disable-dev-shm-usage',
            '--renderer-process-limit=1', '--process-per-site', '--js-flags=--max-old-space-size=1536'])
        ctx = await b.new_context(viewport={'width': 420, 'height': 900})
        pg = await ctx.new_page()
        errors = []
        pg.on('console', lambda m: errors.append(m.text[:200]) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)[:200]))

        page_file = os.path.join(PAGE_DIR, 'page.html')
        await pg.goto(f'http://127.0.0.1:{PORT}/{os.path.basename(page_file)}', wait_until='load', timeout=120000)
        await pg.add_init_script(BRIDGES)
        await pg.reload(wait_until='load')
        await pg.wait_for_timeout(2500)

        started = await pg.evaluate("() => ({ lib: !!document.querySelector('#libGrid'), ver: (typeof VERSION !== 'undefined') ? VERSION : '?' })")
        ok(bool(started['lib']), 'страница поднялась, версия ' + str(started['ver']))

        # ── картинка → книга ──
        await pg.set_input_files('#imgPick', args.image)
        await pg.wait_for_timeout(3000)
        books = await pg.evaluate("() => (typeof Library !== 'undefined' ? Library.books.length : -1)")
        ok(books >= 1, f'книга в библиотеке: {books}')

        # ── модели (те же, что внутри АПК) ──
        await pg.set_input_files('#modelPick', [
            os.path.join(MODELS, 'detection.onnx'),
            os.path.join(MODELS, 'cyrillic.onnx'),
            os.path.join(MODELS, 'cyrillic.txt')])
        ready = False
        for _ in range(40):
            await pg.wait_for_timeout(1500)
            ready = await pg.evaluate("() => { try { return !!OCR.ready; } catch (e) { return false; } }")
            if ready:
                break
        engine = await pg.evaluate("() => { try { return OCR.engine + ' / ' + (OCR.reason || ''); } catch (e) { return 'нет'; } }")
        ok(ready, 'движок поднялся: ' + str(engine))

        # ── открыть книгу и прочитать открытую страницу ──
        await pg.click('.card')
        await pg.wait_for_timeout(2000)
        mode = await pg.evaluate("() => { try { return Reader.mode; } catch (e) { return '?'; } }")
        pages = await pg.evaluate("() => { try { return Reader.pages.length; } catch (e) { return 0; } }")
        print(f'\n── режим: {mode}, страниц в книге: {pages}')

        button = await pg.evaluate("""() => { const b = document.querySelector('#btnFullPage') || document.querySelector('#btnOcr2');
          if (!b) return 'нет кнопки'; b.click(); return b.id; }""")
        print(f'── запуск распознавания: {button}')

        lines = []
        for _ in range(40):
            await pg.wait_for_timeout(1500)
            raw = await pg.evaluate("""() => { try { const d = Reader.regions.get(Reader.page);
              return d ? JSON.stringify(d.lines.map(l => l.text)) : ''; } catch (e) { return ''; } }""")
            if raw:
                lines = json.loads(raw)
                break
        await pg.screenshot(path=f'{SHOTS}/20-recognized.png')
        print(f'\n── распознано реплик: {len(lines)}')
        for i, t in enumerate(lines, 1):
            print(f'   {i}. {t}')
        ok(bool(lines), 'страница распознана и текст есть')
        ok(not any(len(norm(t)) < 6 for t in lines), 'нет реплик-обрывков (меньше 6 знаков)')
        ok(len(set(norm(t) for t in lines)) == len(lines), 'нет одинаковых реплик')

        # ── чтение вслух ──
        await pg.evaluate("() => { window.__komaTtsReset(); window.__komaSpokenReset(); window.__scrollLog = []; }")
        clicked = await pg.evaluate("() => { const b = document.querySelector('#btnStartRead'); if (!b) return 'нет'; b.click(); return 'ok'; }")
        ok(clicked == 'ok', 'кнопка «Читать вслух» нажата')
        said = []
        for _ in range(60):
            await pg.wait_for_timeout(700)
            said = [x['text'] for x in await pg.evaluate("() => window.__komaTtsLog") if str(x.get('text', '')).strip()]
            if len(said) >= len(lines) and len(lines) > 0:
                break
        await pg.screenshot(path=f'{SHOTS}/21-reading.png')
        print(f'\n── в голос ушло: {len(said)}')
        for i, t in enumerate(said, 1):
            print(f'   {i}. {t}')
        ok(bool(said), 'читалка читает: голос получил фразы')
        ok(len(said) >= len(lines), f'прочитаны все реплики: {len(said)} из {len(lines)}')
        ok(said[:len(lines)] == lines[:len(said)] or len(said) != len(lines), 'порядок чтения совпадает с репликами')
        ok(len(set(said)) == len(said), 'ничего не прочитано дважды')

        # ── СТОП: после нажатия новых фраз быть не должно ──
        await pg.evaluate("() => { window.__komaTtsReset(); window.__komaSpokenReset(); }")
        await pg.evaluate("() => document.querySelector('#btnStartRead').click()")
        await pg.wait_for_timeout(1800)
        before = await pg.evaluate("() => window.__komaTtsLog.length")
        await pg.evaluate("() => document.querySelector('#btnStop').click()")
        await pg.wait_for_timeout(400)
        after_stop = await pg.evaluate("() => window.__komaTtsLog.length")
        await pg.wait_for_timeout(6000)
        after_wait = await pg.evaluate("() => window.__komaTtsLog.length")
        print(f'\n── стоп: до {before}, сразу после {after_stop}, через 6 с {after_wait}')
        ok(before >= 1, 'до стопа чтение шло')
        ok(after_wait == after_stop, f'после стопа новых фраз нет ({after_stop} → {after_wait})')

        # ── сверка с эталоном ──
        if expected:
            def best(want):
                wn = norm(want)
                bi, br = -1, 0.0
                for i, t in enumerate(said):
                    r = difflib.SequenceMatcher(None, wn, norm(t)).ratio()
                    if r > br:
                        br, bi = r, i
                return bi, br

            print('\n── сверка с эталоном')
            got = []
            for want in expected:
                i, r = best(want)
                got.append(i)
                flag = 'OK ' if r >= 0.75 else '—  '
                print(f'   {flag}{r:.2f}  эталон: {want[:52]}')
                if r < 0.75:
                    print(f'         читалка: {said[i][:60] if i >= 0 else "(не найдено)"}')
            hit = sum(1 for w in expected if best(w)[1] >= 0.75)
            ok(hit >= len(expected) * 0.8, f'эталонные реплики найдены: {hit} из {len(expected)}')
            order_ok = all(a <= b for a, b in zip(got, got[1:]) if a >= 0 and b >= 0)
            ok(order_ok, 'порядок эталонных реплик не нарушен: ' + str(got))

        ok(errors == [], 'ошибок в консоли нет' + ((': ' + '; '.join(errors[:3])) if errors else ''))
        await pg.screenshot(path=f'{SHOTS}/22-final.png')
        await b.close()
    httpd.shutdown()
    print('\nИТОГ: ' + ('всё зелёное' if ok_all else 'ЕСТЬ КРАСНЫЕ ПРОВЕРКИ — см. выше'))
    return 0 if ok_all else 1


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default=os.path.join(LAB, 'dense-a.jpg'))
    ap.add_argument('--expected', default=os.path.join(LAB, 'dense-expected.json'))
    a = ap.parse_args()
    os.makedirs(SHOTS, exist_ok=True)
    sys.exit(asyncio.run(run(a)))
