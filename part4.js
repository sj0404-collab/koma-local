
/* ───────────────────────── 8. Читалка ───────────────────────── */
/**
 * Настройки чтения ПО УМОЛЧАНИЮ (1.0.21).
 *
 * Требование 4.11: «я сам буду выбирать, если по умолчанию не то, и он будет
 * запоминать именно то, что выбрано для текущей книги, а для других — возврат
 * по умолчанию». Отсюда два уровня, и оба видны в ⚙:
 *   · профиль книги — лежит в самой записи книги (mode, dir, voice, profUser);
 *   · умолчание      — здесь, применяется к любой книге без профиля.
 */
const ReadDefaults = {
  KEY: 'readdefaults',
  v: { mode: 'vertical', dir: 'rtl', voice: false, startPage: 'first', engine: 'auto' },
  async load() {
    const row = await DB.get('kv', this.KEY);
    if (row && row.v) this.v = Object.assign({}, this.v, row.v);
    return this.v;
  },
  async save() { await DB.put('kv', { k: this.KEY, v: this.v }); },
};

const Reader = {
  book: null, pages: [], urls: [], canvases: [], imgEls: [],
  mode: 'vertical', dir: 'rtl', page: 0, frames: true, follow: true,
  regions: new Map(),          // page → {regions, boxes, ms}
  bandCache: new Map(),        // page → Map(ключ полосы → распознанное)
                               // (поле bands занято массивом полос из bandsOf)
  spoken: new Set(),        // «стр|текст» — что уже прочитано вслух
  spokenDirty: false,
  current: null,
  scrollBusy: false,

  async open(book) {
    this.book = book;
    this.pages = await Library.pages(book.id);
    if (!this.pages.length) return toast('В книге нет страниц');
    // Профиль книги главнее умолчания, но только если человек его задал.
    // Никакого подбора «по пропорции страницы» больше нет: 4.11 — «выбирать
    // каждый вручную». Автоподбор молча переключал книгу в страницы, и человек
    // не понимал, почему лента перестала листаться сама.
    const D = (typeof ReadDefaults !== 'undefined') ? ReadDefaults.v : { mode: 'vertical', dir: 'rtl', voice: false };
    this.modeUser = !!book.profUser;
    this.mode = this.modeUser && book.mode ? book.mode : (D.mode || 'vertical');
    this.dir = this.modeUser && book.dir ? book.dir : (D.dir || 'rtl');
    this.voiceOn = this.modeUser && typeof book.voice === 'boolean' ? book.voice : !!D.voice;
    // Чтец распознавания: свой у книги, иначе общий. Пять пунктов в ⚙.
    // Чтеца мог выбрать человек (engineUser) или замер на странице (engineAuto).
    this.engine = ((this.modeUser || book.engineUser || book.engineAuto) && book.engine)
      ? book.engine : (D.engine || 'auto');
    this.page = clamp(book.progress || 0, 0, this.pages.length - 1);
    this.regions.clear();
    // Что уже прочитано — из базы: после остановки и даже перезапуска чтение
    // продолжается с первого непрочитанного места, а не с начала страницы.
    const spokenRow = await DB.get('kv', 'spoken:' + book.id);
    this.spoken = new Set((spokenRow && spokenRow.v) || []);
    // Уже распознанные страницы берём из буфера: повторное открытие книги и
    // повторное чтение не должны снова стоить 10 секунд на страницу.
    let cleaned = 0;
    try {
      const buf = await Buffer.all();
      for (const row of buf) {
        if (row && Array.isArray(row.lines) && row.lines.length) {
          // Текст в буфере распознан прежней версией — прогоняем его через
          // нынешние правила чистки, иначе старый мусор («Тг. чв») живёт вечно.
          const lines = await cleanLines(row.lines);
          this.regions.set(row.page, { lines, regions: null, cached: true, ms: 0, detMs: 0, recMs: 0, crops: lines.length, boxes: 0 });
          if (lines.length !== row.lines.length) {
            await Buffer.put(row.page, lines);
            cleaned++;
          }
        }
      }
      if (buf.length) toast('Из буфера: ' + buf.length + ' стр. уже распознаны', 3000, true);
    } catch (e) { console.warn('буфер не прочитался', e); }
    $('#rTitle').textContent = book.title;
    $('#pageTotal').textContent = String(this.pages.length);
    show('reader');
    this.syncSub();
    await this.buildStrip();
    this.scrollToPage(this.page, false);
    // Распознавание стартует СРАЗУ при открытии главы (просьба 06.11, 10:33:
    // «сделай распознавание сразу при открытии, чтобы он успел распознать»).
    // Раньше здесь показывалась заглушка и ждали нажатия — первые секунды
    // пропадали, а потом человек видел «Распознаём…» уже после листания.
    if (!this.regions.get(this.page)) {
      this.hideStart();
      if (RULES.autoScan && OCR.ready) {
        setTimeout(async () => {
          try { await this.ensureLoaded(this.page); } catch (e) { /* ниже проверит scan */ }
          // Ждём два кадра: за это время лента получает настоящую высоту и
          // позицию. Без этого «полоса» считалась по неразложенной странице.
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          if (!this.regions.get(this.page)) this.scanCurrent(false, null, 'открытие страницы');
        }, 0);
      }
    } else this.hideStart();
  },

  syncSub() {
    const modeText = (this.mode === 'vertical' ? 'Вертикально' : this.mode === 'rtl' ? 'Страницы' : 'Страницы')
      + ' · ' + (this.dir === 'rtl' ? '← справа налево' : 'слева направо →');
    // Версию печатаем в подзаголовке: раньше по скриншоту нельзя было понять,
    // какая сборка у человека, и мы спорили о починках, которых в его АПК не было.
    $('#rSub').textContent = `KOMA · веб ${VERSION} · ${this.page + 1} из ${this.pages.length} · ${modeText}`;
    $('#pageNum').textContent = String(this.page + 1);
  },

  async buildStrip() {
    const strip = $('#strip');
    if (this.ratios && Object.keys(this.ratios).length) {
      const vals = Object.values(this.ratios);
      this.bookRatio = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    strip.innerHTML = '';
    this.urls.forEach(u => URL.revokeObjectURL(u));
    this.urls = []; this.imgEls = []; this.canvases = [];
    strip.style.display = this.mode === 'vertical' ? 'block' : 'none';
    $('#paged').classList.toggle('on', this.mode !== 'vertical');
    if (this.mode === 'vertical') {
      for (let i = 0; i < this.pages.length; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'pagewrap'; wrap.dataset.page = i;
        // Место под страницу резервируется сразу: пропорция известна из буфера
        // (если страницу уже открывали) или берётся средняя по книге.
        wrap.style.aspectRatio = String((this.ratios && this.ratios[i]) || this.bookRatio || 0.7);
        const img = document.createElement('img');
        img.alt = 'Страница ' + (i + 1);
        img.decoding = 'async';
        img.onload = () => { this.onPageSized(i); };
        wrap.appendChild(img);
        const frames = document.createElement('div');
        frames.className = 'frames'; frames.dataset.frames = i;
        wrap.appendChild(frames);
        strip.appendChild(wrap);
        this.imgEls[i] = img;
        this.paintPage(i);
      }
    } else {
      const paged = $('#paged');
      paged.innerHTML = '';
      for (let i = 0; i < this.pages.length; i++) {
        const box = document.createElement('div');
        box.className = 'pagebox'; box.dataset.page = i;
        // Класс .on делал только turnPage(), то есть после переключения режима
        // на «Страницы» не была видна НИ ОДНА страница — чёрный экран с
        // панелью «5 / 8» (живой прогон 04.11, жалоба 127). Текущую страницу
        // показываем сразу.
        box.classList.toggle('on', i === this.page);
        box.innerHTML = '<div class="inner"><img alt="Страница ' + (i + 1) + '">'
          + '<div class="frames" data-frames="' + i + '"></div></div>';
        paged.appendChild(box);
        this.imgEls[i] = box.querySelector('img');
        this.imgEls[i].onload = () => this.onPageSized(i);
      }
      this.ensureLoaded(this.page);
    }
    // грузим страницы лениво: сначала текущую и соседние
    for (const i of this.loadOrder()) this.ensureLoaded(i);
  },

  loadOrder() {
    const out = [];
    for (let d = 0; d <= this.pages.length; d++) {
      for (const i of [this.page - d, this.page + d]) {
        if (i >= 0 && i < this.pages.length && !out.includes(i)) out.push(i);
      }
      if (out.length > 6) break;
    }
    return out;
  },

  async ensureLoaded(i) {
    const img = this.imgEls[i];
    if (!img || img.dataset.src) return;
    img.dataset.src = '1';
    const row = this.pages[i];
    const pageRec = await DB.get('pages', row.key);
    const blob = pageRec ? pageRec.blob : null;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    this.urls[i] = url;
    img.src = url;
  },

  async onPageSized(i) {
    const img = this.imgEls[i];
    if (!img || !img.naturalWidth) return;
    // Запоминаем пропорции: без этого незагруженные страницы схлопывались в 0
    // по высоте, лента прыгала, и «текущая страница» определялась неверно.
    const ratio = img.naturalWidth / img.naturalHeight;
    this.ratios = this.ratios || {};
    if (!this.ratios[i]) {
      this.ratios[i] = ratio;
      const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
      if (wrap) wrap.style.aspectRatio = String(ratio);
    }
    if (!this.canvases[i]) {
      // рабочий холст для OCR — один раз на страницу
      this.canvases[i] = canvasFromImage(img);
    }
    // Автоподбор режима по пропорции страницы УБРАН (1.0.21, требование 4.11:
    // «выбирать каждый вручную»). Режим берётся из профиля книги, иначе из ⚙.
    this.paintPage(i);
    if (i === this.page) this.afterPageReady();
  },

  /**
   * Перераспознать ОДНУ реплику целиком и прочитать её.
   *
   * Зачем: автопроход полосы иногда берёт только часть облачка — «ПОНЯТНО.»
   * превращается в «НОНО», из двух строк остаётся одна, а вторая половина
   * приходит другим текстом (журнал 06.11, 19:05:26 «НОНО ЕЩЕ РАЗ БОЛЬШОЕ
   * СПАСИБО.», скрины 19:05:50 и 19:06:48 с полурамками). Человек в этот
   * момент видит текст глазами и знает, что там написано — ему нужен способ
   * сказать «прочитай вот это облачко заново, целиком».
   *
   * Делаем так: берём рамку реплики с запасом (строка выше/ниже того же
   * пузыря), вырезаем её из холста страницы, увеличиваем и распознаём ОТДЕЛЬНО
   * от полосы — без соседей и без краёв экрана, которые режут буквы. Найденные
   * строки, стоящие на том же месте по ширине, склеиваем сверху вниз, рамку
   * реплики расширяем до них и заменяем текст. Затем читаем вслух.
   */
  /**
   * Распознать ОДНУ реплику по её рамке, отдельно от полосы.
   *
   * Возвращает { text, raw, bbox } или null. Рамка берётся с запасом (строка
   * выше/ниже того же пузыря), кроп увеличивается в 1–4 раза — мелкий текст,
   * который полоса теряла, читается. Строки, стоящие на том же месте по
   * ширине, склеиваются сверху вниз.
   */
  async ocrLineCrop(page, line) {
    const c = this.canvases[page];
    if (!c || !c.width || !c.height || !line) return null;
    if (typeof OCR === 'undefined' || !OCR.ready) return null;
    const h = Math.max(0.004, line.bottom - line.top);
    const w = Math.max(0.004, line.right - line.left);
    const y0 = clamp(line.top - h * 1.7, 0, 1);
    const y1 = clamp(line.bottom + h * 1.7, 0, 1);
    const x0 = clamp(line.left - w * 0.06, 0, 1);
    const x1 = clamp(line.right + w * 0.06, 0, 1);
    const sx = Math.round(x0 * c.width), sy = Math.round(y0 * c.height);
    const sw = Math.max(12, Math.round((x1 - x0) * c.width));
    const sh = Math.max(12, Math.round((y1 - y0) * c.height));
    if (sx < 0 || sy < 0 || sx + sw > c.width + 1 || sy + sh > c.height + 1) return null;
    const variantsOf = (k) => {
      const crop = makeCanvas(sw * k, sh * k);
      const cx = crop.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(c, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
      const out = [crop];
      try { out.push(contrastCanvas(crop)); } catch (e) { /* нет — и ладно */ }
      try { out.push(binarizeCanvas(crop, 0, RULES)); } catch (e) { /* нет — и ладно */ }
      return out;
    };
    const runPass = async (k) => {
      let bestOfPass = null;
      for (const work of variantsOf(k)) {
        let res = null;
        try { res = await recognizePage(work, RULES, () => {}, null, null); } catch (e) { res = null; }
        const rows = (res && res.regions ? res.regions : [])
          .filter(r => r && r.text && r.bottom > r.top)
          .map(r => ({
            text: r.text,
            left: x0 + r.left * (x1 - x0), right: x0 + r.right * (x1 - x0),
            top: y0 + r.top * (y1 - y0), bottom: y0 + r.bottom * (y1 - y0),
          }))
          .filter(r => {
            const cr = (r.left + r.right) / 2;
            return cr >= line.left - w * 0.25 && cr <= line.right + w * 0.25;
          })
          .sort((a, b) => (a.top - b.top) || (a.left - b.left));
        if (!rows.length) continue;
        const raw = rows.map(r => r.text).join(' ');
        let text = raw;
        try { text = cleanSpeech(raw); } catch (e) { /* без чистки */ }
        // Перенос по слогам внутри облачка: «БОЛЬ- ШОЕ» — это «БОЛЬШОЕ».
        text = String(text || '').replace(/(\p{Lu})[-–—:]\s+(\p{Lu})/gu, '$1$2');
        text = dehyphenText(text);
        if (!text || text.replace(/[^\p{L}]/gu, '').length < 2) continue;
        const score = textScore(text);
        if (!bestOfPass || score > bestOfPass.score) {
          bestOfPass = {
            text, raw, score,
            bbox: {
              left: Math.min(line.left, ...rows.map(r => r.left)),
              right: Math.max(line.right, ...rows.map(r => r.right)),
              top: Math.min(line.top, ...rows.map(r => r.top)),
              bottom: Math.max(line.bottom, ...rows.map(r => r.bottom)),
            },
          };
        }
      }
      return bestOfPass;
    };
    // Увеличение — не «чем больше, тем лучше». Стенд 06.11 на облачке
    // «ТЫ ВИДИШЬ МЕНЯ?»: при 1x чтец отдаёт верное «ТЫ», при 2x и выше —
    // «Тb» (латинская b вместо Ы), и это уходило в озвучку. Поэтому сначала
    // читаем в НАТИВНОМ масштабе, потом в расчётном, и только при слабом
    // результате поднимаем увеличение. При равном счёте остаётся меньшее:
    // лишние пиксели ничего не добавили.
    const k0 = clamp(Math.round(1500 / Math.max(sw, sh)), 1, 4);
    // Перебираем увеличения от нативного к большему и останавливаемся, как
    // только чтение стало уверенным. Диагностика 06.11 на мелком кропе
    // (200x50) показала: k=1 и k=4 дают латиницу вместо кириллицы
    // («HacлeqHuкa»), а бинаризация при k=2–3 — верные буквы. Поэтому в
    // наборе все ступени, а не «нативный + расчётный», как было.
    const ks = Array.from(new Set([1, 2, 3, k0])).filter(k => k >= 1 && k <= 4).sort((a, b) => a - b);
    let best = null;
    for (const k of ks) {
      const pass = await runPass(k);
      if (pass && (!best || pass.score > best.score + 0.01)) best = pass;
      if (best && best.score >= 14) break;       // текст уверенный — не жжём время
    }
    // Слабый результат (одно-два словарных слова) — пробуем крупнее: мелкий
    // каллиграфический шрифт читается только при увеличении 3–4x. Так «Исп» и
    // «Испокойнолии» получают второй шанс без участия человека.
    if ((!best || best.score < 2.0) && k0 < 4) {
      const bigger = await runPass(Math.min(4, k0 + 1));
      if (bigger && (!best || bigger.score > best.score)) best = bigger;
    }
    return best;
  },

  /**
   * Перераспознать ОДНУ реплику целиком и прочитать её.
   *
   * ЖЕСТА ДВОЙНОГО ТАПА БОЛЬШЕ НЕТ (просьба 06.11, 20:43: он открывал системное
   * меню картинки и не засчитывался). Функция осталась как внутренний
   * помощник: её механизм (кроп + несколько подготовок + выбор лучшего чтения)
   * использует кнопка «⬚ Распознать вручную», см. scanArea.
   *
   * Зачем: автопроход полосы иногда берёт только часть облачка — «ПОНЯТНО.»
   * превращается в «НОНО», из двух строк остаётся одна, вторая приходит другим
   * текстом (журнал 06.11, 19:05:26 «НОНО ЕЩЕ РАЗ БОЛЬШОЕ СПАСИБО.»). Человек
   * видит текст глазами, ему нужен способ сказать «прочитай вот это облачко
   * заново, целиком» — по просьбе 06.11, 19:06: «добавь, чтобы я мог два раза
   * нажать на строку и он распознал именно её всю».
   *
   * Если новое чтение НЕ лучше прежнего (меньше словарных слов) — текст не
   * трогаем: смысл жеста в том, чтобы стало точнее, а не «иначе».
   */
  /**
   * ── РУЧНОЕ РАСПОЗНАВАНИЕ ОБЛАСТИ ────────────────────────────────────────
   * Просьба с телефона 06.11, 20:43: «двойной клик не засчитывается, он мне
   * открывает и скрывает меню, так что убери его… добавь кнопку распознать
   * вручную: нажал на кнопку, выделил область и повторно нажал на кнопку».
   *
   * Как работает: первое нажатие включает режим выделения (поверх страницы
   * ложится прозрачный слой), палец чертит рамку; рамка остаётся на экране;
   * второе нажатие кнопки — область вырезается из страницы, увеличивается и
   * распознаётся ОТДЕЛЬНО, результат встаёт на место прежних реплик в этой
   * области и сразу читается вслух.
   */
  pickToggle() {
    if (this._pick && this._pick.rect) { this.pickApply(); return; }
    if (this._pick) { this.pickCancel(); toast('Выделение отменено', 2000, true); return; }
    this.pickBegin();
  },

  pickHint(text, sticky) {
    try {
      let el = document.getElementById('pickHint');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pickHint'; el.className = 'pickHint';
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.display = 'block';
      clearTimeout(this._pickHintT);
      if (!sticky) this._pickHintT = setTimeout(() => { el.style.display = 'none'; }, 3500);
    } catch (e) { /* подсказка не критична */ }
  },

  pickBegin() {
    const page = (typeof this.pageAtViewport === 'function' ? this.pageAtViewport() : this.page) | 0;
    const layer = document.createElement('div');
    layer.className = 'pickLayer';
    const box = document.createElement('div');
    box.className = 'pickRect';
    layer.appendChild(box);
    document.body.appendChild(layer);
    const st = { page, layer, box, rect: null, drawing: false, x0: 0, y0: 0 };
    this._pick = st;
    this.setPickButton(true);
    try { document.body.classList.add('picking'); } catch (e) { /* не критично */ }
    this.pickHint('Проведите рамку вокруг облачка, затем нажмите кнопку ещё раз', true);
    layer.addEventListener('pointerdown', (e) => {
      st.drawing = true; st.x0 = e.clientX; st.y0 = e.clientY;
      box.style.display = 'block';
      box.style.left = st.x0 + 'px'; box.style.top = st.y0 + 'px';
      box.style.width = '0px'; box.style.height = '0px';
      try { layer.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      e.preventDefault();
    });
    layer.addEventListener('pointermove', (e) => {
      if (!st.drawing) return;
      const x = Math.min(e.clientX, st.x0), y = Math.min(e.clientY, st.y0);
      box.style.left = x + 'px'; box.style.top = y + 'px';
      box.style.width = Math.abs(e.clientX - st.x0) + 'px';
      box.style.height = Math.abs(e.clientY - st.y0) + 'px';
      e.preventDefault();
    });
    layer.addEventListener('pointerup', (e) => {
      if (!st.drawing) return;
      st.drawing = false;
      const r = {
        left: Math.min(e.clientX, st.x0), top: Math.min(e.clientY, st.y0),
        right: Math.max(e.clientX, st.x0), bottom: Math.max(e.clientY, st.y0),
      };
      if (r.right - r.left < 24 || r.bottom - r.top < 16) {
        st.rect = null; box.style.display = 'none';
        this.pickHint('Слишком маленькая рамка — проведите ещё раз', true);
        return;
      }
      st.rect = r;
      this.pickHint('Область выделена — нажмите кнопку «⬚» ещё раз', true);
      e.preventDefault();
    });
  },

  pickCancel() {
    const st = this._pick;
    this._pick = null;
    this.setPickButton(false);
    try { document.body.classList.remove('picking'); } catch (e) { /* не критично */ }
    try { if (st && st.layer && st.layer.parentNode) st.layer.parentNode.removeChild(st.layer); } catch (e) { /* уже нет */ }
    const hint = document.getElementById('pickHint');
    if (hint) hint.style.display = 'none';
  },

  setPickButton(on) {
    for (const id of ['btnPickArea', 'btnPickArea2']) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.classList.toggle('on', !!on);
      if (id === 'btnPickArea') b.textContent = on ? '✓' : '⬚';
      else b.textContent = on ? '✓ Распознать выделенное' : '⬚ Распознать вручную — выделить область';
    }
  },

  /** Перевести экранную рамку в доли страницы и распознать область. */
  async pickApply() {
    const st = this._pick;
    if (!st || !st.rect) return;
    const page = st.page;
    const img = (this.imgEls && this.imgEls[page]) || document.querySelector('.pagewrap[data-page="' + page + '"] img');
    const rect = st.rect;
    this.pickCancel();
    if (!img) { toast('Страница не найдена на экране', 3000); return; }
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) { toast('Страница ещё не отрисована', 3000); return; }
    const frac = {
      left: clamp((rect.left - r.left) / r.width, 0, 1),
      right: clamp((rect.right - r.left) / r.width, 0, 1),
      top: clamp((rect.top - r.top) / r.height, 0, 1),
      bottom: clamp((rect.bottom - r.top) / r.height, 0, 1),
    };
    if (frac.right - frac.left < 0.02 || frac.bottom - frac.top < 0.01) {
      toast('Область слишком мала — выделите крупнее', 3000);
      return;
    }
    await this.scanArea(page, frac);
  },

  /**
   * Распознать выделенный прямоугольник страницы и поставить его на место
   * прежних реплик, которые в него попали.
   */
  async scanArea(page, frac) {
    if (typeof OCR === 'undefined' || !OCR.ready) { toast('Сначала добавьте модели OCR (⚙ → Модели)'); return; }
    const c = this.canvases[page];
    if (!c || !c.width) { toast('Страница ещё не готова', 3000); return; }
    soft('Распознаю выделенную область…', 6000);
    // ── Как читаем выделение ─────────────────────────────────────────────
    // Сначала — как ПОЛОСУ ВСЕЙ СТРАНИЦЫ: движку уходит кадр шириной во всю
    // страницу в нативном масштабе, а видимость ограничена вертикальными
    // границами выделения. Это ровно тот путь, которым страница читается
    // обычно, поэтому текст получается обычного качества.
    //
    // Так делать пришлось после телефона 06.11, 21:34: первый вариант резал
    // выделение отдельным кропом и увеличивал его в 4 раза — и детектор на
    // увеличенном огрызке разваливал строки на обрывки: «разомпа Так пм
    // чИЛно» вместо «таким образом Пантею…», «ИНолишилвейнам (Но» вместо
    // «И спокойно лишил Фейна титула наследника?».
    const H = c.height, W = c.width;
    const bandPx = {
      y0: Math.max(0, Math.round(frac.top * H)),
      y1: Math.min(H, Math.round(frac.bottom * H)),
    };
    const boxPx = {
      left: frac.left * W, right: frac.right * W,
      top: bandPx.y0, bottom: bandPx.y1,
    };
    const inside = (l) => {
      const ix = Math.min(l.right * W, boxPx.right) - Math.max(l.left * W, boxPx.left);
      const iy = Math.min(l.bottom * H, boxPx.bottom) - Math.max(l.top * H, boxPx.top);
      if (ix <= 0 || iy <= 0) return false;
      const own = Math.max(1e-6, (l.right - l.left) * W) * Math.max(1e-6, (l.bottom - l.top) * H);
      // Берём строки, которые в основном ВНУТРИ выделения. Строка облачка
      // обычно шире пальца и торчит за рамку — «в основном внутри» это ловит.
      return (ix * iy) / own >= 0.35;
    };
    const readBand = async () => {
      // Тёмная страница — отдельная беда: на чёрном фоне с обводкой буквы
      // читаются хуже всего. Поэтому для такой страницы полосу прогоняем ещё
      // и бинаризованной (это же лечение, что помогает кропу). Победителя
      // выбирает оценка текста.
      const sources = [c];
      try {
        const probe = makeCanvas(c.width, Math.max(1, bandPx.y1 - bandPx.y0));
        probe.getContext('2d', { willReadFrequently: true })
          .drawImage(c, 0, bandPx.y0, c.width, probe.height, 0, 0, c.width, probe.height);
        const px = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height).data;
        if (meanLumaOf(px) < 118) sources.push(binarizeCanvas(c, 0, RULES));
      } catch (e) { /* без бинаризации */ }
      let best = null;
      for (const srcCanvas of sources) {
        let res = null;
        try { res = await recognizePage(srcCanvas, RULES, () => {}, bandPx, null); } catch (e) { res = null; }
        const rows = ((res && res.regions) || []).filter(r => r && r.text && r.bottom > r.top && inside(r))
          .sort((a, b) => (a.top - b.top) || (a.left - b.left));
        if (!rows.length) continue;
        const raw0 = rows.map(r => r.text).join(' ');
        let t0 = raw0;
        try { t0 = cleanSpeech(raw0); } catch (e) { /* без чистки */ }
        t0 = dehyphenText(String(t0 || '')).replace(/\s+/g, ' ').trim();
        const sc = textScore(t0);
        if (!best || sc > best.score) {
          best = {
            text: t0, raw: raw0, score: sc,
            bbox: {
              left: Math.max(frac.left * 0.98, Math.min(...rows.map(r => r.left))),
              right: Math.min(frac.right * 1.02, Math.max(...rows.map(r => r.right))),
              top: Math.max(frac.top, Math.min(...rows.map(r => r.top))),
              bottom: Math.min(frac.bottom, Math.max(...rows.map(r => r.bottom))),
            },
          };
        }
      }
      if (!best) return null;
      return best;
    };
    // Запасной путь — вырезанный кроп с перебором подготовок и увеличений.
    const readCrop = async () => {
      try { return await this.ocrLineCrop(page, { left: frac.left, top: frac.top, right: frac.right, bottom: frac.bottom }); }
      catch (e) { return null; }
    };
    let got = await readBand();
    const bandText = got && got.text;
    const bandScore = got && got.score;
    // Кроп читаем ВСЕГДА, а не только при неудаче полосы: на телефоне
    // (06.11, 21:34–21:36) полоса отдавала «уланаслегника?», «Нянежалуюсь»,
    // а бинаризованный кроп на тех же пикселях — «тула наследника?». Из двух
    // чтений берём то, что выше по оценке текста (словарные слова минус
    // слипшиеся).
    const alt = await readCrop();
    let src = 'полоса';
    if (alt && (!got || alt.score > got.score + 0.01)) { got = alt; src = 'кроп'; }
    // В журнал — оба чтения: без этого нельзя понять, почему ручное
    // распознавание дало не то, что ждал человек (телефон 06.11, 21:34).
    try {
      Journal.add('распознавание', 'ручное выделение, кандидаты: полоса «'
        + String((bandText || '').slice(0, 40)) + '» (' + (bandScore == null ? '—' : bandScore.toFixed(1))
        + '), кроп «' + String((alt && alt.text) || '').slice(0, 40) + '» ('
        + (alt && alt.score != null ? alt.score.toFixed(1) : '—') + ') → выбрано: ' + src);
    } catch (e) { /* журнала может не быть */ }
    if (!got || !got.text) { toast('В этой области текст не читается — выделите плотнее', 4000); return; }
    const data = this.regions.get(page) || { lines: [] };
    // Прежние реплики, чей центр внутри выделения.
    const centreIn = (l) => {
      const cx = (l.left + l.right) / 2, cy = (l.top + l.bottom) / 2;
      return cx >= frac.left - 0.01 && cx <= frac.right + 0.01
        && cy >= frac.top - 0.01 && cy <= frac.bottom + 0.01;
    };
    const old = (data.lines || []).filter(centreIn);
    const kept = (data.lines || []).filter(l => !centreIn(l));
    // Кнопка НЕ ИМЕЕТ ПРАВА сделать хуже. Автопроход на этой странице уже
    // прочитал «тула наследника?» (с пробелами), а кроп из выделения даёт
    // «НКА АСАЕ9НИ» — если бы мы просто вставили новое чтение, стало бы хуже
    // (стенд 06.11). Поэтому сравниваем оценки и оставляем лучшее.
    let useText = got.text, useRaw = got.raw || got.text, note = 'новое чтение';
    const oldBest = old.map(l => ({ text: l.text, score: textScore(l.text) }))
      .sort((x, y) => y.score - x.score)[0];
    if (oldBest && oldBest.score >= got.score + 0.01) {
      useText = old.map(l => l.text).join(' ');
      useRaw = useText;
      note = 'оставлено прежнее';
    }
    const area = got.bbox || frac;
    const added = {
      left: area.left, right: area.right, top: area.top, bottom: area.bottom,
      text: useText, rawText: useRaw, manual: true, confidence: 1, fromPick: true,
    };
    const lines = kept.concat([added]).sort((a, b) => (a.top - b.top) || (a.left - b.left));
    this.regions.set(page, { ...data, lines });
    try { await this.savePageBuffer(page); } catch (e) { /* не критично */ }
    this.paintPage(page);
    try {
      Journal.add('распознавание', 'выделено вручную (' + note + '): «' + useText.slice(0, 60) + '»');
    } catch (e) { /* нет журнала */ }
    toast((note === 'оставлено прежнее' ? 'Движок прочитал хуже — оставил: «' : 'Распознано вручную: «')
      + useText.slice(0, 44) + (useText.length > 44 ? '…' : '') + '»', 3500);
    this.page = page;
    if (typeof TTS !== 'undefined' && TTS) { try { TTS.prime(); TTS.speakLine(added); } catch (e) { /* голос не обязателен */ } }
  },

  async rereadLine(page, idx) {
    const data = this.regions.get(page);
    if (!data || !Array.isArray(data.lines) || !data.lines[idx]) return;
    const line = data.lines[idx];
    soft('Перечитываю реплику целиком…', 2000);
    let got = null;
    try { got = await this.ocrLineCrop(page, line); } catch (e) {
      toast('Не удалось перечитать: ' + ((e && e.message) || e), 4000);
      return;
    }
    if (!got) { toast('На этом месте текст не читается — попробуйте ещё раз', 4000); return; }
    const was = String(line.text || '');
    const better = textBetter(got.text, was);
    const lines = data.lines.slice();
    const updated = { ...line, ...got.bbox };
    if (better) { updated.text = got.text; updated.rawText = got.raw; updated.manual = true; delete updated.key; }
    lines[idx] = updated;
    this.regions.set(page, { ...data, lines });
    try { await this.savePageBuffer(page); } catch (e) { /* не критично */ }
    this.paintPage(page);
    try {
      Journal.add('распознавание', 'реплика перечитана вручную: «' + was.slice(0, 40) + '» → «'
        + String(better ? got.text : was).slice(0, 40) + '»' + (better ? '' : ' (новое чтение не лучше — оставил прежнее)'));
    } catch (e) { /* журнала может не быть */ }
    toast(!better
      ? 'Движок прочитал так же — оставил: «' + was.slice(0, 30) + '…»'
      : (got.text === was ? 'Текст тот же: «' + got.text.slice(0, 40) + '…»'
        : 'Было: «' + was.slice(0, 26) + '…» → стало: «' + got.text.slice(0, 26) + '…»'), 4000, true);
    this.page = page;
    TTS.speakLine(updated);
  },

  paintPage(i) {
    // Слой рамок есть в обоих режимах: в ленте — на обёртке страницы, в
    // постраничном — внутри .pagebox.
    const framesEl = this.mode === 'vertical'
      ? document.querySelector(`#strip [data-frames="${i}"]`)
      : document.querySelector(`#paged [data-frames="${i}"]`);
    if (!framesEl) return;
    framesEl.innerHTML = '';
    if (!this.frames) return;
    const data = this.regions.get(i);
    if (!data) return;
    // Рамка рисуется КАЖДОЙ распознанной строке, независимо от того, прочитана
    // она или нет. «Прочитано» — это только цвет (класс done), а не фильтр.
    data.lines.forEach((line, idx) => {
      const d = document.createElement('div');
      d.className = 'frame';
      d.style.left = (line.left * 100) + '%';
      d.style.top = (line.top * 100) + '%';
      d.style.width = ((line.right - line.left) * 100) + '%';
      d.style.height = ((line.bottom - line.top) * 100) + '%';
      // Раньше «текущая» реплика искалась сравнением ТЕКСТА: две одинаковые
      // реплики на странице («ДА!», «…») светились обе, и было непонятно, что
      // именно звучит (жалоба 4.11: «читается и светятся сразу несколько и он
      // путает что озвучивать»). Теперь — по месту реплики на странице.
      const isCur = this.isCurrentLine(i, line);
      const isDone = this.isSpoken(i, line);
      if (line.large) d.classList.add('large');     // титул/каллиграфия — другой цвет
      if (isCur) d.classList.add('cur');
      else if (isDone) d.classList.add('done');
      // Один тап по рамке — прочитать реплику. Двойного тапа больше нет: на
      // телефоне он попадал в системное меню (открывал и закрывал его) и не
      // засчитывался (жалоба 06.11, 20:43). Вместо него — кнопка «Распознать
      // вручную»: нажали, выделили область, нажали ещё раз.
      d.onclick = () => TTS.speakLine(line);
      framesEl.appendChild(d);
    });
  },

  /**
   * Рамки НАЙДЕННОГО — до распознавания (просьба 06.11, 10:58).
   *
   * Пока движок читает строки, на странице уже видно, ЧТО он нашёл. Если рамка
   * есть, а слова в реплике нет — это видно сразу, а не по пропавшему «ПОНЯТНО.».
   * Пунктирные фиолетовые рамки = «найдено, читаю сейчас»; после распознавания
   * их заменяют обычные рамки реплик.
   */
  paintPendingFrames(i, boxes) {
    const framesEl = this.mode === 'vertical'
      ? document.querySelector(`#strip [data-frames="${i}"]`)
      : document.querySelector(`#paged [data-frames="${i}"]`);
    if (!framesEl || !Array.isArray(boxes) || !boxes.length) return;
    framesEl.innerHTML = '';
    for (const b of boxes) {
      const d = document.createElement('div');
      d.className = 'frame pending';
      d.style.left = (b.left * 100) + '%';
      d.style.top = (b.top * 100) + '%';
      d.style.width = Math.max(0.4, (b.right - b.left) * 100) + '%';
      d.style.height = Math.max(0.4, (b.bottom - b.top) * 100) + '%';
      framesEl.appendChild(d);
    }
  },

  paintAllFrames() {
    for (let i = 0; i < this.pages.length; i++) this.paintPage(i);
  },

  afterPageReady() {
    const i = this.page;
    const c = this.canvases[i];
    if (!c) return;
    // Видимая доля страницы: полосы (как KomaBands в АПК)
    const rect = this.pageRect(i);
    const vp = window.innerHeight - 0;
    const frac = rect && rect.height > 0 ? clamp(vp / rect.height, 0.12, 1) : 1;
    this.bands = bandsOf(frac, RULES);
    this.band = this.bands[clamp(this.bandIndex || 0, 0, this.bands.length - 1)];
    this.syncSub();
    if (RULES.semiManual && State.semi) return;         // ждём остановки и прокрутки
    // Буфер прошлой версии хранит страницу, распознанную ЦЕЛИКОМ. Для длинной
    // страницы это лишние реплики за пределами экрана — такую пересчитываем
    // видимой полосой один раз (полоса запомнится в bandCache).
    const data = this.regions.get(i);
    const staleFull = data && data.cached && this.visibleBandPx(i);
    // Само ничего не запускаем: человек сам сказал «Распознать» (или включил
    // автозапуск в настройках). Иначе при открытии страницы начиналось
    // распознавание, и было непонятно, что вообще происходит.
    // Ждать «лента встала» нужно только когда текст у страницы УЖЕ есть и его
    // надо уточнить. Если текста нет вовсе — распознаём сразу, иначе на телефоне
    // первые секунды после листания уходили в пустоту (06.11, 10:33).
    if ((!this.scrollBusy || !data) && (!data || staleFull)) {
      if (RULES.autoScan) { this.hideStart(); this.scanCurrent(false, null, 'открытие'); }
      else this.showStart();
    }
    if (data && !staleFull) {
      this.hideStart();                          // страница уже распознана
      // Голос у этой книги (1.0.21): если для книги он включён — читаем сами,
      // один раз на страницу. В ленте по умолчанию голос выключен: человек
      // листает сам.
      // Первое открытие книги: пусть приложение само замерит чтецов на этой
      // странице и запомнит лучшего (по доле словарных слов). Один раз.
      if (typeof window.__komaAutoEngine === 'function' && this.autoPickPage !== i) {
        this.autoPickPage = i;
        setTimeout(() => { try { window.__komaAutoEngine(); } catch (e) {} }, 900);
      }
      if (this.voiceOn && this.voiceAutoPage !== i) {
        this.voiceAutoPage = i;
        setTimeout(() => {
          try { TTS.prime(); TTS.readVisible(); } catch (e) { console.warn('авточтение', e); }
        }, 250);
      }
    }
  },

  /**
   * Какая страница РЕАЛЬНО на экране — по геометрии, а не по сохранённому
   * индексу. Раньше считалось только внутри обработчика scroll и только когда
   * у страницы уже был загружен образ; при ленивой загрузке (высота 0 до
   * загрузки) и после автолистания индекс «застревал»: на экране первая
   * страница, а шапка и распознавание — четвёртая.
   */
  /**
   * Видимая сейчас полоса страницы — в пикселях её кадра.
   *
   * Возвращает null, если страница целиком помещается на экран (обычная
   * страница манги) — тогда распознаём всю. Для длинного вебтуна полоса
   * ограничена экраном плюс небольшим запасом, иначе в реплики попадает текст
   * на два экрана вперёд («нашёл 5 реплик, хотя видно одну»).
   */
  /**
   * Дождаться, пока геометрия ленты станет настоящей, и вернуть видимую полосу.
   *
   * Зачем: распознавание теперь стартует сразу при открытии главы, а в этот
   * момент страница может быть ещё не разложена — тогда visibleBandPx отдаёт
   * null, и код считает, что «видно всю страницу». Именно так на телефоне
   * 06.11, 11:34 из одного облачка получалось «3 реплик, 10 строк»: приложение
   * прочитало страницу ЦЕЛИКОМ и ещё не доехавшие облачка тоже.
   *
   * Возвращает null только в одном честном случае: страница действительно
   * помещается на экран целиком.
   */
  async awaitBand(i) {
    const scroller = $('#strip');
    const view = (scroller && scroller.clientHeight) || window.innerHeight || 800;
    for (let w = 0; w < 30; w++) {
      const b = this.visibleBandPx(i);
      if (b) return b;
      const c = this.canvases[i];
      const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
      if (c && c.height && wrap && !this.scrollBusy) {
        const h = wrap.getBoundingClientRect().height;
        if (h > 0 && h <= view * 1.03) return null;      // страница правда влезает
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return this.visibleBandPx(i);
  },

  /**
   * Лента ли это (манхва/вебтун), а не постраничная манга.
   *
   * Прямая поправка с телефона 06.11, 18:48: «манхву читаем как ленту
   * непрерывную на главу, значит там вообще нету страницы, это все страницы
   * целиком». В ленте делить нечего: глава — один непрерывный поток, и слова
   * «Страница 3 дочитана, ▶ — следующая» здесь просто неверны: следующей
   * страницы нет, есть продолжение той же ленты. Конец объявляем только когда
   * лента кончилась целиком, и это «Глава дочитана».
   */
  isStrip() { return this.mode === 'vertical'; },
  visibleBandPx(i) {
    try { return this.visibleBandPxInner(i); } catch (e) { return null; }
  },
  visibleBandPxInner(i) {
    const c = this.canvases[i];
    const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
    const scroller = $('#strip');
    if (!c || !wrap || !scroller || this.mode !== 'vertical') return null;
    const r = wrap.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    if (!r.height || !c.height) return null;
    const scale = c.height / r.height;                 // пиксели кадра на экранный px
    const viewH = scroller.clientHeight || window.innerHeight;
    const overlap = clamp(Number(RULES.bandOverlap) || 0, 0, 0.6);
    // Запас по умолчанию НОЛЬ: полоса = ровно то, что видно на экране.
    // Замер на странице 720×2960: с запасом 200 px — 19,6 с и 147 кропов,
    // ровно экранами — 13,4 с и 120 кропов, текст одинаковый. Разрезанные
    // границей экрана строки ловит защита atEdge в recognizePage.
    const pad = Math.min(r.height * overlap, viewH * 0.25);
    // Экран в координатах страницы
    const topPx = (Math.max(sr.top, r.top) - r.top) + 0;      // видимое начало
    const botPx = (Math.min(sr.top + viewH, r.bottom) - r.top);
    const y0 = clamp((topPx - pad) * scale, 0, c.height);
    const y1 = clamp((botPx + pad) * scale, 0, c.height);
    if (y1 - y0 < 32) return null;
    // Если видно (почти) всю страницу — полоса не нужна
    if (y1 - y0 >= c.height * 0.92) return null;
    // Раньше страница до 2,2 экрана читалась ЦЕЛИКОМ — и в реплики попадал
    // текст, которого человек ещё не видит: «подхватил то, что гораздо ниже
    // того, что я вижу» (телефон 06.11, 09:35). Просьба прямая: подхватывать
    // ровно то, что в кадре. Поэтому исключения больше нет — полоса всегда,
    // если видно меньше 92 % страницы. Остальное дочитается при прокрутке.
    const vy0 = clamp(topPx * scale, 0, c.height);
    const vy1 = clamp(botPx * scale, 0, c.height);
    // Границы полосы прилипают к пустому месту страницы: иначе экран режет
    // облачко пополам, и реплика читалась двумя кусками на двух «страницах»
    // («НО РАЗВЕ» отдельно от остального облачка — скриншот 17:30).
    // Если карту «где пусто» построить нельзя (нет canvas/getImageData или
    // страница не отрисована), полоса остаётся как была — это не повод её
    // терять целиком.
    let snap = { y0, y1 };
    try { snap = this.blankSnap(i, y0, y1); } catch (e) { snap = { y0, y1 }; }
    return {
      y0: snap.y0, y1: snap.y1, vy0, vy1,
      key: Math.round(vy0 / 96) + ':' + Math.round(vy1 / 96),
    };
  },

  /**
   * Карта «где на странице пусто»: по строке берём самую тёмную точку. Нужна,
   * чтобы границы полосы не проходили через текст.
   */
  inkRows(i) {
    if (this._ink && this._ink.page === i && this._ink.canvas === this.canvases[i]) return this._ink;
    const c = this.canvases[i];
    if (!c || !c.width) return null;
    try {
    const w = 48;
    const h = Math.max(1, Math.round(c.height * (w / c.width)));
    const t = makeCanvas(w, h);
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, w, h);
    let data;
    try { data = g.getImageData(0, 0, w, h).data; } catch (e) { return null; }
    const dark = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let m = 255;
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const v = Math.min(data[o], data[o + 1], data[o + 2]);
        if (v < m) m = v;
      }
      dark[y] = m;
    }
    this._ink = { page: i, canvas: c, h, dark };
    return this._ink;
    } catch (e) { return null; }        // нет canvas/getImageData — полоса как есть
  },

  /** Сдвинуть границу полосы к ближайшей пустой строке (в пределах допуска). */
  blankSnap(i, y0, y1) {
    const ink = this.inkRows(i);
    const c = this.canvases[i];
    if (!ink || !c) return { y0, y1 };
    const rowOf = (px) => clamp(Math.round(px / c.height * ink.h), 0, ink.h - 1);
    const isBlank = (r) => ink.dark[clamp(r, 0, ink.h - 1)] >= 232;
    const maxShift = Math.round(c.height / ink.h) * 6;      // ~6 строк растра
    const find = (px, dir) => {
      const r0 = rowOf(px);
      for (let d = 0; d <= 6; d++) {
        const r = dir < 0 ? r0 - d : r0 + d;
        if (r < 0 || r >= ink.h) break;
        if (isBlank(r)) return Math.round(r * c.height / ink.h);
      }
      return null;
    };
    let ny1 = y1, ny0 = y0;
    const down = find(y1, +1);
    const up = find(y1, -1);
    // Низ двигаем вниз, если пусто близко; иначе вверх — но не меньше 55 %
    // исходной полосы, иначе начнём резать по живому.
    if (down != null && down - y1 <= maxShift) ny1 = Math.min(c.height, down);
    else if (up != null && y1 - up <= maxShift && up - y0 >= (y1 - y0) * 0.55) ny1 = up;
    const upTop = find(y0, -1);
    const downTop = find(y0, +1);
    if (upTop != null && y0 - upTop <= maxShift) ny0 = Math.max(0, upTop);
    else if (downTop != null && downTop - y0 <= maxShift && ny1 - downTop >= (y1 - y0) * 0.55) ny0 = downTop;
    if (ny1 - ny0 < 32) return { y0, y1 };
    return { y0: ny0, y1: ny1 };
  },

  pageAtViewport() {
    const scroller = $('#strip');
    if (!scroller || this.mode !== 'vertical') return this.page;
    const vh = scroller.clientHeight || window.innerHeight;
    const mid = vh * 0.45;                     // чуть выше центра — реплики сверху
    let best = -1, bestArea = -1, bestDist = Infinity, bestNear = -1;
    for (let i = 0; i < this.pages.length; i++) {
      const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
      if (!wrap) continue;
      const r = wrap.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const top = r.top - sr.top, bottom = r.bottom - sr.top;
      const visible = Math.min(bottom, vh) - Math.max(top, 0);
      if (visible > bestArea) { bestArea = visible; best = i; }
      const d = Math.abs(top - mid);
      if (d < bestDist) { bestDist = d; bestNear = i; }
    }
    // Если середина экрана попала в пустоту (страница не загружена и места нет),
    // берём ту, что занимает больше всего экрана.
    return best >= 0 ? best : Math.max(0, bestNear);
  },

  /** Сверить сохранённый индекс с экраном и обновить шапку/подгрузку. */
  syncPage() {
    if (!this.pages || !this.pages.length) return this.page;
    const actual = this.pageAtViewport();
    if (actual !== this.page) {
      this.page = actual;
      this.ensureLoaded(actual);
      this.ensureLoaded(actual + 1);
      this.saveProgress();
      this.syncSub();
      return actual;
    }
    this.syncSub();
    return this.page;
  },

  pageRect(i) {
    const img = this.imgEls[i];
    if (!img) return null;
    return img.getBoundingClientRect();
  },

  scrollToPage(i, animate = true) {
    const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`) || document.querySelector(`.pagebox[data-page="${i}"]`);
    if (!wrap) return;
    wrap.scrollIntoView({ block: 'start', behavior: animate ? 'smooth' : 'auto' });
    this.page = i;
    this.syncSub();
    this.ensureLoaded(i);
    this.ensureLoaded(i + 1);
    this.saveProgress();
  },

  saveProgress() {
    if (!this.book) return;
    this.book.progress = this.page;
    this.book.mode = this.mode;
    DB.put('books', this.book);
  },

  /** Сохранить в буфер все реплики страницы (собранные из полос). */
  async savePageBuffer(i) {
    if (!this.book || !this.book.id) return;       // некуда сохранять — не ошибка
    const data = this.regions.get(i);
    if (data && data.lines) await Buffer.put(i, data.lines);
  },
  /** Смена направления чтения: пересортировать уже распознанное, без OCR. */
  rescanInDir() {
    const rtl = (this.dir || 'rtl') === 'rtl';
    let n = 0;
    for (const [i, data] of this.regions) {
      if (!data || !data.regions) continue;       // из буфера — регионов нет
      data.lines = readingOrder(data.regions, rtl, true, RULES);
      Buffer.put(i, data.lines);
      n++;
    }
    this.paintAllFrames();
    toast(n ? 'Порядок пересчитан: ' + (rtl ? 'справа налево' : 'слева направо') : 'Откройте страницу заново, чтобы применить направление', 4000);
  },

  /**
   * Распознать КОНКРЕТНУЮ страницу.
   *
   * Раньше единственная точка входа (`scanCurrent`) брала «текущую» страницу в
   * момент вызова. Из-за этого «Распознать заново» из шторки «Текст страницы N»
   * сканировало ту страницу, на которой лента оказалась к тому моменту, а не ту,
   * чей текст открыт: реплики не перезаписывались вообще.
   */
  async scanPage(i, opts = {}) {
    this.hideStart();
    const silent = !!opts.silent;          // предзагрузка: без бейджа и тостов
    // Метка источника: без неё в журнале видно «страница 2 встала в очередь»
    // три раза подряд и неясно, кто просит. Пишем кто и что просит.
    try { Journal.add('распознавание', 'запрос: ' + (opts.tag || 'без метки')
      + (opts.force ? ' · заново' : '') + (opts.full ? ' · вся страница' : '')
      + (silent ? ' · тихо' : '') + ' · стр. ' + (i + 1)); } catch (e) { /* ignore */ }
    const force = !!opts.force;
    const keepSheet = !!opts.keepSheet;
    if (i == null || i < 0 || i >= this.pages.length) return null;

    // Полоса, которую сейчас видно: ключ нужен, чтобы при прокрутке
    // распознавать новые куски, а уже распознанные не гонять заново.
    // opts.bandPx — явная полоса в пикселях кадра. Нужна, чтобы распознать
    // следующую полосу ЗАРАНЕЕ, пока звучит речь, и не ждать 3 секунды после
    // прокрутки (на телефоне 22:11 это выглядело как «прокрутил и молчит»).
    const band = opts.full ? null : (opts.bandPx || await this.awaitBand(i));
    const bandKey = band ? band.key : 'page';
    if (!(this.bandCache instanceof Map)) this.bandCache = new Map();
    const bandMap = this.bandCache.get(i) || new Map();

    // Эта же область только что распознавалась — второй раз не гоняем.
    // Обход только у ручного повтора («Распознать заново»): у него force без
    // internal. Фоновые и служебные проходы правило соблюдают.
    if (this.scanCooldown(i, band) && !(force && !opts.internal)) {
      this.paintPage(i);
      return this.regions.get(i) || null;
    }

    // Кэш годится, если: (а) полоса уже распознана; (б) страницу распознали
    // целиком; (в) данные пришли из буфера прошлой сессии — тогда считаем их
    // полной страницей, иначе старые книги распознавались бы заново.
    const cached = this.regions.get(i);
    const hasBands = this.bandCache.has(i);
    const fresh = cached && (band ? (hasBands && bandMap.has(bandKey)) : !hasBands);
    if (cached && fresh && !force) { this.paintPage(i); return cached; }

    if (silent && !opts.internal && (State.scanning || State.prefetching)) return null;
    if (State.scanning && !silent && !opts.internal) {
      // Молча выходить нельзя: нажатие «Распознать заново» выглядело как
      // «кнопка не работает». Ставим в очередь и говорим об этом.
      State.pendingScan = { i, force, keepSheet, full: !!opts.full };
      const msg = 'Идёт распознавание — страница ' + (i + 1) + ' встала в очередь';
      toast(msg, 4000);
      if (keepSheet) $('#textStats').textContent = msg + '…';
      return null;
    }

    let c = this.canvases[i];
    if (!c) {
      // Распознавание стартует сразу при открытии главы — и застаёт момент,
      // когда страница ещё не декодирована. Раньше это давало ложный тост
      // «Страница 1 ещё не загрузилась» поверх идущего распознавания
      // (телефон 06.11, 11:00). Теперь ждём загрузку, а не ругаемся.
      try { await this.ensureLoaded(i); } catch (e) { /* ниже подождём */ }
      for (let w = 0; !this.canvases[i] && w < 25; w++) {
        await new Promise(r => setTimeout(r, 100));
      }
      c = this.canvases[i];
    }
    if (!c) { toast('Страница ' + (i + 1) + ' ещё не загрузилась'); return null; }
    // Пустой кадр (ширина/высота 0) — это ещё не нарисованная страница. Раньше
    // распознавание запускалось сразу и читало «ничего»: человек видел, что
    // первый проход взял не весь текст, а после прокрутки туда-обратно всё
    // сходилось (телефон 06.11, 10:01). Ждём явно, до 2,5 с.
    if (!c.width || !c.height) {
      for (let w = 0; w < 25; w++) {
        await new Promise(r => setTimeout(r, 100));
        c = this.canvases[i];
        if (c && c.width && c.height) break;
      }
      if (!c || !c.width || !c.height) { toast('Страница ' + (i + 1) + ' ещё рисуется — попробуйте ещё раз'); return null; }
    }
    if (!OCR.ready) {
      // Раньше шторка «Модели» открывалась ПУСТОЙ: состояние рисует renderModels,
      // а её здесь никто не звал. На скриншоте с телефона 28.10 так и было —
      // «СОСТОЯНИЕ» без единой строки, непонятно, чего не хватает.
      openSheet('sheetModels');
      renderModels().catch(() => {});
      toast('Сначала добавьте модели OCR (⚙ → Модели)');
      return null;
    }

    if (silent) State.prefetching = true; else State.scanning = true;
    if (!silent) {
      $('#scanBadge').classList.add('on');
      $('#scanBadge').textContent = `Распознаём… стр. ${i + 1}`;
    }
    if (keepSheet) $('#textStats').textContent = `Распознаю страницу ${i + 1} заново…`;
    try {
      const label = band ? `полосу ${i + 1}` : `страницу ${i + 1}`;
      // Рамки найденного рисуем ДО распознавания (см. paintPendingFrames).
      const prevOnBoxes = RULES.onBoxes;
      RULES.onBoxes = (boxes) => { try { this.paintPendingFrames(i, boxes); } catch (e) {} };
      const res = await recognizePage(c, RULES, (done, total, phase) => {
        // Числа проверяем: раньше сюда мог прийти текст фазы вместо числа, и в
        // бейдже висело «Распознаём… NaN/0» (телефон 22:41).
        const okDone = Number.isFinite(done), okTotal = Number.isFinite(total) && total > 0;
        const t = (phase && !okTotal)
          ? `Распознаём… ${phase}`
          : (phase
            ? `Распознаём… ${phase} ${Math.max(1, Math.ceil(done))}/${total}`
            : (okTotal ? `Распознаём… ${Math.min(total, Math.max(1, Math.ceil(done)))}/${total}` : 'Распознаём…'));
        $('#scanBadge').textContent = t;
        if (keepSheet) {
          const dDone = Math.round(Number(done) || 0), dTotal = Math.round(Number(total) || 0);
          $('#textStats').textContent = (okDone && okTotal)
            ? `Распознаю ${label} заново… ${dDone}/${dTotal}`
            : `Распознаю ${label} заново…` + (phase ? ' ' + phase : '');
        }
      }, band, opts.det || null);
      // Журнал: где именно теряется текст. Просьба 06.11, 19:37: «журнал теперь
      // пишет по каждой странице: детекция WxH: боксов N, распознано строк M
      // (отброшено K)». По этой строке сразу видно, детектор не нашёл текст или
      // распознавание отбросило строки по уверенности.
      try {
        const bx = Number(res.boxes) || 0;
        const got = (res.regions || []).length || Number(res.replicas ? res.replicas.length : 0);
        const dropped = Math.max(0, bx - got);
        // По каждой странице — одна строка; в тихих проходах пишем только когда
        // что-то отброшено (иначе журнал забивался предзагрузкой).
        if (!silent || dropped > 0) {
          Journal.add('распознавание',
            'детекция ' + (c.width || 0) + 'x' + (c.height || 0) + ': боксов ' + bx
            + ', распознано строк ' + got + ' (отброшено ' + dropped + ')'
            + ' за ' + (Number(res.ms) || 0) + ' мс'
            + (band ? ' · полоса' : ' · страница'));
        }
      } catch (e) { /* журнал не обязателен */ }
      // Своя плашка «Полоса N распознана…» может попасть в кадр (снимок экрана).
      // До сборки реплик её строки отбрасываем: иначе они склеиваются в
      // «реплику» вида «реплик · 6.1 с (детектор 2.5 с, распознавание 3.6 с,
      // 4 строк)» и уходят в чтение (телефон 06.11, 10:33).
      const toastLines = (res.regions || []).filter(r => isAppToastText(r && r.text)).length;
      if (toastLines) res.regions = (res.regions || []).filter(r => !isAppToastText(r && r.text));
      // Направление чтения — отдельная настройка (dir), а не раскладка.
      const rtl = (this.dir || 'rtl') === 'rtl';
      let fresh;
      if (res.plan === 'native' && Array.isArray(res.replicas) && res.replicas.length) {
        // Порядок и склейку уже сделал движок чтения в приложении. Здесь только
        // слова: словарь и языковая починка живут в странице (3 МБ словаря).
        // ВАЖНО: чистка реплики (двойники, цифры, приклеенная латиница,
        // слипшиеся слова) применяется ЗДЕСЬ, до словаря. Нативный движок
        // собирает реплики в приложении и идёт мимо конвейера страницы — из-за
        // этого на телефоне 4.11 оставались «ПОДУМАЛАw», «сапьYwb», «ЗНА4ИТ».
        fresh = res.replicas
          .map(r => ({
            ...r,
            text: Words.polish(polishLineText(String(r.text || '')), RULES.junkRatio, r.confidence),
          }))
          .filter(l => l.text && (l.text.match(/\p{L}/gu) || []).length >= 2);
        // Ни одна прочитанная строка не должна остаться за бортом реплики:
        // именно из-за этого реплики выходили обрезками («НО РАЗВЕ»).
        const rec = recoverLostLines(fresh, res.regions);
        // Сырые строки этой же страницы — улика против обрезков: если движок
        // где-то прочитал слово целиком, хвост реплики восстанавливаем по нему.
        const rawTexts = (res.regions || []).map(r => String((r && r.text) || ''));
        fresh = rec.replicas
          .map(r => ({ ...r, text: restoreCutTails(polishLineText(String(r.text || '')), rawTexts) }))
          .map(r => ({ ...r, text: Words.polish(r.text, RULES.junkRatio, r.confidence) }))
          .filter(l => l.text && (l.text.match(/\p{L}/gu) || []).length >= 2);
        // Одно облачко, приехавшее дважды («А ТО МЫ ТОЛЬКО ПОДРУЖИЛИСЬ.» и
        // «ПОДРУЖИЛИСЬ»), читалось вслух два раза подряд — телефон 19:58.
        fresh = dropDuplicateReplicas(fresh);
        OCR.recovered = rec.attached;
        OCR.readPlan = 'native';
      } else {
        fresh = readingOrder(res.regions, rtl, true, RULES)
          .filter(l => !isAppToastText(l.text))     // своя плашка — не реплика
          .map(l => ({ ...l, text: polishLineText(String(l.text || '')) }))
          .filter(l => l.text && !isAppToastText(l.text));
        OCR.readPlan = 'page';
      }
      // Края реплик чистим ЗДЕСЬ, на выходе распознавания: обрывок звукового
      // эффекта приклеивается к началу текста уже при склейке строк, то есть
      // позже первой чистки («*ь*.*о НЕ УВЕРЕН…» — эмулятор APKForge, 29.10).
      fresh = fresh
        // Нативная ветка отдаёт текст как есть, а полировка (сборка обрывков,
        // ремонт слов по словарю) жила только в веб-ветке и в чистке буфера.
        // Отсюда на телефоне 00:01 жили «ШКОЛ?» вместо «ШКОЛУ» и «ПОДУМАЛ АШ»:
        // их не чинили, а не «не смогли починить». Полируем ровно один раз.
        .map(l => {
          const raw = String(l.text || '');
          const text = l.polished ? raw
            : trimJunkEdges(Words.ready ? Words.polish(raw, RULES.junkRatio, l.confidence) : raw);
          return { ...l, rawText: raw, text, polished: true };
        })
        .filter(l => l.text && (l.text.match(/\p{L}/gu) || []).length >= 2);
      // Титул, «Гл. 48» и адрес сайта — не реплики. Высота строки нужна, чтобы
      // отличить каллиграфию от реплики: медиана по самой странице.
      const hs = fresh.map(l => Number(l.height || (l.bottom - l.top)) || 0)
        .filter(h => h > 0).sort((a, b) => a - b);
      const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
      fresh = fresh
        // Смотрим и на сырой текст: полировка умеет «починить» адрес сайта до
        // нечитаемого «МАNГАВЛФФ.РИ», а мусор из обрывков каллиграфии — до
        // формально словарных, но бессмысленных слов («ТАР ТТ ПА АДЕ ЕД»).
        .filter(l => !isTitleOrMarker(l.rawText || l.text, l, 1, medH))
        .filter(l => !isTitleOrMarker(l.text, l, 1, medH))
        .filter(l => !looksLikeJunkLine(l.text));
      // Последняя страховка: распознанная строка не имеет права пропасть.
      // Сюда попадаем уже после чистки и склейки — если строка выпала, вернём её.
      fresh = attachLostLines(fresh, res.regions || [], medH);
      // Реплика, прочитанная дважды подряд внутри одной строки, — частая беда
      // при узких полосах: половина облачка попадает в две полосы, и обе
      // приносят свою расшифровку одной и той же фразы.
      fresh = fresh.map(l => {
        const t = dedupeRepeatText(l.text);
        return t === l.text ? l : { ...l, rawText: l.rawText || l.text, text: t };
      });
      // Строки у края полосы СПЕЦИАЛЬНО не перечитываем: авторемонт подменял
      // текст соседней строки (журнал 06.11, 20:11:20 «НЕ МОГУ ОСТАВИТЬ ЭТО БЕЗ
      // ВНИМАНИЯ» → «ДАЖЕ ЕСЛИ И ТАК…»). Для этого есть ручное выделение области.
      // Помечаем, на какой полосе нашлась реплика: в шторке видно, что
      // показано «на экране», а что распознано раньше с этой же страницы.
      const bandTop = band ? Math.round(band.y0) : 0;
      fresh = fresh.map(l => ({ ...l, bandTop }));
      const at = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // Собираем полосы страницы. Реплики этой же полосы НЕ выбрасываем:
      // повторный проход (третий, четвёртый — «заново», «дочитывание»,
      // «предзагрузка») иногда находит меньше строк, чем первый, и раньше
      // новый результат ЗАМЕНЯЛ старый — уже распознанный текст неожиданно
      // пропадал (жалоба 06.11, 22:0x: «после распознавания текст, который он
      // сканировал, теряется на последнем проходе»). Теперь объединяем:
      // новая строка того же места вытесняет старую только если прочитана не
      // хуже (оценка текста), иначе остаётся прежняя.
      const prevPart = bandMap.get(bandKey);
      const mergedLines = keepOldLines(prevPart && prevPart.lines, fresh);
      if (prevPart && mergedLines.length !== fresh.length) {
        try {
          Journal.add('распознавание', 'полоса ' + (bandKey === 'full' ? 'вся' : 'на экране')
            + ': сохранено ' + (mergedLines.length - fresh.length) + ' реплик прежнего прохода');
        } catch (e) { /* нет журнала */ }
      }
      bandMap.set(bandKey, { lines: mergedLines, res, at });
      const detPass = res.detPass || 'normal';
      const largePasses = res.largePasses || 0;
      this.bandCache.set(i, bandMap);
      // ── Полнота полосы ────────────────────────────────────────────────────
      // Первый проход иногда успевает разобрать только верхнюю часть кадра:
      // распознавание шло, пока страница ещё дорисовывалась, и низ выпадал.
      // Человек видел «прочитало не всё», прокручивал вниз-вверх, и второй
      // проход подхватывал остаток (телефон 06.11, 10:01). Догоняем САМИ:
      // если в полосе ниже последней найденной строки есть краска, а реплик
      // нет — распознаём этот кусок отдельно и приклеиваем к полосе. Границы
      // полосы не расширяются, лишнего (того, чего не видно) не читаем.
      if (band && !opts.tail && !opts.full) {
        try {
          const bottoms = (res.regions || []).map(r => Number(r.bottom) || 0);
          const lastBottom = bottoms.length ? Math.max(...bottoms) * c.height : band.y0;
          const tailFrom = Math.round(Math.max(band.y0, lastBottom));
          const tailH = Math.round(band.y1) - tailFrom;
          const bandH = Math.round(band.y1 - band.y0);
          const ink = this.inkRows(i);
          const darkInTail = () => {
            if (!ink) return true;                       // нет карты — считаем, что текст есть
            const row = (px) => clamp(Math.round(px / c.height * ink.h), 0, ink.h - 1);
            const a = row(tailFrom), b = row(band.y1);
            for (let r = a; r <= b; r++) if (ink.dark[r] < 200) return true;
            return false;
          };
          if (tailH > Math.max(200, bandH * 0.2) && darkInTail()) {
            // Это полоса, а не «текущая страница»: scanCurrent() принимает
            // (force, preDet, tag), поэтому объект с bandPx уезжал в preDet, а
            // номер страницы — в force. Проверка молча возвращалась к целой
            // странице: лишний полный проход на 10–14 с (журнал 06.11,
            // 18:21:19 «детектор 3.3, распознавание 11.1»).
            await this.scanPage(i, {
              bandPx: { y0: tailFrom, y1: band.y1, vy0: band.vy0, vy1: band.vy1,
                        key: bandKey + ':tail' + Math.round(tailFrom) },
              silent: true, internal: true, tail: true, force: true,
              tag: 'дочитывание полосы',
            });
          }
        } catch (e) { console.warn('дочитывание полосы', e); }
      }
      const parts = Array.from(bandMap.entries())
        .sort((a, b) => {
          const ya = a[1].res.band ? a[1].res.band.y0 : 0;
          const yb = b[1].res.band ? b[1].res.band.y0 : 0;
          return ya - yb;
        });
      let lines = mergeBandLines(parts.map(([, part]) => part), c);
      // ── Страховка от потери уже найденного ────────────────────────────────
      // Автоматический проход (прокрутка, предзагрузка, дочитывание, очередь)
      // не должен УМЕНЬШАТЬ список реплик страницы: человек видел текст, а
      // после очередного прохода он пропал. Если проход не по прямому
      // требованию («заново», кнопка, ручное выделение) — недостающие реплики
      // возвращаем. Явный пересчёт по кнопке остаётся полным пересчётом:
      // иначе старые строки закреплялись бы навсегда.
      const autoPass = silent
        || /прокрутка|предзагрузка|дочитывание|догон|целая страница|очередь|заранее|контроль конца/i.test(String(opts.tag || ''));
      const prevPage = this.regions.get(i);
      if (autoPass && prevPage && Array.isArray(prevPage.lines) && prevPage.lines.length) {
        const before = lines.length;
        lines = keepOldLines(prevPage.lines, lines);
        if (lines.length > before) {
          try {
            Journal.add('распознавание', 'страница ' + (i + 1) + ': сохранено '
              + (lines.length - before) + ' реплик прежнего прохода (проход «' + (opts.tag || 'без метки') + '»)');
          } catch (e) { /* нет журнала */ }
        }
      }
      const total = parts.reduce((acc, [, p]) => acc + (p.res.ms || 0), 0);
      this.regions.set(i, {
        ...res, lines, at, bands: parts.length,
        detPass, largePasses,
        ms: total, detMs: res.detMs, recMs: res.recMs, crops: res.crops,
        boxes: res.boxes, regions: res.regions, recovered: OCR.recovered || 0,
        bandKeys: parts.length,
      });
      await this.savePageBuffer(i);
      this.paintPage(i);
      if (silent) return this.regions.get(i);      // молча: это фоновая загрузка
      // Числа берём только те, что есть. Нативный проход неделим (детектор и
      // распознавание идут одним вызовом), поэтому для него печатаем один
      // замер; раньше поля были пустыми и тост писал «NaN с».
      const secTxt = (v) => (Number.isFinite(v) && v > 0 ? (v / 1000).toFixed(1) : null);
      const nativePass = (res.via === 'native' || res.detPass === 'native');
      const totalSec = secTxt(res.ms)
        || secTxt((Number(res.detMs) || 0) + (Number(res.recMs) || 0)) || '?';
      const how = nativePass
        ? `нативно, ${res.crops} строк`
        : `детектор ${secTxt(res.detMs) || '0.0'} с, распознавание ${secTxt(res.recMs) || '0.0'} с, ${res.crops} строк`
          + (OCR.nativeNote ? `, нативно не вышло: ${String(OCR.nativeNote).slice(0, 80)}` : '');
      toast(`${band ? 'Полоса' : 'Страница'} ${i + 1} ${force ? 'обновлена' : 'распознана'}: ${fresh.length} реплик`
        + (parts.length > 1 ? `, всего ${lines.length} на странице` : '')
        + ` · ${totalSec} с (${how})`, 6000, true);
      // Шторка остаётся открытой — и обязательно перерисовывается.
      if ($('#sheetText').classList.contains('on')) renderTextSheet(i);
      return this.regions.get(i);
    } catch (e) {
      console.error(e);
      const ln = String((e && e.stack) || '').split('\n')[1] || '';
      const where = ln.trim().replace(/\s*\(?.*\//, '(').replace(/^at /, '');
      const msg = 'Ошибка распознавания: ' + (e.message || e) + (where ? ' · ' + where : '');
      toast(msg, 8000);
      if (keepSheet) $('#textStats').textContent = msg;
      return null;
    } finally {
      RULES.onBoxes = null;                    // крючок рамок — только на один проход
      State.scanning = false;
      State.prefetching = false;
      $('#scanBadge').classList.remove('on');
      const p = State.pendingScan;
      State.pendingScan = null;
      // Повтор из очереди идёт БЕЗ «заново»: иначе один и тот же запрос
      // перезапускался сам себя и тост «обновлена: 0 реплик» крутился кольцом
      // (журнал 06.11, 18:04:01 → 18:04:04).
      if (p) setTimeout(() => this.scanPage(p.i, { force: false, keepSheet: p.keepSheet, full: p.full, tag: 'очередь' }), 50);
    }
  },

  /** Совместимость: распознать текущую страницу. */
  async scanCurrent(force = false, preDet = null, tag = '') {
    return this.scanPage(this.page, { force, det: preDet, tag });
  },

  /** Карточка «ничего не запущено»: показывается, пока страница не распознана. */
  showStart() {
    const el = $('#startCard');
    if (!el) return;
    const data = this.regions.get(this.page);
    if (data) { el.style.display = 'none'; return; }
    $('#startTitle').textContent = 'Страница ' + (this.page + 1) + ' открыта';
    $('#startHint').textContent = 'Ничего не запущено. Скорость: '
      + (SPEED_NAMES[RULES.speed] || RULES.speed) + ' ' + (SPEED_APPROX[RULES.speed] || '');
    $('#cbAutoScan').checked = !!RULES.autoScan;
    el.style.display = 'block';
  },
  hideStart() {
    const el = $('#startCard');
    if (el) el.style.display = 'none';
  },

  /**
   * Ключ «прочитано»: страница + НОМЕР реплики (+ текст для читаемости).
   *
   * Раньше ключ был «страница + текст», и этого хватало, чтобы реплики
   * ПРОПАДАЛИ: в манхве два разных облачка часто читаются одинаково («ДА!»,
   * «?!», «ХАНА»), и второе считалось прочитанным вместе с первым — голос его
   * пропускал, страница перескакивала. Это и есть «съел реплики» из жалобы 4.11.
   * Теперь номер реплики входит в ключ, поэтому одинаковый текст — разные
   * реплики. Текст остаётся в ключе, чтобы после перераспознавания страницы
   * с другим числом строк отметки не сыпались на чужие места.
   */
  /**
   * ВРЕМЯ ОЗВУЧКИ РЕПЛИКИ — по тексту, а не по объекту.
   *
   * Объект реплики пересоздаётся при пересчёте полосы и при перерисовке, и
   * время, записанное в него, терялось (проверка 06.11: у одной из трёх реплик
   * было 0). Ключ — страница + нормализованный текст.
   */
  setSpeakMs(i, line, ms) {
    if (!(this.speakMsMap instanceof Map)) this.speakMsMap = new Map();
    const t = String((line && line.text) || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!t || !(ms >= 0)) return;
    this.speakMsMap.set(i + '|' + t, ms);
    if (line && typeof line === 'object') line.speakMs = ms;
  },
  getSpeakMs(i, line) {
    if (!(this.speakMsMap instanceof Map)) return 0;
    const t = String((line && line.text) || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return Number(this.speakMsMap.get(i + '|' + t)) || 0;
  },
  spokenKey(i, text, idx) {
    const t = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return (idx === undefined || idx === null) ? (i + '|' + t) : (i + '#' + idx + '|' + t);
  },
  /** Номер реплики на странице (или -1, если строки нет в списке). */
  lineIdx(i, line) {
    const d = this.regions.get(i);
    if (!d || !d.lines || !line) return -1;
    return d.lines.indexOf(line);
  },
  /**
   * Реплика уже прочитана. Реплики, которых нет в списке страницы (первая
   * реплика конвейера «распознал и сразу сказал»), отмечаются только по тексту:
   * иначе одна и та же фраза звучала бы дважды — из конвейера и из списка.
   */
  isSpoken(i, line) {
    if (!line) return false;
    // Ключ без номера ставится ТОЛЬКО реплике вне списка страницы — той, что
    // конвейер сказал до распознавания. Если её текст совпал с репликой на
    // странице, второй раз та же фраза звучать не должна (проверка 4.11:
    // «ЭТО ПЕРВАЯ РЕПЛИКА» успевало прозвучать дважды).
    if (this.spoken.has(this.spokenKey(i, line.text))) return true;
    const idx = this.lineIdx(i, line);
    if (idx < 0) return false;
    return this.spoken.has(this.spokenKey(i, line.text, idx));
  },
  unmarkSpoken(i, line) {
    const text = (line && line.text) || String(line || '');
    const idx = this.lineIdx(i, line);
    this.spoken.delete(this.spokenKey(i, text, idx >= 0 ? idx : undefined));
    this.spokenDirty = true;
    this.paintPage(i);
  },
  markSpoken(i, line) {
    const text = (line && line.text) || String(line || '');
    const idx = this.lineIdx(i, line);
    this.spoken.add(this.spokenKey(i, text, idx >= 0 ? idx : undefined));
    this.spokenDirty = true;
    this.paintPage(i);
  },
  /**
   * Подсвечена ОДНА реплика — та, что звучит. Сравнение по объекту, а если
   * объект пересоздан (пересчёт полосы) — по месту на странице.
   */
  isCurrentLine(i, line) {
    const cur = this.current;
    if (!cur || !line) return false;
    if (cur === line) return true;
    if (this.currentPage !== undefined && this.currentPage !== i) return false;
    if (cur.top === undefined || line.top === undefined) return false;
    return Math.abs(cur.top - line.top) < 1e-6 && Math.abs((cur.left || 0) - (line.left || 0)) < 1e-6;
  },
  /** Сохранить отметки «прочитано» в базу (не чаще раза в 3 с). */
  saveSpoken() {
    if (!this.spokenDirty || !this.book) return;
    this.spokenDirty = false;
    const k = 'spoken:' + this.book.id;
    DB.put('kv', { k, v: Array.from(this.spoken).slice(-4000) }).catch(() => {});
  },
  /** Непрочитанные реплики ВСЕЙ страницы — страховка от «прочитал одну». */
  unspokenPage() {
    const data = this.regions.get(this.page);
    if (!data) return [];
    return (data.lines || []).filter(l => !this.isSpoken(this.page, l));
  },
  /** Непрочитанные реплики текущей полосы. */
  unspokenInBand() {
    const i = this.page;
    return this.visibleLines().filter(l => !this.isSpoken(i, l));
  },

  /**
   * Пока человек слушает текущую страницу, тихо распознаём следующую. Тогда
   * переход не упирается в «Распознаём… стр. N»: страница уже готова. Раньше
   * 14 страниц читались как 14 ожиданий подряд.
   */
  prefetchNext() {
    if (!OCR.ready) return;
    this.prefetchPages(this.page + 1, 3);
  },
  /**
   * Тихо распознать страницы впереди — по очереди, до `count` штук.
   *
   * Зачем цепочка: в вебтуне между репликами часто стоят страницы-картинки без
   * текста. Раньше предраспознавалась только СЛЕДУЮЩАЯ страница, и на каждой
   * пустой читалка снова ждала полное распознавание — лента уже стоит, голос
   * молчит (жалоба 4.11). Теперь пустая страница не обрывает подготовку:
   * следующая за ней распознаётся сразу после неё.
   */
  prefetchPages(from, count) {
    if (!OCR.ready || count <= 0) return;
    if (from >= this.pages.length || this.regions.get(from)) return;
    clearTimeout(this.prefetchTimer);
    let tries = 0;
    const tick = async () => {
      // Читаем ли мы ещё? Раньше проверка стояла как `this.stopped === undefined`,
      // то есть было `undefined === undefined` — и предраспознавание НЕ
      // запускалось НИКОГДА. Из-за этого каждый переход на новую страницу
      // упирался в полное распознавание: лента уже доехала, голос молчит
      // секунды — ровно «остановился, потом резко заговорил» (жалоба 4.11).
      if (typeof TTS !== 'undefined' && TTS.stopped !== false) return;
      if (!this.canvases[from]) {                    // страница ещё не декодирована
        if (++tries <= 8) this.prefetchTimer = setTimeout(tick, 400);
        return;
      }
      if (State.scanning || State.prefetching) {      // занято — попробуем ещё
        if (++tries <= 12) this.prefetchTimer = setTimeout(tick, 500);
        return;
      }
      if (this.regions.get(from)) { this.prefetchPages(from + 1, count - 1); return; }
      try { await this.scanPage(from, { full: true, silent: true, tag: 'предзагрузка' }); } catch (e) { /* фон — молча */ }
      const data = this.regions.get(from);
      const empty = !data || !(data.lines || []).length;
      if (empty && count > 1) this.prefetchPages(from + 1, count - 1);
    };
    this.prefetchTimer = setTimeout(tick, 700);
  },
  /* ── Полосы: распознать ВПЕРЁД, прокрутить ПОСЛЕ ──────────────────────── */

  /** Полоса (доли страницы) → пиксели кадра + ключ для кэша полос. */
  bandPx(i, b) {
    const c = this.canvases[i];
    if (!c || !b || b.whole) return null;
    const y0 = clamp(Math.round(b.top * c.height), 0, c.height);
    const y1 = clamp(Math.round(b.bottom * c.height), 0, c.height);
    if (y1 - y0 < 32) return null;
    return { y0, y1, vy0: y0, vy1: y1,
      key: 'b' + (b.index || 0) + ':' + Math.round(y0 / 96) + '-' + Math.round(y1 / 96) };
  },
  /**
   * Покрыта ли полоса (в пикселях кадра) уже распознанными кусками.
   *
   * Раньше здесь было «один кусок перекрывает 60 % полосы». Этого мало:
   * границы полосы прилипают к пустым местам и при каждой прокрутке чуть
   * съезжают, поэтому кэш набирал несколько кусков, каждый по половине полосы,
   * и полоса считалась НЕраспознанной — приложение снова и снова запускало
   * распознавание (телефон 06.11, 12:02: «Полоса 2 обновлена: 0 реплик»
   * каждые две секунды). Теперь считаем ОБЪЕДИНЕНИЕ кусков.
   */
  bandCoveredPx(i, px) {
    const data = this.regions.get(i);
    const maps = this.bandCache && this.bandCache.get(i);
    if (data && !maps) return true;                 // страница распознана целиком
    if (!maps) return false;
    if (!px) return !!data;
    const h = Math.max(1, px.y1 - px.y0);
    const segs = [];
    for (const [, part] of maps) {
      const r = part && part.res && part.res.band;
      if (!r) return true;                          // этот кусок — вся страница
      const a = Math.max(r.y0, px.y0), b = Math.min(r.y1, px.y1);
      if (b > a) segs.push([a, b]);
    }
    segs.sort((a, b) => a[0] - b[0]);
    let covered = 0, end = -Infinity;
    for (const [a, b] of segs) {
      const from = Math.max(a, end);
      if (b > from) covered += b - from;
      if (b > end) end = b;
    }
    return covered > h * 0.6;
  },
  /** Уже распознана ли эта полоса (в кэше полос или страница целиком). */
  bandScanned(i, b) {
    const maps = this.bandCache && this.bandCache.get(i);
    const px = this.bandPx(i, b);
    return this.bandCoveredPx(i, px);
  },

  /**
   * Не гонять одну и ту же область по кругу.
   *
   * Полоса, где нет речи (облачко с одними точками «…» — это размышление,
   * слов там нет), распознавалась заново каждые две секунды: геометрия полосы
   * после перерисовки чуть менялась, ключ кэша не совпадал, и цикл не
   * заканчивался никогда. Тост «0 реплик» висел на экране бесконечно
   * (телефон 06.11, 12:02).
   *
   * Правило: ту же страницу и ту же полосу (с допуском) не распознаём повторно
   * в течение SCAN_COOLDOWN_MS. Ручное «Распознать заново» это правило обходит.
   */
  scanCooldown(i, band) {
    const now = Date.now();
    if (!(this._scanLog instanceof Map)) this._scanLog = new Map();
    const k = i + ':' + (band
      ? Math.round(band.y0 / 64) + '-' + Math.round(band.y1 / 64)
      : 'page');
    const prev = this._scanLog.get(k);
    this._scanLog.set(k, now);
    if (prev && now - prev < SCAN_COOLDOWN_MS) return true;
    return false;
  },
  /**
   * Гарантировать текст полосы: при необходимости распознать её ЗДЕСЬ и сейчас.
   * Возвращает непрочитанные реплики этой полосы.
   */
  async ensureBandLines(i, ni) {
    const bands = this.bands || [];
    const b = bands[ni];
    if (!b) return [];
    this.bandIndex = ni;
    this.band = b;
    if (b.whole) return this.unspokenInBand();
    await this.waitIdle();
    if (!this.bandScanned(i, b)) {
      const px = this.bandPx(i, b);
      if (px) await this.scanPage(i, { bandPx: px, tag: 'полоса: чтение' });
    }
    this.band = b;
    return this.unspokenInBand();
  },
  /**
   * Прокрутить к реплике, ТОЛЬКО если её не видно (или видно у самого края).
   * Спокойное чтение вместо дёрганья: если строка уже на экране — не трогаем
   * ленту вовсе.
   */
  scrollToLineIfNeeded(i, line) {
    try {
      const sc = $('#strip');
      const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
      if (!sc || !wrap || !line || this.mode !== 'vertical') return false;
      const h = wrap.getBoundingClientRect().height || ((this.pageRect(i) || {}).height || 0);
      if (!h) return false;
      const viewH = sc.clientHeight || window.innerHeight;
      const abs = (wrap.offsetTop || 0) + clamp(line.top, 0, 1) * h;   // строка в ленте
      const rel = abs - sc.scrollTop;                                  // где она на экране
      // Уже хорошо видно: от 8 % до 80 % экрана — ничего не делаем.
      if (rel > viewH * 0.08 && rel < viewH * 0.8) return false;
      const target = Math.max(0, abs - viewH * 0.22);
      if (Math.abs(target - sc.scrollTop) < 24) return false;
      SMOOTH.glide(target);              // один твин на всех, время — по дистанции
      return true;
    } catch (e) { return false; }
  },

  /** Плавно подвести ленту к началу страницы (вертикальный режим). */
  scrollToPage(i, animate = true) {
    try {
      const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
      const sc = $('#strip');
      if (!wrap || !sc || this.mode !== 'vertical') return false;
      const viewH = sc.clientHeight || window.innerHeight;
      const target = Math.max(0, (wrap.offsetTop || 0) - viewH * 0.04);
      if (Math.abs(target - (sc.scrollTop || 0)) < 24) return false;
      if (animate) SMOOTH.glide(target);
      else { SMOOTH.stop(); sc.scrollTop = target; }
      return true;
    } catch (e) { return false; }
  },
  /**
   * Показать страницу ЦЕЛИКОМ, если в ней нет текста: подъехать к её низу с
   * обычной скоростью прокрутки. Именно этого не хватало — читалка молча
   * перепрыгивала такие страницы, и человек терял кусок сюжета.
   */
  async glideThroughPage(i) {
    try {
      const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
      const sc = $('#strip');
      if (!wrap || !sc || this.mode !== 'vertical') return false;
      const h = wrap.getBoundingClientRect().height || 0;
      if (!h) return false;
      const viewH = sc.clientHeight || window.innerHeight;
      const target = Math.max(0, (wrap.offsetTop || 0) + h - viewH * 0.92);
      const from = sc.scrollTop || 0;
      if (target - from < 24) return false;
      SMOOTH.glide(target);
      await SMOOTH.done();
      await sleep(PANEL_DWELL_MS);
      return true;
    } catch (e) { return false; }
  },
  /** Прокрутить ленту ровно к началу полосы (без накопления сдвига). */
  scrollToBand(i, ni, animate = true) {
    const b = (this.bands || [])[ni];
    const wrap = document.querySelector(`.pagewrap[data-page="${i}"]`);
    const sc = $('#strip');
    if (!b || !wrap || !sc) return false;
    const h = wrap.getBoundingClientRect().height || ((this.pageRect(i) || {}).height || 0);
    if (!h) return false;
    const target = Math.max(0, (wrap.offsetTop || 0) + b.top * h);
    if (animate) SMOOTH.glide(target);
    else { SMOOTH.stop(); sc.scrollTop = target; }
    return true;
  },
  /**
   * Пока человек слушает текущую полосу — тихо распознать следующую.
   * Это и убирает «прокрутил и несколько секунд молчит»: к моменту перехода
   * текст следующей полосы уже посчитан.
   */
  prefetchBandAhead() {
    if (!OCR.ready || RULES.pipeline === false) return;
    const i = this.page, bands = this.bands || [];
    const ni = (this.bandIndex || 0) + 1;
    if (ni >= bands.length) return;             // дальше страница — её prefetchNext
    clearTimeout(this._bandTimer);
    this._bandTimer = setTimeout(async () => {
      try {
        if (typeof TTS !== 'undefined' && TTS.stopped !== false) return;  // не читаем
        if (State.scanning || State.prefetching) return;
        if (Reader.bandScanned(i, bands[ni])) return;
        const px = Reader.bandPx(i, bands[ni]);
        if (!px) return;
        await Reader.scanPage(i, { bandPx: px, silent: true, tag: 'заранее' });
      } catch (e) { /* фон — молча */ }
    }, 500);
  },

  /** Дождаться конца фоновой загрузки, чтобы не запускать два распознавания. */
  async waitIdle(ms = 25000) {
    const t0 = Date.now();
    while ((State.scanning || State.prefetching) && Date.now() - t0 < ms) await sleep(120);
  },

  /* Реплики текущей полосы — то, что читается */
  visibleLines() {
    const data = this.regions.get(this.page);
    if (!data) return [];
    if (!this.band || this.band.whole) return data.lines;
    const b = this.band;
    return data.lines.filter(l => l.bottom > b.top && l.top < b.bottom);
  },
};

/**
 * Пауза на панель/страницу БЕЗ текста. Озвучивать нечего, но человек должен
 * успеть рассмотреть кадр: иначе читалка «перелетает полсюжета» (жалоба 4.11).
 */
const PANEL_DWELL_MS = 520;
/**
 * Пауза, в течение которой ту же полосу повторно не распознаём. Две секунды
 * детектора на цикл — это и был бесконечный «0 реплик» на телефоне 06.11.
 */
const SCAN_COOLDOWN_MS = 12000;

/* ───────────────────────── 9. Буфер строк ───────────────────────── */
const Buffer = {
  async put(page, lines) {
    // Буфер живёт в книге. Если книга не из библиотеки (страница открыта сама
    // по себе), сохранять некуда — и падать из-за этого нельзя: раньше отсюда
    // прилетал тост «Ошибка распознавания: Cannot read properties of null»,
    // хотя распознавание прошло нормально (замечено 28.10 на прозе).
    if (!Reader.book || !Reader.book.id) return;
    const key = 'buf:' + Reader.book.id + ':' + page;
    // В записи храним ИМЯ КНИГИ, а не только её ключ: тогда даже если ключи
    // когда-нибудь совпадут по префиксу, чужие строки в чужую страницу не
    // попадут — при чтении сверяем книгу ещё раз.
    const build = (typeof VERSION !== 'undefined') ? VERSION : '';
    // textFormat — формат строк, а не номер сборки: см. TEXT_FORMAT в part2.js.
    const textFormat = (typeof TEXT_FORMAT !== 'undefined') ? TEXT_FORMAT : 0;
    await DB.put('kv', { k: key, v: { page, book: Reader.book.id, at: Date.now(), rules: RULES.version, build, textFormat, lines } });
  },
  async get(page) {
    const bufRow = await DB.get('kv', 'buf:' + Reader.book.id + ':' + page);
    return (bufRow && bufRow.v) || null;
  },
  /**
   * Ключ книги в буфере — С ДВОЕТОЧИЕМ на конце.
   *
   * Было `startsWith('buf:' + id)`: у книги `b1` под это подходили и строки
   * книги `b12`, и на экране страница одной манги показывала реплики другой
   * (телефон 17:51: «Как прожить жизнь, будучи старшей сестрой тирана» и
   * «Пиксель хоррор» в одном списке). Разделитель обязателен ещё и потому, что
   * без книги префикс `buf:` совпадал со всем буфером сразу.
   */
  keyPrefix() {
    const id = Reader.book && Reader.book.id;
    return id ? 'buf:' + id + ':' : null;
  },
  async all() {
    const prefix = this.keyPrefix();
    if (!prefix) return [];
    const id = Reader.book.id;
    const rows = (await DB.all('kv') || []).filter(r => typeof r.k === 'string' && r.k.startsWith(prefix));
    // ── ТЕКСТ ПРЕЖНЕЙ СБОРКИ НЕ ПОКАЗЫВАЕМ (1.9.67) ────────────────────────
    // Буфер строк хранит уже собранные реплики. После обновления читалки они
    // приходили из базы КАК ЕСТЬ, и человек видел старый мусор в новой версии:
    // на телефоне 19:58 (v1.9.66) страница 1 читалась «…В НАШУ ШКОЛ?» и
    // «ПОДУМАЛ АШ», хотя в этой сборке таких строк уже не бывает — они были
    // записаны в 18:50 на v1.9.64. Чистка это не лечит: «АШ» уже кириллица,
    // а отрезанный хвост без сырых строк не вернуть.
    // Поэтому записи другой сборки не отдаём (и подчищаем, чтобы не копились):
    // страница распознается заново НОВЫМ конвейером.
    const build = (typeof VERSION !== 'undefined') ? VERSION : '';
    const stale = [];
    const fresh = [];
    for (const r of rows) {
      const v = r.v;
      if (!v || typeof v.page !== 'number') continue;
      // Сверяем ФОРМАТ, а не версию сборки: обновление читалки не должно стирать
      // готовый текст страниц (журнал 06.11, 18:46:27 и 18:47:08).
      const fmt = (typeof TEXT_FORMAT !== 'undefined') ? TEXT_FORMAT : 0;
      const docFmt = Number(v.textFormat || 0);
      // Запись без метки формата (сделана до 1.9.95) считаем совместимой, если
      // совпал набор правил чтения: иначе одна установка обнуляла бы весь
      // накопленный текст просто из-за номера сборки.
      const sameRules = v.rules === RULES.version;
      if (docFmt ? docFmt !== fmt : !sameRules) { stale.push(r.k); continue; }
      const _ = build;  // (поле build осталось только для истории записи)
      fresh.push(v);
    }
    if (stale.length) {
      for (const k of stale) { try { await DB.del('kv', k); } catch (e) { /* не критично */ } }
      try {
        toast('Текст прежней версии читалки забыт: ' + stale.length + ' стр. распознаются заново', 5000, true);
      } catch (e) { /* toast может не быть готов */ }
    }
    return fresh
      .filter(v => v && typeof v.page === 'number')
      // Записи прежних версий поля book не имеют — их оставляем (ключ уже
      // проверен), а новые обязаны совпасть по книге.
      .filter(v => !v.book || v.book === id)
      .sort((a, b) => a.page - b.page);
  },
  /**
   * Стереть ВЕСЬ буфер строк, у всех книг (1.9.69).
   *
   * Раньше «Буфер строк → Очистить» чистил только открытую книгу, а если книга
   * не открыта — не делал ничего: keyPrefix() возвращает null и функция молча
   * выходила. Человек чистил «в двух местах», видел «Буфер очищен», а страницы
   * одной из книг продолжали приходить из базы. Теперь очистка одна и та же
   * для всех книг, и она же сбрасывает память страниц.
   */
  async clearAll() {
    const rows = (await DB.all('kv') || []).filter(r => typeof r.k === 'string'
      && (r.k.startsWith('buf:') || r.k.startsWith('spoken:')));
    for (const r of rows) await DB.del('kv', r.k);
    try { Reader.regions.clear(); Reader.bandCache.clear(); } catch (e) { /* не критично */ }
    return rows.length;
  },
  async clear() {
    const prefix = this.keyPrefix();
    if (!prefix) return this.clearAll();
    const rows = (await DB.all('kv') || []).filter(r => typeof r.k === 'string' && r.k.startsWith(prefix));
    for (const r of rows) await DB.del('kv', r.k);
  },
};

/* ───────────────────────── 10. Озвучка ───────────────────────── */
/**
 * «Где читает»: лента над плеером, где каждая буква — отдельный элемент, а
 * текущая подсвечена тенью.
 *
 * Точную привязку «буква ↔ звук» браузер не даёт: SpeechSynthesis шлёт
 * onboundary только по границам СЛОВ (и только часть движков). Поэтому так:
 * границы слов дают точку отсчёта, а внутри слова тень идёт по оценке —
 * ≈14 символов в секунду при rate 1.0 (замер по длительности реплик:
 * «УЖЕ ПОРА НАЧИНАТЬ ВСТРЕЧУ, ТАК ЧТО ЕЁ ВЫСОЧЕСТВО, ДОЛЖНО БЫТЬ, ПРИБЫЛА» —
 * 78 знаков, 5,6 с). Как только приходит новая граница, позиция выравнивается
 * по ней, поэтому расхождение не копится.
 */
const SpeakCursor = {
  el: null, chars: [], pos: 0, t0: 0, rate: 1, exact: false, timer: 0, on: false,
  cps() { return 14 * (this.rate || 1); },
  start(text, rate) {
    const el = $('#nowLine');
    if (!el) return;
    this.el = el; this.rate = rate || 1; this.pos = 0; this.exact = false; this.on = true;
    this.t0 = performance.now();
    el.innerHTML = Array.from(text).map((ch, i) =>
      `<span class="ch" data-i="${i}">${escapeHtml(ch)}</span>`).join('');
    this.chars = Array.from(el.querySelectorAll('.ch'));
    el.style.display = 'block';
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 50);
    this.paint();
  },
  /** Точка отсчёта из onboundary: charIndex — начало слова. */
  boundary(charIndex) {
    if (!this.on || typeof charIndex !== 'number' || charIndex < 0) return;
    this.exact = true;
    this.pos = Math.min(charIndex, this.chars.length);
    this.pos0 = this.pos;
    this.t0 = performance.now();
    this.paint();
  },
  tick() {
    if (!this.on || !this.chars.length) return;
    if (!this.exact) {
      const done = (performance.now() - this.t0) / 1000 * this.cps();
      this.pos = Math.min(this.chars.length, Math.round(done));
      this.paint();
    } else {
      // После границы слова внутри слова ведём тень по оценке.
      const guess = this.pos0 + (performance.now() - this.t0) / 1000 * this.cps();
      const p = Math.min(this.chars.length, Math.round(guess));
      if (p !== this.pos) { this.pos = p; this.paint(); }
    }
  },
  paint() {
    for (let i = 0; i < this.chars.length; i++) {
      const c = this.chars[i];
      const k = i < this.pos ? 'ch sp' : (i === this.pos ? 'ch cur' : 'ch');
      if (c.className !== k) c.className = k;
    }
    // Лента — одна строка в высоту (меньше закрывает страницу), поэтому
    // за текущей буквой она подкручивается сама: видно именно ту строку, где
    // сейчас звучит голос.
    if (this.el && this.pos > 0 && this.chars[this.pos]) {
      const c = this.chars[this.pos];
      const y = c.offsetTop || 0;
      const h = c.offsetHeight || 17;
      // Прокрутка кратна высоте строки: иначе снизу торчала половина
      // следующей строки — выглядело как обрезанный текст.
      // Высота строки — из line-height: у символа offsetHeight округляется
      // по-разному, и строки «плыли» на пару пикселей.
      let rowH = h;
      try { rowH = parseFloat(getComputedStyle(this.el).lineHeight) || h; } catch (e) { rowH = h; }
      const top = Math.floor(y / rowH) * rowH;
      if (top < this.el.scrollTop || top + h > this.el.scrollTop + this.el.clientHeight) {
        this.el.scrollTop = Math.max(0, top);
      }
    }
  },
  stop() {
    this.on = false;
    clearInterval(this.timer); this.timer = 0;
    if (this.el) { this.el.style.display = 'none'; this.el.innerHTML = ''; }
    this.chars = [];
  },
};

/**
 * ГОЛОС: один слой над двумя движками речи.
 *
 * В браузере это Web Speech API (`speechSynthesis`). В Android WebView его НЕТ
 * ВООБЩЕ: 28.10 на телефоне это выглядело как «Скрипты страницы не выполнились»
 * и тост «speechSynthesis is not defined» — падал самый первый вызов в TTS.init(),
 * и всё, что шло дальше по boot (правила, библиотека, модели), не выполнялось.
 * Поэтому речи в приложении даёт нативный Android TTS через мост KomaSpeech,
 * а страница общается только с этим фасадом и не знает, кто под ним.
 *
 * Фасад повторяет ровно тот минимум, который нужен читалке: список голосов,
 * speak с событиями start/end/error, отмена, пауза (где есть) и состояние.
 */
const VOICE = {
  _voices: null, _handlers: {}, _seq: 0, speaking: false, paused: false,

  /** Нативный синтез из АПК. В браузере его нет — и это нормально. */
  native() {
    return !!(typeof window !== 'undefined' && window.KomaSpeech
      && typeof window.KomaSpeech.speak === 'function');
  },
  /** Web Speech API. В WebView отсутствует, поэтому только через typeof. */
  synth() {
    return (typeof speechSynthesis !== 'undefined') ? speechSynthesis : null;
  },
  /** Онлайн-голос Edge выбран и возможен (см. part4a-edge.js). */
  edge() { return (typeof EDGE !== 'undefined') && EDGE.active(); },
  available() { return this.edge() || this.native() || !!this.synth(); },
  /** Чей это голос — для проверок и для честных сообщений человеку. */
  kind() {
    if (this.edge()) return 'Edge TTS (онлайн)';
    return this.native() ? 'Android TTS (АПК)' : (this.synth() ? 'Web Speech' : null);
  },

  /** Список голосов в одном формате: {name, lang, voiceURI}. */
  voices() {
    if (this.native()) {
      // Пустой ответ НЕ кэшируем: Android TTS инициализируется асинхронно, и
      // первый вызов почти всегда приходит раньше, чем движок готов. Раньше
      // пустой список запоминался навсегда — отсюда «Система не дала ни одного
      // голоса» (телефон 22:12) при живом синтезе.
      if (this._voices && this._voices.length) return this._voices;
      try {
        const raw = window.KomaSpeech.voices();
        const arr = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw || []));
        this._voices = (Array.isArray(arr) ? arr : []).map((v, i) => (
          typeof v === 'string'
            ? { name: v, lang: 'ru-RU', voiceURI: 'native:' + i }
            : { name: v.name || ('голос ' + i), lang: v.lang || 'ru-RU', voiceURI: v.voiceURI || ('native:' + i) }));
      } catch (e) { console.warn('KomaSpeech.voices', e); this._voices = []; }
      return this._voices;
    }
    const sw = this.synth();
    if (!sw) return [];
    try { return (sw.getVoices() || []).slice(); } catch (e) { return []; }
  },

  /** Движки синтеза, установленные в системе (только в АПК). */
  engines() {
    if (!this.native() || typeof window.KomaSpeech.engines !== 'function') return [];
    try {
      const raw = window.KomaSpeech.engines();
      const arr = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw || []));
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  },
  /** Переключить движок синтеза. Пусто — системный по умолчанию. */
  useEngine(name) {
    if (!this.native() || typeof window.KomaSpeech.useEngine !== 'function') return false;
    try { window.KomaSpeech.useEngine(String(name || '')); this._voices = null; return true; }
    catch (e) { return false; }
  },

  /** Короткая причина состояния голоса — для честных сообщений человеку. */
  statusText() {
    if (this.edge()) {
      const bits = [EDGE.label()];
      if (!EDGE.uaOk()) bits.push('User-Agent без Edg/ — сервер откажет');
      const err = EDGE.lastError();
      if (err) bits.push(err);
      return bits.join(', ');
    }
    if (!this.native()) {
      const sw = this.synth();
      if (!sw) return 'синтеза речи нет';
      return 'Web Speech: голосов ' + (sw.getVoices() || []).length;
    }
    try {
      const raw = window.KomaSpeech.status();
      const o = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw || {}));
      const bits = [];
      if (o.engine) bits.push(String(o.engine).split('.').pop());
      bits.push(o.ready ? 'готов' : 'не готов');
      if (o.ru === false) bits.push('нет русского голоса');
      if (o.voices) bits.push('голосов ' + o.voices);
      if (o.error) bits.push(o.error);
      return bits.join(', ');
    } catch (e) { return ''; }
  },

  /** Скажет ли нативный движок по-русски; null — не знаем (браузер). */
  nativeReady() {
    if (!this.native()) return null;
    try {
      const st = window.KomaSpeech.status();
      const o = JSON.parse(typeof st === 'string' ? st : JSON.stringify(st || {}));
      return !!o.ready;
    } catch (e) { return false; }
  },

  cancel() {
    this.speaking = false; this.paused = false; this._handlers = {};
    if (this.edge()) { try { EDGE.stop(); } catch (e) { /* ignore */ } }
    if (this.native()) { try { window.KomaSpeech.cancel(); } catch (e) { /* моста уже нет */ } }
    const sw = this.synth();
    if (sw) { try { sw.cancel(); } catch (e) { /* ignore */ } }
  },
  pause() {
    this.paused = true;
    // Edge играет mp3 в <audio>: там пауза настоящая, без перезапуска реплики.
    if (this.edge()) { return EDGE.pause() ? 'pause' : 'restart'; }
    const sw = this.synth();
    if (this.native()) {
      // У Android TTS паузы нет: честно останавливаем и запоминаем, что читаем.
      // Продолжение начинает текущую реплику заново — об этом говорим в интерфейсе.
      try { window.KomaSpeech.cancel(); } catch (e) {}
      this.speaking = false;
      return 'restart';
    }
    if (sw) { try { sw.pause(); } catch (e) {} }
    return 'pause';
  },
  resume() {
    this.paused = false;
    if (this.edge()) { return EDGE.resume(); }
    const sw = this.synth();
    if (sw && !this.native()) { try { sw.resume(); } catch (e) {} return true; }
    return false;
  },

  /**
   * Сказать текст. opts: {lang, rate, voice, onstart, onboundary, onend, onerror}.
   * Возвращает true, если движок принял фразу.
   */
  speak(text, opts = {}) {
    // Что уходит в голос — сразу и мосту стенда (KomaUi.spoken): в эмуляторе
    // это строка на «экране» и журнал порядка, а не догадки по логам.
    try {
      if (typeof window !== 'undefined' && window.KomaUi
          && typeof window.KomaUi.spoken === 'function') {
        window.KomaUi.spoken(String(text || ''));
      }
    } catch (e) { /* моста нет — обычный браузер */ }
    // Онлайн-голос Edge — выше системного: если человек его выбрал, читает он.
    // Ошибку не глотаем: причина уходит в onerror и на экран (тост «Голос не
    // сказал: edge:…»), иначе это выглядело бы как молчание читалки.
    if (this.edge()) {
      const ok = EDGE.speak(String(text || ''), {
        rate: opts.rate,
        onstart: () => { VOICE.speaking = true; if (opts.onstart) opts.onstart(); },
        onend: () => { VOICE.speaking = false; if (opts.onend) opts.onend(); },
        onerror: (e) => {
          VOICE.speaking = false;
          if (opts.onerror) opts.onerror({ error: String((e && e.error) || 'edge') });
        },
      });
      return !!ok;
    }
    if (this.native()) {
      const id = 'v' + (++this._seq) + '_' + Date.now().toString(36);
      this._handlers[id] = opts;
      this.speaking = true;
      window.__komaSpeechEvent = window.__komaSpeechEvent || ((eid, type, data) => {
        const h = VOICE._handlers[eid];
        if (!h) return;
        if (type === 'start') { VOICE.speaking = true; if (h.onstart) h.onstart(); }
        else if (type === 'end') { delete VOICE._handlers[eid]; VOICE.speaking = false; if (h.onend) h.onend(); }
        else if (type === 'error') {
          delete VOICE._handlers[eid]; VOICE.speaking = false;
          if (h.onerror) h.onerror({ error: String(data || 'native') });
        }
      });
      try {
        window.KomaSpeech.speak(String(text || ''), String(opts.rate || 1),
          String(opts.lang || 'ru-RU'), String((opts.voice && opts.voice.name) || ''), id);
        return true;
      } catch (e) {
        delete this._handlers[id];
        this.speaking = false;
        if (opts.onerror) opts.onerror({ error: String((e && e.message) || e) });
        return false;
      }
    }
    const sw = this.synth();
    if (!sw || typeof SpeechSynthesisUtterance === 'undefined') return false;
    // Chrome на Android «засыпает» на длинном чтении: очередь встаёт, и кажется,
    // что голос умер. Лечится периодическим resume(), пока фраза звучит.
    try {
      if (!this._keep) {
        this._keep = setInterval(() => {
          try {
            const s2 = VOICE.synth();
            if (!s2) return;
            if (s2.paused) s2.resume();
            else if (s2.pending && !s2.speaking) s2.resume();
          } catch (e) { /* ignore */ }
        }, 4000);
      }
    } catch (e) { /* ignore */ }
    const u = new SpeechSynthesisUtterance(String(text || ''));
    try { if (opts.voice) u.voice = opts.voice; } catch (e) { /* старый голос */ }
    u.lang = opts.lang || (opts.voice && opts.voice.lang) || 'ru-RU';
    u.rate = opts.rate || 1;
    if (opts.volume != null) u.volume = opts.volume;
    u.onstart = () => { this.speaking = true; if (opts.onstart) opts.onstart(); };
    u.onboundary = (e) => { if (opts.onboundary) opts.onboundary((e && e.charIndex) || 0); };
    u.onend = () => { this.speaking = false; if (opts.onend) opts.onend(); };
    u.onerror = (e) => { this.speaking = false; if (opts.onerror) opts.onerror(e); };
    try { sw.speak(u); return true; } catch (e) {
      if (opts.onerror) opts.onerror({ error: String((e && e.message) || e) });
      return false;
    }
  },
};

/* Кадр анимации и время: в браузере requestAnimationFrame/performance,
   в прогонах без окна — таймер. Обёртки — чтобы не звать браузерные
   глобалы напрямую (сборка проверяет, что каждый вызов определён). */
const RAF = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
  ? window.requestAnimationFrame.bind(window) : null;
const CAF = (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function')
  ? window.cancelAnimationFrame.bind(window) : null;
const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

/**
 * ПЛАВНАЯ ПРОКРУТКА ЛЕНТЫ — один твин за раз.
 *
 * Было: три места дёргали `scrollTo({behavior:'smooth'})` независимо
 * (scrollToLineIfNeeded, followLine, scrollToBand), и на смене реплики они
 * спорили за ленту. Каждый вызов стартовал свою анимацию, лента бросала
 * начатую и ехала к другой цели — это и есть «резко дёрнулся, потом ещё
 * дважды» (телефон 28.10). Родной smooth-scroll в WebView при этом не даёт
 * ни события «доехал», ни отмены.
 *
 * Стало: один requestAnimationFrame-твин. Новая цель во время движения не
 * запускает вторую анимацию, а просто меняет точку назначения — движение
 * остаётся непрерывным. `done()` ждёт, пока лента реально встанет, поэтому
 * голос начинает реплику уже на неподвижной странице.
 */
const SMOOTH = {
  _raf: 0, _to: 0, _wait: [],
  /**
   * Скорость прокрутки (0,25…2). Раньше длительность была ФИКСИРОВАННОЙ
   * (220–260 мс) на любую дистанцию: сдвиг на 30 px и переход на следующую
   * страницу в вебтуне (несколько экранов) ехали одинаково быстро, и переход
   * выглядел как резкий перескок через страницы (телефон 17:48). Теперь время
   * пропорционально дистанции и делится на скорость.
   */
  speed: 1,
  msFor(delta) {
    const px = Math.abs(delta || 0);
    // 1,2 px/мс ≈ 1200 px/с при 1×. Скорость подобрана так, чтобы даже на 1×
    // кадр не перескакивал больше трети экрана: при 2,2 px/мс переход через
    // страницу шёл рывками по ~70 px за кадр — это и видно как «прыжок».
    const base = px / 1.2;
    return clamp(base / Math.max(0.05, this.speed || 1), 200, 3500);
  },
  /** Плавно доехать до y: время считается по дистанции и скорости. */
  glide(y) {
    const sc = $('#strip');
    if (!sc) return false;
    return this.to(y, this.msFor(Math.round(y) - Math.round(sc.scrollTop || 0)));
  },
  /** Кадр: в браузере rAF, в тестах и старом WebView — таймер. */
  _raf2(fn) {
    if (typeof RAF === 'function') return RAF(fn);
    return setTimeout(() => fn(nowMs()), 16);
  },
  _caf(id) {
    if (!id) return;
    try {
      if (typeof CAF === 'function') CAF(id);
      else clearTimeout(id);
    } catch (e) { /* уже отменён */ }
  },
  /** Ехать к y (в пикселях ленты). Возвращает false, если ехать некуда. */
  to(y, ms = 240) {
    const sc = $('#strip');
    if (!sc) return false;
    const from = sc.scrollTop || 0;
    const to = Math.max(0, Math.round(y));
    if (Math.abs(to - from) < 2) { this._to = to; return false; }
    this._to = to;
    if (this._raf) return true;                 // уже едем — только цель обновилась
    const start = from, t0 = nowMs();
    const tick = (t) => {
      const k = Math.min(1, Math.max(0, (t - t0) / ms));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOutQuad
      sc.scrollTop = Math.max(0, start + (this._to - start) * e);
      if (k < 1) { this._raf = this._raf2(tick); return; }
      this._raf = 0;
      sc.scrollTop = Math.max(0, this._to);
      const w = this._wait; this._wait = [];
      w.forEach(f => { try { f(); } catch (e) { /* ждём, не падаем */ } });
    };
    this._raf = this._raf2(tick);
    return true;
  },
  /** Ждать остановки ленты (сразу, если она стоит). */
  done() {
    if (!this._raf) return Promise.resolve();
    return new Promise(res => this._wait.push(res));
  },
  /** Человек сам тронул ленту — анимацию отдаём ему. */
  stop() {
    this._caf(this._raf);
    this._raf = 0;
    const w = this._wait; this._wait = [];
    w.forEach(f => { try { f(); } catch (e) { } });
  },
};

/**
 * ИНТЕРФЕЙС ЧТЕНИЯ В АПК.
 *
 * В приложении панель чтения нативная (KomaUi): она лежит под страницей, не
 * ездит вместе с лентой и не пересчитывает свою высоту на каждой реплике.
 * Страница остаётся владельцем чтения — она лишь рассказывает панели, что
 * сейчас звучит, и принимает от неё нажатия (`window.KomaUiCmd`). В браузере
 * моста нет, и всё работает по-старому: своя HTML-панель.
 */
const NATIVE_UI = {
  there() {
    return !!(typeof window !== 'undefined' && window.KomaUi
      && typeof window.KomaUi.show === 'function');
  },
  /** Отдать панели текущее состояние чтения. */
  push() {
    if (!this.there()) return false;
    try {
      const cur = (typeof Reader !== 'undefined' && Reader.current) || null;
      const line = (TTS && (TTS.curLine || cur)) || null;
      const total = (TTS && TTS.queue) ? TTS.queue.length : 0;
      const idx = (TTS && TTS.curIdx) ? TTS.curIdx : (total ? 1 : 0);
      const bands = (typeof Reader !== 'undefined' && Reader.bands) ? Reader.bands.length : 0;
      // Номер полосы не может быть больше их числа: на телефоне 00:01 панель
      // показывала «полоса 3 из 1», потому что номер шёл из bandIndex, а всего
      // полос считалось по другой величине. Если полос нет — пишем «1».
      const band = Math.min((typeof Reader !== 'undefined' ? (Reader.bandIndex | 0) : 0) + 1, bands || 1);
      let voice = '';
      try { voice = VOICE.native() ? 'Android TTS' : 'Web Speech'; } catch (e) { voice = ''; }
      const paused = !!(TTS && TTS.paused);
      const playing = !!(TTS && !TTS.stopped);
      if (!playing && !line && !total) { this.hide(); return false; }
      window.KomaUi.show(JSON.stringify({
        text: (line && line.text) || '',
        index: Math.min(idx || 0, total || 0),
        total: total,
        band: band, bands: bands,
        playing: playing, paused: paused,
        voice: voice,
        status: paused ? 'пауза' : '',
      }));
      return true;
    } catch (e) { console.warn('KomaUi.show', e); return false; }
  },
  hide() {
    if (!this.there() || typeof window.KomaUi.hide !== 'function') return;
    try { window.KomaUi.hide(); } catch (e) { /* моста уже нет */ }
  },
};

/**
 * КОМАНДЫ С НАТИВНОЙ ПАНЕЛИ (KomaUiBridge в АПК).
 *
 * Панель в приложении только показывает состояние и ловит нажатия; чтением
 * владеет страница. Поэтому здесь ровно те же действия, что у своих кнопок —
 * иначе поведение в АПК и в браузере разъехалось бы.
 */
if (typeof window !== 'undefined') {
  window.KomaUiCmd = (cmd) => {
    try {
      switch (String(cmd || '')) {
        case 'toggle':
          if (TTS.stopped) {
            TTS.prime();
            Reader.scanCurrent(false, null, 'панель АПК: ▶').then(() => TTS.readVisible({ fromStart: true }));
          } else if (!TTS.paused) {
            TTS.pauseRead(); TTS.paused = true;
          } else {
            TTS.resumeRead(); TTS.paused = false;
          }
          break;
        case 'next':
          // Пропуск: гасим текущую фразу и сразу идём к следующей реплике.
          VOICE.cancel();
          if (!TTS.stopped) TTS.step();
          break;
        case 'repeat':
          TTS.replay();
          break;
        case 'stop':
        default:
          TTS.stop();
          break;
      }
    } catch (e) { console.warn('KomaUiCmd', e); }
    NATIVE_UI.push();
  };
}

const TTS = {
  voices: [], voice: null, rate: 1, speaking: false, stopped: true, queue: [], idx: 0, primed: false,
  init() {
    // Ни одного прямого обращения к speechSynthesis: в WebView его нет вовсе.
    const fill = () => {
      try {
        const all = VOICE.voices();
        this.voices = all.filter(v => /ru/i.test(v.lang)).concat(all.filter(v => !/ru/i.test(v.lang)));
        const sel = $('#selVoice');
        if (!sel) return;
        // Первый пункт — «системный по умолчанию». Это НЕ заглушка: именно так
        // читают все, кто настроил голос в Android (Tera TTS и прочие).
        const savedIdx = Store.get('koma.voice');
        const chosen = (savedIdx !== null && savedIdx !== 'default') ? +savedIdx : -1;
        sel.innerHTML = '<option value="default">системный (как в настройках Android)</option>'
          + this.voices.map((v, i) =>
            `<option value="${i}">${escapeHtml(v.name)} (${v.lang})</option>`).join('');
        sel.value = (chosen >= 0 && this.voices[chosen]) ? String(chosen) : 'default';
        this.voice = (sel.value === 'default') ? null : (this.voices[+sel.value] || null);
      } catch (e) { console.warn('голоса не заполнились', e); }
    };
    fill();
    const sw = VOICE.synth();
    if (sw) { try { sw.onvoiceschanged = fill; } catch (e) { /* ignore */ } }
    // Список ДВИЖКОВ синтеза (в АПК): человек может выбрать Tera TTS, даже
    // если системным по умолчанию стоит другой.
    try {
      const selE = $('#selTtsEngine');
      if (selE && typeof VOICE.engines === 'function') {
        const list = VOICE.engines();
        if (list.length) {
          const savedE = Store.get('koma.ttsEngine') || '';
          selE.innerHTML = '<option value="">системный движок</option>'
            + list.map(e => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.label || e.name)}${e.default ? ' · по умолчанию' : ''}</option>`).join('');
          selE.value = list.some(e => e.name === savedE) ? savedE : '';
          selE.onchange = (ev) => {
            const name = ev.target.value || '';
            Store.set('koma.ttsEngine', name);
            try { VOICE.useEngine(name); } catch (err) { console.warn('движок не переключился', err); }
            VOICE._voices = null;          // голоса у нового движка свои
            setTimeout(fill, 400);
          };
        }
      }
    } catch (e) { /* в браузере движков нет — это нормально */ }
    // Онлайн-голос Edge: выбор запоминается сразу, без перезапуска читалки.
    try {
      const selEdge = $('#selEdgeVoice');
      if (selEdge && typeof EDGE !== 'undefined') {
        selEdge.value = EDGE.chosen();
        selEdge.onchange = (e) => {
          EDGE.setChosen(e.target.value || '');
          if (EDGE.chosen()) {
            toast(EDGE.uaOk()
              ? 'Онлайн-голос: ' + EDGE.label() + '. Нужен интернет.'
              : 'Онлайн-голос выбран, но эта обёртка не пускает Edge (User-Agent без Edg/)', 6000);
          } else {
            toast('Онлайн-голос выключен — читает системный', 3000);
          }
        };
      }
    } catch (e) { console.warn('выбор онлайн-голоса', e); }
    $('#selVoice').onchange = (e) => {
      // «default» — это выбор системного голоса, а не отсутствие выбора.
      if (e.target.value === 'default') {
        this.voice = null;
        Store.set('koma.voice', 'default');
      } else {
        this.voice = this.voices[+e.target.value] || null;
        Store.set('koma.voice', e.target.value);
      }
    };
    const r = $('#rngRate');
    r.value = +(Store.get('koma.rate') || (RULES.speechRate || 1));
    this.rate = +r.value;
    r.oninput = () => { this.rate = +r.value; Store.set('koma.rate', r.value); };

    // Скорость ПРОКРУТКИ: отдельный ползунок, отдельная память. Значение из
    // правил главнее локальной памяти — правила приезжают плагином.
    const sc = $('#rngScroll');
    if (sc) {
      const saved = Number(RULES.scrollSpeed) || +(Store.get('koma.scroll') || 1) || 1;
      SMOOTH.speed = clamp(saved, 0.25, 2);
      sc.value = String(SMOOTH.speed);
      const hint = $('#scrollSpeedHint');
      const label = () => {
        if (hint) {
          hint.textContent = SMOOTH.speed <= 0.3
            ? SMOOTH.speed.toFixed(2).replace('.', ',') + '× — самое медленное, без рывков'
            : SMOOTH.speed.toFixed(2).replace(/\.00$/, '').replace('.', ',') + '× — прокрутка к реплике';
        }
      };
      label();
      sc.oninput = () => {
        SMOOTH.speed = clamp(+sc.value || 1, 0.25, 2);
        Store.set('koma.scroll', String(SMOOTH.speed));
        RULES.scrollSpeed = SMOOTH.speed;
        label();
        DB.put('kv', { k: 'rules', v: JSON.stringify(RULES) }).catch(() => {});
      };
    }
  },
  stop() {
    this.stopped = true; this.speaking = false; this.queue = [];
    this._gen = (this._gen || 0) + 1;          // колбэки прошлой фразы — в мусор
    try { SpeakCursor.stop(); } catch (e) { /* ленты ещё нет */ }
    VOICE.cancel();
    Reader.current = null;
    Reader.paintAllFrames();
    $('#playBar').style.display = 'none';
    $('#btnRead').textContent = '▶';
    this.curLine = null; this.curIdx = 0;
    NATIVE_UI.hide();
  },
  /**
   * Повторить текущую реплику (кнопка ⟲ на нативной панели).
   * Отдельный метод, потому что просто «ещё раз speakLine» без остановки
   * накладывает вторую фразу на первую.
   */
  replay() {
    const line = this.curLine || Reader.current;
    if (!line || !line.text) return false;
    VOICE.cancel();
    this.stopped = false;
    this.speakLine(line, () => { if (!this.stopped) this.step(); });
    NATIVE_UI.push();
    return true;
  },
  /**
   * Держать читаемую реплику в «безопасной» полосе экрана: сверху шапка и
   * бейдж распознавания, снизу панель проигрывания и нижняя панель. Раньше
   * плеер стоял прямо на облачке — текст реплики был закрыт.
   * Масштаб не меняем (правило), только прокручиваем ленту.
   */
  followLine(line) {
    if (Reader.mode !== 'vertical' || !line) return;
    const wrap = document.querySelector(`.pagewrap[data-page="${Reader.page}"]`);
    const sc = $('#strip');
    if (!wrap || !sc) return;
    const r = wrap.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    if (!r.height || !sr.height) return;
    const top = r.top + line.top * r.height;
    const bottom = r.top + line.bottom * r.height;
    const safeTop = sr.top + 72;                        // шапка + бейдж
    // Нижняя граница учитывает ленту «где читает»: она висит над панелью
    // плеера, и без поправки реплика оказывалась ровно под ней (правило:
    // UI не должен закрывать облачко).
    // Высоту ленты берём, только если она реально показана и это лента, а не
    // случайный нулевой/растянутый элемент: иначе безопасная зона схлопывалась
    // и читалка дёргала страницу на каждой реплике.
    let nowH = 0;
    try {
      const ln = $('#nowLine');
      const shown = ln && ln.style && ln.style.display && ln.style.display !== 'none';
      const lr = ln && ln.getBoundingClientRect ? ln.getBoundingClientRect() : null;
      if (shown && lr && lr.height > 0 && lr.height < 120) nowH = lr.height + 8;
    } catch (e) { nowH = 0; }
    const safeBottom = sr.top + sr.height - 170 - nowH;  // панель чтения + лента
    if (top >= safeTop && bottom <= safeBottom) return;
    const want = sr.top + sr.height * 0.3;               // реплику — в верхнюю треть
    // Тот же единственный твин: followLine больше не тянет ленту отдельно от
    // перехода к следующей полосе.
    SMOOTH.glide(Math.max(0, sc.scrollTop + top - want));
  },
  /**
   * Chrome/WebView разрешает озвучку только «из жеста»: если между нажатием и
   * speak() есть await (распознавание, чтение буфера), speak молча отбивается
   * с ошибкой not-allowed — панель есть, звука нет. Пустая фраза в самом
   * обработчике нажатия разблокирует синтезатор.
   */
  /**
   * Держать синтез «горячим» ДО открытия книги.
   *
   * Просьба с телефона 06.11, 12:22: «до открытия книги уже держи tts
   * включённым, чтобы задержка была поменьше». Задержка бралась не из сети, а
   * из холодного старта: список голосов Chrome отдаёт асинхронно, синтезатор
   * до первого касания заблокирован, и первая реплика либо ждала, либо уходила
   * в системный голос «по умолчанию». Теперь список голосов запрашивается при
   * запуске приложения, а разблокировка — на первом же касании экрана, задолго
   * до ▶.
   */
  prewarm() {
    if (this._warm) { try { VOICE.resume(); } catch (e) { /* не критично */ } return; }
    this._warm = true;
    try {
      const sw = VOICE.synth();
      const load = () => { try { VOICE.voices(); } catch (e) { /* ignore */ } };
      load();
      if (sw && typeof sw.addEventListener === 'function') sw.addEventListener('voiceschanged', load);
    } catch (e) { /* не критично */ }
    try {
      const unlock = () => {
        try { this.prime(); } catch (e) { /* ignore */ }
        try {
          document.removeEventListener('pointerdown', unlock, true);
          document.removeEventListener('touchstart', unlock, true);
        } catch (e) { /* ignore */ }
      };
      document.addEventListener('pointerdown', unlock, true);
      document.addEventListener('touchstart', unlock, true);
    } catch (e) { /* не критично */ }
  },
  prime() {
    // В АПК голос нативный: там нет правила «только из жеста», разблокировать нечего.
    // Edge играет mp3 в <audio> и тоже не требует «разблокировки» — а пустая
    // фраза « » у него стоила бы отдельного сетевого запроса на каждое чтение.
    if (VOICE.native() || VOICE.edge()) { this.primed = true; return; }
    try {
      if (!VOICE.synth()) return;
      if (this.primed) { VOICE.resume(); return; }
      VOICE.speak(' ', { rate: 1, lang: 'ru-RU', volume: 0.05 });
      this.primed = true;
    } catch (e) { console.warn('голос не разблокировался', e); }
  },
  /**
   * Голос, которым читать.
   *
   * Возвращает null, если человек голос НЕ выбирал: тогда говорит системный
   * голос по умолчанию — тот, что стоит в «Настройки → Синтез речи» (Tera TTS
   * и любой другой). Раньше здесь брался первый русский голос движка, и это
   * молча подменяло выбор человека (замечание 28.10 22:4x).
   */
  pickVoice() {
    const cur = this.voice;
    if (!cur) return null;                       // «системный по умолчанию»
    let avail = [];
    try { avail = VOICE.voices() || []; } catch (e) { avail = []; }
    if (!avail.length) return null;              // список не отдан — пусть решает движок
    return avail.find(v => v.voiceURI === cur.voiceURI || v.name === cur.name) || null;
  },
  speakLine(line, then) {
    // ── ПОКОЛЕНИЕ РЕЧИ ────────────────────────────────────────────────────
    // Телефон 06.11, 13:0x: «голос был на первой реплике, а на остальных просто
    // страница окончена». Причина — колбэки ПРОШЛОЙ фразы продолжали управлять
    // очередью. Когда звучит первая реплика и подъезжает распознанная полоса,
    // читалка запускает следующую фразу и отменяет текущую; отмена приходит
    // как error 'interrupted', а обработчик ошибки вызывал then() — то есть
    // «идём дальше». Каждая следующая фраза отменяла предыдущую и тут же сама
    // получала свою отмену: очередь проскакивала целиком за доли секунды, и
    // выходило «Страница дочитана» без звука. Теперь у каждой фразы свой номер:
    // колбэк устаревшей фразы ничего не делает.
    const gen = (this._gen = (this._gen || 0) + 1);
    // «Прочитано» отмечаем ТОЛЬКО когда голос реально заговорил (нажатие ▶ не
    // считается). Раньше отметка ставилась сразу: если синтез отказывал (нет
    // голоса, not-allowed), строка считалась прочитанной и при продолжении
    // чтения ПРОПУСКАЛАСЬ — то есть текст терялся. Отказ = не отмечаем.
    let marked = false;
    const t0 = Date.now();          // для проверки «движок проглотил фразу»
    if (!VOICE.available()) {
      toast('В этой среде нет синтеза речи: ни системного голоса, ни движка АПК', 8000);
      return;
    }
    // Онлайн-голос Edge не зависит от списка голосов Android: там свой голос,
    // и предупреждение «система не дала ни одного голоса» к нему не относится.
    const avail = VOICE.edge() ? [{ name: EDGE.label(), lang: 'ru-RU', voiceURI: 'edge' }] : VOICE.voices();
    if (!avail.length) {
      if (VOICE.native()) {
        // В АПК список голосов даёт Android. Пустой список ≠ «нет синтеза»:
        //  • движок ещё поднимается — ждём и повторяем (до двух раз);
        //  • движок готов, но список голосов не отдал — говорим системным
        //    голосом по умолчанию, а не молчим.
        if (VOICE.nativeReady() === false && (this._voiceTries || 0) < 2) {
          this._voiceTries = (this._voiceTries || 0) + 1;
          toast('Android TTS просыпается — повторю через секунду', 2500);
          setTimeout(() => { if (!this.stopped) this.speakLine(line, then); }, 1100);
          return;
        }
        if (!this._noVoiceHinted) {
          this._noVoiceHinted = true;
          console.warn('список голосов пуст, читаю системным голосом по умолчанию');
        }
      } else {
        toast('Система не дала ни одного голоса: Настройки Android → Синтез речи', 7000);
      }
    } else {
      this._voiceTries = 0;
    }
    const chosen = this.pickVoice();
    if (this.voice && !chosen) {
      // Выбранный раньше голос пропал (сменили движок синтеза, перезапустили
      // TTS). Не подсовываем «первый русский» — возвращаемся к системному и
      // говорим об этом один раз.
      toast('Голос «' + (this.voice.name || '') + '» пропал — читаю системным', 5000);
      this.voice = null;
    } else if (chosen && this.voice && chosen.voiceURI !== this.voice.voiceURI) {
      toast('Голос «' + (this.voice.name || '') + '» недоступен, читаю ' + chosen.name, 5000);
      this.voice = chosen;
    } else if (chosen) {
      this.voice = chosen;
    }
    // Явно выбранный голос — только если человек его выбирал. Иначе null:
    // мост не будет трогать голос и локаль, и заговорит системный (Tera TTS).
    // cancel() «на всякий случай» убивает очередь: следующий вызов уже не
    // запускается. Отменяем только если что-то реально звучит (в браузере) —
    // нативный движок отменять перед каждой репликой не нужно и вредно.
    // Раньше здесь стоял cancel() «на всякий случай» перед КАЖДОЙ фразой.
    // На телефоне 06.11 (13:0x) это и съедало чтение: движок ещё считал
    // предыдущую фразу звучащей, cancel() убивал только что запущенную, та
    // приходила как 'interrupted', обработчик шёл дальше — и вся страница
    // «дочитывалась» без звука. Отменять нужно только по команде (стоп,
    // ⏭, повтор, новое ▶), и это уже делается в stop()/next/replay.
    Reader.current = line;
    Reader.currentPage = Reader.page;      // подсветка не ищет совпадения по тексту
    Reader.paintAllFrames();
    let started = false;
    const started0 = () => {
      started = true;
      // Отметку «прочитано» ставим ТОЛЬКО когда голос дошёл до конца (finished).
      // На телефоне 2.11 (скриншот 20:11) вышло иначе: отметка ставилась на
      // «начал говорить», а звука не было слышно, и реплики оказались
      // «прочитанными» без озвучки. Отметка на старте — это обещание, которое
      // нельзя проверить; на конце фразы оно проверено.
      // Тень по буквам стартует вместе со звуком, а не по нажатию кнопки.
      try { SpeakCursor.start(line.text, this.rate); } catch (e) { /* не критично */ }
    };
    const finished = () => {
      if (gen !== this._gen) return;              // это фраза прошлого поколения
      this._retryCount = 0;
      clearTimeout(this._watch);
      // ВРЕМЯ ОЗВУЧКИ РЕПЛИКИ (просьба 06.11, 17:05: «добавь время озвучки
      // каждого кропа»). Пишем в саму реплику — его видно в «Текст страницы» —
      // и в журнал. Заодно это единственный честный признак, что звук был:
      // движок, который «проглотил» фразу, даёт подозрительно короткое время.
      try {
        const msAll = Date.now() - t0;
        line.speakMs = msAll;
        line.voicedAt = new Date().toLocaleTimeString('ru-RU');
        try { Reader.setSpeakMs(Reader.page, line, msAll); } catch (e) { /* ignore */ }
        Journal.add('голос', 'озвучка ' + (msAll / 1000).toFixed(1) + ' с · «'
          + String(line.text || '').slice(0, 40) + (String(line.text || '').length > 40 ? '…' : '') + '»', { ms: msAll });
        // Если открыт «Текст страницы» — обновляем список, чтобы время озвучки
        // было видно сразу, а не после повторного открытия шторки.
        if (typeof renderTextSheet === 'function') {
          const sh = $('#sheetText');
          if (sh && sh.classList.contains('on') && Reader.textPage === Reader.page) renderTextSheet(Reader.textPage);
        }
      } catch (e) { /* журнала может не быть */ }
      try { SpeakCursor.stop(); } catch (e) {}
      // Движок может «проглотить» фразу: прислать start и сразу end. На телефоне
      // 2.11 (скриншот 20:11) так и вышло — реплики «прочитаны», звука нет.
      // Мерило простое и проверяемое: фразу из 8+ букв нельзя произнести за
      // 250 мс. Если end пришёл раньше — считаем, что не сказал: НЕ отмечаем
      // «прочитано» (реплика не потеряется) и один раз говорим, где проверить.
      const ms = Date.now() - t0;
      const letters = (String(line.text || '').match(/\p{L}/gu) || []).length;
      if (letters >= 8 && ms < 250) {
        this._fastSilent = (this._fastSilent || 0) + 1;
        try { Journal.add('голос', 'движок «проглотил» фразу: ' + ms + ' мс на '
          + letters + ' букв · «' + String(line.text || '').slice(0, 40) + '»'); } catch (e) { /* ignore */ }
        if (!this._fastSilentHinted) {
          this._fastSilentHinted = true;
          toast('Голос ответил мгновенно — похоже, движок молчит: ⚙ → «Проверить голос»', 8000);
        }
        // Вторая «мгновенная» реплика подряд — движок не говорит вовсе.
        // Раньше очередь доходила до конца, и приложение бодро сообщало
        // «Страница 1 дочитана. ▶ — следующая», хотя не прозвучало ни слова
        // (телефон 06.11, 12:21). Останавливаемся и говорим прямо.
        if (this._fastSilent >= 2) {
          this.stop();
          toast('Голос не говорит — остановился, страница НЕ дочитана. ⚙ → «Проверить голос»', 9000);
          return;
        }
        if (then) then();
        return;
      }
      this._fastSilent = 0;
      marked = true;
      try { Reader.markSpoken(Reader.page, line); } catch (e) { /* не критично */ }
      if (then) then();
    };
    const failed = (code) => {
      if (gen !== this._gen) return;              // отменили МЫ — не идём дальше
      this.speaking = false;
      try { SpeakCursor.stop(); } catch (err) {}
      // Не заговорил — отметки быть не должно (ставится только в finished).
      if (marked) { try { Reader.unmarkSpoken(Reader.page, line); } catch (err) {} marked = false; }
      // Молчать нельзя: раньше «голос не работает» выглядело как поломка
      // читалки, хотя движок просто отбил озвучку.
      if (code === 'interrupted' || code === 'canceled') {
        // Движок отбил фразу (наш cancel, переключение, занятость канала).
        // Идти дальше нельзя: реплика пропала бы без звука. Повторяем ИМЕННО
        // ЕЁ один раз, и только если за это время не начали другую.
        const n = (this._retryCount || 0) + 1;
        this._retryCount = n;
        try { Journal.add('голос', 'фраза оборвана (' + code + '), попытка ' + n + ' · «'
          + String(line.text || '').slice(0, 40) + '»'); } catch (e) { /* ignore */ }
        if (n <= 1 && !this.stopped) {
          setTimeout(() => { if (!this.stopped && gen === this._gen) this.speakLine(line, then); }, 220);
          return;
        }
        this._retryCount = 0;
        toast('Голос оборвал реплику — пропускаю: «' + String(line.text || '').slice(0, 28) + '…»', 5000);
      } else if (code === 'not-allowed') {
        toast('Браузер не разрешил озвучку — нажмите ▶ ещё раз', 5000);
      } else {
        toast('Голос не сказал: ' + code, 5000);
      }
      if (then) then();
    };
    const accepted = VOICE.speak(line.text, {
      lang: (this.voice && this.voice.lang) || 'ru-RU',
      rate: this.rate,
      voice: this.voice,
      onstart: started0,
      // Точная граница слова (Chrome отдаёт её как name:'word'). Нативный Android
      // TTS границ не шлёт — там тень идёт по оценке, ровно как и раньше.
      onboundary: (ci) => { try { SpeakCursor.boundary(ci || 0); } catch (err) { /* ignore */ } },
      onend: finished,
      onerror: (e) => failed((e && e.error) || 'unknown'),
    });
    if (!accepted) {
      toast('Синтез отказал: движок не принял фразу', 6000);
      return;
    }
    // Если синтез не начал говорить и не сообщил ошибку — молчать нельзя:
    // именно это выглядело как «голос по умолчанию молчит».
    clearTimeout(this._watch);
    const watchdog = (ms) => {
      clearTimeout(this._watch);
      this._watch = setTimeout(() => {
        if (started || this.stopped) return;
        if (VOICE.native()) {
          // Не заговорил — пробуем ещё раз системным голосом БЕЗ выбора
          // конкретного голоса и без скорости. Раньше при «движок молчит»
          // страница просто останавливалась, и это выглядело как «голос умер».
          if ((this._softAgain || 0) < 1) {
            this._softAgain = (this._softAgain || 0) + 1;
            try {
              VOICE.speak(line.text, {
                lang: 'ru-RU', rate: 1, voice: null,
                onstart: () => { started = true; },
                onend: () => { if (then) then(); },
                onerror: (e) => { console.warn('голос: повтор не удался', e); },
              });
            } catch (e) { console.warn('голос: повтор не запустился', e); }
            watchdog(2200);
            return;
          }
          const st = VOICE.statusText ? VOICE.statusText() : '';
          toast('Голос не заговорил. ⚙ → «Проверить голос»' + (st ? ': ' + st : ''), 7000);
          return;
        }
        // Браузер: молчание Web Speech видно по speaking/pending.
        const sw = VOICE.synth();
        if (sw && !sw.speaking && !sw.pending) {
          toast('Синтез не ответил. Нажмите ⚙ → «Проверить голос»', 6000);
        }
      }, ms);
    };
    // Онлайн-синтез идёт по сети (плюс сеть у телефона может быть медленной),
    // поэтому для Edge ждём дольше — иначе «не заговорил» срабатывало бы на
    // каждом нормальном ответе сервера.
    watchdog(VOICE.edge() ? 9000 : 1500);
    // Прокрутка — ПОСЛЕ запуска речи и в try: ошибка геометрии не должна съедать звук.
    try { this.followLine(line); } catch (e) { console.warn('не прокрутил к реплике', e); }
    // Пока звучит эта реплика — тихо распознаём следующую полосу. Так переход
    // не упирается в ожидание: к моменту «дочитал» текст уже готов.
    try { Reader.prefetchBandAhead(); } catch (e) { console.warn('предраспознавание полосы', e); }
  },
  /** Пауза: в браузере — настоящая, в АПК — остановка с продолжением реплики заново. */
  pauseRead() {
    const mode = VOICE.pause();
    setTimeout(() => NATIVE_UI.push(), 0);
    if (mode === 'restart') {
      this.pausedLine = Reader.current;
      toast('В приложении пауза = стоп: продолжу эту реплику сначала', 3500);
    }
    return mode;
  },
  resumeRead() {
    setTimeout(() => NATIVE_UI.push(), 0);
    if (VOICE.native()) {
      const line = this.pausedLine;
      this.pausedLine = null;
      if (line) { this.speakLine(line, () => { if (!this.stopped) this.step(); }); return true; }
      return false;
    }
    return VOICE.resume();
  },
  async readVisible(opts = {}) {
    // fromStart — человек нажал ▶ сам. Тогда читаем С ВЕРХА видимой полосы,
    // включая то, что уже было прочитано раньше. Раньше отметки «прочитано»
    // соблюдались и при явном нажатии: страница молча ждала, пока дойдёшь до
    // места, где остановился в прошлый раз (жалоба с телефона 22:41).
    // Новый запуск (после стопа или после листания) всегда читает С НАЧАЛА
    // видимой полосы. Раньше соблюдались отметки «прочитано» из прошлого
    // прохода, и после возврата наверх читалка начинала с третьей реплики,
    // хотя первые две человек видел (телефон 06.11, 10:02).
    const fromStart = opts.fromStart === undefined ? !!this.stopped : !!opts.fromStart;
    // Если страница ещё не распознана — сначала распознать, потом читать.
    // Раньше в этот момент вылезало «На этой полосе нет распознанного текста»
    // прямо во время сканирования, хотя текст вот он.
    const i = Reader.page;
    // Конвейер: распознаём и читаем одновременно. Голос начинает с первой
    // готовой реплики, остальные досчитываются, пока звучит речь.
    if (OCR.ready && !State.scanning && RULES.pipeline === true
        && !Reader.unspokenInBand().length && !Reader.regions.get(i)) {
      return this.readWhileScanning();
    }
    if (!Reader.regions.get(i)) {
      if (State.scanning) {
        toast('Распознаю страницу, начну читать сразу после', 4000, true);
        const wait = setInterval(() => {
          if (!State.scanning) {
            clearInterval(wait);
            if (Reader.regions.get(i) && !this.stopped && !State.waitingScroll) this.readVisible();
          }
        }, 400);
        return;
      }
      if (OCR.ready) {
        toast('Сначала распознаю страницу…', 4000, true);
        // Раньше сюда передавался `det` из другого метода — переменной в этой
        // области нет, и в браузере это давало «det.boxes is not iterable»
        // посреди чтения (журнал 06.11, 18:03:27). Детекцию делает сам scanPage.
        await Reader.scanCurrent(false, null, 'чтение');
      }
    }
    let lines = fromStart ? Reader.visibleLines() : Reader.unspokenInBand();
    // Если в полосе экрана текста нет, а на СТРАНИЦЕ он есть — читаем страницу
    // с начала, а не упираемся в тупик. Требование с телефона 21:54: на
    // вебтуне видно облачко с «УЖЕ ... ЧИНАТЬ ...», а приложение отвечало
    // «на этой полосе нет распознанного текста».
    // ТОЛЬКО ТО, ЧТО В КАДРЕ. Если в полосе по мнению Reader.band пусто —
    // пересчитываем полосу по геометрии и берём строки из неё напрямую:
    // Reader.band мог отстать от реальной прокрутки (после скачка ленты).
    if (!lines.length) {
      const data = Reader.regions.get(i);
      const all = (data && data.lines) || [];
      const c = Reader.canvases[i];
      let bnd = null;
      try { bnd = Reader.visibleBandPx(i); } catch (e) { bnd = null; }
      if (all.length && c && bnd) {
        const inBand = all.filter(l => l.bottom * c.height > bnd.vy0 - 4 && l.top * c.height < bnd.vy1 + 4);
        const freshInBand = inBand.filter(l => !Reader.spoken.has(l.key || (l.page + '|' + l.text)));
        if (freshInBand.length) lines = freshInBand;
      }
      // Человек нажал ▶ сам: молча уехать на другую полосу/страницу нельзя —
      // читалка «перепрыгивала», не сказав ни слова (телефон 06.11, 11:34).
      if (!lines.length && fromStart) {
        // В ленте совет «листните» бессмысленный: листать нечего, глава — одна
        // лента. Продолжаем с текущего места вниз (жалоба 06.11, 18:47:45).
        if (Reader.isStrip()) return this.advanceReading();
        toast('На этой полосе непрочитанного текста нет — листните', 4000, true);
        return;
      }
      if (!lines.length && all.length) return this.advanceReading();   // естественный конец полосы
    }
    if (!lines.length && Reader.visibleLines().length) {
      // На этой полосе всё прочитано — переходим к следующему куску.
      return this.advanceReading();
    }
    if (!lines.length && !Reader.visibleLines().length) {
      if (Reader.scrollBusy) return toast('Лента едет — дочитаю, когда остановится', 3000, true);
      const data = Reader.regions.get(i);
      if (!data) { toast('Сначала нужно распознать страницу: ✨ Текст страницы', 4000); return; }
      toast('На этой полосе нет распознанного текста — прокрутите к репликам', 4000, true);
      return;
    }
    this.queue = lines.slice();          // только непрочитанное на этой полосе
    this.stopped = false; this.idx = 0;
    this._softAgain = 0;                 // новый запуск — снова есть право на повтор
    this._chapterChecked = false;        // контроль конца главы — заново
    Reader.prefetchNext();               // следующая страница — пока слушаем эту
    $('#playBar').style.display = 'flex';
    $('#btnRead').textContent = '⏸';
    this.step();
  },
  /**
   * Читать и распознавать одновременно.
   *
   * Не по строкам: построчная отдача рвала реплики на куски («УЖЕ ПОРА НА-» +
   * «ЧИНАТЬ ВСТРЕЧУ,»), а реплику резать нельзя. Поэтому так: сначала
   * распознаём ТОЛЬКО первую целую реплику (0,57 с «Быстро», 0,70 с «Обычно»)
   * и сразу начинаем её читать, а пока звучит речь — распознаём полосу
   * целиком и продолжаем с того, что ещё не прочитано.
   */
  async readWhileScanning() {
    this.queue = []; this.idx = 0; this.stopped = false;
    this.scanDone = false;
    $('#playBar').style.display = 'flex';
    $('#btnRead').textContent = '⏸';
    $('#playStatus').textContent = 'распознаю…';
    const i = Reader.page;
    const c = Reader.canvases[i];
    const band = Reader.visibleBandPx(i);
    const bandCanvas = (() => {
      if (!c) return null;
      if (!band) return c;
      const y0 = Math.max(0, Math.round(band.y0)), y1 = Math.min(c.height, Math.round(band.y1));
      const out = makeCanvas(c.width, Math.max(1, y1 - y0));
      out.getContext('2d', { willReadFrequently: true })
        .drawImage(c, 0, y0, c.width, y1 - y0, 0, 0, c.width, y1 - y0);
      return out;
    })();
    let first = null, det = null;
    if (bandCanvas && OCR.ready) {
      try {
        det = await detectWithRetry(bandCanvas, RULES);           // ~450 мс
        first = await recognizeFirstBubble(bandCanvas, RULES,
          band ? { ...band, y0: 0 } : null, det).catch(() => null);  // +100…300 мс
      } catch (e) { console.warn('конвейер: детектор не сработал', e); det = null; }
    }
    // Пока полоса не досчитана, очередь НЕ закончена: иначе после первой же
    // реплики step() видел пустую очередь, объявлял «страница дочитана» и уезжал
    // дальше, а остальные две реплики звучали уже после этого (журнал 06.11,
    // 18:03:27 → 18:03:51: «дочитана» дважды подряд).
    this._expectMore = true;
    this._expectMoreUntil = Date.now() + 20000;   // страховка от вечного «распознаю…»
    if (first) {
      // Первую реплику конвейера прогоняем через ТОТ ЖЕ фильтр, что и остальные
      // строки страницы (cleanLines): иначе в чтение пролезало то, что при
      // обычном распознавании отбрасывается — например, обрывок титульной
      // надписи с ошибкой в слове (эмулятор Forge, 29.10: первым звучало
      // «Как прожить жизнь, оддучиг старшей сестрой тирана.»).
      let firstText = first;
      try {
        const cleaned = await cleanLines([{ text: first, top: 0, bottom: 0.002, confidence: 1 }]);
        firstText = cleaned.length ? String(cleaned[0].text || '').trim() : '';
      } catch (e) { firstText = first; }
      if (firstText && (firstText.match(/\p{L}/gu) || []).length >= 2) {
        $('#playStatus').textContent = '';
        this.queue.push({ text: firstText, top: 0, bottom: 0 });
        this.step();                  // голос пошёл, пока идёт распознавание полосы
      }
    }
    $('#scanBadge').classList.add('on');
    $('#scanBadge').textContent = 'Распознаём… стр. ' + (i + 1);
    try {
      await Reader.scanCurrent(false, null, 'конвейер');
    } catch (e) { console.warn('конвейер: полоса не распозналась', e); }
    finally {
      this.scanDone = true;
      $('#scanBadge').classList.remove('on');
    }
    // Полоса досчитана: дальше очередь может закончиться по-настоящему.
    this._expectMore = false;
    // Дальше — обычный путь по уже распознанной полосе (первая реплика уже
    // отмечена прочитанной, поэтому повторно не читается).
    if (!this.stopped) {
      const rest = Reader.unspokenInBand();
      if (rest.length) {
        // Первая реплика может ещё звучать. Перезапускать очередь в этот
        // момент нельзя: новой фразе приходилось отменять текущую, и (до
        // правки выше) отмена уводила чтение дальше по списку — облачка
        // «проглатывались». Поэтому ДОПИСЫВАЕМ остаток в очередь, а не
        // начинаем её заново.
        const have = new Set((this.queue || []).map(l => String(l.text || '')));
        const add = rest.filter(l => !have.has(String(l.text || '')));
        if (add.length) {
          if (this.speaking || this.stopped === false) this.queue.push(...add);
          else this.readQueue(add);
        }
      } else if (!first) this.readVisible();
    }
  },
  step() {
    if (this.stopped) return;
    Reader.saveSpoken();
    if (this.idx >= this.queue.length) {
      // Конвейер ещё досчитывает полосу — ждём, а не объявляем конец страницы.
      if (this._expectMore && !this.stopped && Date.now() < (this._expectMoreUntil || 0)) {
        $('#playStatus').textContent = 'распознаю…';
        clearTimeout(this._waitMore);
        this._waitMore = setTimeout(() => { if (!this.stopped) this.step(); }, 150);
        return;
      }
      // Конвейер: реплики ещё идут — ждём следующую, а не заканчиваем чтение.
      // Ждём ТОЛЬКО своё распознавание (конвейер). Раньше условие было
      // `!this.scanDone`, а без конвейера scanDone = undefined, то есть «ждём
      // всегда»: тихое предраспознавание следующей страницы останавливало
      // чтение на секунду с лишним — лента стоит, голос молчит (жалоба 4.11).
      if (State.scanning && this.scanDone === false) {
        $('#playStatus').textContent = 'распознаю…';
        clearTimeout(this._waitMore);
        this._waitMore = setTimeout(() => { if (!this.stopped) this.step(); }, 150);
        return;
      }
      $('#playStatus').textContent = '';
      NATIVE_UI.push();
      this.onQueueEnd();
      return;
    }
    const line = this.queue[this.idx++];
    this.curLine = line;                       // что звучит — для панели и ⟲
    this.curIdx = this.idx;
    // Онлайн-голос: следующую реплику синтезируем ПОКА звучит эта. Иначе
    // между репликами пауза 0,8–4 с (сеть), и чтение выглядит рваным.
    try {
      if (VOICE.edge()) {
        const next = this.queue[this.idx];
        if (next && next.text) EDGE.prefetch(next.text, this.rate);
      }
    } catch (e) { /* заготовка не должна мешать чтению */ }
    $('#playStatus').textContent = (RULES.semiManual && State.semi) ? 'ждём прокрутки' : '';
    NATIVE_UI.push();
    this.speakLine(line, () => { if (!this.stopped) this.step(); });
  },
  /**
   * Дальше по чтению: следующая полоса той же страницы → следующая страница →
   * конец книги. Раньше сразу прыгали на следующую СТРАНИЦУ, и остаток
   * длинной страницы не читался. И полосу перед чтением обязательно
   * распознаём: «страница уже есть в памяти» не значит «есть эта полоса».
   */
  /**
   * Поехать к следующей полосе/странице СРАЗУ, не дожидаясь распознавания.
   * Куда именно мы поедем, в 90 % случаев известно и так: следующая полоса
   * этой страницы или начало следующей страницы. Если текст ещё считается,
   * лента уже едет — поэтому переход остаётся плавным, а не «стоим, потом
   * прыжок и сразу голос».
   */
  glideToAhead() {
    if (Reader.mode !== 'vertical') return false;
    const bands = Reader.bands || [];
    const ni = (Reader.bandIndex || 0) + 1;
    if (ni < bands.length) return Reader.scrollToBand(Reader.page, ni, true);
    if (Reader.page < Reader.pages.length - 1) return Reader.scrollToPage(Reader.page + 1, true);
    return false;
  },
  async advanceReading() {
    // ОДИН проход за раз. Раньше два вызова (из step и из конвейера) шли
    // параллельно: каждый считал «следующую полосу» и дёргал ленту — отсюда
    // «дёрнулся, потом ещё дважды, а прочитал одну реплику» (телефон 28.10).
    if (this._advancing) return;
    this._advancing = true;
    try {
      // Лента трогается сразу: распознавание идёт в пути, а не до него.
      try { this.glideToAhead(); } catch (e) { /* геометрия — не повод молчать */ }
      let page = Reader.page;
      for (let guard = 0; guard < 64; guard++) {
        if (this.stopped) return;
        Reader.page = page;
        const bands = Reader.bands || [];
        // ── Полосы этой страницы ──────────────────────────────────────────
        // Порядок важен и он новый (4.11): СНАЧАЛА лента едет к полосе и
        // РАСПОЗНАВАНИЕ идёт одновременно с движением. Раньше было наоборот:
        // сначала 1–2 с ждали текст при неподвижной странице и в тишине, а
        // потом прыгали к реплике и сразу начинали говорить — это и есть
        // «останавливается, а потом резко озвучивает».
        for (let ni = (Reader.bandIndex || 0) + 1; ni < bands.length; ni++) {
          const moved = Reader.scrollToBand(page, ni, true);
          const scanning = Reader.ensureBandLines(page, ni);   // не ждём — едем
          if (moved) await SMOOTH.done();                      // лента встала
          let un = await scanning;
          // Полоса, которую распознавали В ДВИЖЕНИИ, может выйти пустой: кадр
          // ещё ехал, полоса посчиталась по другой геометрии. Тогда реплика
          // «проскакивала» — человек видел облачко, а голос уезжал дальше
          // (телефон 06.11, 11:34: «слово ХА-А так и не закрасилось»).
          // Пересчитываем один раз на СТОЯЩЕЙ ленте, прежде чем считать полосу пустой.
          if (!un.length && moved && !this.stopped) {
            // Ретраи уходят В ФОН и больше не держат голос.
            //
            // Журнал 06.11, 20:12:29–20:12:42: между репликами «ХА-А» и
            // «ПОЛУЧАЕТСЯ, ГРАФ…» прошло 13 секунд тишины — это «догон полосы»
            // и «целая страница после пустой полосы» стояли в очереди движка,
            // и чтение ждало их. Человек слышит это как «долго молчит».
            // Теперь: полосу пропускаем сразу, а повторный проход запускаем
            // следом, тихо, не блокируя следующую реплику. И только когда
            // очередь чтения действительно пуста.
            this._bgRetry = this._bgRetry || new Set();
            const retryKey = page + ':' + ni;
            if (!this._bgRetry.has(retryKey) && (!this.queue || this.idx >= (this.queue || []).length)) {
              this._bgRetry.add(retryKey);
              setTimeout(async () => {
                try {
                  if (this.stopped || (this.queue && this.idx < this.queue.length)) return;
                  const b2 = Reader.visibleBandPx(page);
                  const redone = await Reader.scanPage(page, { bandPx: b2, force: true, silent: true, internal: true, tag: 'догон полосы' });
                  const seen = Number((redone && (redone.crops || redone.boxes)) || 0);
                  let un2 = Reader.unspokenInBand();
                  // Детектор нашёл строки, а реплик — ноль: полоса распознана
                  // впустую. Один раз читаем целую страницу.
                  if (!un2.length && seen > 0) {
                    await Reader.scanPage(page, { force: true, silent: true, tag: 'целая страница после пустой полосы' });
                    un2 = Reader.unspokenInBand();
                  }
                } catch (e) { /* не обязано получиться */ }
                finally { this._bgRetry.delete(retryKey); }
              }, 500);
            }
          }
          if (this.stopped) return;
          if (un.length) {
            Reader.bandIndex = ni;
            Reader.band = bands[ni] || Reader.band;
            Reader.page = page;
            Reader.scrollToLineIfNeeded(page, un[0]);
            await SMOOTH.done();          // голос — только на стоящей ленте
            await sleep(40);
            Reader.page = page;
            return this.readQueue(un);
          }
          // Полоса без текста. Она уже перед глазами (лента к ней приехала) —
          // даём её рассмотреть. Раньше такие полосы пролистывались молча, и
          // читалка «перелетала полсюжета» без звука (жалоба 4.11).
          if (moved) await sleep(PANEL_DWELL_MS);
        }
        // Полосы кончились, а на странице остались непрочитанные реплики
        // (например, текст попал в полосу, которую мы не считали текущей):
        // читаем их, а не прыгаем дальше молча.
        Reader.bandIndex = bands.length;
        // ── ПЕРЕСЧЁТ КАДРА ────────────────────────────────────────────────
        // «Остаток страницы» считался по Reader.band — по той полосе, которую
        // распознали ПЕРВОЙ. Но лента к этому моменту уже уехала вперёд
        // (glideToAhead), на экране другие облачка, а проверка смотрела в
        // старое окно. Отсюда журнал 06.11, 18:21:56: прозвучала первая
        // реплика — и сразу «Страница 1 дочитана», хотя на экране ещё два
        // облачка, которые потом и читались. Теперь кадр берём по геометрии:
        // что видно СЕЙЧАС, то и остаток.
        let rest = [];
        try {
          const px = Reader.visibleBandPx(page);
          const cv = Reader.canvases[page];
          if (px && cv && cv.height) {
            Reader.band = { top: px.y0 / cv.height, bottom: px.y1 / cv.height, whole: false };
            if (RULES.autoScan && !Reader.bandCoveredPx(page, px)) {
              await Reader.scanPage(page, { bandPx: px, silent: true, tag: 'догон: кадр' });
            }
            rest = Reader.unspokenInBand();
          } else if (!px) {
            // Страница целиком в экране — читаем всё непрочитанное на ней.
            Reader.band = { whole: true };
            rest = Reader.unspokenInBand();
          }
        } catch (e) { console.warn('остаток кадра', e); rest = []; }
        if (rest.length) { Reader.page = page; return this.readQueue(rest); }

        // ── Следующая страница ────────────────────────────────────────────
        // Сам по себе голос за границу страницы НЕ едет (правило autoPage,
        // по умолчанию выключено). Иначе выходило ровно то, на что пожаловались
        // 4.11: страница 2 дочитана — и без единого нажатия голос уехал на 3-ю.
        //
        // В ленте (манхва) границы страниц нет вообще: файлы книги — это одна
        // непрерывная глава. Здесь голос обязан ехать дальше сам, иначе человек
        // жмёт ▶ после каждой «страницы», которой на экране не существует
        // (жалоба 06.11, 18:48).
        if (!RULES.autoPage && !Reader.isStrip()) {
          this.stop();
          Reader.page = page;
          toast('Страница ' + (page + 1) + ' дочитана. ▶ — следующая', 4000);
          return;
        }
        if (page < Reader.pages.length - 1) {
          const next = page + 1;
          await Reader.ensureLoaded(next);
          // Подъезжаем к странице так же плавно, как читаем, и только потом
          // говорим. Раньше ждали распознавания на месте, потом листали и
          // сразу начинали звук.
          Reader.page = next;
          Reader.bandIndex = 0;
          Reader.band = (Reader.bands || [])[0] || null;
          const moved = Reader.scrollToPage(next, true);
          // Распознавание идёт ОДНОВРЕМЕННО с движением ленты, а не после него.
          const scanning = Reader.regions.get(next)
            ? Promise.resolve()
            : Reader.scanPage(next, { full: true, silent: true, tag: 'следующая страница' }).catch(() => {});
          if (moved) await SMOOTH.done();
          await scanning;
          if (this.stopped) return;
          Reader.page = next;
          Reader.band = (Reader.bands || [])[0] || null;
          const un = Reader.unspokenInBand();
          if (un.length) {
            Reader.scrollToLineIfNeeded(next, un[0]);
            // Ждём остановки ленты: иначе голос начинал реплику, пока страница
            // ещё ехала, и переход на следующую страницу вебтуна «прыгал».
            await SMOOTH.done();
            Reader.page = next;
            return this.readQueue(un);
          }
          const restNext = Reader.unspokenPage();
          if (restNext.length) return this.readQueue(restNext);
          // Страница БЕЗ ТЕКСТА: показываем её целиком, с той же скоростью
          // прокрутки, что и остальная лента. Ничего не озвучиваем (озвучивать
          // нечего), но и не перескакиваем через неё молча.
          const through = await Reader.glideThroughPage(next);
          if (this.stopped) return;
          if (!through) await sleep(PANEL_DWELL_MS);
          page = next;
          continue;
        }
        // ── Конец главы ───────────────────────────────────────────────────
        // В ленте перед словом «дочитано» делаем один контрольный проход по
        // кадру: первый проход полосы бывает неполным (журнал 06.11, 18:47:56
        // «1 реплик · 6 строк», а через 30 с та же полоса — «3 реплик ·
        // 19 строк»). Если контроль нашёл новые реплики — читаем их, и только
        // потом говорим, что глава кончилась.
        if (Reader.isStrip() && !this._chapterChecked) {
          this._chapterChecked = true;
          try {
            const px = Reader.visibleBandPx(page);
            await Reader.scanPage(page, { bandPx: px, force: true, silent: true, tag: 'контроль конца главы' });
            const tail = Reader.unspokenInBand();
            if (tail.length) { Reader.page = page; return this.readQueue(tail); }
          } catch (e) { console.warn('контроль конца главы', e); }
        }
        this.stop();
        toast(Reader.isStrip() ? 'Глава дочитана' : 'Конец книги', 2500);
        return;
      }
    } finally {
      this._advancing = false;
    }
  },

  /** Прочитать ровно этот список реплик (без повторного вывода полосы). */
  readQueue(lines) {
    this.queue = lines.slice();
    this.idx = 0;
    this.curLine = null; this.curIdx = 0;
    this.stopped = false;
    $('#playBar').style.display = 'flex';
    $('#btnRead').textContent = '⏸';
    Reader.prefetchNext();
    this.step();
  },

  async onQueueEnd() {
    Reader.current = null;
    Reader.paintAllFrames();
    if (!RULES.semiManual || !State.semi) {
      // обычный режим: следующая полоса → следующая страница → конец книги
      return this.advanceReading();
    }
    // полуручной: встали и ждём прокрутки
    State.waitingScroll = true;
    $('#playBar').style.display = 'flex';
    $('#playStatus').textContent = 'ждём прокрутки';
    showArrow();
  },
};

