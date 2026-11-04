"""1.0.21: своё сочетание у книги, у остальных — умолчание. Проверяем по-настоящему."""
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 390, 'height': 844})
    errs = []
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.goto('file:///home/user/kl/koma-lite.html', wait_until='domcontentloaded')
    p.wait_for_timeout(2500)

    def mkbooks():
        p.evaluate("""async () => {
          const mk = (id, title, n) => new Promise(res => {
            const c = document.createElement('canvas'); c.width = 800; c.height = 1200;
            const x = c.getContext('2d'); x.fillStyle = '#f2efe9'; x.fillRect(0,0,800,1200);
            x.fillStyle = '#333'; x.font = '30px system-ui'; x.fillText(title, 60, 120);
            c.toBlob(async blob => {
              await DB.put('books', {id, title, kind:'chapter', count:n, at:Date.now(), progress:0, mode:'vertical', cover:blob});
              for (let i=0;i<n;i++) await DB.put('pages', {key: id+'/'+i, id, index:i, name:'p'+i+'.png', blob});
              res();
            }, 'image/png');
          });
          await mk('bookA', 'Книга А', 3);
          await mk('bookB', 'Книга Б', 3);
          await Library.load();
        }""")

    mkbooks(); p.wait_for_timeout(1200)

    def open_book(bid):
        p.evaluate("""async (id) => {
          const b = await DB.get('books', id);
          if (typeof TTS !== 'undefined' && TTS.stop) TTS.stop();
          await Reader.open(b);
        }""", bid)
        p.wait_for_timeout(1500)

    def state():
        return p.evaluate("""async () => ({
          mode: Reader.mode, dir: Reader.dir, voice: !!Reader.voiceOn, prof: !!Reader.modeUser,
          saved: await DB.get('books', 'bookA').then(b => ({mode:b.mode, dir:b.dir, voice:b.voice, prof:!!b.profUser})),
          savedB: await DB.get('books', 'bookB').then(b => ({mode:b.mode, prof:!!b.profUser})),
          def: JSON.parse(JSON.stringify(ReadDefaults.v)),
        })""")

    # 1. Книге А — своё: страницы справа налево + голос
    open_book('bookA')
    p.e6787 = None
    p.evaluate("() => { openSheet('sheetSettings'); syncSettingsUI(); }")
    p.wait_for_timeout(600)
    p.click('#modeChips .chip[data-mode="rtl"]'); p.wait_for_timeout(500)
    p.click('#dirChips .chip[data-dir="rtl"]'); p.wait_for_timeout(500)
    p.check('#cbVoiceBook'); p.wait_for_timeout(600)
    a = state()
    print('А после настройки:', a)

    # 2. Книга Б — без профиля, значит умолчание (лента, без голоса)
    open_book('bookB')
    bb = state()
    print('Б (не настраивали):', bb)

    # 3. Меняем умолчание — Б берёт его, А остаётся со своим
    p.evaluate("() => { openSheet('sheetSettings'); syncSettingsUI(); }") if False else None
    p.click('#btnSettings') if False else None
    p.evaluate("() => document.querySelector('#defModeChips .chip[data-mode=\"ltr\"]').click()")
    p.wait_for_timeout(600)
    open_book('bookB'); bb2 = state(); print('Б после смены умолчания:', bb2)
    open_book('bookA'); a2 = state(); print('А после смены умолчания:', a2)

    # 4. «Вернуть как по умолчанию» для А
    p.evaluate("() => { openSheet('sheetSettings'); syncSettingsUI(); }")
    p.wait_for_timeout(400)
    p.click('#btnProfReset'); p.wait_for_timeout(800)
    a3 = state(); print('А после возврата:', a3)

    ok = (a['mode'] == 'rtl' and a['voice'] and a['saved']['prof']
          and a['saved']['mode'] == 'rtl' and a['saved']['voice'] is True
          and bb['mode'] == 'vertical' and not bb['prof']
          and bb2['mode'] == 'ltr' and a2['mode'] == 'rtl'
          and a3['mode'] == 'ltr' and not a3['prof'])
    print('профиль книги:', 'ок' if ok else 'ПЛОХО')
    print('ошибки:', errs[:3])
    b.close()
