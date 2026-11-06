'use strict';
/* ───────────────────────── 0. Мелкие утилиты ───────────────────────── */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function toast(msg, ms = 2200, quiet) {
  const text = String(msg || '');
  // Один и тот же текст не показываем дважды подряд: «Идёт распознавание —
  // страница 2 встала в очередь» прилетало три раза и перекрывало страницу
  // (журнал 06.11, 18:22:21–18:22:22). В журнал пишем каждую попытку.
  let same = false;
  try {
    same = text === toast._last && (Date.now() - (toast._at || 0) < 5000);
  } catch (e) { /* пусто */ }
  toast._last = text; toast._at = Date.now();
  try { Journal.add('сообщение', text); } catch (e) { /* журнала ещё нет */ }
  if (same) return;
  // Служебные сообщения (сколько реплик нашлось, сколько распознано, сколько
  // страниц в буфере) не должны ложиться поверх текста: читают глазами ту же
  // страницу, что слушают. Такие сообщения уходят в тонкую строку сверху —
  // она живёт ниже шапки и на узком экране не закрывает облачка.
  if (quiet) { soft(text, ms); return; }
  const el = $('#toast');
  el.textContent = text; el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), ms);
}

/** Служебная строка сверху (статус распознавания). Та же запись в журнал. */
function soft(msg, ms = 2500) {
  const el = $('#scanBadge');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(soft._t);
  soft._t = setTimeout(() => el.classList.remove('on'), ms);
}

