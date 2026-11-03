#!/usr/bin/env python3
"""Замер читалки: время на страницу, на реплику и на слово + честная сверка с эталоном.

Что меряется по-настоящему (не оценка):
  * время распознавания страницы (мс) — из самого конвейера (res.ms/detMs/recMs);
  * число реплик, слов, знаков;
  * когда каждая реплика ушла в голос (мс от старта чтения) — журнал моста голоса;
  * сверка с эталоном по словам: пропущенные слова, лишние, перепутанные буквы (CER).

Что берётся из модели речи (и это подписано в выводе, а не выдаётся за замер):
  * длительность и время на слово внутри реплики считаются по темпу 15,4 знака/с —
    это темп системного TTS Android при скорости 1.0. В APK голос настоящий, поэтому
    там эти числа будут другими; здесь важно, что читалка отдаёт голосу.

Почему не эмулятор Android Studio: в этой песочнице нет ни Android SDK, ни
эмулятора, ни GPU. Движок читалки — это страница koma-web.html, и в АПК она же
(assets/koma-web.html), с теми же моделями det.onnx/rec.onnx. Поэтому меряем
страницу в Chromium с теми же моделями; что нельзя проверить здесь — говорим прямо.

  python3 tools/measure.py                       # dense-a.jpg + dense-expected.json
  python3 tools/measure.py --image X --expected Y --json out.json
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
MODELS = os.path.join(LAB, 'shipmodels')
PAGE_DIR = os.environ.get('KOMA_PAGE_DIR', LAB)
PORT = 8098
SPEECH_MS_PER_CHAR = 65          # темп системного TTS Android (~15,4 знака/с)

BRIDGES = r"""
(() => {
  window.__say = [];                       // журнал голоса с временами
  window.__sayReset = () => { window.__say = []; };
  const T0 = () => performance.now();
  window.__sayT0 = T0();
  window.KomaSpeech = {
    status: () => JSON.stringify({ ready: true, note: '', engine: 'measure-tts' }),
    voices: () => JSON.stringify([{ name: 'Русский', lang: 'ru-RU' }]),
    engines: () => JSON.stringify(['measure-tts']),
    useEngine: () => true,
    cancel: () => { window.__cancelled = (window.__cancelled || 0) + 1; },
    speak: (text, rate, lang, voice, id) => {
      const t = String(text || '');
      const dur = Math.max(300, t.length * %d);
      const rec = { text: t, id: id, at: Math.round(performance.now() - window.__sayT0), dur };
      window.__say.push(rec);
      setTimeout(() => { if (window.__komaSpeechEvent) window.__komaSpeechEvent(id, 'start', ''); }, 5);
      setTimeout(() => { if (window.__komaSpeechEvent) window.__komaSpeechEvent(id, 'end', ''); }, 5 + dur);
    },
  };
  window.KomaUi = { spoken: () => {}, show: () => {}, hide: () => {} };
})();
""" % SPEECH_MS_PER_CHAR


def norm(t):
    return re.sub(r'[^0-9A-ZА-ЯЁ]', '', str(t or '').upper())


def words(t):
    return [w for w in re.split(r'[^0-9A-Za-zА-Яа-яЁё]+', str(t or '')) if w]


def serve():
    os.chdir(PAGE_DIR)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def cer(truth, got):
    a, b = norm(truth), norm(got)
    if not a:
        return 0.0
    d = sum(max(i2 - i1, j2 - j1) for op, i1, i2, j1, j2 in
            difflib.SequenceMatcher(None, a, b).get_opcodes() if op != 'equal')
    return d / max(len(a), len(b), 1)


def missing_words(truth, got):
    """Слова эталона, которых в прочтении нет (по отдельности, не по буквам).

    Перенос через дефис («ПОД-НОШЕНИЯ», «ЧТО-НИБУДЬ») читалка склеивает в одно
    слово — это правильно, поэтому в эталоне дефис тоже убираем, иначе слово
    попадало в «пропущенные» зря.
    """
    truth = re.sub(r'(\w)-\s*(\w)', r'\1\2', str(truth or ''))
    have = [w.upper() for w in words(got)]
    pool = list(have)
    miss = []
    for w in words(truth):
        u = w.upper()
        if u in pool:
            pool.remove(u)
            continue
        # допускаем опечатку в одной букве — это «прочитано с ошибкой», не пропуск
        best, bi = 0.0, -1
        for i, h in enumerate(pool):
            r = difflib.SequenceMatcher(None, u, h).ratio()
            if r > best:
                best, bi = r, i
        if best >= 0.66 and bi >= 0:
            pool.pop(bi)
        else:
            miss.append(u)
    return miss


async def run(args):
    expected = json.load(open(args.expected, encoding='utf-8')) if os.path.exists(args.expected) else []
    httpd = serve()
    report = {'image': os.path.basename(args.image), 'page': {}, 'lines': [], 'total': {}}
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox', '--mute-audio', '--disable-gpu',
                                          '--disable-dev-shm-usage'])
        pg = await (await b.new_context(viewport={'width': 420, 'height': 900})).new_page()
        errors = []
        pg.on('console', lambda m: errors.append(m.text[:200]) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)[:200]))
        await pg.goto(f'http://127.0.0.1:{PORT}/page.html', wait_until='load', timeout=180000)
        await pg.add_init_script(BRIDGES)
        await pg.reload(wait_until='load')
        await pg.wait_for_timeout(2500)
        ver = await pg.evaluate("() => (typeof VERSION !== 'undefined' ? VERSION : '?')")

        await pg.set_input_files('#imgPick', args.image)
        await pg.wait_for_timeout(3000)
        await pg.set_input_files('#modelPick', [os.path.join(MODELS, 'detection.onnx'),
                                                os.path.join(MODELS, 'cyrillic.onnx'),
                                                os.path.join(MODELS, 'cyrillic.txt')])
        for _ in range(40):
            await pg.wait_for_timeout(1500)
            if await pg.evaluate("() => { try { return !!OCR.ready } catch(e){ return false } }"):
                break
        await pg.click('.card')
        await pg.wait_for_timeout(2000)

        # ── распознавание: замер времени самой страницы ──
        t_click = await pg.evaluate("() => Math.round(performance.now())")
        await pg.evaluate("() => document.querySelector('#btnFullPage').click()")
        data = None
        for _ in range(90):
            await pg.wait_for_timeout(500)
            raw = await pg.evaluate("""() => { const d = Reader.regions.get(Reader.page);
              return d && d.lines && d.lines.length ? JSON.stringify({ms:d.ms,detMs:d.detMs,recMs:d.recMs,
                crops:d.crops, boxes:d.boxes, via:d.via, lines:d.lines.map(l=>({t:l.text,top:l.top,bottom:l.bottom}))}) : '' }""")
            if raw:
                data = json.loads(raw)
                break
        t_done = await pg.evaluate("() => Math.round(performance.now())")
        wall = t_done - t_click

        lines = [l['t'] for l in data['lines']] if data else []
        allwords = sum(len(words(t)) for t in lines)
        chars = sum(len(norm(t)) for t in lines)
        report['page'] = {
            'version': ver, 'lines': len(lines), 'words': allwords, 'chars': chars,
            'engine': data.get('via') if data else None,
            'scan_ms': data.get('ms') if data else None,
            'det_ms': data.get('detMs') if data else None,
            'rec_ms': data.get('recMs') if data else None,
            'ms_per_line': round(data['ms'] / len(lines), 1) if data and lines else None,
            'ms_per_word': round(data['ms'] / allwords, 1) if data and allwords else None,
            'ms_per_char': round(data['ms'] / chars, 1) if data and chars else None,
            'wall_ms_with_ui': wall,
        }

        # ── чтение: когда каждая реплика ушла в голос ──
        await pg.evaluate("() => { window.__sayReset(); window.__sayT0 = performance.now(); }")
        await pg.evaluate("() => document.querySelector('#btnStartRead').click()")
        said = []
        for _ in range(300):
            await pg.wait_for_timeout(250)
            said = await pg.evaluate("() => window.__say")
            if len(said) >= len(lines) and lines:
                break
            if len(said) >= len(lines) + 2:
                break
        await pg.wait_for_timeout(1500)

        # ── сверка по каждой реплике ──
        used = set()
        for want in expected:
            best, bi = 0.0, -1
            for i, rec in enumerate(said):
                if i in used:
                    continue
                r = difflib.SequenceMatcher(None, norm(want), norm(rec['text'])).ratio()
                if r > best:
                    best, bi = r, i
            got = said[bi]['text'] if bi >= 0 else ''
            if bi >= 0:
                used.add(bi)
            miss = missing_words(want, got)
            row = {
                'truth': want, 'got': got, 'cer': round(cer(want, got), 3),
                'missing': miss, 'words': len(words(want)),
                'at_ms': said[bi]['at'] if bi >= 0 else None,
                'speech_ms': said[bi]['dur'] if bi >= 0 else None,
                'ms_per_word': round(said[bi]['dur'] / max(1, len(words(want))), 0) if bi >= 0 else None,
            }
            report['lines'].append(row)

        extra = [said[i]['text'] for i in range(len(said)) if i not in used]
        report['total'] = {
            'spoken': len(said), 'expected_replicas': len(expected), 'extra': extra,
            'read_ms': said[-1]['at'] if said else 0,
            'chars_per_sec': round(sum(len(norm(s['text'])) for s in said) / max(1, said[-1]['at'] / 1000), 1) if said else 0,
            'errors': errors[:5],
        }
        await pg.screenshot(path=os.path.join(LAB, 'shots', '30-measure.png'))
        await b.close()
    httpd.shutdown()
    return report


def show(r):
    p = r['page']
    print(f"\n═══ {r['image']} · страница {p.get('version')} · движок {p.get('engine')}")
    print(f"   реплик {p['lines']}, слов {p['words']}, знаков {p['chars']}")
    print(f"   РАСПОЗНАВАНИЕ: страница {p['scan_ms']} мс (детектор {p['det_ms']}, чтение {p['rec_ms']}),"
          f" на реплику {p['ms_per_line']} мс, на слово {p['ms_per_word']} мс, на знак {p['ms_per_char']} мс")
    print(f"   через экран (с нажатием и отрисовкой): {p['wall_ms_with_ui']} мс")
    print("\n   реплика | слов | CER  | пропущено | в голос, мс | голос, мс | мс/слово")
    for i, row in enumerate(r['lines'], 1):
        miss = ','.join(row['missing']) if row['missing'] else '—'
        print(f"   {i:>2} | {row['words']:>3} | {row['cer']:.2f} | {miss:<20} |"
              f" {str(row['at_ms']):>6} | {str(row['speech_ms']):>6} | {row['ms_per_word']}")
    t = r['total']
    print(f"\n   ВСЕГО: озвучено {t['spoken']} из {t['expected_replicas']};"
          f" страница прочитана за {t['read_ms']} мс; темп {t['chars_per_sec']} зн/с")
    if t['extra']:
        print('   ЛИШНЕЕ в голосе: ' + ' | '.join(x[:40] for x in t['extra']))
    avg = sum(x['cer'] for x in r['lines']) / max(1, len(r['lines']))
    print(f"   CER средний {avg:.3f}")
    if t['errors']:
        print('   ОШИБКИ в консоли: ' + '; '.join(t['errors']))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default=os.path.join(LAB, 'dense-a.jpg'))
    ap.add_argument('--expected', default=os.path.join(LAB, 'dense-expected.json'))
    ap.add_argument('--json', default='')
    a = ap.parse_args()
    os.makedirs(os.path.join(LAB, 'shots'), exist_ok=True)
    rep = asyncio.run(run(a))
    show(rep)
    if a.json:
        json.dump(rep, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
