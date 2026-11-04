"""Ровно та конфигурация, что уезжает в АПК 1.0.20: страница БЕЗ WASM,
движок только нативный (мост KomaOcr подставлен). Те же строки, что телефон
отдал 4.11, прогоняем через сборку реплик."""
import sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, '/home/user/kl/tools')
from native_bridge_sim import RAW, STUB   # те же строки и тот же мост

PAGE = 'file:///home/user/kl/koma-lite.html'
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 390, 'height': 844})
    errs = []
    p.on('pageerror', lambda e: errs.append(str(e)))
    # мост ставим ДО загрузки страницы, как в АПК (addJavascriptInterface)
    p.add_init_script("window.__komaNativeOnBoot = true;")
    p.add_init_script("(" + STUB + ")(" + repr(RAW).replace("'", '"') + ")")
    p.goto(PAGE, wait_until='domcontentloaded')
    p.wait_for_timeout(3000)
    state = p.evaluate("() => ({ort: typeof ort, ready: !!OCR.ready, engine: OCR.engine, dict: !!Words.ready, words: Words.size})")
    print('состояние:', state)
    p.set_input_files('#imgPick', ['/home/user/mieruko/mieruko-ch01-p04.jpg'])
    p.wait_for_timeout(2000)
    p.evaluate("() => { if (typeof closeSheets === 'function') closeSheets(); }")
    p.click('#libGrid .card', position={'x': 40, 'y': 40})
    p.wait_for_timeout(2500)
    res = p.evaluate("""() => Reader.scanPage(Reader.page, {full: true, force: true})
        .then(d => ({lines: (d && d.lines || []).map(l => l.text)}))""")
    for i, t in enumerate(res['lines'], 1):
        print(' %2d. %s' % (i, t))
    print('ошибки:', errs[:3])
    b.close()