/* ───────────────────────── 0.1 ЖУРНАЛ ─────────────────────────
   Просьба с телефона 06.11, 17:05: «добавь журнал, где описано все баги, что
   могли случиться и каких нету, и как их исправлять, как логи приложения».

   Здесь две части:
     · СОБЫТИЯ — кольцевой список того, что приложение реально делало: голос
       (старт/конец/обрыв и время озвучки), распознавание (полоса, время,
       сколько реплик), обновления, ошибки загрузки. Хранится в базе, переживает
       перезапуск, выгружается кнопкой «Скопировать».
     · НЕПОЛАДКИ — каталог известных проблем: что бывает, как проверить, как
       лечить, и в какой сборке исправлено. Он статический, но именно его
       человек читает, когда «что-то не так».
*/
const Journal = {
  events: [],
  max: 400,
  _saveT: null,
  _loaded: false,

  /** Известные неполадки. status: fixed — исправлено, watch — под наблюдением, open — открыто. */
  known: [
    {
      id: 'frame-not-covering-bubble',
      title: 'Рамка накрыла одну строку из нескольких, второй строки нет и в «как распознано»',
      status: 'watch', since: 'v1.9.99',
      check: 'В журнале найдите строку «детекция WxH: боксов N, распознано строк M (отброшено K)». Если K > 0 — строки отбросило распознавание, если строк меньше, чем видно, а K = 0 — детектор не нашёл блок.',
      fix: 'Порог уверенности возвращён к 0,25 (0,22 на 1.9.98 подмешивал в реплики мусорные строки), рост рамок до целого облачка выключен — он менял геометрию и путал видимость строк. Если рамка пустая, строка берётся из неё и подтягивается к соседям; склейка слов больше не соединяет два настоящих слова («НЕ ОН» → «НЕОН»).',
      more: 'Чего это НЕ делает: если детектор отдал бокс только на одну строку, весь пузырь по нему не восстановить — для этого есть кнопка «⬚ Распознать вручную»: нажали, выделили облачко, нажали ещё раз.',
    },
    {
      id: 'manual-area',
      title: 'Реплика распознана не целиком («НОНО» вместо «ПОНЯТНО»)',
      status: 'watch', since: 'v1.9.100',
      check: 'Нажмите «⬚» на нижней панели (или «Распознать вручную» в шторке «Текст страницы»), проведите рамку вокруг облачка и нажмите «⬚» ещё раз. В журнале появится «выделено вручную: «…»».',
      fix: 'Выделение читается двумя независимыми способами — как полоса всей страницы (на тёмной странице ещё и бинаризованной) и как вырезанный кроп с перебором увеличений и подготовок; из двух берётся чтение с лучшей оценкой (словарные слова минус слипшиеся), и только если оно лучше уже прочитанного. Раньше кнопка могла заменить нормальный текст мусором — теперь не может. Двойной тап убран: на телефоне он попадал в системное меню картинки и не засчитывался.',
      more: 'Если и в ручном режиме текст тот же и неверный — пришлите строку из журнала: значит движок не читает этот шрифт, и это уже про модель, а не про конвейер.',
    },
    {
      id: 'voice-first-only',
      title: 'Голос читает только первую реплику, дальше «страница дочитана»',
      status: 'fixed', since: 'v1.9.98–1.9.92',
      check: 'Нажмите ▶ на полосе с 2–3 репликами. В журнале должно быть по строке «озвучка … с» на КАЖДУЮ реплику.',
      fix: 'Читалка больше не отменяет речь перед каждой фразой, колбэки прошлой фразы не могут двигать очередь, оборванная фраза повторяется один раз.',
      more: 'Если повторится — в журнале будет «оборвана, повтор» или «движок не начал фразу». Пришлите эти строки.',
    },
    {
      id: 'page-done-silent',
      title: '«Страница дочитана», а звука не было',
      status: 'fixed', since: 'v1.9.89',
      check: 'После ▶ не должно быть галочек «прочитано» без озвучки: отметка ставится только по концу фразы.',
      fix: 'Если движок дважды подряд «проглотил» фразу, чтение останавливается с сообщением, страница НЕ объявляется дочитанной.',
    },
    {
      id: 'tts-slow-start',
      title: 'Первая реплика начинается с задержкой',
      status: 'fixed', since: 'v1.9.89–1.9.92',
      check: '⚙ «Движок и модели» → блок «ГОЛОС»: там видно время старта проверки.',
      fix: 'Синтез прогревается при запуске приложения и при открытии главы, плюс кнопка «Прогреть голос». После прогрева страницы читаются сразу.',
    },
    {
      id: 'tts-no-voice',
      title: '«Система не дала ни одного голоса» / голос молчит',
      status: 'watch', since: '—',
      check: '⚙ → «Проверить TTS». В отчёте будет список голосов и ошибка движка, если она есть.',
      fix: 'Это настройка Android: Настройки → Система → Языки → Синтез речи → выбрать движок (Google TTS / Tera TTS) и русский голос, затем «Прогреть голос».',
    },
    {
      id: 'scan-loop',
      title: 'Тост «Полоса/Страница … обновлена: 0 реплик» повторяется сам',
      status: 'fixed', since: 'v1.9.88',
      check: 'Страница с облачком, где только «…»: подождите 30 секунд без нажатий — должен быть один проход, не серия.',
      fix: 'Полоса считается прочитанной по объединению кусков и не пересчитывается 12 секунд подряд.',
    },
    {
      id: 'dark-text',
      title: 'Белый текст на тёмном фоне не попадает в реплики',
      status: 'fixed', since: 'v1.9.88',
      check: '«Текст страницы»: надписи поверх тёмного рисунка должны быть в списке.',
      fix: 'Кроп с тёмным фоном автоматически инвертируется перед распознаванием.',
    },
    {
      id: 'word-lost',
      title: 'Слово в облачке не подсвечено / пропало',
      status: 'watch', since: 'v1.9.86',
      check: '«Текст страницы» → «Распознать заново»: строка должна появиться. Все найденные рамки обязаны иметь текст.',
      fix: 'Рамки рисуются до распознавания, пустых не остаётся. Если слово так и не читается — это ошибка распознавателя: пришлите страницу в журнал.',
    },
    {
      id: 'scan-ahead',
      title: 'Распознаёт больше, чем видно в кадре',
      status: 'fixed', since: 'v1.9.87',
      check: '«Текст страницы»: «полос: N»; на экране должна быть только текущая полоса.',
      fix: 'Полоса считается по готовой раскладке ленты, распознаётся ровно видимое.',
    },
    {
      id: 'play-jumps',
      title: '▶ молча уезжает на следующую страницу',
      status: 'fixed', since: 'v1.9.87',
      check: 'Нажмите ▶ на полосе, где есть текст — должна зазвучать реплика из кадра.',
      fix: 'Перед переходом полоса пересчитывается по геометрии; если в кадре пусто, читалка говорит «листните», а не уезжает.',
    },
    {
      id: 'update-stuck',
      title: 'Обновил страницу, а версия старая (правки «не доехали»)',
      status: 'fixed', since: 'v1.9.90',
      check: 'Версия в шапке читалки. При расхождении с сервером приложение само показывает «Вышла новая версия …».',
      fix: 'Кеш помечается версией, оболочка берётся мимо кеша, сверка с version.json при запуске и при возврате на экран.',
    },
    {
      id: 'slow-ocr',
      title: 'Распознавание медленное: 2–4 с на полосу',
      status: 'open', since: '—',
      check: '«Текст страницы»: «итого X с = детектор Y + распознавание Z».',
      fix: 'Пока не ускорено. Помогает «Распознать всю страницу целиком» на длинных страницах и предраспознавание во время чтения.',
    },
    {
      id: 'variants',
      title: '«Перебор вариантов: 3–8» — непонятно, что выбрано',
      status: 'open', since: '—',
      check: 'Строка в «Текст страницы», если распознавание шло тяжёлым путём.',
      fix: 'Пока не сделано: нужен показ выбранного варианта. Правки слов можно задать в ☰ → «Правки слов».',
    },
    {
      id: 'comicinfo',
      title: 'ComicInfo.xml не читается',
      status: 'open', since: '—',
      fix: 'Пока нет. Название серии и номера глав берутся из имён файлов.',
    },
    {
      id: 'no-audio-env',
      title: 'В этой среде нет синтеза речи вовсе',
      status: 'watch', since: '—',
      check: '⚙ → «Проверить TTS»: «движок: Web Speech / Android TTS / нет».',
      fix: 'В обычном браузере Android Web Speech есть всегда; в предпросмотрах и урезанных WebView — нет. В АПК используется Android TTS.',
    },
    {
      id: 'memory',
      title: 'Стало медленно, страниц много',
      status: 'watch', since: '—',
      check: '☰ → «Буфер строк»: сколько страниц и строк сохранено.',
      fix: '☰ → «Буфер строк» → «Очистить», или ⚙ «Забыть текст этой книги» — распознанное пересчитается заново.',
    },
  ],

  async init() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const row = await DB.get('kv', 'journal');
      const v = (row && row.v) || [];
      if (Array.isArray(v) && v.length) this.events = v.slice(-this.max);
    } catch (e) { /* базы нет — живём в памяти */ }
  },

  /** Записать событие: cat — «голос», «распознавание», «обновление», «ошибка»… */
  add(cat, text, data) {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    const e = { t: hh + ':' + mm + ':' + ss, cat: String(cat || 'событие'), text: String(text || '') };
    if (data && typeof data === 'object') e.data = data;
    this.events.push(e);
    if (this.events.length > this.max) this.events = this.events.slice(-this.max);
    if (this._saveT) clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { this._saveT = null; this.save().catch(() => {}); }, 1200);
    // Если журнал открыт — показываем сразу, без перерисовки вручную.
    try { if (typeof renderJournal === 'function'
      && $('#sheetJournal') && $('#sheetJournal').classList.contains('on')) renderJournal(); } catch (err) { /* ignore */ }
    return e;
  },

  async save() {
    try { await DB.put('kv', { k: 'journal', v: this.events.slice(-this.max) }); } catch (e) { /* ignore */ }
  },

  clear() {
    this.events = [];
    try { DB.put('kv', { k: 'journal', v: [] }).catch(() => {}); } catch (e) { /* ignore */ }
  },

  /** Текст для «Скопировать»: шапка с версией и все события. */
  asText() {
    const head = 'KOMA ' + (typeof VERSION !== 'undefined' ? VERSION : '?')
      + ' · ' + new Date().toLocaleString('ru-RU') + '\n';
    const body = this.events.map(e => '[' + e.t + '] ' + e.cat + ' · ' + e.text).join('\n');
    return head + body;
  },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Macrotask-пауза: await внутри async-цепочек даёт только микрозадачи, браузер
// не рисует и не обрабатывает ввод — на телефоне бейдж «Распознаём…» замирает
// и страница выглядит зависшей. setTimeout отдаёт главный поток браузеру.
const yieldUI = () => new Promise(r => setTimeout(r, 0));

const VERSION = 'v1.9.100';

/* Формат сохранённого текста (не версия сборки!).
   Раньше буфер распознанного текста привязывался к VERSION, и КАЖДОЕ
   обновление читалки выбрасывало весь готовый текст: в журнале 06.11 подряд
   «Текст прежней версии читалки забыт: 5 стр. распознаются заново» и
   «Текст книги забыт: убрано записей 2. Распознаем заново», после чего человек
   заново ждал 10–15 с на полосу. Теперь буфер сбрасывается только когда
   меняется сам формат строк — и это число поднимаем руками. */
const TEXT_FORMAT = 3;

/* ───────────────────────── 1. Хранилище (IndexedDB) ─────────────────────────
   Всё локально: книги — блобы страниц, модели — ArrayBuffer, правила — JSON.
   Ничего не уходит в сеть: сервера у этой страницы нет.                        */