/* ───────────────────────── 11. Состояние и интерфейс ───────────────────────── */
const State = { scanning: false, prefetching: false, semi: false, waitingScroll: false, autoScroll: true, pendingScan: null };

function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  // Нижние вкладки — только на экранах библиотеки, истории и «Ещё». В читалке
  // они мешают: там своя нижняя панель.
  const nav = document.getElementById('libNav');
  if (nav) nav.classList.toggle('on', id === 'library' || id === 'history' || id === 'more');
  const tab = nav && nav.querySelector('.navbtn[data-tab="' + id + '"]');
  if (nav) nav.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('on', b === tab));
}
function openSheet(id) {
  $$('.sheet').forEach(s => s.classList.toggle('on', s.id === id));
  const bg = $('#sheetBg');
  if (bg) bg.classList.toggle('on', !!id);
  // Новая шторка всегда открывается сверху, а не с прокруткой от прошлой.
  const sh = document.getElementById(id);
  if (sh) { const b = sh.querySelector('.body'); if (b) b.scrollTop = 0; }
}
function closeSheets() {
  $$('.sheet').forEach(s => s.classList.remove('on'));
  const bg = $('#sheetBg');
  if (bg) bg.classList.remove('on');
}

function showArrow() {
  const a = $('#nextArrow');
  a.className = 'nextArrow ' + (Reader.mode === 'vertical' ? 'down' : Reader.mode === 'rtl' ? 'left' : 'right');
  a.textContent = Reader.mode === 'vertical' ? '▼ Прокрутить' : Reader.mode === 'rtl' ? '◀ Прокрутить' : '▶ Прокрутить';
  a.style.display = 'flex';
}
function hideArrow() { $('#nextArrow').style.display = 'none'; }

