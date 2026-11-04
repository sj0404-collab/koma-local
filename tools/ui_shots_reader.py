from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    errs=[]; p.on('pageerror', lambda e: errs.append(str(e)))
    p.goto('file:///home/user/kl/koma-lite.html', wait_until='domcontentloaded')
    p.wait_for_timeout(2500)
    p.evaluate("""async () => {
      const mk = (n) => new Promise(res => {
        const c = document.createElement('canvas'); c.width=800; c.height=1200;
        const x = c.getContext('2d');
        x.fillStyle='#f4f1ea'; x.fillRect(0,0,800,1200);
        x.strokeStyle='#d8d3c8'; x.lineWidth=3;
        for (let i=0;i<12;i++){ x.strokeRect(60+ (i%2)*20, 90+i*88, 300, 150); }
        x.fillStyle='#333'; x.font='26px system-ui';
        x.fillText('стр. ' + n, 640, 1160);
        c.toBlob(async blob => {
          const id='b'+Math.random().toString(36).slice(2,8);
          if (!window.__bid) { window.__bid = id;
            await DB.put('books', {id, title:'Тихая ночь', kind:'chapter', count:3, at:Date.now(), progress:1, mode:'vertical', cover:blob});
          }
          await DB.put('pages', {key: window.__bid + '/' + n, id: window.__bid, index:n, name:'p'+n+'.png', blob});
          res();
        }, 'image/png');
      });
      for (let i=0;i<3;i++) await mk(i);
      await Library.load();
      const b = (await DB.all('books'))[0];
      await openBook(b);
    }""")
    p.wait_for_timeout(2500)
    p.screenshot(path='/home/user/uploads/ui-reader.png')
    # панели скрыты тапом (погружение)
    p.evaluate("() => { document.querySelector('#readerBar').classList.add('hide'); document.querySelector('#readerHeader').style.transform='translateY(-110%)'; }")
    p.wait_for_timeout(400)
    p.screenshot(path='/home/user/uploads/ui-reader-zen.png')
    print('ошибки:', errs[:5])
    b.close()