const DB = (() => {
  let dbp = null;
  // Если IndexedDB недоступен (предпросмотр в песочнице без same-origin),
  // работаем в памяти: библиотека и чтение живут до перезагрузки страницы,
  // но кнопки не «молчат».
  const memory = { books: new Map(), pages: new Map(), kv: new Map() };
  let useMemory = false;
  const memApi = {
    put: async (store, val) => {
      const key = store === 'books' ? val.id : store === 'pages' ? val.key : val.k;
      memory[store].set(key, val);
    },
    get: async (store, key) => memory[store].get(key),
    del: async (store, key) => { memory[store].delete(key); },
    all: async (store) => Array.from(memory[store].values()),
    clear: async (store) => { memory[store].clear(); },
  };
  function open() {
    if (dbp) return dbp;
    const raw = new Promise((res, rej) => {
      const r = indexedDB.open('koma-web', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('indexedDB открыть не удалось'));
      r.onblocked = () => rej(new Error('indexedDB заблокирован другой вкладкой'));
    });
    // Страховка: если браузер не ответил за 3 секунды (песочница, приватный
    // режим, «зависшая» вкладка), не висим навсегда — уходим в память.
    // Иначе любая запись (буфер, модели, книги) молча не завершалась.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('indexedDB не ответил за 3 с')), 3000));
    dbp = Promise.race([raw, timeout]);
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const p = fn(s);
      if (p && p.onsuccess !== undefined) p.onsuccess = () => { out = p.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  }
  const realApi = {
    put: (store, val) => tx(store, 'readwrite', s => s.put(val)),
    get: (store, key) => tx(store, 'readonly', s => s.get(key)),
    del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
    all: (store) => tx(store, 'readonly', s => s.getAll()),
    clear: (store) => tx(store, 'readwrite', s => s.clear()),
  };
  const wrap = (fn) => async (...args) => {
    if (useMemory) return memApi[fn.name](...args);
    try { return await realApi[fn.name](...args); }
    catch (e) {
      if (useMemory) return memApi[fn.name](...args);
      // Первый же отказ — переходим в память и говорим об этом один раз.
      console.warn('IndexedDB недоступен, работаю в памяти:', e);
      useMemory = true;
      DB.inMemory = true;
      return memApi[fn.name](...args);
    }
  };
  return {
    inMemory: false,
    put: wrap({ name: 'put' }), get: wrap({ name: 'get' }), del: wrap({ name: 'del' }),
    all: wrap({ name: 'all' }), clear: wrap({ name: 'clear' }),
  };
})();

/* ───────────────────────── 2. ZIP/CBZ без библиотек ─────────────────────────
   Используем DecompressionStream('deflate-raw') — есть в Chrome 80+/Safari 16+. */
async function unzip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // ищем End of Central Directory
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('не ZIP');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + cmtLen;
    if (name.endsWith('/')) continue;
    if (!/\.(jpe?g|png|webp|avif|bmp|gif)$/i.test(name)) continue;
    // локальный заголовок
    const lnLen = dv.getUint16(localOff + 26, true);
    const leLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lnLen + leLen;
    const raw = u8.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const blob = new Blob([raw.slice()]);
      data = new Uint8Array(await new Response(blob.stream().pipeThrough(ds)).arrayBuffer());
    } else throw new Error('метод сжатия ' + method);
    files.push({ name, data });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return files;
}

/* ─────────────────── 2b. Плагины (JSON, без пересборки АПК) ───────────────────
   Зачем: любая правка поведения (правила распознавания, замены слов, голос)
   должна ехать ФАЙЛОМ, а не новой сборкой АПК. Плагины читает приложение
   (мост `KomaPlugins`): вшитые в сборку assets/plugins и положенные человеком
   в папку plugins рядом с приложением. Здесь они применяются.

   Формат файла:
     { "id": "...", "name": "...", "order": 10,
       "rules": {...}, "wordFixes": {...},
       "replace": [{"from": "ГОВОРЯ.ш", "to": "ГОВОРИШЬ"}],
       "voice": {"engine": "", "voice": "", "rate": 1.0},
       "ocr": {"engine": "auto"} }                                        */
const Plugins = {
  list: [], problems: [], dir: '', loaded: false,

  bridge() {
    return (typeof window !== 'undefined' && window.KomaPlugins
      && typeof window.KomaPlugins.all === 'function') ? window.KomaPlugins : null;
  },
  present() { return !!this.bridge(); },

  async load() {
    this.list = []; this.problems = []; this.dir = ''; this.loaded = false;
    const b = this.bridge();
    if (b) {
      try {
        const raw = b.all();
        const data = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw || {}));
        if (data && Array.isArray(data.plugins)) this.list = data.plugins.filter(p => p && typeof p === 'object');
        if (data && Array.isArray(data.problems)) this.problems = data.problems.map(String);
        if (data && data.dir) this.dir = String(data.dir);
      } catch (e) {
        this.problems.push('плагины не прочитались: ' + ((e && e.message) || e));
      }
    }
    this.loaded = true;
    return this.list;
  },

  /** Плагины по возрастанию order: последний — самый главный. */
  ordered() {
    return this.list.slice().sort((a, b) => (Number(a.order) || 100) - (Number(b.order) || 100));
  },

  /** Правила из плагинов: накладываются на сохранённые, поверх — sanitizeRules. */
  rules() {
    const out = {};
    for (const p of this.ordered()) {
      if (p.rules && typeof p.rules === 'object') Object.assign(out, p.rules);
      if (p.ocr && typeof p.ocr === 'object' && p.ocr.engine) out.ocrEngine = p.ocr.engine;
    }
    return out;
  },

  /** Словарные правки из всех плагинов (слово → слово). */
  wordFixes() {
    const out = {};
    for (const p of this.ordered()) {
      if (p.wordFixes && typeof p.wordFixes === 'object') {
        for (const [k, v] of Object.entries(p.wordFixes)) {
          if (typeof v === 'string' && k) out[k] = v;
        }
      }
    }
    return out;
  },

  /** Точечные замены в распознанном тексте. */
  replaceList() {
    const out = [];
    for (const p of this.ordered()) {
      if (!Array.isArray(p.replace)) continue;
      for (const r of p.replace) {
        if (r && typeof r.from === 'string' && r.from) {
          out.push({ from: r.from, to: typeof r.to === 'string' ? r.to : '' });
        }
      }
    }
    return out;
  },

  /** Замены применяются к готовой реплике: сначала точные, потом словарные. */
  text(text) {
    let t = String(text || '');
    if (!t) return t;
    for (const r of this.replaceList()) {
      if (t.indexOf(r.from) !== -1) t = t.split(r.from).join(r.to);
    }
    const fixes = this.wordFixes();
    if (Object.keys(fixes).length) {
      t = t.replace(/[\p{L}\p{N}]+/gu, (w) => {
        if (fixes[w] != null) return fixes[w];
        const up = w.toUpperCase(), low = w.toLowerCase();
        if (fixes[up] != null) return /^\p{Lu}/u.test(w) ? fixes[up] : fixes[up].toLowerCase();
        if (fixes[low] != null) return fixes[low];
        return w;
      });
    }
    return t;
  },

  /** Голос из плагинов (движок/голос/скорость) — применяется при запуске. */
  voice() {
    const out = { engine: '', voice: '', rate: 0 };
    for (const p of this.ordered()) {
      if (!p.voice || typeof p.voice !== 'object') continue;
      if (typeof p.voice.engine === 'string') out.engine = p.voice.engine;
      if (typeof p.voice.voice === 'string') out.voice = p.voice.voice;
      if (Number.isFinite(+p.voice.rate) && +p.voice.rate > 0) out.rate = +p.voice.rate;
    }
    return out;
  },

  /** Что показать человеку в настройках. */
  describe() {
    if (!this.present()) return 'Плагинов нет: страница открыта не в приложении.';
    if (!this.list.length) return 'Плагинов нет. Папка: ' + (this.dir || '—');
    const names = this.ordered().map(p => (p.name || p.id || 'без имени')
      + (p._source ? ' [' + p._source + ']' : ''));
    return 'Плагинов: ' + this.list.length + '\n' + names.join('\n')
      + (this.problems.length ? '\nОшибки: ' + this.problems.join('; ') : '')
      + '\nПапка: ' + (this.dir || '—');
  },
};