/**
 * Повторная чистка готовых строк: правила мусора менялись, а в буфере лежит
 * текст, распознанный раньше. Пустые строки выпадают вместе со своими рамками.
 */
async function cleanLines(lines) {
  // Словарь разжимается асинхронно при запуске. Если книгу открыли раньше, чем
  // он готов, весь ремонт слов молча выключался, и в буфере навсегда оставался
  // сырой текст («ШКОЛ?», «ПОДУМАЛ АШ» — телефон 00:02). Ждём словарь здесь.
  if (!Words.ready) { try { await Words.load(); } catch (e) { console.warn('словарь не готов', e); } }
  const keyOf = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Правила «что не реплика» (титул, «Гл. 48», адрес сайта, мусор из редких
  // слов) должны действовать и на старый буфер: иначе после обновления человек
  // снова видит в шторке титул, который я «уже убрал».
  const hs = (lines || []).map(l => Number(l.height || (l.bottom - l.top)) || 0)
    .filter(h => h > 0).sort((a, b) => a - b);
  const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  const out = [];
  for (const ln of lines) {
    // Мусорные края («*ь*.*о НЕ УВЕРЕН…») снимаем ПОСЛЕ словаря: обрывок
    // звукового эффекта приклеивается к реплике уже при склейке строк.
    let text = Words.ready ? Words.polish(ln.text, RULES.junkRatio, ln.confidence) : ln.text;
    text = trimJunkEdges(text || '');
    // Слово, в котором смешаны кириллица и латиница, — почти всегда обрывок
    // распознавания, а не имя: «ПОДУМАЛАw» (телефон 17:51). Латиницу, приклеенную
    // к кириллическому слову, снимаем; если от строки остаётся мусор без гласных
    // («сапьYwb» → «сапь»), строку выбрасываем целиком.
    const hadMixed = /[А-Яа-яЁё][A-Za-z]|[A-Za-z][А-Яа-яЁё]/.test(text);
    text = text
      .replace(/([А-Яа-яЁё]{2,})([A-Za-z]{1,3})(?![A-Za-zА-Яа-яЁё])/g, '$1')
      .replace(/(^|[^A-Za-zА-Яа-яЁё])([A-Za-z]{1,3})([А-Яа-яЁё]{2,})/g, '$1$3')
      .trim();
    if (hadMixed && !/[А-Яа-яЁёАЕЁИОУЫЭЮЯаеёиоуыэюя]/.test(text.replace(/[A-Za-z]/g, ''))) {
      if (text.replace(/[^\p{L}\p{N}]/gu, '').length <= 6) continue;
    }
    if (hadMixed && !/[аеёиоуыэюя]/i.test(text) && text.replace(/[^\p{L}]/gu, '').length <= 6) continue;
    // Регистр: «ОНА Вс ШЕПЧЕТ» → «ОНА ВС ШЕПЧЕТ» (см. fixCaseInCaps).
    text = fixCaseInCaps(text);
    if (!text) continue;
    if (isTitleOrMarker(String(ln.text || ''), ln, 1, medH)) continue;
    if (isTitleOrMarker(text, ln, 1, medH)) continue;
    if (looksLikeJunkLine(text)) continue;
    // Один и тот же текст в том же месте — дубль от полос прежней версии.
    const k = keyOf(text);
    const dup = k && out.some(o => keyOf(o.text) === k
      && Math.min(o.bottom, ln.bottom) > Math.max(o.top, ln.top));
    if (dup) continue;
    out.push(text === ln.text ? ln : { ...ln, text });
  }
  return out;
}



/**
 * Страховка от обрезанных реплик: ни одна прочитанная строка не должна пропасть.
 *
 * Зачем: на скриншотах 1.9.46 реплики выходили обрезками — «НО РАЗВЕ» вместо
 * «НО РАЗВЕ НАШ ЛИДЕР УЖЕ НЕДОСТАТОЧНО ПЛОХ?», «ВАШЕ ПРЕВОСХОДИТЕЛЬСТВО, ЕЁ ЧТО
 * ПРИБЫЛА.» без середины. Строки движок прочитал (они видны в «КАК РАСПОЗНАНО»),
 * но в реплику не попали. Здесь проверяем КАЖДУЮ прочитанную строку: если она не
 * лежит внутри готовой реплики, приклеиваем её к ближайшей по геометрии.
 * Строка без пары остаётся как есть — тогда видно, что она не приклеилась.
 */
function recoverLostLines(replicas, regions) {
  const letters = (t) => (String(t).match(/\p{L}/gu) || []).length;
  const list = Array.isArray(replicas) ? replicas.slice() : [];
  if (!list.length || !Array.isArray(regions) || !regions.length) return { replicas: list, attached: 0 };
  const inside = (l, r, m = 0.004) => r.left >= l.left - m && r.right <= l.right + m
    && r.top >= l.top - m && r.bottom <= l.bottom + m;
  const join = (a, b) => {
    const left = String(a).trim(), right = String(b).trim();
    if (!left) return right;
    if (!right) return left;
    if (/[-‐‑–—]$/.test(left)) return left.slice(0, -1) + right;
    return left + ' ' + right;
  };
  let attached = 0;
  // сверху вниз: так вставка в середину реплики не перепутает порядок
  for (const rg of regions.slice().sort((a, b) => a.top - b.top)) {
    const t = String(rg.text || '').trim();
    if (letters(t) < 3) continue;
    if (list.some((l) => inside(l, rg))) continue;
    let best = null, bestGap = Infinity;
    for (const l of list) {
      const ov = Math.min(l.right, rg.right) - Math.max(l.left, rg.left);
      const minW = Math.min(l.right - l.left, rg.right - rg.left);
      if (minW <= 0 || ov / minW < 0.35) continue;
      const lh = Math.max(l.bottom - l.top, 0.01);
      const gap = rg.top >= l.bottom ? rg.top - l.bottom : (l.top >= rg.bottom ? l.top - rg.bottom : 0);
      if (gap > lh * 1.2) continue;
      if (gap < bestGap) { bestGap = gap; best = l; }
    }
    if (!best) continue;
    const above = rg.top < (best.top + best.bottom) / 2;
    best.text = above ? join(t, best.text) : join(best.text, t);
    best.left = Math.min(best.left, rg.left);
    best.right = Math.max(best.right, rg.right);
    best.top = Math.min(best.top, rg.top);
    best.bottom = Math.max(best.bottom, rg.bottom);
    attached++;
  }
  return { replicas: list, attached };
}

async function renderTextSheet(i) {
  // Открывая шторку, сначала сверяем индекс с тем, что реально на экране:
  // раньше здесь стоял «застрявший» Reader.page, и текст открывался не той
  // страницы, которую человек видит.
  if (i == null) i = Reader.syncPage();
  const onScreen = Reader.pageAtViewport();
  const data = Reader.regions.get(i);
  $('#textTitle').innerHTML = `Текст страницы ${i + 1}`
    + (i === onScreen ? '' : `<span class="hint" style="font-weight:400"> · на экране стр. ${onScreen + 1}</span>`);
  if ($('#textNav')) {
    const hasPrev = i > 0, hasNext = i < Reader.pages.length - 1;
    $('#textNav').innerHTML = `<button class="btn" id="textPrev" ${hasPrev ? '' : 'disabled'}>◀${hasPrev ? ' стр. ' + i : ''}</button>`
      + `<span class="hint" style="align-self:center">${i + 1} из ${Reader.pages.length}</span>`
      + `<button class="btn" id="textNext" ${hasNext ? '' : 'disabled'}>${hasNext ? 'стр. ' + (i + 2) + ' ' : ''}▶</button>`;
    if ($('#textPrev')) $('#textPrev').onclick = () => renderTextSheet(i - 1);
    if ($('#textNext')) $('#textNext').onclick = () => renderTextSheet(i + 1);
  }
  if (!data) { $('#textStats').textContent = 'Страница ещё не распознана'; $('#textOrdered').innerHTML = ''; $('#textRaw').textContent = ''; return; }
  Reader.textPage = i;
  const raw = data.regions || [];
  const stamp = data.at ? ' · обновлено ' + data.at : '';
  $('#textStats').textContent = (data.cached
    ? `${data.lines.length} реплик · из буфера (без повторного распознавания)`
    : `${raw.length} строк · ${Number.isFinite(data.boxes) ? data.boxes : raw.length} блоков · ${data.crops || 0} кропов · `
      // Нативный проход неделим (детектор и распознавание — один вызов), поэтому
      // вместо двух чисел печатаем одно и слово «нативно». Раньше здесь были
      // подстановки undefined → «NaN с» и «0.0 с» (телефон 22:42).
      + ((data.detPass === 'native' || data.via === 'native')
        ? `итого ${(Number(data.ms) || 0) / 1000 < 0.05 ? '?' : ((Number(data.ms) || 0) / 1000).toFixed(1)} с нативно (одним проходом)`
        : `итого ${((Number(data.ms) || 0) / 1000).toFixed(1)} с = детектор ${((Number(data.detMs) || 0) / 1000).toFixed(1)} с `
          + `+ распознавание ${((Number(data.recMs) || 0) / 1000).toFixed(1)} с`)
      + (Number(data.unreadBoxes) > 0 ? ` · не прочитано блоков: ${data.unreadBoxes}` : '')
      + (data.bands > 1 ? ` · полос: ${data.bands}` : '')
      + (data.detPass && data.detPass !== 'normal'
        ? ' · детектор нашёл со 2-й попытки: ' + ({
          contrast: 'контраст', binary: 'бинаризация',
          'binary-inv': 'инверсия', imagenet: 'нормализация кадра',
        }[data.detPass] || data.detPass) : '')
      + (data.largePasses ? ` · 2-й проход по крупному тексту: ${data.largePasses}` : '')
      + (data.variantRuns ? ` · перебор вариантов: ${data.variantRuns}` : '')
      + (data.uncoveredLines ? ` · строк вне боксов: ${data.uncoveredLines}` : '')
      + (data.wordsFixed ? ` · дочинено слов: ${data.wordsFixed}` : '')
      + (data.recovered ? ` · строк приклеено страховкой: ${data.recovered}` : '')
      + (() => {
        const voiced = (data.lines || []).reduce((a, l) => a + (Number(l.speakMs) || Reader.getSpeakMs(i, l) || 0), 0);
        return voiced > 0 ? ` · озвучено ${(voiced / 1000).toFixed(1)} с` : '';
      })()
      + stamp);
  // Показываем ВСЕ реплики страницы, включая уже прочитанные: прочитанное не
  // исчезает из списка, а помечается. Иначе выглядело бы, будто текст пропал.
  // Группируем по полосам страницы. Раньше был один общий список, и на
  // странице 3 в нём оказалась реплика, которую видно на странице 2 — это
  // выглядело как чужие/пропавшие реплики.
  const bandOf = (l) => (Number.isFinite(l.bandTop) ? l.bandTop : 0);
  const groups = new Map();
  for (const l of data.lines) {
    const k = bandOf(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  // Что из списка РЕАЛЬНО на экране — считаем по геометрии кадра, а не по
  // совпадению «метки полосы». Раньше метка ставилась по номеру полосы, и когда
  // она не совпадала (полоса пересчиталась после прокрутки), весь список
  // помечался «распознано раньше» — человек видел реплики, которых на экране
  // нет, и не понимал, откуда они (телефон 06.11, 10:33).
  const bandPx = (() => { try { return Reader.visibleBandPx(i); } catch (e) { return null; } })();
  const cvH = (Reader.canvases[i] && Reader.canvases[i].height) || 0;
  const onScreenLine = (l) => {
    if (!bandPx || !cvH) return null;                        // полоса неизвестна
    const t = (Number(l.top) || 0) * cvH, b = (Number(l.bottom) || 0) * cvH;
    return b > bandPx.vy0 - 2 && t < bandPx.vy1 + 2;
  };
  let counter = 0;
  $('#textOrdered').innerHTML = data.lines.length
    ? Array.from(groups.entries()).sort((a, b) => a[0] - b[0]).map(([top, list]) => {
        const onScreen = list.some(l => onScreenLine(l) === true);
        const head = groups.size > 1
          ? `<div class="hint" style="margin:6px 0 2px">${onScreen ? '● на экране' : '○ за кадром — доедем, когда прокрутите'}</div>`
          : '';
        return head + list.map((l) => {
          counter++;
          const done = Reader.isSpoken(i, l);
          return `<div class="lineitem${l.large ? ' large' : ''}">`
            + `<b>${counter}</b>${done ? '<span class="done">✔ </span>' : ''}${escapeHtml(l.text)}`
            + (l.large ? '<span class="hint"> · крупный текст</span>' : '')
            + (onScreenLine(l) === false ? '<span class="hint"> · за кадром</span>' : '')
            + (done ? '<span class="hint"> · прочитано</span>' : '')
            // Время озвучки этой реплики (просьба 06.11, 17:05). Видно сразу,
            // сколько длилось звучание — и сразу заметно «проглоченную» фразу.
            + ((Number(l.speakMs) || Reader.getSpeakMs(i, l)) > 0
              ? '<span class="hint"> · озвучка ' + (((Number(l.speakMs) || Reader.getSpeakMs(i, l))) / 1000).toFixed(1) + ' с</span>' : '')
            + '</div>';
        }).join('');
      }).join('')
    : '<div class="hint">Реплик не найдено</div>';
  $('#textRaw').textContent = raw.map(r => r.text).join('\n') || '—';
}
async function renderBufferSheet() {
  const items = await Buffer.all();
  const total = items.reduce((a, b) => a + b.lines.length, 0);
  $('#bufferInfo').textContent = `Страниц в буфере: ${items.length} · строк: ${total}`;
  $('#bufferList').innerHTML = items.map(p => p.lines.map(l =>
    `<div class="lineitem"><b>${p.page + 1}</b>${escapeHtml(l.text)}</div>`).join('')).join('');
}
function renderRulesInfo() {
  $('#rulesVer').textContent = `Версия: ${RULES.version}`+
    (RULES.wordFixes && Object.keys(RULES.wordFixes).length ? ` · правок слов: ${Object.keys(RULES.wordFixes).length}` : '');
  $('#wordFixesBox').value = JSON.stringify(RULES.wordFixes || {}, null, 2);
}

/* ─── модели ─── */
async function renderModels() {
  const det = await DB.get('kv', 'model:det');
  const rec = await DB.get('kv', 'model:rec');
  const dict = await DB.get('kv', 'model:dict');
  const f = (x, n) => x ? `${n}: ${(x.v.byteLength / 1048576).toFixed(1)} МБ` : `${n}: нет`;
  const mark = (ok) => ok ? '✅' : '❌';
  const noneYet = !det && !rec && !dict;
  $('#modelsState').innerHTML = [
    noneYet ? '❌ моделей нет — выберите три файла кнопкой «Выбрать файлы» ниже' : '',
    `${mark(!!det)} ${f(det, 'detection.onnx')}`,
    `${mark(!!rec)} ${f(rec, 'cyrillic.onnx')}`,
    `${mark(!!dict)} ${dict ? `cyrillic.txt: ${String(dict.v).split('\n').filter(Boolean).length} символов` : 'cyrillic.txt: нет'}`,
    (await DB.get('kv', 'model:rec2'))
      ? `➕ второй распознаватель: ${OCR.rec2 ? 'подключён — ' + (OCR.rec2Note || 'трудные строки') : 'есть, но ' + (OCR.rec2Note || 'не подключён')}`
      : '➕ второй распознаватель: нет (не обязательно)',
  ].filter(Boolean).join('<br>');
  const note = $('#engineNote');
  if (note) {
    note.style.display = OCR.engine === 'blocked' || OCR.engine === 'failed' ? 'block' : 'none';
    note.innerHTML = OCR.engine === 'blocked'
      ? 'Так выглядит запрет WebAssembly на этой странице (предпросмотр в приложении). '
        + 'Модели уже сохранены — открывать заново не нужно. Скачайте файл и откройте в Chrome: '
        + 'там движок поднимется с теми же тремя файлами.'
      : '';
  }
  if ($('#dictState')) {
    const row = Words.ready
      ? (Words.ordered === false
        ? '⚠️ словарь: ' + Words.size.toLocaleString('ru-RU') + ' слов (' + (Words.source || 'свой файл')
          + '). Список не по убыванию частоты, поэтому правка слов выключена: слова не '
          + 'исправляются, но и верные не портятся. Чтобы правка работала, нужен словарь '
          + 'по частоте (как ru_250k).'
        : '✅ словарь: ' + Words.size.toLocaleString('ru-RU') + ' слов (' + (Words.source || 'вшит') + ')')
      : '❌ словарь не разжался — мусорные строки попадут в озвучку';
    $('#dictState').innerHTML = row;
  }
  $('#ortState').textContent = (typeof ort === 'undefined')
    ? 'onnxruntime-web не загрузился: нужна сеть при первом открытии файла.'
    : OCR.statusText() + (OCR.reason ? ' — ' + OCR.reason : '');
  renderNativeOcr().catch(() => {});
}

/**
 * Блок «Нативный движок» в шторке моделей.
 * Показывается только там, где есть мост `window.KomaOcr` (то есть в АПК):
 * в браузере считать модели нативно нечем, и кнопок-обманок там нет.
 */
async function renderNativeOcr() {
  const block = $('#nativeOcrBlock');
  if (!block) return;
  if (typeof NativeOcr === 'undefined' || !NativeOcr.present()) { block.style.display = 'none'; return; }
  block.style.display = 'block';
  const st = NativeOcr.status();
  const mb = (n) => n ? (n / 1048576).toFixed(1) + ' МБ' : 'нет';
  const mark = (ok) => (ok ? '✅' : '❌');
  const files = st.files || {};
  const embedded = !!st.embedded;
  // Модели встроены в сборку и раскладываются при первом запуске: пока они
  // копируются, честно пишем «готовлю», а не «модели не выбраны» — иначе
  // человек видит красные кресты на свежей установке и думает, что всё сломано.
  const seeding = embedded && !st.models;
  const rows = [];
  if (embedded) {
    rows.push('📦 модели вшиты в приложение — выбирать файлы не нужно');
  }
  rows.push(
    `${mark(st.models)} детектор: ${mb(files['det.onnx'])}`,
    `${mark(st.models)} распознаватель: ${mb(files['rec.onnx'])}`,
    `${mark(st.classes > 0)} азбука: ${st.classes ? (st.classes - 1) + ' символов' : 'нет'}`,
    seeding ? '⏳ раскладываю встроенные модели (первый запуск, пара секунд)'
      : (st.ready ? '✅ движок готов'
        : '❌ ' + (st.error || (embedded ? 'модели готовятся' : 'модели не выбраны'))),
    'считает: <b>' + (NativeOcr.chosen() === 'native' ? 'нативно (ONNX Runtime)' : 'WASM в странице') + '</b>'
      + (OCR.nativeNote ? '<br><span class="hint">последний раз нативный путь: ' + escapeHtml(OCR.nativeNote) + '</span>' : ''),
  );
  // Пока идёт раскладка — переспрашиваем, но не бесконечно.
  if (seeding) {
    if (renderNativeOcr.tries === undefined) renderNativeOcr.tries = 0;
    if (renderNativeOcr.tries < 20) {
      renderNativeOcr.tries++;
      setTimeout(() => { renderNativeOcr().catch(() => {}); }, 700);
    }
  } else {
    renderNativeOcr.tries = 0;
  }
  $('#nativeOcrState').innerHTML = rows.join('<br>');
  // Кнопки выбора движка показывают, что выбрано в правилах.
  const mode = (RULES && RULES.ocrEngine) || 'auto';
  const hot = (id) => { const b = $(id); if (b) b.classList.toggle('hot', b.dataset.ocr === mode); };
  hot('#btnEngineAuto'); hot('#btnEngineNative'); hot('#btnEngineWasm');
}
/**
 * Проверка движка на синтетической странице: гоняем ровно тот же путь, что и на
 * кадре, но на картинке, нарисованной кодом. Так видно, работает ли WASM, не
 * открывая главу. Если WASM запрещён политикой страницы (предпросмотр), здесь
 * это будет сказано прямо, а не «движок загружен, моделей нет».
 */
/**
 * Проверка голоса по нажатию: говорит тестовую фразу и возвращает отчёт о том,
 * что видит браузер. Нужна, потому что «молчит» — это три разные причины
 * (нет голосов в системе, браузер запретил озвучку, синтез не ответил).
 */
/**
 * ПОДРОБНАЯ ПРОВЕРКА СИНТЕЗА (для настроек и журнала).
 *
 * Отвечает на вопрос «почему молчит» числами, а не догадками:
 * приняла ли движок фразу, через сколько она началась, сколько длилась,
 * какая ошибка пришла, сколько голосов видит система, не стоит ли движок
 * на паузе. Всё это пишется в журнал.
 *
 * opts.silent — тихая проверка (громкость почти ноль, одно короткое слово):
 * так приложение греет синтез при запуске, не мешая человеку.
 */
async function ttsSelfTest(opts = {}) {
  const silent = !!opts.silent;
  const res = { ok: false, kind: '', voices: 0, started: false, ended: false, ms: 0, error: '', paused: false, text: '' };
  try {
    res.kind = VOICE.kind ? VOICE.kind() : 'нет';
    res.voices = (VOICE.voices && VOICE.voices().length) || 0;
    const sw = VOICE.synth ? VOICE.synth() : null;
    res.paused = !!(sw && sw.paused);
    if (!VOICE.available()) { res.error = 'синтеза речи в этой среде нет'; res.text = 'Синтеза речи нет'; return res; }
    if (res.paused && sw) { try { sw.resume(); } catch (e) { /* ignore */ } }
    const phrase = silent ? 'раз' : 'Проверка голоса. Раз, два, три.';
    const t0 = Date.now();
    const accepted = VOICE.speak(phrase, {
      lang: (TTS.voice && TTS.voice.lang) || 'ru-RU',
      rate: silent ? 1 : (TTS.rate || 1),
      volume: silent ? 0.02 : 1,
      voice: TTS.pickVoice ? TTS.pickVoice() : null,
      onstart: () => { res.started = true; res.startMs = Date.now() - t0; },
      onend: () => { res.ended = true; res.ms = Date.now() - t0; },
      onerror: (e) => { res.error = String((e && e.error) || e); res.ms = Date.now() - t0; },
    });
    if (!accepted) { res.error = res.error || 'движок не принял фразу'; }
    // ── ЧЕСТНОЕ ИЗМЕРЕНИЕ ────────────────────────────────────────────────
    // На Android Chrome события onstart/onend приходят НЕ ВСЕГДА, хотя звук
    // есть: человек слышал «Проверка голоса», а приложение писало «не
    // заговорил» (журнал 06.11, 18:02:56). Поэтому смотрим ещё и на состояние
    // самого движка: говорящий движок — факт, событие — только удобство.
    const wait = silent ? 2500 : 6000;
    const until = Date.now() + wait;
    let sawSpeaking = false, lastBusy = 0;
    while (Date.now() < until) {
      await sleep(100);
      try {
        const s2 = VOICE.synth();
        if (s2 && (s2.speaking || s2.pending)) {
          if (!res.started) { res.started = true; res.startMs = Date.now() - t0; }
          sawSpeaking = true; lastBusy = Date.now();
        } else if (sawSpeaking && !res.ended) {
          res.ended = true; res.ms = Date.now() - t0;
        }
      } catch (e) { /* ignore */ }
      if (res.error || res.ended) break;
    }
    if (sawSpeaking && !res.ended) { res.ended = true; res.ms = (lastBusy || Date.now()) - t0; }
    res.heard = sawSpeaking;
    res.ok = !!((res.started || sawSpeaking) && !res.error)
      && (!res.ended || res.ms > 120 || silent);
    res.text = [
      'движок: ' + res.kind,
      'голосов: ' + res.voices,
      (res.started || res.heard) ? ('старт ' + (res.startMs || 0) + ' мс') : 'не заговорил',
      res.ended ? ('длительность ' + res.ms + ' мс') : '',
      res.error ? ('ошибка: ' + res.error) : '',
      res.paused ? 'движок был на паузе — снял' : '',
    ].filter(Boolean).join(' · ');
  } catch (e) {
    res.error = String((e && e.message) || e);
    res.text = 'проверка не удалась: ' + res.error;
  }
  try { Journal.add('голос', (silent ? 'прогрев: ' : 'проверка TTS: ') + res.text, res); } catch (e) { /* ignore */ }
  return res;
}

async function selfTestVoice() {
  if (!VOICE.available()) {
    // Раньше здесь было «В этой среде вообще нет синтеза речи (speechSynthesis
    // undefined)» — и это единственное, что видел человек в АПК до 28.10.
    return 'Синтеза речи нет: ни Web Speech в этой среде, ни движка АПК KomaSpeech';
  }
  const avail = VOICE.voices();
  const chosen = TTS.pickVoice();
  const parts = [];
  parts.push('движок: ' + VOICE.kind());
  parts.push('голосов: ' + avail.length);
  parts.push('выбран: ' + (chosen ? chosen.name + ' [' + chosen.lang + ']' : 'системный по умолчанию (ru-RU)'));
  if (VOICE.native()) {
    const ready = VOICE.nativeReady();
    parts.push(ready ? 'Android TTS готов' : 'Android TTS не готов (нет данных движка)');
  }
  let started = false, err = '';
  const accepted = VOICE.speak('Проверка голоса. Раз, два, три.', {
    lang: (chosen && chosen.lang) || 'ru-RU',
    rate: TTS.rate || 1,
    voice: chosen,
    onstart: () => { started = true; },
    onerror: (e) => { err = (e && e.error) || 'unknown'; },
  });
  if (!accepted) {
    parts.push('движок не принял фразу');
    return parts.join(' · ');
  }
  await sleep(1500);
  parts.push(started ? 'синтез заговорил' : (err ? 'ошибка синтеза: ' + err : 'синтез не ответил за 1,5 с'));
  return parts.join(' · ');
}

async function selfTestEngine() {
  if (!OCR.ready) {
    const ok = await OCR.loadModels().catch(e => { OCR.engine = 'failed'; OCR.reason = String(e.message || e); return false; });
    if (!ok) { await renderModels(); toast(OCR.statusText() + (OCR.reason ? ': ' + OCR.reason : ''), 8000); return; }
  }
  try {
    // Тестовая «страница» рисуется НАСТОЯЩИМ canvas: у элемента нет свойства
    // .data (оно было только в Node-заглушке), из-за этого проверка падала с
    // «Cannot read properties of undefined (reading 'length')».
    const W = 600, H = 800;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#101010';
    for (let y = 120; y < 180; y += 2) ctx.fillRect(80, y, 440, 1);
    const boxes = await detectBoxes(c, DEFAULT_RULES.pageSide, RULES);
    toast(boxes.length
      ? 'Движок считает: детектор вернул ' + boxes.length + ' бокс(ов) на тестовой картинке'
      : 'Движок считает, но на тестовой картинке боксов 0 — проверьте модели', 7000);
    await renderModels();
  } catch (e) {
    toast('Движок не считает: ' + (e.message || e), 8000);
    OCR.engine = 'failed'; OCR.reason = String(e.message || e); await renderModels();
  }
}

/**
 * Принять любое количество выбранных файлов модели. Ключевое: шторку не
 * закрываем, разбираем по именам, показываем, чего ещё не хватает.
 */
async function storeModelFiles(files) {
  if (!files || !files.length) return;
  const saved = [];
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n === 'detection.onnx') { await DB.put('kv', { k: 'model:det', v: await f.arrayBuffer() }); saved.push('detection.onnx'); }
    else if (n === 'cyrillic.onnx') { await DB.put('kv', { k: 'model:rec', v: await f.arrayBuffer() }); saved.push('cyrillic.onnx'); }
    else if (n === 'cyrillic.txt') { await DB.put('kv', { k: 'model:dict', v: await f.text() }); saved.push('cyrillic.txt'); }
    // Второй распознаватель — по желанию. Имя файла принципиально другое,
    // чтобы его нельзя было принять за основной.
    else if (n === 'cyrillic2.onnx' || n === 'rec2.onnx' || n === 'line32.onnx'
             || n === 'best_r28_final.onnx' || n === 'best_finetuned_r4.onnx' || n === 'best_base_r3.onnx') {
      await DB.put('kv', { k: 'model:rec2', v: await f.arrayBuffer() });
      saved.push(f.name + ' (второй распознаватель)');
    }
    // Азбука второго распознавателя — отдельно от основного словаря:
    // перепутать нельзя, иначе основной распознаватель начнёт читать мусор.
    else if (n === 'charset.txt' || n === 'line32.txt') {
      await DB.put('kv', { k: 'model:rec2charset', v: await f.text() });
      saved.push(f.name + ' (азбука второго распознавателя)');
    }
  }
  if (!saved.length) {
    await renderModels();
    toast('Нужны файлы detection.onnx, cyrillic.onnx, cyrillic.txt — по именам. Выбрано: '
      + Array.from(files).map(f => f.name).join(', '), 6000);
    return;
  }
  await renderModels();
  const det = await DB.get('kv', 'model:det');
  const rec = await DB.get('kv', 'model:rec');
  const dict = await DB.get('kv', 'model:dict');
  const missing = [!det && 'detection.onnx', !rec && 'cyrillic.onnx', !dict && 'cyrillic.txt'].filter(Boolean);
  toast('Принято: ' + saved.join(', ') + (missing.length ? ' · ещё нужно: ' + missing.join(', ') : ''), 5000);
  if (!missing.length) {
    try {
      const ok = await OCR.loadModels();
      toast(ok ? 'Все три модели на месте, движок готов'
               : 'Модели сохранены. ' + OCR.statusText() + (OCR.reason ? ': ' + OCR.reason : ''), 9000);
    } catch (e) {
      OCR.engine = 'failed'; OCR.reason = String(e.message || e);
      toast('Движок не поднялся: ' + OCR.reason, 8000);
    }
    await renderModels();
    if (typeof selfCheck === 'function') await selfCheck();
  }
}

/* Совместимость: старый вход выбора моделей ведёт на общий разбор файлов,
   но НЕ через общий input библиотеки (из-за него выбор модели открывал читалку). */
async function pickModels() {
  const inp = document.getElementById('modelPick');
  if (inp) inp.click();
}

/* ─── прокрутка: ждём остановки ─── */
function watchScroll() {
  const strip = $('#strip');
  let t = null, raf = 0;
  // Человек тронул ленту пальцем — отдаём прокрутку ему, анимация чтения
  // уступает и не «догоняет» под пальцем.
  try {
    strip.addEventListener('touchstart', () => SMOOTH.stop(), { passive: true });
    strip.addEventListener('wheel', () => SMOOTH.stop(), { passive: true });
  } catch (e) { /* не критично */ }
  const busy = () => {
    Reader.scrollBusy = true;
    clearTimeout(t);
    t = setTimeout(async () => {
      Reader.scrollBusy = false;
      Reader.syncPage();
      onScrollSettled();
    }, Math.max(120, RULES.semiManualSettleMs));
  };
  const onScroll = () => {
    busy();
    // Страницу определяем НА КАЖДОМ кадре прокрутки, а не только когда
    // «успокоится»: иначе шапка и распознавание живут прошлой страницей.
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const before = Reader.page;
      Reader.syncPage();
      if (Reader.page !== before) {
        Reader.ensureLoaded(Reader.page);
        Reader.ensureLoaded(Reader.page + 1);
      }
    });
  };
  strip.addEventListener('scroll', onScroll, { passive: true });
  // В части браузеров scrollend есть — используем как точку «остановились».
  if ('onscrollend' in strip) strip.addEventListener('scrollend', () => Reader.syncPage(), { passive: true });
  window.addEventListener('resize', () => Reader.syncPage());
  window.addEventListener('orientationchange', () => setTimeout(() => Reader.syncPage(), 300));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => Reader.syncPage());
  $('#paged').addEventListener('scroll', (e) => {
    if (e.target.classList && e.target.classList.contains('pagebox')) busy();
  }, true);
  $('#paged').addEventListener('touchmove', () => busy(), { passive: true });
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('reader').classList.contains('on')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') turnPage(1);
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') turnPage(-1);
  });
}
/**
 * Собрать реплики страницы из полос без дублей.
 *
 * Полосы перекрываются (запас нужен детектору), поэтому одно и то же облачко
 * попадало в две-три полосы и реплика повторялась — на скриншоте 11:26 было
 * 11 реплик там, где в оригинале 5. Правило: полоса, распознанная позже,
 * вытесняет всё, что раньше попало в её вертикальный диапазон; одинаковый
 * текст с пересечением по вертикали тоже считается дублем.
 */
