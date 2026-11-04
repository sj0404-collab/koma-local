from playwright.sync_api import sync_playwright
import sys
f = sys.argv[1]
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width':390,'height':844})
    errs=[]; logs=[]
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.on('console', lambda m: logs.append(m.type+': '+m.text[:200]))
    p.goto('file://'+f, wait_until='domcontentloaded')
    for t in (2000,5000,9000):
        p.wait_for_timeout(t if t==2000 else t-2000)
        print(t, p.evaluate("() => ({ready: !!Words.ready, size: Words.size, src: Words.source})"))
    print('ошибки:', errs[:5]); print('логи:', [l for l in logs if 'словар' in l or 'error' in l][:8])
    b.close()
