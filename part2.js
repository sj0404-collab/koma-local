'use strict';
/* ───────────────────────── 0. Мелкие утилиты ───────────────────────── */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), ms);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Macrotask-пауза: await внутри async-цепочек даёт только микрозадачи, браузер
// не рисует и не обрабатывает ввод — на телефоне бейдж «Распознаём…» замирает
// и страница выглядит зависшей. setTimeout отдаёт главный поток браузеру.
const yieldUI = () => new Promise(r => setTimeout(r, 0));

const VERSION = 'v1.9.78';

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
  books: [],
  // Состояние полки (1.0.29): фильтр, поиск, сортировка, вид.
  filter: 'all',        // all | reading | new | done
  query: '',            // поиск по названию
  sort: 'recent',       // recent | old | title | left
  view: 'grid',         // grid | list
  selectedId: '',
  async load() {
    this.books = (await DB.all('books') || []).sort((a, b) => (b.at || 0) - (a.at || 0));
    renderLibrary();
  },
  /**
   * Добавить страницы в СУЩЕСТВУЮЩУЮ главу.
   *
   * Зачем: в браузере на Android нельзя выбрать папку (SAF вебу недоступен), а
   * файловый выбор за один раз редко даёт все 20 страниц. Так можно добавлять
   * по частям — в ту же книгу, с продолжением нумерации.
   */
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
  async addBook(title, files, kind) {
    const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const pages = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = f.name.split('/').pop();
      const blob = f.blob || new Blob([f.data], { type: mimeOf(name) });
      const key = id + '/' + i;
      await DB.put('pages', { key, id, index: i, name, blob });
      pages.push({ key, name });
    }
    const cover = pages.length ? (await DB.get('pages', pages[0].key))?.blob : null;
    const book = { id, title, kind, count: pages.length, at: Date.now(), progress: 0, mode: 'vertical', cover };
    await DB.put('books', book);
    return book;
  },
  async pages(bookId) {
    const rows = (await DB.all('pages') || []).filter(p => p.id === bookId);
    rows.sort((a, b) => a.index - b.index);
    return rows;
  },
  async remove(bookId) {
    const rows = (await DB.all('pages') || []).filter(p => p.id === bookId);
    for (const p of rows) await DB.del('pages', p.key);
    await DB.del('books', bookId);
  },
};
function mimeOf(name) {
  const e = name.split('.').pop().toLowerCase();
  return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : 'image/jpeg';
}

/**
 * Полка библиотеки (1.9.69, по образцу Yomukai).
 *
 * Что изменилось по существу, а не только по виду:
 *  · фильтр «Все / Читаю / Не начато» — раньше с десятком глав нельзя было
 *    понять, что уже открывали;
 *  · полоска прогресса на обложке — видно, где остановился;
 *  · подпись под обложкой, а не поверх: заголовок больше не закрывает рисунок;
 *  · кнопка удаления не висит поверх каждой обложки (случайные нажатия),
 *    а появляется после первой попытки и подтверждается вторым нажатием.
 */
Library.filter = 'all';
/* ───────────────────────── Полка библиотеки (1.0.29) ────────────────────────
   Переписана как отдельный слой, чтобы дальше добавлять по одной вещи, не
   трогая читалку. Здесь: поиск по названию, четыре фильтра со счётчиками,
   сортировка, два вида (обложки и список), карточка «продолжить чтение»
   и меню книги (открыть · переименовать · читать с начала · удалить).
   Состояние живёт в Library, поэтому переживает перерисовку.                 */

/** Ссылки на обложки: создаём один раз на книгу и освобождаем при удалении. */
const LIB_COVERS = new Map();
function libCoverUrl(book) {
  if (!book || !book.cover) return '';
  if (LIB_COVERS.has(book.id)) return LIB_COVERS.get(book.id);
  let url = '';
  try { url = URL.createObjectURL(book.cover); } catch (e) { url = ''; }
  LIB_COVERS.set(book.id, url);
  return url;
}
function libCoverDrop(bookId) {
  const url = LIB_COVERS.get(bookId);
  if (url) { try { URL.revokeObjectURL(url); } catch (e) {} LIB_COVERS.delete(bookId); }
}