/**
 * Одна реплика, прочитанная дважды подряд.
 *
 * В облачке «Мы Просто ВыПол- / нили свою работу.» чтец вернул строку дважды:
 * «Мы ПросТО ВыПол МЫ ПРОСТО ВЫПИЛ НИЛИ СВОЮ РАБОТУ» — и голос читал это
 * целиком (проверка 06.11, 18:22:06). Тексты не совпадают дословно, поэтому
 * ни сравнение строк, ни проверка «короткое входит в длинное» (жáдный проход
 * букв) этого не ловили: «явыпол» и «выпил» расходятся на второй букве.
 *
 * Правило: если начало реплики (2–6 слов) почти дословно повторяется чуть
 * дальше в ней же, и то, что останется после повтора, не короче выброшенного,
 * — оставляем полное чтение, а черновое начало выбрасываем. Сравнение слов
 * мягкое (регистр, одна лишняя/потерянная буква, обрезанный хвост).
 */
/**
 * Насколько текст реплики похож на настоящую речь (для выбора из двух чтений).
 * Считаем слова, которые знает словарь, и штрафуем мусорные вставки: «-ЩЕ»,
 * «БОЛЬ: ШОЕ» хуже, чем «ЕЩЕ» и «БОЛЬШОЕ».
 */
/** Склеить перенос по слогам, если целое слово знает словарь. */
function dehyphenText(t) {
  return String(t || '').replace(/(\p{L}{2,})[-–—](\p{L}{1,})/gu, (m, a, b) => {
    const cat = a + b;
    let known = false;
    try { known = !!(typeof Words !== 'undefined' && Words.isKnown && Words.isKnown(cat.toLowerCase())); } catch (e) { known = false; }
    return known ? cat : m;
  });
}

