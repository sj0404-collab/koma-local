#!/usr/bin/env python3
"""Регресс на настоящих страницах: прогоняет Mieruko через WASM-путь страницы.

Запуск: python3 tools/corpus.py [koma-web.html] [/tmp/out.json]
"""
import json, sys, glob
from playwright.sync_api import sync_playwright

HTML = sys.argv[1] if len(sys.argv) > 1 else '/home/user/kl/koma-web.html'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/corpus.json'
MODELS = '/home/user/koma-lab/models2/'
PAGES = sorted(glob.glob('/home/user/mieruko/mieruko-ch01-p*.jpg'))
if __import__('os').environ.get('LIMIT'): PAGES = PAGES[:int(__import__('os').environ['LIMIT'])]

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 900, 'height': 1200})
    errs = []
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.goto('file://' + HTML, wait_until='domcontentloaded')
    p.wait_for_timeout(1500)
    p.set_input_files('#modelPick', [MODELS + 'detection.onnx', MODELS + 'cyrillic.onnx', MODELS + 'cyrillic.txt'])
    for _ in range(200):
        if p.evaluate("() => typeof OCR !== 'undefined' && !!OCR.ready"):
            break
        p.wait_for_timeout(500)
    p.set_input_files('#imgPick', PAGES)
    p.wait_for_timeout(4000)
    p.click('#libGrid .card', position={'x': 40, 'y': 40})
    p.wait_for_timeout(3000)
    res = {}
    for i in range(len(PAGES)):
        got = p.evaluate("""(i) => Reader.scanPage(i, {full: true, force: true})
            .then(d => ({n: (d && d.lines || []).length, lines: (d && d.lines || []).map(l => l.text)}))""", i)
        res['p%02d' % (i + 2)] = got
        print('p%02d (страница %d): %d реплик' % (i + 2, i + 1, got['n']), flush=True)
        for t in got['lines']:
            print('    ', t, flush=True)
    res['errors'] = errs[:5]
    json.dump(res, open(OUT, 'w'), ensure_ascii=False, indent=1)
    print('ошибки:', res['errors'])
    b.close()