/** В каком состоянии глава: не начата · читаю · закончена. */
function libState(book) {
  const count = Number(book.count) || 0;
  const prog = clamp(Number(book.progress) || 0, 0, Math.max(0, count - 1));
  if (count > 0 && prog >= count - 1) return 'done';
  return prog > 0 ? 'reading' : 'new';
}
function libKindName(book) {
  if (book.mode === 'vertical') return 'лента';
  if (book.mode === 'rtl') return 'манга · справа налево';
  return 'страницы · слева направо';
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
function libPlace(book) {
  const count = Number(book.count) || 0;
  const prog = clamp(Number(book.progress) || 0, 0, Math.max(0, count - 1));
  if (libState(book) === 'done') return 'дочитано';
  return prog > 0 ? `стр. ${prog + 1} из ${count}` : `${count} стр. · не начато`;
}
function libPercent(book) {
  const count = Number(book.count) || 0;
  const prog = clamp(Number(book.progress) || 0, 0, Math.max(0, count - 1));
  if (!count) return 0;
  if (count === 1) return prog ? 100 : 0;
  return Math.round(prog / (count - 1) * 100);
}

/** Список под текущий фильтр, поиск и сортировку. */
function libFiltered() {
  const f = Library.filter || 'all';
  const q = String(Library.query || '').trim().toLowerCase();
  let list = Library.books.slice();
  if (f !== 'all') list = list.filter(b => libState(b) === f);
  if (q) {
    list = list.filter(b => String(b.title || '').toLowerCase().includes(q));
  }
  const sort = Library.sort || 'recent';
  const cmp = {
    recent: (a, b) => (Number(b.at) || 0) - (Number(a.at) || 0),
    old: (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ru'),
    left: (a, b) => {
      const ra = (Number(a.count) || 0) - (Number(a.progress) || 0);
      const rb = (Number(b.count) || 0) - (Number(b.progress) || 0);
      return rb - ra;
    },
  }[sort] || ((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return list.sort(cmp);
}

/** Книга, которую логично предложить продолжить: последняя открытая, не дочитанная. */
function libContinueBook() {
  const list = Library.books
    .filter(b => libState(b) === 'reading')
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return list[0] || null;
}

function renderLibraryHero() {
  const box = $('#libHero');
  if (!box) return;
  const b = libContinueBook();
  if (!b) { box.classList.remove('on'); box.innerHTML = ''; return; }
  const url = libCoverUrl(b);
  box.classList.add('on', 'fade');
  box.innerHTML = (url ? `<img src="${url}" alt="">` : '<div class="nofoto">НЕТ ОБЛОЖКИ</div>')
    + `<div class="txt">
         <div class="kicker">Продолжить чтение</div>
         <div class="name">${escapeHtml(b.title)}</div>
         <div class="meta">${libPlace(b)} · ${libKindName(b)}</div>
       </div>
       <button class="go" title="Продолжить">▶</button>`;
  const open = () => { libCoverSelect(b); openBook(b); };
  box.querySelector('.go').onclick = open;
  box.querySelector('.txt').onclick = open;
}

function libCoverSelect(book) { Library.selectedId = book.id; }

function renderLibrary() {
  const all = Library.books;
  const list = libFiltered();
  const sub = $('#libSub');
  const totalPages = all.reduce((s, b) => s + (Number(b.count) || 0), 0);

  if (sub) {
    sub.textContent = all.length
      ? `${all.length} ${all.length === 1 ? 'глава' : (all.length < 5 ? 'главы' : 'глав')} · ${totalPages} стр. · без сети`
      : 'локальные файлы · ничего не уходит в сеть';
  }

  // счётчики фильтров
  const counts = { all: all.length, reading: 0, new: 0, done: 0 };
  for (const b of all) counts[libState(b)]++;
  $$('#libChips .chip').forEach(c => {
    const f = c.dataset.filter || 'all';
    const num = c.querySelector('.num');
    if (num) num.textContent = String(counts[f] ?? 0);
    c.classList.toggle('on', f === (Library.filter || 'all'));
  });

  // сортировка и вид
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
  if (empty) empty.style.display = all.length ? 'none' : 'block';

  if (grid) grid.innerHTML = '';
  if (rows) rows.innerHTML = '';

  if (all.length && !list.length) {
    const msg = (Library.query ? 'По запросу «' + escapeHtml(Library.query) + '» ничего нет.' : 'Под этот фильтр глав нет.')
      + '<br>Сбросьте фильтр или поиск.';
    if (Library.view === 'list' && rows) rows.innerHTML = `<div class="empty" style="padding:26px 10px">${msg}</div>`;
    else if (grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:26px 10px">${msg}</div>`;
    return;
  }

  for (const b of list) {
    if (Library.view === 'list') rows.appendChild(libRow(b));
    else grid.appendChild(libCard(b));
  }
}

/** Карточка-обложка. */
function libCard(b) {
  const el = document.createElement('div');
  el.className = 'card fade' + (libState(b) === 'done' ? ' done' : '');
  el.dataset.id = b.id;
  const url = libCoverUrl(b);
  const pct = libPercent(b);
  const st = libState(b);
  el.innerHTML = `
    <div class="shot">
      ${url ? `<img src="${url}" alt="" loading="lazy">` : '<div class="nofoto">НЕТ ОБЛОЖКИ</div>'}
      <div class="flag">${st === 'done' ? 'дочитано' : b.mode === 'vertical' ? 'лента' : 'страницы'}</div>
      <button class="more" title="Меню книги">⋯</button>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="cap">${escapeHtml(b.title)}</div>
    <div class="cap2"><span>${libPlace(b)}</span>${b.at ? `<span>·</span><span>${libAgo(b.at)}</span>` : ''}</div>`;
  el.onclick = (e) => {
    if (e.target.closest('.more')) { openLibMenu(b); return; }
    openBook(b);
  };
  let timer = null;
  el.addEventListener('touchstart', () => {
    timer = setTimeout(() => { timer = null; openLibMenu(b); }, 480);
  }, { passive: true });
  el.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('touchmove', () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
  return el;
}

/** Строка списка. */
function libRow(b) {
  const el = document.createElement('div');
  el.className = 'row-card fade';
  el.dataset.id = b.id;
  const url = libCoverUrl(b);
  const pct = libPercent(b);
  el.innerHTML = `
    ${url ? `<img src="${url}" alt="" loading="lazy">` : '<div class="nofoto">НЕТ</div>'}
    <div class="txt">
      <div class="name">${escapeHtml(b.title)}</div>
      <div class="meta">${libPlace(b)} · ${libKindName(b)}${b.at ? ' · ' + libAgo(b.at) : ''}</div>
      <div class="mini"><i style="width:${pct}%"></i></div>
    </div>
    <button class="more" title="Меню книги">⋯</button>`;
  el.onclick = (e) => {
    if (e.target.closest('.more')) { openLibMenu(b); return; }
    openBook(b);
  };
  return el;
}

/* ── меню книги ── */
let LIB_MENU_BOOK = null;
let libDeleteArmed = false;
function openLibMenu(book) {
  LIB_MENU_BOOK = book;
  libDeleteArmed = false;
  const t = $('#libMenuTitle');
  if (t) t.textContent = book.title || 'Книга';
  const del = $('#libMenuDelete');
  if (del) { del.textContent = 'Удалить главу'; del.classList.add('warn'); }
  const st = libState(book);
  const open = $('#libMenuOpen');
  if (open) open.textContent = st === 'reading' ? 'Продолжить' : st === 'done' ? 'Открыть' : 'Начать читать';
  openSheet('libMenu');
}
function bindLibMenu() {
  const close = () => { closeSheets('libMenu'); };
  if ($('#libMenuClose')) $('#libMenuClose').onclick = close;
  if ($('#libMenuOpen')) $('#libMenuOpen').onclick = async () => {
    const b = LIB_MENU_BOOK; close(); if (b) await openBook(b);
  };
  if ($('#libMenuStart')) $('#libMenuStart').onclick = async () => {
    const b = LIB_MENU_BOOK; close();
    if (!b) return;
    b.progress = 0;
    await DB.put('books', b);
    await Library.load();
    await openBook(b);
  };
  if ($('#libMenuRename')) $('#libMenuRename').onclick = () => {
    const b = LIB_MENU_BOOK; close();
    if (!b) return;
    openLibRename(b);
  };
  if ($('#libMenuDelete')) $('#libMenuDelete').onclick = async (e) => {
    const b = LIB_MENU_BOOK;
    if (!b) return;
    // confirm() в песочнице и части мобильных браузеров глушится — спрашиваем
    // вторым нажатием на ту же кнопку.
    if (!libDeleteArmed) {
      libDeleteArmed = true;
      e.currentTarget.textContent = 'Точно удалить «' + (b.title || '').slice(0, 18) + '»?';
      return;
    }
    close();
    libCoverDrop(b.id);
    await Library.remove(b.id);
    await Library.load();
    toast('Глава удалена');
  };
}

/* ── переименование ── */
let LIB_RENAME_BOOK = null;
function openLibRename(book) {
  LIB_RENAME_BOOK = book;
  const inp = $('#libRenameInput');
  if (inp) inp.value = book.title || '';
  openSheet('libRename');
  setTimeout(() => { if (inp) { inp.focus(); inp.select(); } }, 120);
}
function bindLibRename() {
  const save = async () => {
    const b = LIB_RENAME_BOOK;
    const inp = $('#libRenameInput');
    const name = String((inp && inp.value) || '').trim();
    closeSheets('libRename');
    if (!b || !name || name === b.title) return;
    b.title = name;
    b.at = b.at || Date.now();
    await DB.put('books', b);
    await Library.load();
    toast('Название сохранено');
  };
  if ($('#libRenameSave')) $('#libRenameSave').onclick = save;
  if ($('#libRenameCancel')) $('#libRenameCancel').onclick = () => closeSheets('libRename');
  if ($('#libRenameInput')) $('#libRenameInput').onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

/* ── поиск, сортировка, вид ── */
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
  bindLibMenu();
  bindLibRename();
}
/**
 * Открыть книгу. Раньше карточка звала openBook(), а такой функции не было
 * вовсе: тап по книге молча ничего не делал. Ошибки теперь видно, а не в консоли.
 */
async function openBook(book) {
  try {
    await Reader.open(book);
  } catch (e) {
    console.error('openBook', e);
    toast('Не удалось открыть «' + book.title + '»: ' + (e && e.message ? e.message : e), 5000);
  }
}
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
