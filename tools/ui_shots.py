from playwright.sync_api import sync_playwright
import sys
url = 'file:///home/user/kl/koma-lite.html'
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    errs = []
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.goto(url, wait_until='domcontentloaded')
    p.wait_for_timeout(2500)
    p.screenshot(path='/home/user/uploads/ui-lib-empty.png')
    # синтетические книги: обложки рисуем в canvas → blob
    p.evaluate("""async () => {
      const mk = (title, hue, n) => new Promise(async res => {
        const c = document.createElement('canvas'); c.width = 480; c.height = 720;
        const x = c.getContext('2d');
        const g = x.createLinearGradient(0,0,480,720);
        g.addColorStop(0, `hsl(${hue} 55% 42%)`); g.addColorStop(1, `hsl(${hue+40} 45% 16%)`);
        x.fillStyle = g; x.fillRect(0,0,480,720);
        x.fillStyle = '#ffffffee'; x.font = 'bold 44px system-ui';
        const words = title.split(' ');
        words.forEach((w,i)=> x.fillText(w, 40, 300 + i*56));
        x.fillStyle = '#ffffff88'; x.font = '20px system-ui'; x.fillText('глава ' + n, 40, 640);
        c.toBlob(async blob => {
          const id = 'b' + Math.random().toString(36).slice(2,8);
          await DB.put('books', {id, title, kind:'chapter', count: 18, at: Date.now(), progress: 0, mode:'vertical', cover: blob});
          res();
        }, 'image/png');
      });
      await mk('Тихая ночь', 250, 1);
      await mk('Дом у реки', 15, 2);
      await mk('Письма из Осаки', 190, 7);
      await mk('Пыльный август', 320, 3);
      await mk('Седьмой этаж', 275, 12);
      await mk('Клубника в снегу', 340, 1);
      // прогресс: две главы «читаю»
      const rows = await DB.all('books');
      for (let i = 0; i < 2; i++) { rows[i].progress = 7 + i*4; await DB.put('books', rows[i]); }
      await Library.load();
    }""")
    p.wait_for_timeout(1200)
    p.screenshot(path='/home/user/uploads/ui-lib.png')
    p.click('#libChips .chip[data-filter="reading"]')
    p.wait_for_timeout(600)
    p.screenshot(path='/home/user/uploads/ui-lib-reading.png')
    p.click('#libChips .chip[data-filter="all"]')
    p.wait_for_timeout(300)
    print('ошибки:', errs[:5])
    b.close()
