"""1.0.22: чтец выбирается вручную и доезжает до нативного моста как rules.engine."""
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 390, 'height': 844})
    errs, seen = [], []
    p.on('pageerror', lambda e: errs.append(str(e)))
    # мост как в приложении: запоминаем, что именно нам прислали в правилах
    p.add_init_script("""
      window.__rules = [];
      window.KomaOcr = {
        available: () => true,
        status: () => JSON.stringify({ ready: true, engine: 'native', engines: ['auto','rec','eslav','r3','r4'] }),
        recognizeAsync: (b64, rules, cbId) => {
          window.__rules.push(JSON.parse(rules || '{}').engine);
          setTimeout(() => window.__komaOcrEvent(cbId, 'done', JSON.stringify({ ok: true, items: [], ms: 1 })), 5);
        },
      };
    """)
    p.goto('file:///home/user/kl/koma-lite.html', wait_until='domcontentloaded')
    p.wait_for_timeout(2500)
    p.evaluate("""async () => {
      const mk = (id, title) => new Promise(res => {
        const c = document.createElement('canvas'); c.width = 800; c.height = 1200;
        const x = c.getContext('2d'); x.fillStyle = '#f2efe9'; x.fillRect(0,0,800,1200);
        x.fillStyle = '#333'; x.font = '30px system-ui'; x.fillText(title, 60, 120);
        c.toBlob(async blob => {
          await DB.put('books', {id, title, kind:'chapter', count:2, at:Date.now(), progress:0, mode:'rtl', cover:blob});
          for (let i=0;i<2;i++) await DB.put('pages', {key: id+'/'+i, id, index:i, name:'p'+i+'.png', blob});
          res();
        }, 'image/png');
      });
      await mk('bookA','Книга А'); await mk('bookB','Книга Б');
      await Library.load();
      await Reader.open(await DB.get('books','bookA'));
    }""")
    p.wait_for_timeout(1500)
    p.evaluate("() => { openSheet('sheetSettings'); syncSettingsUI(); }")
    p.wait_for_timeout(500)
    p.click('#engChips .chip[data-eng="r3"]')
    p.wait_for_timeout(800)
    st = p.evaluate("""async () => ({
      eng: Reader.engine,
      saved: await DB.get('books','bookA').then(b => b.engine),
      defEng: ReadDefaults.v.engine,
    })""")
    print('А: выбрали r3 →', st)
    # правила для нативного моста
    p.evaluate("() => Reader.scanPage(0, {force:true}) ")
    p.wait_for_timeout(1500)
    sent = p.evaluate("() => window.__rules")
    print('что ушло в мост:', sent)
    # другая книга — по умолчанию
    p.evaluate("""async () => { await Reader.open(await DB.get('books','bookB')); }""")
    p.wait_for_timeout(1200)
    bb = p.evaluate("() => ({eng: Reader.engine})")
    print('Б (не настраивали):', bb)
    # умолчание меняем — А не трогаем
    p.evaluate("() => document.querySelector('#defEngChips .chip[data-eng=\"eslav\"]').click()")
    p.wait_for_timeout(600)
    p.evaluate("""async () => { await Reader.open(await DB.get('books','bookA')); }""")
    p.wait_for_timeout(1200)
    a2 = p.evaluate("() => ({eng: Reader.engine, def: ReadDefaults.v.engine})")
    print('А после смены умолчания:', a2)
    ok = (st['eng'] == 'r3' and st['saved'] == 'r3' and sent and sent[0] == 'r3'
          and bb['eng'] == 'auto' and a2['eng'] == 'r3' and a2['def'] == 'eslav')
    print('чтец:', 'ок' if ok else 'ПЛОХО')
    print('ошибки:', errs[:3])
    b.close()
