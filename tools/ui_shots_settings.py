from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    p.goto('file:///home/user/kl/koma-lite.html', wait_until='domcontentloaded')
    p.wait_for_timeout(2500)
    p.evaluate("""async () => {
      const c = document.createElement('canvas'); c.width=800; c.height=1200;
      const x = c.getContext('2d'); x.fillStyle='#f2efe9'; x.fillRect(0,0,800,1200);
      x.fillStyle='#333'; x.font='28px system-ui'; x.fillText('стр. 1', 620, 1160);
      await new Promise(r => c.toBlob(async blob => {
        await DB.put('books', {id:'b1', title:'Тихая ночь', kind:'chapter', count:3, at:Date.now(), progress:1, mode:'rtl',
          profUser:true, dir:'rtl', voice:true, cover:blob});
        for (let i=0;i<3;i++) await DB.put('pages', {key:'b1/'+i, id:'b1', index:i, name:'p'+i+'.png', blob});
        r();
      }, 'image/png'));
      await Library.load();
      await Reader.open(await DB.get('books','b1'));
    }""")
    p.wait_for_timeout(2000)
    p.evaluate("() => { openSheet('sheetSettings'); syncSettingsUI(); }")
    p.wait_for_timeout(800)
    p.screenshot(path='/home/user/uploads/ui-settings-book.png')
    p.evaluate("() => document.querySelector('#sheetSettings .body').scrollTop = 300")
    p.wait_for_timeout(400)
    p.screenshot(path='/home/user/uploads/ui-settings-engine.png')
    p.evaluate("() => document.querySelector('#sheetSettings .body').scrollTop = 900")
    p.wait_for_timeout(500)
    p.screenshot(path='/home/user/uploads/ui-settings-default.png')
    b.close()