/** Сколько слов текста знает словарь (для сравнения двух чтений). */
function knownCount(t) {
  const words = String(t || '').split(/[^\p{L}\p{N}-]+/u).filter(w => w.length >= 2);
  let n = 0;
  for (const w of words) {
    try { if (typeof Words !== 'undefined' && Words.isKnown && Words.isKnown(w.toLowerCase().replace(/-/g, ''))) n++; } catch (e) { /* нет словаря */ }
  }
  return n;
}

/** Новое чтение лучше прежнего? Осторожно: заменяем только при явном выигрыше. */
function textBetter(newT, oldT) {
  if (!newT) return false;
  if (newT === oldT) return true;
  const lettersOld = String(oldT || '').replace(/[^\p{L}]/gu, '').length;
  const lettersNew = String(newT || '').replace(/[^\p{L}]/gu, '').length;
  if (!lettersOld) return lettersNew > 0;
  // Короткую реплику («Ты», «АХ») не раздуваем в мусор: не больше чем вдвое.
  if (lettersOld < 6 && lettersNew > lettersOld * 2) return false;
  const kOld = knownCount(oldT), kNew = knownCount(newT);
  if (kNew < kOld) return false;                       // потеряли словарное слово — нет
  if (kNew > kOld) return true;
  return textScore(newT) > textScore(oldT) + 0.1;      // при равных словах — чуть чище
}

