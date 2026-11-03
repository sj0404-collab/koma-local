#!/usr/bin/env python3
"""Прокрутка ленты: переход к реплике должен быть плавным, а не рывком.

Жалоба с телефона 17:48 (манхва): «прыжки при авточтении — несколько страниц
резко перескакивал, а не плавно; слишком резко прокручивает после каждого
чтения». Причина: длительность прокрутки была ФИКСИРОВАННОЙ (220–260 мс) на
любую дистанцию, поэтому переход на следующую страницу вебтуна (несколько
экранов) проезжал так же быстро, как сдвиг на 30 px, — это и выглядело рывком.

Что проверяется здесь:
  1. время прокрутки пропорционально дистанции (дальше — дольше);
  2. скорость настраивается: при 0,25× тот же переход едет в ~4 раза дольше;
  3. ни одного кадра с рывком больше 40 px (то есть нет «телепорта»);
  4. прокрутка к реплике из читалки идёт тем же плавным путём.

  python3 tools/check_scroll.py
"""
import asyncio
import http.server
import os
import socketserver
import sys
import threading

from playwright.async_api import async_playwright

PAGE_DIR = os.environ.get('KOMA_PAGE_DIR', '/home/user/koma-lab')
PORT = 8097

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


# Замер: каждый кадр пишем (время, scrollTop). По нему видно и рывки, и темп.
SAMPLER = r"""
window.__samples = [];
window.__sampling = false;
window.__startSample = () => { window.__samples = []; window.__sampling = true; };
window.__stopSample = () => { window.__sampling = false; return window.__samples.length; };
(function tick(ts) {
  if (window.__sampling) {
    const sc = document.querySelector('#strip');
    if (sc) window.__samples.push([Math.round(ts), Math.round(sc.scrollTop || 0)]);
  }
  requestAnimationFrame(tick);
})(performance.now());
"""


PREP = r"""
() => {
  // Читалка должна быть НА ЭКРАНЕ: у скрытого экрана scrollTop не меняется
  // вовсе (и это правильно), поэтому без этого замера не получится.
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  const r = document.querySelector('#reader');
  r.classList.add('on');
  const strip = document.querySelector('#strip');
  strip.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const w = document.createElement('div');
    w.className = 'pagewrap'; w.dataset.page = String(i);
    w.style.height = '2000px';
    strip.appendChild(w);
  }
  Reader.mode = 'vertical';
  return strip.clientHeight;
}
"""

GLIDE = r"""
async (opts) => {
  const sc = document.querySelector('#strip');
  SMOOTH.speed = opts.speed;
  sc.scrollTop = 0;
  await new Promise(r => setTimeout(r, 120));
  window.__startSample();
  const t0 = performance.now();
  SMOOTH.glide(opts.to);
  await SMOOTH.done();
  const t1 = performance.now();
  window.__stopSample();
  const s = window.__samples;
  let maxJump = 0;
  for (let i = 1; i < s.length; i++) maxJump = Math.max(maxJump, Math.abs(s[i][1] - s[i - 1][1]));
  return JSON.stringify({ ms: Math.round(t1 - t0), frames: s.length, maxJump: Math.round(maxJump),
                          end: s.length ? s[s.length - 1][1] : 0, target: opts.to });
}
"""

LINE = r"""
async (opts) => {
  const sc = document.querySelector('#strip');
  // Лента уже собрана в PREP: три страницы по 2000 px. Реплика — в конце второй.
  Reader.mode = 'vertical';
  SMOOTH.speed = opts.speed;
  sc.scrollTop = 0;
  await new Promise(r => setTimeout(r, 120));
  window.__startSample();
  const t0 = performance.now();
  Reader.scrollToLineIfNeeded(1, { top: 0.9, bottom: 0.95, left: 0.2, right: 0.8 });
  await SMOOTH.done();
  const t1 = performance.now();
  window.__stopSample();
  const s = window.__samples;
  let maxJump = 0;
  for (let i = 1; i < s.length; i++) maxJump = Math.max(maxJump, Math.abs(s[i][1] - s[i - 1][1]));
  return JSON.stringify({ ms: Math.round(t1 - t0), frames: s.length, maxJump: Math.round(maxJump),
                          end: s.length ? s[s.length - 1][1] : 0 });
}
"""


async def run():
    httpd = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'])
        pg = await (await b.new_context(viewport={'width': 420, 'height': 900})).new_page()
        await pg.goto(f'http://127.0.0.1:{PORT}/page.html', wait_until='load', timeout=120000)
        await pg.add_init_script(SAMPLER)
        await pg.reload(wait_until='load')
        await pg.wait_for_timeout(2000)
        height = await pg.evaluate(PREP)
        print(f'── лента на экране: clientHeight {height} px, 3 страницы по 2000 px')

        import json
        far_1 = json.loads(await pg.evaluate(GLIDE, {'to': 1600, 'speed': 1}))
        near_1 = json.loads(await pg.evaluate(GLIDE, {'to': 300, 'speed': 1}))
        far_slow = json.loads(await pg.evaluate(GLIDE, {'to': 1600, 'speed': 0.25}))
        print(f'── далеко 1600 px, 1×:    {far_1}')
        print(f'── близко 300 px, 1×:     {near_1}')
        print(f'── далеко 1600 px, 0.25×: {far_slow}')

        ok(abs(far_1['end'] - 1600) <= 2, 'лента доехала до цели')
        ok(far_1['ms'] > near_1['ms'], f'дальше едет дольше: {far_1["ms"]} мс против {near_1["ms"]} мс')
        ok(far_1['maxJump'] <= 40, f'ни одного кадра-рывка больше 40 px: максимум {far_1["maxJump"]} px')
        ok(far_slow['ms'] >= far_1['ms'] * 2.5, f'0,25× заметно медленнее: {far_slow["ms"]} мс против {far_1["ms"]} мс')
        ok(far_slow['maxJump'] <= 40, f'на 0,25× рывков нет: максимум {far_slow["maxJump"]} px')

        line = json.loads(await pg.evaluate(LINE, {'speed': 1}))
        print(f'── прокрутка к реплике на второй странице: {line}')
        ok(line['end'] > 1400, f'реплика на второй странице выведена в кадр (scrollTop {line["end"]})')
        ok(line['maxJump'] <= 40, f'переход между страницами без рывка: максимум {line["maxJump"]} px')
        ok(line['frames'] >= 8, f'переход анимирован, а не телепорт: кадров {line["frames"]}')

        await b.close()
    httpd.shutdown()
    print('\nИТОГ: ' + ('прокрутка плавная и настраиваемая' if ok_all else 'ЕСТЬ КРАСНЫЕ ПРОВЕРКИ'))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(run()))