/* ───────────────────────── 3. Библиотека ───────────────────────── */
const Library = {
  books: [],            // главы
  series: [],           // серии (полка показывает их, как в Yomikai)
  cat: 'all',           // выбранная полка
  filter: 'all',        // all | reading | new | done
  query: '',
  sort: 'recent',       // recent | old | title | left
  view: 'grid',
  selectedId: '',

  async load() {
    const rows = (await DB.all('books') || []);
    this.series = rows.filter(r => r && r.type === 'series');
    this.books = rows.filter(r => !r || r.type !== 'series');
    await this.migrate();
    this.series.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    this.books.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    renderLibrary();
    if (typeof renderHistory === 'function') renderHistory();
  },

  /**
   * Переезд со старой полки на «серии → главы» (1.0.30).
   *
   * До этого каждая глава лежала отдельной книгой, и полка выглядела как свалка
   * из «Том 1 Глава 1», «Том 1 Глава 2»… В Yomikai полка — это серии, а главы
   * внутри. Ничего не теряем: старые записи становятся главами, а серия
   * заводится по названию («Том 2 Глава 3» → серия «Том 2»).
   */
  async migrate() {
    const known = new Map(this.series.map(s => [String(s.title || '').toLowerCase(), s]));
    let touched = 0;
    for (const ch of this.books) {
      if (!ch) continue;
      let dirty = false;
      if (ch.type !== 'chapter') { ch.type = 'chapter'; dirty = true; }
      if (!ch.seriesId) {
        const name = seriesTitleOf(ch.title || 'Глава');
        let s = known.get(name.toLowerCase());
        if (!s) {
          s = {
            id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: 'series', title: name, category: 'Без полки',
            cover: ch.cover || null, at: Number(ch.at) || Date.now(), kind: ch.kind || 'files',
          };
          this.series.push(s);
          known.set(name.toLowerCase(), s);
          await DB.put('books', s);
        }
        ch.seriesId = s.id;
        ch.index = Number.isFinite(ch.index) ? ch.index : (this.chaptersOf(s.id).length + 1);
        dirty = true;
        if (!s.cover && ch.cover) { s.cover = ch.cover; await DB.put('books', s); }
      }
      if (dirty) { await DB.put('books', ch); touched++; }
    }
    // серии без глав убираем: иначе на полке висят пустые карточки
    for (const s of this.series.slice()) {
      if (!this.chaptersOf(s.id).length && !this.books.some(b => b.seriesId === s.id)) {
        this.series = this.series.filter(x => x.id !== s.id);
        await DB.del('books', s.id);
      }
    }
    return touched;
  },

  chaptersOf(seriesId) {
    return this.books
      .filter(b => b.seriesId === seriesId)
      .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  },
  seriesOf(chapter) {
    return this.series.find(s => s.id === (chapter && chapter.seriesId)) || null;
  },
  cats() {
    const set = new Set(this.series.map(s => s.category || 'Без полки'));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  },

  async addSeries(title, category) {
    const s = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'series', title: title || 'Без названия', category: category || 'Без полки',
      cover: null, at: Date.now(), kind: 'files',
    };
    await DB.put('books', s);
    // Держим в памяти сразу: иначе обложка из первой главы не долетит до серии
    // (серия только что создана и в this.series её ещё нет — телефон 5.11).
    this.series.push(s);
    return s;
  },
  async addChapter(seriesId, title, files, kind) {
    const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const pages = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = String(f.name || ('page-' + i)).split('/').pop();
      const blob = f.blob || new Blob([f.data], { type: mimeOf(name) });
      const key = id + '/' + i;
      await DB.put('pages', { key, id, index: i, name, blob });
      pages.push({ key, name });
    }
    const coverRow = pages.length ? await DB.get('pages', pages[0].key) : null;
    // Без ?. — старые WebView (Chrome < 80) не разбирают такой синтаксис вообще,
    // и тогда не выполняется ни один скрипт страницы.
    const cover = coverRow ? coverRow.blob : null;
    const sibs = this.chaptersOf(seriesId);
    // Естественный порядок (как в Yomikai): «Глава 10» идёт после «Глава 2»,
    // поэтому номер берём из названия, а не из порядка добавления.
    const parsed = chapterNumberOf(title);
    const chapter = {
      id, type: 'chapter', seriesId, title: title || ('Глава ' + (sibs.length + 1)),
      index: parsed != null ? parsed : sibs.length + 1, kind: kind || 'files', count: pages.length,
      at: Date.now(), progress: 0, mode: 'vertical', cover,
    };
    await DB.put('books', chapter);
    const s = this.series.find(x => x.id === seriesId) || (await DB.get('books', seriesId));
    if (s) {
      let dirty = false;
      if (!s.cover && cover) { s.cover = cover; dirty = true; }
      s.at = Date.now(); dirty = true;
      if (dirty) await DB.put('books', s);
    }
    return chapter;
  },
  /** Совместимость со старым импортом: одна глава = новая серия. */
  async addBook(title, files, kind) {
    const s = await this.addSeries(seriesTitleOf(title || 'Глава'));
    return this.addChapter(s.id, title || 'Глава 1', files, kind);
  },
  async appendTo(bookId, files) {
    const book = await DB.get('books', bookId);
    if (!book) throw new Error('глава не найдена');
    const start = book.count || 0;
    for (let k = 0; k < files.length; k++) {
      const f = files[k];
      const name = String(f.name || ('page-' + (start + k))).split('/').pop();
      await DB.put('pages', { key: bookId + '/' + (start + k), id: bookId, index: start + k, name, blob: f.blob || f });
    }
    book.count = start + files.length;
    book.at = Date.now();
    await DB.put('books', book);
    return book;
  },
  async pages(bookId) {
    const rows = (await DB.all('pages') || []).filter(p => p.id === bookId);
    rows.sort((a, b) => a.index - b.index);
    return rows;
  },
  /** Удалить главу (и её страницы). */
  async remove(bookId) {
    const rows = (await DB.all('pages') || []).filter(p => p.id === bookId);
    for (const p of rows) await DB.del('pages', p.key);
    await DB.del('books', bookId);
  },
  /** Удалить серию целиком. */
  /** Отметить главу открытой: отсюда берётся история. */
  async touch(chapter) {
    if (!chapter) return;
    const now = Date.now();
    chapter.opened = now;
    chapter.at = now;
    try { await DB.put('books', chapter); } catch (e) {}
    const s = this.series.find(x => x.id === chapter.seriesId);
    if (s) { s.at = now; try { await DB.put('books', s); } catch (e) {} }
  },
  async removeSeries(seriesId) {
    for (const ch of this.chaptersOf(seriesId)) await this.remove(ch.id);
    await DB.del('books', seriesId);
  },
};