function textScore(t) {
  const s = String(t || '');
  // Дефис — РАЗДЕЛИТЕЛЬ: «ХА-А» — это «ха» + «а», и такое чтение ценнее
  // обрубка «А-А» (стенд 06.11: кроп терял первую букву, а оценка этого не
  // видела, потому что «ха-а» целиком в словаре, конечно, нет).
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return -1e9;
  // Оценка ВЗВЕШЕНА ПО ДЛИНЕ СЛОВА. Прежняя (по слову «+3 за словарное»)
  // сравнивала несравнимое: чтение «ИН» из двух букв получало 5 и обыгрывало
  // полное «Ноя не жалуюсь на урезание расходов» — стенд 06.11 это поймал,
  // и в ручное распознавание попадал мусор из двух букв.
  let score = 0;
  for (const w of words) {
    const low = w.toLowerCase().replace(/-/g, '');
    if (low.length < 2) { score -= 0.5; continue; }
    let known = false, rank;
    try {
      known = !!(typeof Words !== 'undefined' && Words.isKnown && Words.isKnown(low));
      rank = (typeof Words !== 'undefined' && Words.rank) ? Words.rank.get(low) : undefined;
    } catch (e) { known = false; }
    if (known) {
      // Словарное слово: тем ценнее, чем оно длиннее и чем чаще встречается.
      score += low.length + (rank === undefined ? 0 : 0.4 * Math.max(0, 1 - rank / 20000));
    } else if (low.length >= 14) {
      score -= 1.4 * low.length;     // слипшаяся фраза («туланаследника», «Ноянежалуюсь»)
    } else if (low.length >= 9) {
      score -= 0.8 * low.length;     // длинное незнакомое — скорее мусор
    } else {
      score += 0.25 * low.length;    // имя, звук, редкое слово — это норма
    }
  }
  // Мусор внутри слова (двоеточия, чёрточки посреди капса) — минус.
  score -= (s.match(/[\p{L}][:;|_/\\][\p{L}]/gu) || []).length * 2;
  return score;
}

