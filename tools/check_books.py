#!/usr/bin/env python3
"""Две книги подряд: строки одной не должны показываться в другой.

Жалоба 18:40: на «Том 1 Глава 48» в списке реплик стояли строки из «Пиксель
хоррор» (эй, мичируя…; а почему ты перевелась…; из-за работы). Это либо старый
буфер (тогда виновата сборка), либо остатки в памяти читалки (тогда виноват код).

Прогон честный: две РАЗНЫЕ страницы распознаются по очереди в одном запуске
страницы, как это делает человек — открыл одну книгу, потом другую.

  python3 tools/check_books.py
"""
import asyncio
import http.server
import json
import os
import socketserver
import sys
import threading

from playwright.async_api import async_playwright

LAB = os.environ.get('KOMA_LAB', '/home/user/koma-lab')
PAGE_DIR = os.environ.get('KOMA_PAGE_DIR', LAB)
MODELS = os.path.join(LAB, 'shipmodels')
PORT = 8096

ok_all = True


def ok(cond, msg):
    global ok_all
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        ok_all = False


def norm(t):
    import re
    return re.sub(r'[^0-9A-ZА-ЯЁ]', '', str(t or '').upper())


def serve():
    os.chdir(PAGE_DIR)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


BRIDGES = r"""
(() => {
  window.__komaTtsLog = [];
  window.KomaSpeech = {
    status: () => JSON.stringify({ ready: true, note: '', engine: 'mock' }),
    voices: () => JSON.stringify([{ name: 'Русский', lang: 'ru-RU' }]),
    engines: () => JSON.stringify(['mock']),
    useEngine: () => true, cancel: () => {},
    speak: (t, r, l, v, id) => {
      window.__komaTtsLog.push({ text: String(t || ''), id });
      const d = Math.max(300, Math.min(1800, String(t || '').length * 20));
      setTimeout(() => window.__komaSpeechEvent && window.__komaSpeechEvent(id, 'end', ''), d);
    },
  };
  window.KomaUi = { spoken: () => {}, show: () => {}, hide: () => {} };
})();
"""

LINES = """() => { try { const d = Reader.regions.get(Reader.page);
  return d ? JSON.stringify({ lines: d.lines.map(l => l.text), page: Reader.page, book: Reader.book && Reader.book.id }) : ''; }
  catch (e) { return ''; } }"""


async def scan_current(pg):
    await pg.evaluate("() => { const b = document.querySelector('#btnFullPage') || document.querySelector('#btnOcr2'); if (b) b.click(); }")
    for _ in range(40):
        await pg.wait_for_timeout(1500)
        raw = await pg.evaluate(LINES)
        if raw:
            return json.loads(raw)
    return {'lines': [], 'page': None, 'book': None}


async def run():
    httpd = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
                                          '--js-flags=--max-old-space-size=1536'])
        pg = await (await b.new_context(viewport={'width': 420, 'height': 900})).new_page()
        await pg.goto(f'http://127.0.0.1:{PORT}/page.html', wait_until='load', timeout=120000)
        await pg.add_init_script(BRIDGES)
        await pg.reload(wait_until='load')
        await pg.wait_for_timeout(2000)

        await pg.set_input_files('#modelPick', [
            os.path.join(MODELS, 'detection.onnx'), os.path.join(MODELS, 'cyrillic.onnx'),
            os.path.join(MODELS, 'cyrillic.txt')])
        for _ in range(40):
            await pg.wait_for_timeout(1500)
            if await pg.evaluate("() => { try { return !!OCR.ready; } catch (e) { return false; } }"):
                break

        # Книга А
        await pg.set_input_files('#imgPick', os.path.join(LAB, 'book-a.png'))
        await pg.wait_for_timeout(2500)
        first = json.loads(await pg.evaluate("() => JSON.stringify(Library.books.map(b => ({ id: b.id, title: b.title })))"))[0]
        await pg.click('.card')
        await pg.wait_for_timeout(2000)
        a = await scan_current(pg)
        print(f'── A: {first["title"]} ({first["id"]}) — распознано {len(a["lines"])}')
        for t in a['lines']:
            print(f'     {t}')
        ok(bool(a['lines']), 'первая книга распознана')

        # Назад в библиотеку и вторая книга
        await pg.evaluate("() => document.querySelector('#btnBack').click()")
        await pg.wait_for_timeout(1500)
        await pg.set_input_files('#imgPick', os.path.join(LAB, 'book-b.png'))
        await pg.wait_for_timeout(2500)
        books = json.loads(await pg.evaluate("() => JSON.stringify(Library.books.map(b => ({ id: b.id, title: b.title })))"))
        print(f'── книг в библиотеке: {len(books)}: ' + ', '.join(x['title'] + ' (' + x['id'] + ')' for x in books))
        ok(len(books) == 2, 'в библиотеке две книги')
        ok(books[0]['id'] != books[1]['id'], 'у книг разные идентификаторы')

        # Открываем ВТОРУЮ книгу (только что добавленную — она первая в списке)
        await pg.evaluate("() => { const cards = document.querySelectorAll('.card'); cards[0].click(); }")
        await pg.wait_for_timeout(2000)
        title2 = await pg.evaluate("() => { try { return Reader.book.title; } catch (e) { return '?'; } }")
        b2 = await scan_current(pg)
        print(f'── B: {title2} ({b2["book"]}) — распознано {len(b2["lines"])}')
        for t in b2['lines']:
            print(f'     {t}')

        a_set = {norm(t) for t in a['lines'] if len(norm(t)) > 8}
        b_set = {norm(t) for t in b2['lines']}
        foreign = [t for t in b2['lines'] if norm(t) in a_set and len(norm(t)) > 8]
        ok(not foreign, 'во второй книге нет строк первой: ' + (', '.join(foreign) if foreign else 'нет'))
        ok(b2['book'] != a['book'], 'страница открытой книги — вторая, а не первая')

        # ── Сброс состояния книги ─────────────────────────────────────────────
        cleared = await pg.evaluate("""async () => {
          const before = (await Buffer.all()).length;
          document.querySelector('#btnForgetBook').click();
          await new Promise(r => setTimeout(r, 900));
          const after = (await Buffer.all()).length;
          const inMemory = Reader.regions.size;
          return JSON.stringify({ before, after, inMemory });
        }""")
        state = json.loads(cleared)
        print(f'── сброс книги: записей в буфере {state["before"]} → {state["after"]}, страниц в памяти {state["inMemory"]}')
        ok(state['after'] == 0, 'кнопка «Забыть текст этой книги» стёрла буфер книги')
        ok(state['inMemory'] == 0, 'кнопка стёрла и распознанное в памяти (страница просит распознать заново)')

        await b.close()
    httpd.shutdown()
    print('\nИТОГ: ' + ('книги не смешиваются' if ok_all else 'ЕСТЬ КРАСНЫЕ ПРОВЕРКИ'))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(run()))