/** Русские склонения: plural(3, ['глава','главы','глав']) → «главы». */
function plural(n, forms) {
  const a = Math.abs(Number(n) || 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** Номер главы из названия: «Глава 10» → 10, «ch. 3» → 3, «Том 2 Глава 4» → 4. */
function chapterNumberOf(title) {
  const t = String(title || '');
  const m = t.match(/(?:глава|гл\.|chapter|chap\.|ch\.|эпизод|episode)\s*[№#]?\s*(\d+(?:\.\d+)?)/i)
    || t.match(/\b(\d+(?:\.\d+)?)\b/);
  return m ? parseFloat(m[1]) : null;
}

/** «Том 2 Глава 3» → «Том 2»; «Глава 7» → «Без названия»; иначе — как есть. */
function seriesTitleOf(title) {
  let t = String(title || '').trim();
  if (!t) return 'Без названия';
  t = t.replace(/[·—–-]?\s*(глава|гл\.?|chapter|chap\.?|эпизод|episode)\s*[№#]?\s*\d+.*$/i, '').trim();
  t = t.replace(/[\s·—–-]+$/, '').trim();
  if (!t || /^(том|vol\.?|volume)\s*[№#]?\s*\d+$/i.test(t)) return t || 'Без названия';
  return t || 'Без названия';
}

/* ───────────────────────── Полка (как в Yomikai) ───────────────────────────
   Полка показывает СЕРИИ. Внутри серии — главы (шторка «Главы»). Сверху полки:
   свои полки-категории, под ними — состояние (читаю / не начато / закончено),
   справа — сортировка и вид. Снизу — три вкладки: Библиотека · История · Ещё.  */

function mimeOf(name) {
  const e = name.split('.').pop().toLowerCase();
  return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : 'image/jpeg';
}

const LIB_COVERS = new Map();
function libCoverUrl(book) {
  const key = book && (book.id || book.seriesId);
  const blob = book && (book.cover || null);
  if (!key || !blob) return '';
  if (LIB_COVERS.has(key)) return LIB_COVERS.get(key);
  let url = '';
  try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
  LIB_COVERS.set(key, url);
  return url;
}
function libCoverDrop(id) {
  const url = LIB_COVERS.get(id);
  if (url) { try { URL.revokeObjectURL(url); } catch (e) {} LIB_COVERS.delete(id); }
}

function chapState(ch) {
  const count = Number(ch.count) || 0;
  const prog = clamp(Number(ch.progress) || 0, 0, Math.max(0, count - 1));
  const opened = Number(ch.opened) > 0;
  // Глава из одной страницы: «дочитано» только если её действительно открывали.
  // Иначе только что добавленная глава сразу числилась бы прочитанной.
  if (count > 1 && prog >= count - 1) return 'done';
  if (count === 1 && opened) return 'done';
  return (prog > 0 || opened) ? 'reading' : 'new';
}
function seriesState(s) {
  const chs = Library.chaptersOf(s.id);
  if (!chs.length) return 'new';
  const states = chs.map(chapState);
  if (states.every(x => x === 'done')) return 'done';
  if (states.some(x => x !== 'new')) return 'reading';
  return 'new';
}
function seriesUnread(s) {
  return Library.chaptersOf(s.id).filter(c => chapState(c) === 'new').length;
}
function seriesPercent(s) {
  const chs = Library.chaptersOf(s.id);
  if (!chs.length) return 0;
  const pages = chs.reduce((a, c) => a + (Number(c.count) || 0), 0) || 1;
  const read = chs.reduce((a, c) => a + clamp(Number(c.progress) || 0, 0, Number(c.count) || 0), 0);
  return Math.round(read / pages * 100);
}
function chapPlace(ch) {
  const count = Number(ch.count) || 0;
  const prog = clamp(Number(ch.progress) || 0, 0, Math.max(0, count - 1));
  const st = chapState(ch);
  if (st === 'done') return 'дочитано';
  if (st === 'reading') return `стр. ${prog + 1} из ${count}`;
  return `${count} ${plural(count, ['страница', 'страницы', 'страниц'])} · не начато`;
}
function libAgo(at) {
  if (!at) return '';
  const d = new Date(Number(at));
  const now = new Date();
  const day = 24 * 3600 * 1000;
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((b - a) / day);
  if (diff <= 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  if (diff < 7) return diff + ' дн. назад';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function libKindName(ch) {
  if (ch.mode === 'vertical') return 'лента';
  if (ch.mode === 'rtl') return 'манга';
  return 'страницы';
}

/** Какая глава логична для «продолжить»: недоконченная, иначе первая не начатая. */
function seriesNext(s) {
  const chs = Library.chaptersOf(s.id);
  const reading = chs.filter(c => chapState(c) === 'reading')
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  if (reading.length) return reading[0];
  const fresh = chs.find(c => chapState(c) === 'new');
  return fresh || chs[chs.length - 1] || null;
}

function libSeriesList() {
  const cat = Library.cat || 'all';
  const q = String(Library.query || '').trim().toLowerCase();
  let list = Library.series.slice();
  if (cat === 'fav') list = list.filter(s => !!s.fav);
  else if (cat !== 'all') list = list.filter(s => (s.category || 'Без полки') === cat);
  const f = Library.filter || 'all';
  if (f !== 'all') list = list.filter(s => seriesState(s) === f);
  if (q) list = list.filter(s => String(s.title || '').toLowerCase().includes(q));
  const sort = Library.sort || 'recent';
  const cmp = {
    recent: (a, b) => (Number(b.at) || 0) - (Number(a.at) || 0),
    old: (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ru', { numeric: true }),
    left: (a, b) => seriesUnread(b) - seriesUnread(a),
  }[sort] || ((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return list.sort(cmp);
}

function libContinueChapter() {
  const chs = Library.books.filter(c => chapState(c) === 'reading')
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return chs[0] || null;
}

function renderLibraryHero() {
  const box = $('#libHero');
  if (!box) return;
  const ch = libContinueChapter();
  if (!ch) { box.classList.remove('on'); box.innerHTML = ''; return; }
  const s = Library.seriesOf(ch);
  const url = libCoverUrl(s || ch);
  box.classList.add('on', 'fade');
  box.innerHTML = (url ? `<img src="${url}" alt="">` : '<div class="nofoto">НЕТ ОБЛОЖКИ</div>')
    + `<div class="txt">
         <div class="kicker">Продолжить чтение</div>
         <div class="name">${escapeHtml(s ? s.title : ch.title)}</div>
         <div class="meta">${escapeHtml(ch.title)} · ${chapPlace(ch)} · ${libKindName(ch)}</div>
       </div>
       <button class="go" title="Продолжить">▶</button>`;
  const open = () => openBook(ch);
  box.querySelector('.go').onclick = open;
  box.querySelector('.txt').onclick = open;
}

function renderLibrary() {
  const allSeries = Library.series;
  const list = libSeriesList();
  const sub = $('#libSub');
  const chapters = Library.books.length;
  const pages = Library.books.reduce((a, c) => a + (Number(c.count) || 0), 0);

  if (sub) {
    sub.textContent = allSeries.length
      ? `${allSeries.length} ${plural(allSeries.length, ['серия', 'серии', 'серий'])}`
        + ` · ${chapters} ${plural(chapters, ['глава', 'главы', 'глав'])} · ${pages} ${plural(pages, ['страница', 'страницы', 'страниц'])}`
      : 'локальные файлы · ничего не уходит в сеть';
  }

  // полки
  const catsBox = $('#libCats');
  if (catsBox) {
    const cats = Library.cats();
    const favCount = allSeries.filter(s => s.fav).length;
    const items = [{ name: 'all', label: 'Все полки', n: allSeries.length },
      { name: 'fav', label: '★ Избранное', n: favCount }]
      .concat(cats.map(c => ({
        name: c, label: c,
        n: allSeries.filter(s => (s.category || 'Без полки') === c).length,
      })));
    catsBox.innerHTML = items.map(it =>
      `<button data-cat="${escapeHtml(it.name)}" class="${(Library.cat || 'all') === it.name ? 'on' : ''}">`
      + `${escapeHtml(it.label)}<b>${it.n}</b></button>`).join('');
    catsBox.querySelectorAll('button').forEach(b => {
      b.onclick = () => { Library.cat = b.dataset.cat; renderLibrary(); };
    });
  }

  // состояния
  const counts = { all: allSeries.length, reading: 0, new: 0, done: 0 };
  for (const s of allSeries) counts[seriesState(s)]++;
  $$('#libChips .chip').forEach(c => {
    const f = c.dataset.filter || 'all';
    const num = c.querySelector('.num');
    if (num) num.textContent = String(counts[f] === undefined ? 0 : counts[f]);
    c.classList.toggle('on', f === (Library.filter || 'all'));
  });

  const sortSel = $('#libSort');
  if (sortSel) sortSel.value = Library.sort || 'recent';
  const viewBtn = $('#btnLibView');
  if (viewBtn) viewBtn.textContent = (Library.view === 'list') ? 'Список' : 'Обложки';
  const grid = $('#libGrid');
  const rows = $('#libList');
  if (grid) grid.style.display = (Library.view === 'list') ? 'none' : '';
  if (rows) rows.style.display = (Library.view === 'list') ? 'flex' : 'none';

  renderLibraryHero();

  const empty = $('#libEmpty');
  if (empty) empty.style.display = allSeries.length ? 'none' : 'block';
  if (grid) grid.innerHTML = '';
  if (rows) rows.innerHTML = '';

  if (allSeries.length && !list.length) {
    const msg = (Library.query ? 'По запросу «' + escapeHtml(Library.query) + '» ничего нет.'
      : 'В этой полке и фильтре ничего нет.') + '<br>Сбросьте фильтр, полку или поиск.';
    if (Library.view === 'list' && rows) rows.innerHTML = `<div class="empty" style="padding:26px 10px">${msg}</div>`;
    else if (grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:26px 10px">${msg}</div>`;
    return;
  }

  for (const s of list) {
    if (Library.view === 'list') rows.appendChild(libSeriesRow(s));
    else grid.appendChild(libSeriesCard(s));
  }
}

function libSeriesCard(s) {
  const el = document.createElement('div');
  el.className = 'card fade' + (seriesState(s) === 'done' ? ' done' : '');
  el.dataset.id = s.id;
  const url = libCoverUrl(s);
  const pct = seriesPercent(s);
  const chs = Library.chaptersOf(s.id).length;
  const unread = seriesUnread(s);
  const st = seriesState(s);
  el.innerHTML = `
    <div class="shot">
      ${url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()">` : '<div class="nofoto">НЕТ ОБЛОЖКИ</div>'}
      <div class="flag">${s.fav ? '★ ' : ''}${st === 'done' ? 'дочитано' : unread ? `${unread} новых` : 'читаю'}</div>
      <button class="more" title="Меню серии">⋯</button>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="cap">${escapeHtml(s.title)}</div>
    <div class="cap2"><span>${chs} ${plural(chs, ['глава', 'главы', 'глав'])}</span>`
    + `<span>·</span><span>${s.at ? libAgo(s.at) : ''}</span></div>`;
  el.onclick = (e) => {
    if (e.target.closest('.more')) { openSeriesMenu(s); return; }
    openChapters(s);
  };
  libLongPress(el, () => openSeriesMenu(s));
  return el;
}

function libSeriesRow(s) {
  const el = document.createElement('div');
  el.className = 'row-card fade';
  el.dataset.id = s.id;
  const url = libCoverUrl(s);
  const pct = seriesPercent(s);
  const chs = Library.chaptersOf(s.id);
  const next = seriesNext(s);
  const unread = seriesUnread(s);
  el.innerHTML = `
    ${url ? `<img src="${url}" alt="" loading="lazy">` : '<div class="nofoto">НЕТ</div>'}
    <div class="txt">
      <div class="name">${escapeHtml(s.title)}</div>
      <div class="meta">${chs.length} ${plural(chs.length, ['глава', 'главы', 'глав'])}${unread
        ? ` · ${unread} не начато`
        : (next ? ' · ' + chapPlace(next) : '')}</div>
      <div class="mini"><i style="width:${pct}%"></i></div>
    </div>
    <button class="more" title="Меню серии">⋯</button>`;
  el.onclick = (e) => {
    if (e.target.closest('.more')) { openSeriesMenu(s); return; }
    openChapters(s);
  };
  libLongPress(el, () => openSeriesMenu(s));
  return el;
}

function libLongPress(el, fn) {
  let timer = null;
  el.addEventListener('touchstart', () => { timer = setTimeout(() => { timer = null; fn(); }, 480); }, { passive: true });
  el.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('touchmove', () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
}

/* ── главы серии ── */
let LIB_OPEN_SERIES = null;
function openChapters(s) {
  LIB_OPEN_SERIES = s;
  const title = $('#libChaptersTitle');
  if (title) title.textContent = s.title || 'Главы';
  const box = $('#libChaptersList');
  if (box) {
    const chs = Library.chaptersOf(s.id);
    box.innerHTML = chs.length ? chs.map((c, i) => {
      const st = chapState(c);
      return `<div class="chaprow ${st === 'done' ? 'done' : st === 'reading' ? 'read' : ''}" data-id="${c.id}">
        <div class="chapnum">${i + 1}</div>
        <div class="chaptxt">
          <div class="chaptitle">${escapeHtml(c.title)}</div>
          <div class="chapmeta">${chapPlace(c)} · ${libKindName(c)}${c.at ? ' · ' + libAgo(c.at) : ''}</div>
        </div>
        <div class="chapgo">${st === 'done' ? '✓' : '▶'}</div>
      </div>`;
    }).join('') : '<div class="hint" style="padding:14px 0">В этой серии пока нет глав.</div>';
    box.querySelectorAll('.chaprow').forEach(row => {
      row.onclick = () => {
        const ch = Library.books.find(b => b.id === row.dataset.id);
        closeSheets();
        if (ch) openBook(ch);
      };
    });
  }
  openSheet('libChapters');
}

/* ── меню серии ── */
let SERIES_MENU = null;
let seriesDeleteArmed = false;
function openSeriesMenu(s) {
  SERIES_MENU = s;
  seriesDeleteArmed = false;
  const t = $('#libMenuTitle');
  if (t) t.textContent = s.title || 'Серия';
  const del = $('#libMenuDelete');
  if (del) del.textContent = 'Удалить серию';
  const open = $('#libMenuOpen');
  if (open) open.textContent = 'Открыть главы';
  const start = $('#libMenuStart');
  if (start) start.textContent = 'Продолжить чтение';
  const fav = $('#libMenuFav');
  if (fav) fav.textContent = s.fav ? 'Убрать из избранного' : 'В избранное';
  openSheet('libMenu');
}
function bindLibMenu() {
  const close = () => closeSheets();
  if ($('#libMenuClose')) $('#libMenuClose').onclick = close;
  if ($('#libMenuOpen')) $('#libMenuOpen').onclick = () => {
    const s = SERIES_MENU; close(); if (s) openChapters(s);
  };
  if ($('#libMenuStart')) $('#libMenuStart').onclick = () => {
    const s = SERIES_MENU; close();
    const ch = s && seriesNext(s);
    if (ch) openBook(ch);
  };
  if ($('#libMenuRename')) $('#libMenuRename').onclick = () => {
    const s = SERIES_MENU; close(); if (s) openLibRename(s);
  };
  if ($('#libMenuDelete')) $('#libMenuDelete').onclick = async (e) => {
    const s = SERIES_MENU;
    if (!s) return;
    if (!seriesDeleteArmed) {
      seriesDeleteArmed = true;
      e.currentTarget.textContent = 'Точно удалить «' + String(s.title || '').slice(0, 16) + '»?';
      return;
    }
    close();
    libCoverDrop(s.id);
    await Library.removeSeries(s.id);
    await Library.load();
    toast('Серия удалена');
  };
  // «Полка» — тот же пункт меню, что переименование, но для категории
  if ($('#libMenuFav')) $('#libMenuFav').onclick = async () => {
    const s = SERIES_MENU;
    close();
    if (!s) return;
    s.fav = !s.fav;
    await DB.put('books', s);
    await Library.load();
    toast(s.fav ? 'В избранном' : 'Убрано из избранного');
  };
  const catBtn = $('#libMenuCat');
  if (catBtn) catBtn.onclick = () => { const s = SERIES_MENU; close(); if (s) openLibCat(s); };
}

/* ── полка (категория) серии ── */
let LIB_CAT_SERIES = null;
function openLibCat(s) {
  LIB_CAT_SERIES = s;
  const inp = $('#libCatInput');
  if (inp) inp.value = s.category || 'Без полки';
  const box = $('#libCatChips');
  if (box) {
    const cats = Library.cats();
    box.innerHTML = cats.map(c => `<button class="chip" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')
      || '<span class="hint">Полок пока нет — введите название.</span>';
    box.querySelectorAll('button').forEach(b => {
      b.onclick = () => { if (inp) inp.value = b.dataset.cat; };
    });
  }
  openSheet('libCat');
}
function bindLibCat() {
  const save = async () => {
    const s = LIB_CAT_SERIES;
    const inp = $('#libCatInput');
    const cat = String((inp && inp.value) || '').trim() || 'Без полки';
    closeSheets();
    if (!s) return;
    s.category = cat;
    await DB.put('books', s);
    await Library.load();
    toast('Полка: ' + cat);
  };
  if ($('#libCatSave')) $('#libCatSave').onclick = save;
  if ($('#libCatCancel')) $('#libCatCancel').onclick = () => closeSheets();
}

/* ── переименование ── */
let LIB_RENAME_BOOK = null;
function openLibRename(s) {
  LIB_RENAME_BOOK = s;
  const inp = $('#libRenameInput');
  if (inp) inp.value = s.title || '';
  openSheet('libRename');
  setTimeout(() => { if (inp) { inp.focus(); inp.select(); } }, 120);
}
function bindLibRename() {
  const save = async () => {
    const s = LIB_RENAME_BOOK;
    const inp = $('#libRenameInput');
    const name = String((inp && inp.value) || '').trim();
    closeSheets();
    if (!s || !name || name === s.title) return;
    s.title = name;
    await DB.put('books', s);
    await Library.load();
    toast('Название сохранено');
  };
  if ($('#libRenameSave')) $('#libRenameSave').onclick = save;
  if ($('#libRenameCancel')) $('#libRenameCancel').onclick = () => closeSheets();
  if ($('#libRenameInput')) $('#libRenameInput').onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

/* ── история ── */
function renderHistory() {
  const box = $('#histList');
  const sub = $('#histSub');
  if (!box) return;
  const list = Library.books.filter(b => Number(b.opened) > 0)
    .sort((a, b) => (Number(b.opened) || 0) - (Number(a.opened) || 0));
  if (sub) sub.textContent = list.length
    ? `${list.length} ${plural(list.length, ['глава', 'главы', 'глав'])} · последние сверху`
    : 'пока пусто';
  box.innerHTML = list.length ? list.map(ch => {
    const s = Library.seriesOf(ch);
    const url = s ? libCoverUrl(s) : '';
    const st = chapState(ch);
    return `<div class="row-card" data-id="${ch.id}">
      ${url ? `<img src="${url}" alt="" loading="lazy">` : '<div class="nofoto">НЕТ</div>'}
      <div class="txt">
        <div class="name">${escapeHtml(s ? s.title : ch.title)}</div>
        <div class="meta">${escapeHtml(ch.title)} · ${chapPlace(ch)}${ch.at ? ' · ' + libAgo(ch.at) : ''}</div>
      </div>
      <div class="more" style="${st === 'done' ? 'color:#8fe0b0' : ''}">${st === 'done' ? '✓' : '▶'}</div>
    </div>`;
  }).join('') : '<div class="empty"><div class="big">История пуста</div>Открой главу — она появится здесь.</div>';
  box.querySelectorAll('.row-card').forEach(row => {
    row.onclick = () => {
      const ch = Library.books.find(b => b.id === row.dataset.id);
      if (ch) openBook(ch);
    };
  });
}

/* ── связки: фильтры, поиск, сортировка, вкладки ── */
function bindLibChips() {
  $$('#libChips .chip').forEach(c => {
    c.onclick = () => { Library.filter = c.dataset.filter || 'all'; renderLibrary(); };
  });
  const bar = $('#libSearchBar');
  const inp = $('#libSearch');
  if ($('#btnLibSearch')) $('#btnLibSearch').onclick = () => {
    const on = bar && bar.classList.toggle('on');
    if (on && inp) setTimeout(() => inp.focus(), 60);
    if (!on && inp) { inp.value = ''; Library.query = ''; renderLibrary(); }
  };
  if ($('#btnLibSearchClose')) $('#btnLibSearchClose').onclick = () => {
    if (bar) bar.classList.remove('on');
    if (inp) inp.value = '';
    Library.query = '';
    renderLibrary();
  };
  if (inp) inp.oninput = () => { Library.query = inp.value; renderLibrary(); };
  if ($('#libSort')) $('#libSort').onchange = (e) => { Library.sort = e.target.value; renderLibrary(); };
  if ($('#btnLibView')) $('#btnLibView').onclick = () => {
    Library.view = Library.view === 'list' ? 'grid' : 'list';
    renderLibrary();
  };
  if ($('#libChaptersClose')) $('#libChaptersClose').onclick = () => closeSheets();
  if ($('#btnHistClear')) $('#btnHistClear').onclick = () => {
    // История — это метки открытия. Чистим их, сами главы остаются на полке.
    for (const ch of Library.books) { ch.opened = 0; }
    Promise.all(Library.books.map(ch => DB.put('books', ch))).then(() => Library.load());
    toast('История очищена');
  };
  bindLibMenu();
  bindLibRename();
  bindLibCat();
  bindLibraryNav();
}

/** Нижние вкладки: Библиотека · История · Ещё. */
function bindLibraryNav() {
  const nav = $('#libNav');
  if (!nav || nav.dataset.bound === '1') return;
  nav.dataset.bound = '1';
  // Показываем вкладки сразу: на старте открыт экран библиотеки, и ждать
  // переключения экрана, чтобы они появились, — неправильно.
  nav.classList.toggle('on', !!($('#library') && $('#library').classList.contains('on')));
  nav.querySelectorAll('.navbtn').forEach(b => {
    b.onclick = () => libGoTab(b.dataset.tab);
  });
  if ($('#btnMoreModels')) $('#btnMoreModels').onclick = () => { const el = $('#btnModels'); if (el) el.click(); };
  if ($('#btnMoreRules')) $('#btnMoreRules').onclick = () => { const el = $('#btnRulesLib'); if (el) el.click(); };
  if ($('#btnMoreImport')) $('#btnMoreImport').onclick = () => { const el = $('#btnImport'); if (el) el.click(); };
  const about = $('#moreAbout');
  if (about) {
    const v = (typeof VERSION !== 'undefined') ? VERSION : '';
    about.innerHTML = 'KOMA · веб ' + v + '<br>Всё считается на этом устройстве: распознавание, словарь, голос. '
      + 'Ни одного запроса наружу.';
  }
}
function libGoTab(tab) {
  if (typeof show === 'function') show(tab === 'library' ? 'library' : tab === 'history' ? 'history' : 'more');
  const nav = $('#libNav');
  if (nav) nav.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'history') renderHistory();
  if (tab === 'library') renderLibrary();
}
/**
 * Открыть книгу. Раньше карточка звала openBook(), а такой функции не было
 * вовсе: тап по книге молча ничего не делал. Ошибки теперь видно, а не в консоли.
 */
async function openBook(book) {
  // Голос держим наготове ДО открытия книги (просьба 06.11, 12:22): тап по
  // главе — это уже жест, значит синтезатор можно разблокировать здесь, а не
  // в момент ▶. Задержка первой реплики уходит.
  try {
    if (typeof TTS !== 'undefined' && TTS.prewarm) TTS.prewarm();
    if (typeof TTS !== 'undefined' && TTS.prime) TTS.prime();
  } catch (e) { /* голос не должен мешать открытию книги */ }
  try {
    await Reader.open(book);
    await Library.touch(book);
  } catch (e) {
    console.error('openBook', e);
    toast('Не удалось открыть «' + book.title + '»: ' + (e && e.message ? e.message : e), 5000);
  }
}
/**
 * Безопасное хранилище настроек.
 *
 * В обычном браузере это localStorage, но в песочнице предпросмотра
 * (`sandbox="allow-scripts"` без allow-same-origin) и в приватном режиме любое
 * обращение к localStorage бросает SecurityError. Раньше это валило шаг загрузки
 * «голос» — и на экране честно, но бесполезно висело «Не поднялось: голос…».
 */
const Store = {
  get(key, def = null) {
    try { const v = localStorage.getItem(key); return v === null ? def : v; }
    catch (e) { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(key, String(value)); return true; }
    catch (e) { return false; }
  },
};

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Импорт: папка / CBZ / отдельные картинки */
async function importDir(fileList) {
  const imgs = Array.from(fileList).filter(f => /\.(jpe?g|png|webp|avif|bmp|gif)$/i.test(f.name));
  if (!imgs.length) return toast('В выбранной папке нет картинок');
  imgs.sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath, undefined, { numeric: true }));
  const title = (imgs[0].webkitRelativePath || imgs[0].name).split('/')[0] || 'Глава';
  toast('Сохраняю ' + imgs.length + ' страниц…', 5000);
  await Library.addBook(title, imgs.map(f => ({ name: f.name, blob: f })), 'dir');
  await Library.load();
  toast('Добавлено: ' + title + ' (' + imgs.length + ' стр.)');
}
async function importZip(file) {
  toast('Разбираю архив…', 5000);
  const files = await unzip(await file.arrayBuffer());
  if (!files.length) return toast('В архиве нет картинок');
  const title = file.name.replace(/\.(cbz|zip)$/i, '');
  await Library.addBook(title, files, 'zip');
  await Library.load();
  toast('Добавлено: ' + title + ' (' + files.length + ' стр.)');
}