function dedupeRepeatText(text) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  const words = src.split(' ');
  const n = words.length;
  if (n < 4) return src;
  // Кириллица и латиница в одном слове — обычное дело у чтеца («HE» вместо
  // «НЕ»). Для сравнения повторов буквы схлопываем к кириллице: иначе
  // «АХ, HE АХ, НЕ ОТВЕТИЛА В LINE» не считалось повтором и читалось целиком.
  const LOOK = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о',
    p: 'р', t: 'т', x: 'х', y: 'у', u: 'и', '0': 'о', '3': 'з' };
  const letters = (w) => String(w || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/[a-z0-9]/g, (ch) => LOOK[ch] || ch);
  const dist1 = (a, b) => {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a.length >= 4 && (b.startsWith(a) || a.startsWith(b))) return true;
    if (Math.min(a.length, b.length) < 5) return false;
    let i = 0, j = 0, diff = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    return diff + (a.length - i) + (b.length - j) <= 1;
  };
  for (let k = Math.min(6, Math.floor(n / 2)); k >= 2; k--) {
    for (let p = k; p + k <= n && p <= k + 3; p++) {
      let ok = 0;
      for (let t = 0; t < k; t++) {
        const a = letters(words[t]), b = letters(words[p + t]);
        if (a.length < 2 || b.length < 2) break;
        if (!dist1(a, b)) break;
        ok++;
      }
      if (ok < k) continue;
      const head = words.slice(0, p).join(' ').replace(/[^\p{L}\p{N}]/gu, '');
      const tail = words.slice(p).join(' ').replace(/[^\p{L}\p{N}]/gu, '');
      if (tail.length < head.length) continue;      // полное чтение — в начале, не трогаем
      return words.slice(p).join(' ');
    }
  }
  return src;
}

