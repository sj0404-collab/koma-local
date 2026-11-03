#!/usr/bin/env python3
"""Проверка буфера страниц: строки одной книги не должны попадать в другую.

Это тот самый дефект с телефона 17:51 — на странице «Пиксель хоррор» в списке
реплик стояли строки из «Тома 1 Главы 48». Причина: буфер искал свои записи по
префиксу ключа без разделителя (`buf:<id>`), поэтому книга `b1` забирала записи
книги `b12`, а без открытой книги — вообще все записи сразу.

Проверка ставит в базу три набора строк (b1, b12, и запись без книги) и
спрашивает у страницы, что она видит для b1 и для b12.

  python3 tools/check_buffer.py
"""
import asyncio
import http.server
import os
import socketserver
import sys
import threading

from playwright.async_api import async_playwright

PAGE_DIR = os.environ.get('KOMA_PAGE_DIR', '/home/user/koma-lab')
PORT = 8098

ok_all = True


def ok(cond, msg):
    global ok_all
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        ok_all = False


def serve():
    os.chdir(PAGE_DIR)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


SETUP = r"""
(async () => {
  const line = (text) => ({ text, top: 0.1, bottom: 0.2, left: 0.9, right: 0.1 });
  await DB.clear('kv');
  // Старое имя книги — только в ключе (так писали до починки).
  await DB.put('kv', { k: 'buf:b1:0', v: { page: 0, at: 1, rules: 1, lines: [line('СТРОКА КНИГИ ОДИН')] } });
  await DB.put('kv', { k: 'buf:b12:0', v: { page: 0, at: 1, rules: 1, lines: [line('СТРОКА КНИГИ ДВЕНАДЦАТЬ')] } });
  // Новая запись: имя книги и в ключе, и в значении.
  await DB.put('kv', { k: 'buf:b7:0', v: { page: 0, book: 'b7', at: 1, rules: 1, lines: [line('СТРОКА КНИГИ СЕМЬ')] } });
  return true;
})()
"""

READ = r"""
async (id) => {
  Reader.book = { id };
  const rows = await Buffer.all();
  return JSON.stringify(rows.flatMap(r => r.lines.map(l => l.text)));
}
"""


async def run():
    httpd = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'])
        pg = await (await b.new_context()).new_page()
        await pg.goto(f'http://127.0.0.1:{PORT}/page.html', wait_until='load', timeout=120000)
        await pg.wait_for_timeout(2000)
        await pg.evaluate(SETUP)

        one = await pg.evaluate(READ, 'b1')
        twelve = await pg.evaluate(READ, 'b12')
        seven = await pg.evaluate(READ, 'b7')
        nothing = await pg.evaluate("""async () => { Reader.book = null; const rows = await Buffer.all(); return JSON.stringify(rows.length); }""")
        print(f'── b1:  {one}')
        print(f'── b12: {twelve}')
        print(f'── b7:  {seven}')
        ok('КНИГИ ОДИН' in one and 'ДВЕНАДЦАТЬ' not in one, 'страница книги b1 не видит строк книги b12')
        ok('КНИГИ ДВЕНАДЦАТЬ' in twelve and 'ОДИН' not in twelve, 'страница книги b12 не видит строк книги b1')
        ok('СЕМЬ' in seven and 'ОДИН' not in seven and 'ДВЕНАДЦАТЬ' not in seven, 'новая запись читается только своей книгой')
        ok(nothing in ('[]', '0'), f'без открытой книги буфер пуст (было бы всё подряд): {nothing}')
        await b.close()
    httpd.shutdown()
    print('\nИТОГ: ' + ('буфер книг не смешивает' if ok_all else 'ЕСТЬ КРАСНЫЕ ПРОВЕРКИ'))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(run()))
