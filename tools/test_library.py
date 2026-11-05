# -*- coding: utf-8 -*-
"""Полка библиотеки: импорт, обложки, фильтры со счётчиками, поиск, сортировка,
два вида, «продолжить чтение», меню книги и переименование.

Гоняется по настоящей странице (не по моку): файлы подкладываются в input,
дальше всё как у человека — снимки кладутся в /home/user/agon-test/lib-*.png.
"""
import json, os, subprocess, sys, time

ROOT = '/home/user/kl/pwa'
PORT = 8793
SHOTS = '/home/user/agon-test'
OUT = []
PAGES = ['/home/user/mieruko/mieruko-ch01-p02.jpg',
         '/home/user/mieruko/mieruko-ch01-p04.jpg',
         '/home/user/mieruko/mieruko-ch01-p05.jpg']


def log(*a):
    line = ' '.join(str(x) for x in a)
    print(line, flush=True)
    OUT.append(line)


def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            br = pw.chromium.launch(args=['--no-sandbox'])
            pg = br.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
            errs = []
            pg.on('console', lambda m: errs.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
            pg.goto(f'http://127.0.0.1:{PORT}/index.html', wait_until='load')
            pg.wait_for_function('typeof Library !== "undefined" && typeof renderLibrary === "function"', timeout=60000)
            pg.wait_for_timeout(800)
            pg.screenshot(path=os.path.join(SHOTS, 'lib-01-empty.png'))

            # ── импорт трёх глав
            for n, title in enumerate(['Том 1 Глава 1', 'Том 1 Глава 2', 'Маньхуа · глава 7'], start=1):
                pg.click('#btnImport')
                pg.wait_for_timeout(250)
                pg.set_input_files('#imgPick', PAGES[:n])
                pg.wait_for_timeout(1200)
                # диалог мог остаться открытым — закрываем
                pg.evaluate("() => { try { closeSheets(); } catch (e) {} }")
                pg.wait_for_timeout(300)
            books = pg.evaluate("() => Library.books.map(b => ({id: b.id, title: b.title, count: b.count}))")
            log('после импорта книг:', len(books), json.dumps(books, ensure_ascii=False))

            # переименуем для наглядности и выставим разный прогресс (как после чтения)
            pg.evaluate("""async (titles) => {
              const series = Library.series.slice().sort((a,b)=>a.at-b.at);
              for (let i = 0; i < series.length && i < titles.length; i++) {
                const s = series[i];
                s.title = titles[i];
                s.category = i === 0 ? 'Маньхуа' : (i === 1 ? 'Манга' : 'Вебтуны');
                s.at = Date.now() - i * 86400000;
                await DB.put('books', s);
                const chs = Library.chaptersOf(s.id);
                for (let k = 0; k < chs.length; k++) {
                  const c = chs[k];
                  c.at = Date.now() - i * 86400000;
                  c.mode = i === 0 ? 'rtl' : 'vertical';
                  // «читаю» — только у третьей серии, и только если страниц больше двух
                  // «дочитано» = открыта последняя страница главы
                  c.progress = (i === 2 && k === 0 && c.count >= 3) ? (c.count - 1) : 0;
                  // «читаю» — глава, которую открывали, но не дочитали
                  c.opened = (i === 1 && k === 0) ? Date.now() : 0;
                  await DB.put('books', c);
                }
              }
              await Library.load();
            }""", ['Маньхуа · глава 7', 'Том 1 Глава 2', 'Том 1 Глава 1'])
            pg.wait_for_timeout(600)
            pg.screenshot(path=os.path.join(SHOTS, 'lib-02-grid.png'))

            st = pg.evaluate("""() => {
              const cards = document.querySelectorAll('#libGrid .card').length;
              const nums = Array.from(document.querySelectorAll('#libChips .num')).map(n => n.textContent);
              const hero = document.querySelector('#libHero').classList.contains('on');
              const heroName = (document.querySelector('#libHero .name') || {}).textContent || '';
              const sub = document.querySelector('#libSub').textContent;
              const imgs = Array.from(document.querySelectorAll('#libGrid .card img')).length;
              return { cards, nums, hero, heroName, sub, imgs };
            }""")
            log('полка:', json.dumps(st, ensure_ascii=False))

            # ── фильтры
            res = {}
            for f in ['new', 'reading', 'done', 'all']:
                pg.click(f'#libChips .chip[data-filter="{f}"]')
                pg.wait_for_timeout(200)
                res[f] = pg.evaluate("() => document.querySelectorAll('#libGrid .card').length")
            log('карточек по фильтрам:', json.dumps(res, ensure_ascii=False))

            # ── поиск
            pg.click('#btnLibSearch')
            pg.fill('#libSearch', 'маньхуа')
            pg.wait_for_timeout(300)
            found = pg.evaluate("() => Array.from(document.querySelectorAll('#libGrid .card .cap')).map(e => e.textContent)")
            log('поиск «маньхуа»:', json.dumps(found, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-03-search.png'))
            pg.click('#btnLibSearchClose')
            pg.wait_for_timeout(200)

            # ── сортировка по названию
            pg.select_option('#libSort', 'title')
            pg.wait_for_timeout(250)
            order = pg.evaluate("() => Array.from(document.querySelectorAll('#libGrid .card .cap')).map(e => e.textContent)")
            log('сортировка по названию:', json.dumps(order, ensure_ascii=False))

            # ── вид списком
            pg.click('#btnLibView')
            pg.wait_for_timeout(300)
            rows = pg.evaluate("() => document.querySelectorAll('#libList .row-card').length")
            log('вид списком, строк:', rows)
            pg.screenshot(path=os.path.join(SHOTS, 'lib-04-list.png'))
            pg.click('#btnLibView')
            pg.wait_for_timeout(200)

            # ── меню книги и переименование
            pg.click('#libGrid .card .more')
            pg.wait_for_timeout(350)
            menu = pg.evaluate("() => ({open: document.querySelector('#libMenu').classList.contains('on'), title: document.querySelector('#libMenuTitle').textContent, open_btn: document.querySelector('#libMenuOpen').textContent})")
            log('меню книги:', json.dumps(menu, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-05-menu.png'))
            pg.click('#libMenuRename')
            pg.wait_for_timeout(350)
            pg.fill('#libRenameInput', 'Переименованная глава')
            pg.click('#libRenameSave')
            pg.wait_for_timeout(700)
            names = pg.evaluate("() => Library.series.map(s => s.title)")
            log('после переименования:', json.dumps(names, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-06-renamed.png'))

            # ── удаление (двойное нажатие)
            before = pg.evaluate("() => Library.books.length")
            pg.click('#libGrid .card .more')
            pg.wait_for_timeout(300)
            pg.click('#libMenuDelete')
            pg.wait_for_timeout(200)
            pg.click('#libMenuDelete')
            pg.wait_for_timeout(700)
            after = pg.evaluate("() => Library.books.length")
            log('удаление: было', before, 'стало', after)

            # ── открытие книги из полки
            pg.click('#libGrid .card')
            pg.wait_for_timeout(600)
            chaps = pg.evaluate("() => ({open: document.querySelector('#libChapters').classList.contains('on'), rows: document.querySelectorAll('#libChaptersList .chaprow').length, title: document.querySelector('#libChaptersTitle').textContent})")
            log('главы серии:', json.dumps(chaps, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-08-chapters.png'))
            pg.click('#libChaptersList .chaprow')
            pg.wait_for_timeout(1500)
            opened = pg.evaluate("() => ({screen: document.querySelector('#reader').classList.contains('on'), title: (document.querySelector('#rTitle')||{}).textContent, pages: (typeof Reader !== 'undefined' && Reader.pages ? Reader.pages.length : 0)})")
            log('открытие книги:', json.dumps(opened, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-07-opened.png'))

            # ── избранное: пункт меню + чип-фильтр (из читалки — на полку)
            pg.evaluate("() => libGoTab('library')")
            pg.wait_for_timeout(300)
            pg.click('#libGrid .card .more')
            pg.wait_for_timeout(300)
            pg.click('#libMenuFav')
            pg.wait_for_timeout(600)
            fav = pg.evaluate("() => ({n: Library.series.filter(s => s.fav).length, chip: document.querySelector('#libCats button[data-cat=fav]').textContent, flag: (document.querySelector('#libGrid .card .flag')||{}).textContent})")
            log('избранное:', json.dumps(fav, ensure_ascii=False))
            pg.click('#libCats button[data-cat="fav"]')
            pg.wait_for_timeout(400)
            log('в избранном карточек:', pg.evaluate("() => document.querySelectorAll('#libGrid .card').length"))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-12-fav.png'))
            pg.click('#libCats button[data-cat="all"]')
            pg.wait_for_timeout(300)

            # ── несколько глав в одной серии, естественный порядок
            series_test = pg.evaluate("""async () => {
              const s = await Library.addSeries('Проверка естественного порядка');
              const mk = (n) => [{ name: 'p' + n + '.jpg', blob: new Blob([new Uint8Array([255,216,255,217])], { type: 'image/jpeg' }) }];
              await Library.addChapter(s.id, 'Глава 10', mk(10));
              await Library.addChapter(s.id, 'Глава 2', mk(2));
              await Library.addChapter(s.id, 'Глава 1', mk(1));
              await Library.load();
              return { order: Library.chaptersOf(s.id).map(c => c.title), cover: !!s.cover, id: s.id };
            }""")
            log('главы 1/2/10:', json.dumps(series_test, ensure_ascii=False))
            pg.evaluate("() => openChapters(Library.series.find(s => s.title === 'Проверка естественного порядка'))")
            pg.wait_for_timeout(400)
            chap = pg.evaluate("() => Array.from(document.querySelectorAll('#libChaptersList .chaprow .chaptitle')).map(e => e.textContent)")
            log('шторка глав по порядку:', json.dumps(chap, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-11-series.png'))
            pg.evaluate("() => closeSheets()")
            pg.wait_for_timeout(200)

            # ── полки и нижние вкладки (из читалки сначала возвращаемся на полку)
            pg.evaluate("() => libGoTab('library')")
            pg.wait_for_timeout(500)
            cats = pg.evaluate("() => Array.from(document.querySelectorAll('#libCats button')).map(b => b.textContent)")
            log('полки:', json.dumps(cats, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-09-cats.png'))
            pg.click('#libNav .navbtn[data-tab="history"]')
            pg.wait_for_timeout(500)
            hist = pg.evaluate("() => ({on: document.querySelector('#history').classList.contains('on'), rows: document.querySelectorAll('#histList .row-card').length, sub: document.querySelector('#histSub').textContent})")
            log('вкладка История:', json.dumps(hist, ensure_ascii=False))
            pg.screenshot(path=os.path.join(SHOTS, 'lib-10-history.png'))
            pg.click('#libNav .navbtn[data-tab="more"]')
            pg.wait_for_timeout(400)
            more = pg.evaluate("() => ({on: document.querySelector('#more').classList.contains('on'), about: (document.querySelector('#moreAbout')||{}).textContent.slice(0,40)})")
            log('вкладка Ещё:', json.dumps(more, ensure_ascii=False))
            pg.click('#libNav .navbtn[data-tab="history"]')
            pg.wait_for_timeout(400)
            pg.click('#btnHistClear')
            pg.wait_for_timeout(600)
            log('после очистки истории:', json.dumps(pg.evaluate("() => document.querySelectorAll('#histList .row-card').length")))
            pg.click('#libNav .navbtn[data-tab="library"]')
            pg.wait_for_timeout(400)

            log('ошибки консоли:', json.dumps(errs[:8], ensure_ascii=False))
            br.close()
    finally:
        srv.terminate()
    open(os.path.join(SHOTS, 'lib-result.txt'), 'w', encoding='utf-8').write('\n'.join(OUT))
    print('готово')


if __name__ == '__main__':
    main()