/**
 * Старые реплики полосы + новые с той же полосы = ничего не теряем.
 *
 * Повторный проход не обязан найти всё, что нашёл первый: кадр мог уехать,
 * детектор — недосмотреть, дочитывание — отдать часть строк. Раньше результат
 * нового прохода ЗАМЕНЯЛ прежний, и уже распознанный текст исчезал у человека
 * на глазах («теряется на последнем проходе»). Здесь объединение: реплика
 * нового прохода вытесняет старую только на том же месте и только если
 * прочитана не хуже.
 */
function keepOldLines(prev, fresh) {
  const list = Array.isArray(prev) ? prev : [];
  const out = (Array.isArray(fresh) ? fresh : []).slice();
  if (!list.length) return out;
  const near = (a, b) => {
    const ha = Math.max(1e-6, a.bottom - a.top), hb = Math.max(1e-6, b.bottom - b.top);
    const wa = Math.max(1e-6, a.right - a.left), wb = Math.max(1e-6, b.right - b.left);
    const ov = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const oh = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    return ov > Math.min(ha, hb) * 0.35 && oh > Math.min(wa, wb) * 0.3;
  };
  for (const o of list) {
    const i = out.findIndex(n => near(o, n));
    if (i < 0) { out.push(o); continue; }
    const scoreNew = textScore(out[i].text);
    const scoreOld = textScore(o.text);
    if (scoreOld > scoreNew + 0.01) out[i] = o;      // прежнее чтение лучше
  }
  return out.sort((a, b) => (a.top - b.top) || (a.left - b.left));
}

function mergeBandLines(parts, canvas) {
  const H = (canvas && canvas.height) || 1;
  const out = [];
  const keyOf = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const overlapV = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  for (const part of parts) {
    for (const ln of part.lines) {
      const k = keyOf(ln.text);
      const h = Math.max(1e-6, ln.bottom - ln.top);
      // Тот же текст в том же месте — дубль от перекрытия полос.
      //
      // «В том же месте» — это И по вертикали, И по горизонтали. Раньше здесь
      // хватало вертикали, и два одинаковых облачка на одной высоте («ТЫ
      // ВИДИШЬ МЕНЯ?» слева и справа, страница Mieruko-chan) считались одним:
      // одна реплика молча пропадала (5 из 6 вместо 6 из 6, замер 04.11).
      const overlapHdup = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (k && out.some(o => {
        if (keyOf(o.text) !== k) return false;
        if (overlapV(o, ln) <= h * 0.2) return false;
        const ow = Math.max(1e-6, o.right - o.left);
        const w = Math.max(1e-6, ln.right - ln.left);
        return overlapHdup(o, ln) > Math.min(ow, w) * 0.4;
      })) continue;
      // Разный текст на одном месте: оставляем тот, что осмысленнее. Ничего не
      // выбрасываем «по диапазону полосы» — так терялись реплики, которые
      // соседняя полоса просто не распознала.
      // «Одно и то же место» — это совпадение И по вертикали, И по горизонтали.
      // Раньше хватало вертикали, и две реплики на одной высоте (две колонки
      // газеты; два облачка рядом в манге) считались дублем друг друга: одна
      // молча выбрасывалась. Замер 28.10 на странице-прозе: 58 распознанных
      // строк → 2 реплики, потому что правая и левая колонки «перекрывались».
      const overlapH = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const same = out.findIndex(o => {
        const oh = Math.max(1e-6, o.bottom - o.top);
        const ow = Math.max(1e-6, o.right - o.left);
        const w = Math.max(1e-6, ln.right - ln.left);
        return overlapV(o, ln) > Math.min(h, oh) * 0.6
          && overlapH(o, ln) > Math.min(w, ow) * 0.5;
      });
      if (same >= 0) {
        const q1 = qualityOf([out[same].text]) + Math.min(ln.text.length, 60) * 0.3;
        const q2 = qualityOf([ln.text]) + Math.min(ln.text.length, 60) * 0.3;
        if (q2 > q1) out[same] = ln;
        continue;
      }
      // Тот же пузырь, прочитанный ДВАЖДЫ и по-разному: одна полоса поймала
      // его целиком, другая — обрезанным краем экрана, и в реплике звучало
      // «Мы ПросТО ВыПол МЫ ПРОСТО ВЫПИЛ НИЛИ СВОЮ РАБОТУ» (проверка 06.11 на
      // странице с двумя облачками). Тексты не совпадают дословно, поэтому
      // прежние проверки их не ловили. Правило: если буквы одной реплики
      // почти целиком (80 %) входят в другую В ТОМ ЖЕ ПОРЯДКЕ и рамки стоят
      // друг на друге — это один пузырь, оставляем длинное чтение.
      const lettersOfText = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const subRatio = (a, b) => {
        if (!a || !b) return 0;
        let i = 0;
        for (let j = 0; j < b.length && i < a.length; j++) if (a[i] === b[j]) i++;
        return i / a.length;
      };
      const partial = out.findIndex(o => {
        const oh = Math.max(1e-6, o.bottom - o.top);
        const ow = Math.max(1e-6, o.right - o.left);
        const w = Math.max(1e-6, ln.right - ln.left);
        if (overlapHdup(o, ln) <= Math.min(ow, w) * 0.4) return false;
        if (overlapV(o, ln) <= Math.min(h, oh) * 0.4) return false;
        const a = lettersOfText(ln.text), b = lettersOfText(o.text);
        const la = a.length, lb = b.length;
        if (la < 4 || lb < 4) return false;
        if (Math.max(la, lb) < Math.min(la, lb) * 1.25) return false;   // длины похожи — это разные реплики
        const short = la < lb ? a : b, long = la < lb ? b : a;
        return subRatio(short, long) > 0.8;
      });
      if (partial >= 0) {
        const cur = out[partial];
        if (lettersOfText(ln.text).length > lettersOfText(cur.text).length) out[partial] = ln;
        continue;
      }
      out.push(ln);
    }
  }
  // Обрезанная реплика рядом с полной.
  //
  // Полоса — это то, что попало в экран. Если облачко выше экрана, полоса
  // распознаёт только его нижнюю часть: «СКРЫВАЕШЬ ОТ МЕНЯ ВСЁ ЭТО ВРЕМЯ?…»
  // вместо «ТЫ ДУМАЕШЬ Я НЕ ЗНАЛ О ТОМ ЧТО ТЫ СКРЫВАЕШЬ…». Соседняя полоса при
  // этом даёт ЦЕЛУЮ реплику. Совпадением текста такие две не считались (тексты
  // разные), по координатам тоже не совпадали — и в очереди чтения оказывались
  // обе: сначала обрезок, потом целая (живой прогон в эмуляторе Aether Q,
  // 04.11). Для человека это дефект: одну реплику порезали на две.
  //
  // Правило: если текст одной реплики ЦЕЛИКОМ входит в текст другой (и это не
  // короткое «ДА!», а хотя бы 12 знаков и не меньше трети целой), то короткая —
  // обрезок той же реплики, если она стоит там же по вертикали (полосы
  // перекрываются) либо целиком лежит внутри вертикального охвата целой.
  const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const nearV = (a, b) => {
    const ha = Math.max(1e-6, a.bottom - a.top), hb = Math.max(1e-6, b.bottom - b.top);
    return overlapV(a, b) + Math.min(ha, hb) * 0.75 > 0;
  };
  const overlapH = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const samePlace = (a, b) => {
    if (!nearV(a, b)) return false;
    const wa = Math.max(1e-6, a.right - a.left), wb = Math.max(1e-6, b.right - b.left);
    return overlapH(a, b) > Math.min(wa, wb) * 0.4;
  };
  const keep = out.filter((a) => !out.some((b) => {
    if (a === b) return false;
    const na = norm(a.text), nb = norm(b.text);
    if (!na || !nb || na === nb) return false;
    // Совсем короткое («ДА!», «НЕТ») не трогаем: это может быть своя реплика.
    if (na.length < 6) return false;
    if (!nb.includes(na)) return false;
    // Обрезок стоит в том же облачке: рядом по вертикали И по горизонтали.
    return samePlace(a, b);
  }));
  const dropped = out.length - keep.length;
  if (dropped > 0 && typeof OCR === 'object' && OCR) OCR.cutReplicas = dropped;

  // Порядок чтения: сверху вниз, а внутри строки — справа налево для манги.
  // Раньше здесь был простой `sort((a,b) => a.top - b.top)`, и он убивал
  // порядок: две реплики на одной высоте (или с разницей в 1–2 ‰) вставали по
  // левому краю, то есть для манги наоборот. Живой прогон 29.10: в нижней панели
  // «ОНА ВСЁ ЕЩЁ ШЕПЧЕТ» (справа) читалась ПОСЛЕДНЕЙ вместо первой.
  const rtl = (typeof Reader !== 'undefined' ? Reader.dir : 'rtl') !== 'ltr';
  return orderBubbles(keep, rtl);
}

async function onScrollSettled() {
  if (!$('#reader').classList.contains('on')) return;
  const i = Reader.page;
  await Reader.ensureLoaded(i);
  // Распознаём видимую полосу, если она ещё не распознана (вебтун: страница
  // длиннее экрана, полосы идут по мере прокрутки).
  if (OCR.ready && !State.scanning && RULES.autoScan) {
    const band = Reader.visibleBandPx(i);
    // «Уже распознана» — по покрытию области, а не по совпадению строкового
    // ключа: границы полосы прилипают к пустому месту и при каждом сдвиге
    // дают новый ключ, из-за чего один и тот же кадр распознавался по кругу.
    const done = Reader.bandCoveredPx(i, band);
    if (!done) await Reader.scanPage(i, { tag: 'прокрутка' });
  }
  if (RULES.semiManual && State.semi) {
    if (State.waitingScroll) {
      // человек прокрутил — читаем то, что видно
      State.waitingScroll = false; hideArrow();
      await sleep(RULES.semiManualSettleMs);
      if (!Reader.scrollBusy) TTS.readVisible();
    }
  }
}
function turnPage(dir) {
  const next = clamp(Reader.page + dir, 0, Reader.pages.length - 1);
  // Новая страница в кадре → сразу распознаём именно её видимую часть.
  // Иначе после листания человек видел прошлый текст, пока не тронет экран.
  setTimeout(() => { try { onScrollSettled(); } catch (e) {} }, 350);
  if (Reader.mode === 'vertical') {
    const wrap = document.querySelector(`.pagewrap[data-page="${next}"]`);
    if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    document.querySelectorAll('.pagebox').forEach(b => b.classList.toggle('on', +b.dataset.page === next));
    Reader.page = next; Reader.syncSub(); Reader.ensureLoaded(next); Reader.afterPageReady(); Reader.saveProgress();
  }
}
