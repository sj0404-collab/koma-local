"""Проверка единственного буфера (1.9.69): очистка стирает ВСЕ книги и память."""
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width':390,'height':844})
    p.goto('file:///home/user/kl/koma-lite.html', wait_until='domcontentloaded')
    p.wait_for_timeout(2000)
    r = p.evaluate("""async () => {
      const put = (k, v) => DB.put('kv', {k, v});
      await put('buf:b1:0', {build:'v1.9.68', lines:['РАЗ']});
      await put('buf:b1:1', {build:'v1.9.68', lines:['ДВА']});
      await put('buf:b2:0', {build:'v1.9.69', lines:['ТРИ']});
      await put('spoken:b2', {n:1});
      const before = (await DB.all('kv')).filter(r => /^(buf|spoken):/.test(r.k)).length;
      // книги не открыто — прежняя кнопка в этом случае не делала ничего
      Reader.book = null;
      const n = await Buffer.clearAll();
      const after = (await DB.all('kv')).filter(r => /^(buf|spoken):/.test(r.k)).length;
      const keep = (await DB.all('kv')).filter(r => !/^(buf|spoken):/.test(r.k)).length;
      return {before, n, after, keep};
    }""")
    print(r)
    ok = r['before'] == 4 and r['after'] == 0 and r['n'] == 4
    print('буфер: ' + ('ок — стирается всё, у всех книг' if ok else 'ПЛОХО'))
    b.close()
