"""Проверка НАТИВНОГО пути без телефона: подставляем мосты KomaOcr/KomaRead
и отдаём те самые строки, что видел человек на скриншотах 4.11."""
import json
from playwright.sync_api import sync_playwright

# Дословно из блока «КАК РАСПОЗНАНО» на скриншотах 4.11 (v1.9.63, нативный
# движок). Это ровно то, что телефон отдал странице; ниже — что из этого
# получается сейчас.
RAW = [
    "ПОКА НЕ сля л 0ь СОБИРА-w",
    "СТОЙ! Юсь.",
    "2wb ЗНА4иТ ТЫМОЖЕШЬ И От НАСош",
    "СЛАВАвb БОГУ!",
    "УЕХАТЬ? А ТО Мы",
    "Я БЫ ХОТЕЛА ПОЗ ДОРО ВА ТЬСЯ С НИМ.",
    "ПОДР-УШ ЖИ ЛИСЬ",
    "БЫЛО БЫВ ФРЫСТНО ЕСЛИ БЫ ТЫ УЕХАЛА.",
    "ПРОСТО КОГДА ТЫYowb ГОВОРИЛА ПО ТЕЛЕ ФО ХОРОШО.",
    "МИЧ ИР ТОЧНО НИЧЕГО, ЕСЛИ ТЫ ОС АН ЕШЬСЯ У МЕНЯ НА НОЧЬ?",
    "ТЫ МЕНЯ СМЩ ЕШЬ.Ш",
]

STUB = """
(replicas) => {
  window.__nativeRaw = replicas.map(t => t);
  window.KomaOcr = {
    available: () => true,
    status: () => JSON.stringify({ ready: true, engine: 'native' }),
    recognizeAsync: (b64, rules, cbId) => {
      const items = window.__nativeRaw.map((t, i) => ({
        text: t, left: 0.05, right: 0.95,
        top: 0.02 + i * 0.1, bottom: 0.09 + i * 0.1, confidence: 0.9,
      }));
      setTimeout(() => {
        window.__komaOcrEvent(cbId, 'state', 'нативный движок');
        window.__komaOcrEvent(cbId, 'done', JSON.stringify({ ok: true, items, ms: 8600 }));
      }, 30);
    },
  };
  window.KomaRead = {
    plan: (itemsJson, rulesJson) => JSON.stringify({
      ok: true,
      replicas: JSON.parse(itemsJson).map(it => ({
        text: it.text, left: it.left, right: it.right, top: it.top, bottom: it.bottom,
        confidence: it.confidence,
      })),
    }),
  };
}
"""

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 390, 'height': 844})
    errs = []
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.goto('file:///home/user/kl/koma-lite.html', wait_until='domcontentloaded')
    p.wait_for_timeout(1500)
    M = '/home/user/koma-lab/models2/'
    p.set_input_files('#modelPick', [M + 'detection.onnx', M + 'cyrillic.onnx', M + 'cyrillic.txt'])
    for _ in range(140):
        if p.evaluate("() => typeof OCR !== 'undefined' && !!OCR.ready"): break
        p.wait_for_timeout(500)
    p.set_input_files('#imgPick', ['/home/user/mieruko/mieruko-ch01-p04.jpg'])
    p.wait_for_timeout(2500)
    p.evaluate("() => { if (typeof closeSheets === 'function') closeSheets(); }")
    p.click('#libGrid .card', position={'x': 40, 'y': 40}); p.wait_for_timeout(2500)
    p.evaluate(STUB, RAW)
    res = p.evaluate("""() => Reader.scanPage(Reader.page, {full: true, force: true})
        .then(d => ({ plan: OCR.readPlan, lines: (d && d.lines || []).map(l => l.text) }))""")
    print('план:', res['plan'])
    for i, t in enumerate(res['lines'], 1):
        print(' %2d. %s' % (i, t))
    print('ошибки:', errs[:3])
    b.close()
