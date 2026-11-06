
/* ───────────────────────── 12. Привязка событий ───────────────────────── */
/**
 * Что браузер умеет на самом деле. В вебе нет Android SAF — его нельзя
 * вызвать из страницы. Ближайшее: File System Access API (Chrome Android 132+,
 * Chrome/Edge на десктопе) и старый input[webkitdirectory] (только десктоп).
 * Ниже — честный ответ на вопрос «почему нет кнопки "выбрать папку"».
 */
const FILES = (() => {
  const ua = navigator.userAgent || '';
  const m = ua.match(/Chrome\/(\d+)/);
  const chromium = m ? +m[1] : 0;
  const android = /Android/i.test(ua);
  const fsa = typeof window.showDirectoryPicker === 'function';
  const dirInput = 'webkitdirectory' in document.createElement('input');
  const secure = window.isSecureContext !== false;
  let why = '';
  if (fsa) why = 'выбор папки доступен (File System Access)';
  else if (android) {
    why = 'выбор папки в этом браузере недоступен: Android-браузеры отдают только файлы';
    if (chromium && chromium < 132) why += ` (у вас Chrome ${chromium}, папка появится с 132)`;
  } else if (dirInput) why = 'выбор папки доступен (input webkitdirectory)';
  else why = 'выбор папки недоступен: браузер его не поддерживает';
  if (!secure) why += ' · страница не в защищённом контексте';
  return { fsa, dirInput, android, chromium, secure, why };
})();

function bindUI() {
  // ── Шторки: крестик в шапке и закрытие по подложке ──
  // Раньше «Закрыть» была только в самом низу: на телефоне шторка выше экрана,
  // и до кнопки надо было долистать. Плюс часть шторок закрывалась только ею.
  $$('.sheet').forEach(sh => {
    const head = sh.querySelector('.head');
    if (head && !head.querySelector('.x')) {
      const x = document.createElement('button');
      x.className = 'x'; x.type = 'button'; x.setAttribute('aria-label', 'Закрыть');
      x.textContent = '✕';
      x.onclick = () => closeSheets();
      head.appendChild(x);
    }
  });
  const bg = $('#sheetBg');
  if (bg) bg.onclick = () => closeSheets();
  // закрытие свайпом вниз по шапке — привычный жест
  $$('.sheet .head').forEach(head => {
    let y0 = null;
    head.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    head.addEventListener('touchend', (e) => {
      if (y0 != null && e.changedTouches[0].clientY - y0 > 60) closeSheets();
      y0 = null;
    }, { passive: true });
  });

  // ── Импорт главы ────────────────────────────────────────────────────────
  // Каждый выбор — свой input: общий переиспользовался, и выбор модели
  // запускал импорт библиотеки («выбрал onnx — и меня выбросило в читалку»).
  const imgInput = $('#imgPick');
  const dirInput = $('#dirPick');
  const modelInput = $('#modelPick');
  const modelDirInput = $('#modelDirPick');
  const rulesInput = $('#rulesPick');

  $('#btnImport').onclick = () => {
    const fsOK = FILES.fsa;
    const dirOK = FILES.dirInput;
    // Кнопки не прячем: видно, что они есть и почему не работают.
    $('#btnPickDir').style.display = 'block';
    $('#btnPickDir').disabled = !dirOK;
    $('#btnPickDir').style.opacity = dirOK ? '1' : '.45';
    $('#btnPickFolderModern').style.display = 'block';
    $('#btnPickFolderModern').disabled = !fsOK;
    $('#btnPickFolderModern').style.opacity = fsOK ? '1' : '.45';
    $('#importCaps').textContent = 'Ваш браузер: ' + FILES.why;
    // Куда добавлять: список существующих глав
    const sel = $('#importTarget');
    // Как в Yomikai: файлы добавляются главой в серию, а не отдельной книгой.
    const series = Library.series || [];
    sel.innerHTML = '<option value="">Новая серия</option>'
      + series.map(s => {
        const n = Library.chaptersOf(s.id).length;
        return `<option value="${s.id}">Глава в «${escapeHtml(s.title)}» (${n} гл.)</option>`;
      }).join('');
    $('#importNote').innerHTML = dirOK || fsOK
      ? 'Папка: страницы берутся все сразу, порядок — по именам файлов.'
      : 'Этот браузер не умеет выбирать папку. Нажмите «Выбрать файлы или CBZ» '
        + 'и отметьте сразу все страницы главы — порядок возьмём из имён.';
    $('#importTip').innerHTML = 'Подойдёт: папка с главой · CBZ/ZIP · просто набор картинок.<br>'
      + (ENV.android
        ? 'На Android папку браузер не отдаёт: в файловом менеджере удерживайте первую '
          + 'страницу, затем последнюю — выберутся все, порядок возьмём из имён.'
        : 'На десктопе проще всего выбрать папку целиком.');
    openSheet('sheetImport');
  };

  async function addImages(files) {
    const target = ($('#importTarget') && $('#importTarget').value) || '';
    const imgs = Array.from(files).filter(f => /\.(jpe?g|png|webp|avif|bmp|gif)$/i.test(f.name));
    if (!imgs.length) { toast('Среди выбранных файлов нет картинок'); return; }
    // Одна книга на главу: имя папки, если оно есть, иначе имя файла/общий заголовок.
    const rel = (f) => f.webkitRelativePath || f.name;
    const folders = new Set(imgs.map(f => (f.webkitRelativePath || '').split('/')[0]).filter(Boolean));
    imgs.sort((a, b) => rel(a).localeCompare(rel(b), undefined, { numeric: true }));
    const title = folders.size === 1 ? Array.from(folders)[0]
      : imgs.length === 1 ? imgs[0].name.replace(/\.[^.]+$/, '')
      : 'Глава из ' + imgs.length + ' страниц';
    toast('Сохраняю ' + imgs.length + ' страниц…', 5000);
    const items = imgs.map(f => ({ name: f.name, blob: f }));
    if (target) {
      // В выбранную серию — новая глава (страницы не подмешиваются в старую).
      const chapter = await Library.addChapter(target, title, items, 'files');
      await Library.load();
      const s = Library.series.find(x => x.id === target);
      toast('Глава добавлена в «' + (s ? s.title : '') + '»: ' + title + ' (' + imgs.length + ' стр.)');
      return;
    }
    const chapter = await Library.addBook(title, items, 'files');
    await Library.load();
    toast('Новая серия: ' + seriesTitleOf(title) + ' · глава «' + chapter.title + '» (' + imgs.length + ' стр.)');
  }

  $('#btnPickDir').onclick = () => {
    if (!FILES.dirInput) {
      toast('Этот браузер не умеет выбирать папку — ' + FILES.why + '. Выберите файлы или CBZ.', 7000);
      return;
    }
    dirInput.click();
  };
  $('#btnPickFolderModern').onclick = async () => {
    if (!FILES.fsa) {
      toast('Выбор папки недоступен: ' + FILES.why
        + '. Обновите Chrome до 132+ или соберите страницы в CBZ.', 7000);
      return;
    }
    try {
      const handle = await window.showDirectoryPicker();
      const files = [];
      for await (const entry of handle.values()) {
        if (entry.kind !== 'file') continue;
        files.push(await entry.getFile());
      }
      closeSheets();
      await addImages(files);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Папка не открылась: ' + (e.message || e) + ' — выбирайте файлами', 5000);
      imgInput.click();
    }
  };
  $('#btnPickFiles').onclick = () => imgInput.click();

  dirInput.addEventListener('change', async () => {
    const files = Array.from(dirInput.files || []);
    dirInput.value = '';
    if (!files.length) return;
    closeSheets();
    try { await addImages(files); }
    catch (e) { toast('Не удалось добавить папку: ' + (e.message || e), 5000); }
  });
  imgInput.addEventListener('change', async () => {
    const files = Array.from(imgInput.files || []);
    imgInput.value = '';
    if (!files.length) return;
    closeSheets();
    try {
      const zips = files.filter(f => /\.(cbz|zip)$/i.test(f.name));
      for (const z of zips) await importZip(z);
      const rest = files.filter(f => !/\.(cbz|zip)$/i.test(f.name));
      if (rest.length) await addImages(rest);
    } catch (e) { toast('Импорт не удался: ' + (e.message || e), 5000); }
  });
  $('#closeImport').onclick = closeSheets;

  $('#btnModels').onclick = () => { openSheet('sheetModels'); renderModels(); };

  $('#btnRulesLib').onclick = () => { openSheet('sheetRules'); renderRulesInfo(); renderBufferSheet(); };
  // Полка фильтров библиотеки (Все / Читаю / Не начато) — 1.9.69.
  if (typeof bindLibChips === 'function') bindLibChips();
  $$('#closeSheets,#closeSheets2,#closeSheets3,#closeSheets4,#closeSheets5').forEach(b => b.onclick = closeSheets);

  // Кнопка «Проверить движок» была в разметке, но НИ К ЧЕМУ не привязана:
  // нажатие не делало ничего. Теперь она запускает синтетическую страницу и
  // показывает работу: «Проверяю…» → результат.
  if ($('#btnTestVoice')) {
    const b = $('#btnTestVoice');
    b.onclick = async (e) => {
      const el2 = e.currentTarget;
      if (el2.disabled) return;
      const label = el2.textContent || 'Проверить голос';
      el2.disabled = true; el2.textContent = 'Говорю…';
      try {
        // Проговариваем и показываем отчёт: какая из трёх причин молчания.
        const report = await selfTestVoice();
        toast(report, 9000);
      } finally {
        el2.disabled = false; el2.textContent = label;
      }
    };
  }

  const btnTest = $('#btnTestEngine');
  if (btnTest) btnTest.onclick = async (e) => {
    const b = e.currentTarget;
    if (b.disabled) return;
    const label = b.textContent || 'Проверить движок';
    b.disabled = true; b.textContent = 'Проверяю…';
    try { await selfTestEngine(); }
    finally { b.disabled = false; b.textContent = label; }
  };
  $('#btnPickModels').onclick = () => modelInput.click();
  // Осознанный выбор в шторке текста: распознать ВСЮ страницу, а не только
  // видимую полосу (у вебтуна полос много, автопрокрутка идёт по экрану).
  if ($('#btnFullPage')) {
    const b = $('#btnFullPage');
    b.onclick = async () => {
      const i = Reader.page;
      b.disabled = true;
      try {
        await Reader.scanPage(i, { force: true, keepSheet: true, full: true, tag: 'вся страница' });
        renderTextSheet(i);
      } finally {
        b.disabled = false;
      }
    };
  }
  // Словарь — отдельным выбором: его берут из того же APK (assets/koma/dict).
  $('#btnPickDict').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.txt,text/plain';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (!/250k|ru_|russian|dict|словар/i.test(f.name) && f.size < 100000) {
        const ok = true; void ok;
      }
      toast('Читаю словарь…', 4000);
      const text = await f.text();
      const count = text.split('\n').filter(l => l.trim()).length;
      if (count < 1000) { toast('Это не словарь: ' + count + ' строк', 6000); return; }
      await DB.put('kv', { k: 'dict:ru250k', v: text });
      const ok = await Words.load();
      await renderModels();
      toast(ok ? 'Словарь загружен: ' + Words.size + ' слов' : 'Словарь не разобрался', 5000);
    };
    inp.click();
  };
  $('#btnPickModelDir').onclick = () => {
    if (!('webkitdirectory' in document.createElement('input'))) {
      toast('Папку браузер не выберет — выберите три файла сразу', 4000);
      modelInput.click();
      return;
    }
    modelDirInput.click();
  };
  modelInput.addEventListener('change', async () => {
    const files = Array.from(modelInput.files || []);
    modelInput.value = '';
    try { await storeModelFiles(files); }
    catch (e) { toast('Модель не принялась: ' + (e.message || e), 5000); }
  });
  modelDirInput.addEventListener('change', async () => {
    const files = Array.from(modelDirInput.files || []);
    modelDirInput.value = '';
    try { await storeModelFiles(files); }
    catch (e) { toast('Модели из папки не принялись: ' + (e.message || e), 5000); }
  });
  // Случайно стереть 12 МБ моделей одним касанием не даём.
  let armedClear = false, armTimer = null;
  $('#btnClearModels').onclick = async (e) => {
    const b = e.currentTarget;
    if (!armedClear) {
      armedClear = true; b.textContent = 'Точно убрать?';
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armedClear = false; b.textContent = 'Убрать модели'; }, 3000);
      return;
    }
    clearTimeout(armTimer); armedClear = false; b.textContent = 'Убрать модели';
    for (const k of ['model:det', 'model:rec', 'model:dict', 'model:rec2', 'model:rec2charset']) await DB.del('kv', k);
    OCR.ready = false; OCR.det = OCR.rec = OCR.rec2 = null; OCR.engine = 'idle';
    await renderModels();
    toast('Модели убраны. Словарь вшит в файл — его трогать не нужно', 5000);
  };

  // правила
  // ── Блок «Приложение (АПК)»: обновление читалки и проверка нативного Lens ──
  // Кнопки есть в разметке всегда, обработчики — тоже: «мёртвых» кнопок в сборке
  // не остаётся. Но сам блок виден только при живом мосте KomaApp, то есть
  // только внутри АПК: в браузере обновлять и перезагружать нечего, и вместо
  // пустых обещаний там просто нет этого блока.
  const appReady = () => (typeof window !== 'undefined' && window.KomaApp
    && typeof window.KomaApp.version === 'function');
  const syncAppBlock = () => {
    const block = $('#appBlock');
    if (!block) return;
    if (!appReady()) { block.style.display = 'none'; return; }
    block.style.display = 'block';
    try {
      const info = JSON.parse(window.KomaApp.version() || '{}');
      $('#appState').innerHTML = 'Оболочка: <b>' + (info.app || '—') + '</b> · читалка: <b>'
        + (info.page || '—') + '</b><br><span class="hint">Обновление качает koma-web.html из '
        + 'из единственного релиза на GitHub и перезагружает страницу. Модели, книги и настройки остаются '
        + 'на месте, а новая версия приложения (АПК) ставится поверх старой — удалять ничего не нужно.</span>';
    } catch (e) { console.warn('KomaApp.version', e); }
  };
  if ($('#btnAppUpdate')) $('#btnAppUpdate').onclick = () => {
    if (!appReady()) { toast('Обновление есть только в приложении: в браузере страница не обновляется сама', 7000); return; }
    // Обновление асинхронное: мост считает в своём потоке и присылает сообщения
    // в window.__komaAppEvent. Поэтому первое, что видит человек, — «Проверяю…»
    // сразу по нажатию, а дальше каждый шаг. Раньше кнопка молчала: синхронный
    // вызов держал поток JS всё время проверки и скачивания.
    const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let settled = false;
    const finish = (json) => {
      if (settled) return;
      settled = true;
      let res = {};
      try { res = JSON.parse(json || '{}'); } catch (e) { res = { updated: false, reason: String(json) }; }
      if (res.updated) toast('Обновлено до ' + res.version + ' — перезагружаю…', 5000);
      else if (res.ok && res.reason) toast(String(res.reason), 6000);
      else if (res.reason) toast(String(res.reason).startsWith('уже свежая')
        ? 'Обновлений нет: ' + res.reason
        : 'Обновление не удалось: ' + res.reason, 7000);
      else toast('Обновление: без ответа', 6000);
      // Если оболочка старая и перезагрузку не сделает — сделаем сами.
      if (res.updated && (!window.KomaApp.reloadNow || res.reload === false)) {
        setTimeout(() => { try { window.KomaApp.reloadNow('обновление'); } catch (e) {} }, 1600);
      }
    };
    window.__komaAppEvent = (eid, type, data) => {
      if (eid !== id) return;
      if (type === 'state') { toast(data, 5000); return; }
      if (type === 'done') finish(data);
    };
    toast('Проверяю обновление…', 4000);
    try {
      const ret = window.KomaApp.checkUpdate(id);
      // Старая оболочка отвечала синхронно строкой JSON — поддерживаем и её.
      if (typeof ret === 'string' && ret) finish(ret);
    } catch (e) {
      finish(JSON.stringify({ updated: false, reason: String((e && e.message) || e) }));
    }
    // Страховка: мост мог умереть молча — тогда через 3 минуты скажем прямо.
    setTimeout(() => finish(JSON.stringify({ updated: false, reason: 'мост обновления не ответил' })), 180000);
  };
  if (appReady()) {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      // Оболочка сообщает версию событием после загрузки страницы.
      document.addEventListener('koma-app', syncAppBlock);
    }
    if (typeof setTimeout === 'function') setTimeout(syncAppBlock, 0);
  }

  // ── Нативное распознавание (только в АПК) ────────────────────────────────
  // Кнопки есть в разметке всегда, обработчики ставятся всегда — «мёртвых»
  // кнопок в сборке не остаётся; в браузере они честно говорят, что нативно
  // считать нечем.
  if ($('#btnNativePick')) $('#btnNativePick').onclick = () => {
    if (typeof NativeOcr === 'undefined' || !NativeOcr.present()) {
      toast('Нативные модели есть только в приложении', 7000); return;
    }
    toast('Выберите два файла .onnx (детектор и распознаватель) и азбуку .txt', 8000);
    try { window.KomaOcr.pickModels(); } catch (e) { toast('Выбор файлов не открылся: ' + ((e && e.message) || e), 7000); }
  };
  if ($('#btnNativeTest')) $('#btnNativeTest').onclick = () => {
    if (typeof NativeOcr === 'undefined' || !NativeOcr.present()) {
      toast('Нативный движок есть только в приложении', 7000); return;
    }
    toast('Проверяю нативный движок на тестовой странице…', 8000);
    const cbId = 't' + Date.now().toString(36);
    window.__komaOcrEvent = window.__komaOcrEvent || (() => {});
    const prev = window.__komaOcrEvent;
    window.__komaOcrEvent = (id, type, data) => {
      prev(id, type, data);
      if (id !== cbId || type !== 'done') return;
      let r = {};
      try { r = JSON.parse(data || '{}'); } catch (e) { r = { ok: false, error: 'ответ не разобрался' }; }
      toast(r.ok
        ? 'Нативный движок читает: «' + String(r.text || '').slice(0, 120) + '» за ' + r.ms + ' мс'
        : 'Нативный движок не прочитал: ' + (r.error || 'нет текста'), 9000);
      renderNativeOcr().catch(() => {});
    };
    try { window.KomaOcr.selfTestAsync(cbId); }
    catch (e) { toast('Проверка не запустилась: ' + ((e && e.message) || e), 7000); }
  };
  const setOcrEngine = async (mode) => {
    RULES = sanitizeRules({ ...RULES, ocrEngine: mode });
    await saveRules();
    syncSettingsUI();
    // Смена движка должна действовать сразу: иначе «выбрал нативно», а считает
    // по-старому до перезапуска.
    OCR.ready = false; OCR.engine = 'idle'; OCR.nativeNote = '';
    try { await OCR.loadModels(); } catch (e) { console.warn(e); }
    syncEngineUI();
    renderNativeOcr().catch(() => {});
    toast('Движок распознавания: ' + (NativeOcr.chosen() === 'native' ? 'нативно (АПК)' : 'WASM в странице'), 5000);
  };
  if ($('#btnEngineAuto')) $('#btnEngineAuto').onclick = () => setOcrEngine('auto');
  if ($('#btnEngineNative')) $('#btnEngineNative').onclick = () => setOcrEngine('native');
  if ($('#btnEngineWasm')) $('#btnEngineWasm').onclick = () => setOcrEngine('wasm');

  $('#btnRulesImport').onclick = () => {
    const inp = rulesInput;
    inp.onchange = async () => {
      const list = inp.files;
      const f = list && list[0];
      inp.value = '';
      if (!f) return;
      try {
        RULES = sanitizeRules(JSON.parse(await f.text()));
        await DB.put('kv', { k: 'rules', v: JSON.stringify(RULES) });
        renderRulesInfo(); toast('Правила применены: ' + RULES.version);
      } catch (e) { toast('Файл правил не разобрался: ' + e.message); }
    };
    inp.click();
  };
  $('#btnRulesExport').onclick = () => {
    const blob = new Blob([JSON.stringify(RULES, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'koma-rules.json'; a.click();
  };
  $('#btnRulesReset').onclick = async () => {
    RULES = sanitizeRules({ ...DEFAULT_RULES });
    await DB.put('kv', { k: 'rules', v: JSON.stringify(RULES) });
    renderRulesInfo(); toast('Встроенные правила');
  };
  $('#btnWordFixesSave').onclick = async () => {
    try {
      const obj = JSON.parse($('#wordFixesBox').value || '{}');
      RULES.wordFixes = obj;
      await DB.put('kv', { k: 'rules', v: JSON.stringify(RULES) });
      toast('Правки слов сохранены: ' + Object.keys(obj).length);
      // пересчитываем порядок из буфера, без нового OCR
      const i = Reader.page;
      const buf = await Buffer.get(i);
      if (buf) {
        const data = Reader.regions.get(i);
        if (data) {
          data.lines = readingOrder(data.regions, Reader.mode === 'rtl', true, RULES);
          Reader.paintPage(i);
          toast('Порядок пересчитан из буфера: ' + data.lines.length + ' реплик');
        }
      }
    } catch (e) { toast('JSON правок не разобрался: ' + e.message); }
  };
  $('#btnBufferExport').onclick = async () => {
    const items = await Buffer.all();
    const text = items.map(p => `стр. ${p.page + 1} · r${p.rules}\n` +
      p.lines.map(l => '  ' + l.text).join('\n')).join('\n\n') || 'Буфер пуст';
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'koma-buffer.txt'; a.click();
  };
  $('#btnBufferClear').onclick = async () => {
    // Одна кнопка — одна правда: стираем буфер ВСЕХ книг и память страниц.
    const n = await Buffer.clearAll();
    await renderBufferSheet();
    toast(n ? 'Буфер очищен: убрано записей ' + n : 'Буфер и так был пуст', 3500);
  };

  // читалка
  $('#btnBack').onclick = () => { TTS.stop(); show('library'); Library.load(); };
  // Открывая текст, ставим авточтение на паузу: иначе лента уезжает на
  // следующую страницу, пока человек читает текст, и кажется, что «текст не тот».
  const openTextSheet = () => {
    if (!TTS.stopped) { TTS.stop(); toast('Авточтение остановлено — вы открыли текст страницы', 3500); }
    openSheet('sheetText');
    renderTextSheet(null);           // страницу берём С ЭКРАНА, а не из сохранённого индекса
  };
  // Движок распознавания ОДИН — локальные модели в фоне (как в Yomikai).
  // Google Lens убран целиком по просьбе 4.11: он не читал страницу сам,
  // а требовал открыть сайт и перенести текст руками.
  syncEngineUI();
  $('#btnScan').onclick = openTextSheet;
  $('#btnOcr2').onclick = openTextSheet;
  $('#btnSettings').onclick = () => { openSheet('sheetSettings'); syncSettingsUI(); };
  $('#btnMore').onclick = () => { openSheet('sheetRules'); renderRulesInfo(); renderBufferSheet(); };
  // Журнал: и с экрана «Ещё», и из шторки правил, и из настроек движка.
  if ($('#btnMoreJournal')) $('#btnMoreJournal').onclick = () => openJournal();
  if ($('#btnOpenJournal')) $('#btnOpenJournal').onclick = () => openJournal();
  if ($('#closeSheets6')) $('#closeSheets6').onclick = closeSheets;
  if ($('#btnJrnClear')) $('#btnJrnClear').onclick = () => { Journal.clear(); renderJournal(); toast('Журнал очищен', 2000); };
  if ($('#btnJrnCopy')) $('#btnJrnCopy').onclick = async () => {
    const text = Journal.asText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); toast('Журнал скопирован — можно вставить в сообщение', 3500); }
      else throw new Error('нет буфера обмена');
    } catch (e) {
      // Буфера нет — показываем текст, чтобы можно было выделить руками.
      openJournal();
      const box = $('#jrnEvents');
      if (box) { box.textContent = text; box.style.whiteSpace = 'pre-wrap'; }
      toast('Скопировать не дали — текст показан в журнале, выделите и скопируйте', 5000);
    }
  };
  if ($('#btnVoiceCheck')) $('#btnVoiceCheck').onclick = async (e) => {
    const b = e.currentTarget, label = b.textContent;
    b.disabled = true; b.textContent = 'Говорю…';
    try { await runVoiceCheck(false); } finally { b.disabled = false; b.textContent = label; }
  };
  if ($('#btnWarmVoice')) $('#btnWarmVoice').onclick = async (e) => {
    const b = e.currentTarget, label = b.textContent;
    b.disabled = true; b.textContent = 'Грею…';
    try { const r = await runVoiceCheck(true); toast(r.ok ? 'Голос прогрет — страницы будут читаться сразу' : 'Прогрев не прошёл: ' + (r.error || 'нет старта'), 4000); }
    finally { b.disabled = false; b.textContent = label; }
  };
  if ($('#btnVoiceReport')) $('#btnVoiceReport').onclick = () => { openJournal(); };
  // Шторку НЕ закрываем: иначе не видно, что происходит, и результат некуда
  // показать. Сканируем ту страницу, чей текст открыт (Reader.textPage), а не
  // «текущую в ленте» — из-за этого раньше реплики не перезаписывались вовсе.
  $('#btnRescan').onclick = async () => {
    const i = (Reader.textPage == null ? Reader.page : Reader.textPage);
    $('#btnRescan').disabled = true;
    try {
      await Reader.scanPage(i, { force: true, keepSheet: true, tag: 'кнопка: заново' });
    } finally {
      $('#btnRescan').disabled = false;
    }
  };
  // ── Сброс состояния: «Забыть текст этой книги» и «Сбросить у всех книг» ──
  // Раньше распознанный текст и отметки «прочитано» жили вечно: у книги
  // оставался старый список реплик, и на новой сборке человек видел текст,
  // которого на странице нет. Теперь это можно стереть руками, не переустанавливая.
  const forgetOf = async (id) => {
    const keys = (await DB.all('kv') || []).filter(r => typeof r.k === 'string'
      && (r.k === 'buf:' + id + ':' || r.k.startsWith('buf:' + id + ':'))
      || (typeof r.k === 'string' && r.k === 'spoken:' + id));
    for (const r of keys) await DB.del('kv', r.k);
    return keys.length;
  };
  const forgetCurrent = async () => {
    const book = Reader.book;
    if (!book || !book.id) { toast('Книга не открыта'); return; }
    const n = await forgetOf(book.id);
    Reader.regions.clear();
    Reader.bandCache.clear();
    if (typeof Reader.spoken === 'object' && Reader.spoken.clear) Reader.spoken.clear();
    Reader.spokenDirty = true;
    Reader.paintAllFrames();
    renderTextSheet();
    toast('Текст книги забыт: убрано записей ' + n + '. Распознаем заново.', 4000);
  };
  const forgetEverything = async () => {
    const rows = (await DB.all('kv') || []).filter(r => typeof r.k === 'string'
      && (r.k.startsWith('buf:') || r.k.startsWith('spoken:')));
    for (const r of rows) await DB.del('kv', r.k);
    Reader.regions.clear();
    Reader.bandCache.clear();
    if (typeof Reader.spoken === 'object' && Reader.spoken.clear) Reader.spoken.clear();
    Reader.paintAllFrames();
    renderTextSheet();
    toast('Сброшено у всех книг: записей ' + rows.length, 4000);
  };
  if ($('#btnForgetBook')) $('#btnForgetBook').onclick = () => { forgetCurrent().catch(e => toast('Не удалось: ' + e.message)); };
  if ($('#btnForgetAll')) $('#btnForgetAll').onclick = () => { forgetEverything().catch(e => toast('Не удалось: ' + e.message)); };

  $('#btnSpeakPage').onclick = async () => {
    TTS.prime();                        // «Прочитать» в шторке — тот же жест
    const i = (Reader.textPage == null ? Reader.page : Reader.textPage);
    await Reader.scanPage(i, { keepSheet: false });
    closeSheets();
    // Человек нажал сам — читаем с начала того, что на экране, а не с того
    // места, где остановились в прошлый раз.
    TTS.readVisible({ fromStart: true });
  };
  const btnAdd = $('#btnPluginsAdd');
  if (btnAdd) btnAdd.onclick = () => {
    try {
      if (Plugins.present() && typeof window.KomaPlugins.pick === 'function') {
        window.KomaPlugins.pick();
        toast('Выберите .json-файл плагина', 4000);
        return;
      }
    } catch (e) { /* нет моста */ }
    toast('Добавлять плагины можно только в приложении', 4000);
  };
  // В приложении панель нативная — своя HTML-панель в это время не нужна:
  // две панели на экране и были источником «прыжков» (28.10).
  if (NATIVE_UI.there()) document.body.classList.add('native-ui');

  const btnPlug = $('#btnPluginsReload');
  if (btnPlug) btnPlug.onclick = () => {
    try {
      if (Plugins.present() && typeof window.KomaPlugins.reload === 'function') {
        window.KomaPlugins.reload();
        toast('Перечитываю плагины…', 2000);
        return;
      }
    } catch (e) { /* нет моста — покажем, что есть */ }
    Plugins.load().then(syncPluginsUI);
  };
  // Кнопка «Распознать вручную» (⬚): первое нажатие — режим выделения,
  // второе — распознать выделенный прямоугольник (просьба 06.11, 20:43).
  const pickOn = (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (!Reader.book) { toast('Сначала откройте главу', 2500); return; }
    Reader.pickToggle();
  };
  { const b1 = $('#btnPickArea'); if (b1) b1.onclick = pickOn; }
  { const b2 = $('#btnPickArea2'); if (b2) b2.onclick = (ev) => {
      try { if (typeof closeSheets === 'function') closeSheets(); } catch (e) { /* шторки нет */ }
      pickOn(ev);
    }; }
  $('#btnFrames').onclick = () => {
    Reader.frames = !Reader.frames;
    // Настройка живёт в правилах: иначе после перезапуска рамки молча
    // выключались, и это выглядело как «рамки делись» (телефон 22:11).
    RULES.frames = Reader.frames;
    $('#btnFrames').classList.toggle('hot', Reader.frames);
    const cb = $('#cbFrames'); if (cb) cb.checked = Reader.frames;
    Reader.paintAllFrames();
    saveRules().catch(() => {});
  };
  $('#btnRead').onclick = () => {
    if (TTS.stopped) {
      TTS.prime();                       // разблокировать голос в жесте
      // Явное нажатие ▶ = «читай отсюда и с начала», а не «продолжай с того
      // места, где я остановился в прошлый раз» (жалоба 28.10 22:41).
      Reader.scanCurrent(false, null, 'кнопка ▶').then(() => TTS.readVisible({ fromStart: true }));
    } else { TTS.stop(); }
  };
  // Стартовая карточка: страница сама ничего не запускает.
  $('#btnStartScan').onclick = async () => {
    Reader.hideStart();
    await Reader.scanCurrent(false, null, 'кнопка: распознать');
    // renderTextSheet — не промис в общем случае: вызываем через Promise.resolve,
    // иначе `.catch` падал с «Cannot read properties of undefined (reading 'catch')»
    // (это и был тост с телефона 28.10).
    try { await Promise.resolve(renderTextSheet(null)); } catch (e) { console.warn(e); }
  };
  $('#btnStartRead').onclick = async () => {
    TTS.prime();                        // голос разрешён только из жеста
    Reader.hideStart();
    if (!Reader.regions.get(Reader.page)) await Reader.scanCurrent(false, null, 'кнопка: читать');
    TTS.readVisible();
  };
  $('#btnStartClose').onclick = () => Reader.hideStart();
  $('#cbAutoScan').onchange = async (e) => {
    RULES.autoScan = !!e.target.checked;
    await saveRules();
    toast(RULES.autoScan
      ? 'Страницы будут распознаваться сами при открытии и прокрутке'
      : 'Само распознаваться больше не будет — только по кнопке', 3500);
    if (RULES.autoScan) { Reader.hideStart(); Reader.scanCurrent(false, null, 'авто: включили'); }
  };

  // Профиль скорости: одно нажатие меняет весь конвейер.
  $('#speedChips').onclick = async (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    RULES = sanitizeRules({ ...RULES, speed: chip.dataset.speed });
    await saveRules();
    syncSettingsUI();
    toast('Скорость: ' + SPEED_NAMES[RULES.speed] + ' ' + SPEED_APPROX[RULES.speed]
      + '. Уже распознанные страницы не пересчитываются — нажмите «Распознать заново».', 4500);
  };
  $('#btnStop').onclick = () => TTS.stop();
  $('#btnPause').onclick = () => {
    // Голос живёт за фасадом VOICE: в браузере это Web Speech, в АПК — Android
    // TTS. Раньше здесь стоял прямой speechSynthesis, и в приложении кнопка
    // падала с «speechSynthesis is not defined».
    if (!TTS.paused) {
      TTS.pauseRead();
      TTS.paused = true;
      $('#btnPause').textContent = '▶';
    } else {
      TTS.resumeRead();
      TTS.paused = false;
      $('#btnPause').textContent = '⏸';
    }
  };
  $('#btnSkip').onclick = () => { VOICE.cancel(); if (!TTS.stopped) TTS.step(); };
  $('#nextArrow').onclick = async () => {
    hideArrow();
    TTS.prime();
    const step = Math.round(window.innerHeight * 0.85);
    $('#strip').scrollBy({ top: step, behavior: 'smooth' });
    await sleep(300 + RULES.semiManualSettleMs);
    if (!Reader.scrollBusy) TTS.readVisible();
  };

  // ── настройки чтения: профиль книги и умолчание (1.0.21) ────────────────
  /** Записать профиль текущей книги. Другие книги не трогаем — у них умолчание. */
  const saveProfile = async (patch) => {
    if (!Reader.book) return;
    Reader.book = Object.assign({}, Reader.book, { profUser: true }, patch || {});
    Reader.modeUser = true;
    await DB.put('books', Reader.book);
  };
  $('#modeChips').onclick = async (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    Reader.mode = chip.dataset.mode;
    // Лента — это «листаю сам»: голос у книги выключаем, пока человек сам не
    // включит его обратно тумблером ниже.
    if (Reader.mode === 'vertical') Reader.voiceOn = false;
    await saveProfile({ mode: Reader.mode, voice: Reader.voiceOn });
    Reader.buildStrip().then(() => { Reader.syncSub(); syncSettingsUI(); });
  };
  $('#dirChips').onclick = async (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    Reader.dir = chip.dataset.dir;
    await saveProfile({ dir: Reader.dir });
    Reader.rescanInDir();
    syncSettingsUI();
  };
  if ($('#cbVoiceBook')) $('#cbVoiceBook').onchange = async (e) => {
    Reader.voiceOn = !!e.target.checked;
    await saveProfile({ voice: Reader.voiceOn });
    toast(Reader.voiceOn
      ? 'Эта книга читается вслух сама, как только страница распознана'
      : 'Эта книга без голоса — листаешь сам', 3500);
  };
  // ── чтец распознавания: у книги свой, иначе общий (1.0.22) ──────────────
  if ($('#engChips')) $('#engChips').onclick = async (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    Reader.engine = chip.dataset.eng || 'auto';
    // Выбрал человек — автоподбор больше не вмешивается в эту книгу.
    await saveProfile({ engine: Reader.engine, engineUser: true, engineAuto: false });
    syncSettingsUI();
    toast('Чтец этой книги: ' + (ENG_NAMES[Reader.engine] || Reader.engine)
      + '. Текст будет распознан заново.', 3500);
    // Прежний текст этой книги собран другим чтецом — его надо забыть,
    // иначе человек увидит старые строки и решит, что выбор не работает.
    try {
      if (Reader.book) {
        const rows = (await DB.all('kv') || []).filter(r => typeof r.k === 'string'
          && r.k.startsWith('buf:' + Reader.book.id + ':'));
        for (const r of rows) await DB.del('kv', r.k);
        Reader.regions.clear(); Reader.bandCache.clear();
        Reader.paintAllFrames();
      }
    } catch (err) { console.warn('буфер не очистился', err); }
  };
  if ($('#defEngChips')) $('#defEngChips').onclick = async (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    ReadDefaults.v.engine = chip.dataset.eng || 'auto';
    await ReadDefaults.save();
    syncSettingsUI();
  };
  // ── проверка и ПОДБОР чтеца на этой странице (1.0.23–1.0.24) ────────────
  // Мой стенд с телефоном не сошёлся, поэтому чтец подбирается замером на
  // странице человека: прогоняем всех по одним строкам, считаем долю слов,
  // которые есть в словаре, и берём лучшего. Это же число показывает таблица.
  const probeNow = async () => {
    const b = (typeof NativeOcr !== 'undefined') ? NativeOcr.bridge() : null;
    if (!b || typeof b.probeAsync !== 'function') return { ok: false, error: 'только в приложении' };
    const i = Reader.page;
    const canvas = Reader.canvases && Reader.canvases[i];
    if (!canvas) return { ok: false, error: 'страница не готова' };
    const cbId = 'p' + Date.now().toString(36);
    const prev = window.__komaOcrEvent;
    return new Promise((resolve) => {
      window.__komaOcrEvent = (id, type, data) => {
        if (id !== cbId) { if (typeof prev === 'function') prev(id, type, data); return; }
        if (type === 'state') {
          const box = $('#engProbe');
          if (box) box.textContent = 'Считаю… ' + data;
          return;
        }
        if (type === 'done') {
          window.__komaOcrEvent = prev;
          let r = {};
          try { r = JSON.parse(data || '{}'); } catch (e) {}
          resolve(r);
        }
      };
      try {
        const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
        b.probeAsync(b64, JSON.stringify({ pageSide: (typeof RULES !== 'undefined' && RULES.pageSide) || 1600 }), cbId);
      } catch (e) { window.__komaOcrEvent = prev; resolve({ ok: false, error: String(e) }); }
    });
  };
  const bestOf = (r) => {
    const list = (r && r.engines) || [];
    let best = null;
    for (const e of list) {
      if (!e || !e.lines) continue;
      // сначала доля словарных слов, при близких — кто прочитал больше строк
      if (!best || (e.knownShare || 0) > (best.knownShare || 0) + 0.02
          || (Math.abs((e.knownShare || 0) - (best.knownShare || 0)) <= 0.02 && e.lines > best.lines)) {
        best = e;
      }
    }
    return best;
  };
  const renderProbe = (r) => {
    const box = $('#engProbe');
    if (!box) return;
    if (!r.ok) {
      box.innerHTML = '<span style="color:#ff9b9b">Не получилось: '
        + escapeHtml(String(r.error || '')) + '</span>';
      return;
    }
    const win = bestOf(r);
    const rows = (r.engines || []).map(x => {
      const pct = Math.round((x.knownShare || 0) * 100);
      // Зелёным — лучший на этой странице. Раньше зелёным считалось «45 %»,
      // а на манге с мелким шрифтом ни один чтец до 45 % не добирается
      // (скриншот 22:34: rec 43 %, eslav 38 %) — таблица целиком краснела и
      // выглядела как «ничего не работает». Порог оставлен только как ориентир.
      const good = x === win || pct >= 45;
      return '<tr' + (x === win ? ' style="font-weight:600"' : '') + '><td>' + (ENG_NAMES[x.engine] || x.engine) + '</td><td>' + x.lines + '/' + x.of + '</td>'
        + '<td style="color:' + (good ? '#8fe0b0' : '#ffb4b4') + '">' + pct + ' %</td>'
        + '<td>' + (x.ms / 1000).toFixed(1) + ' с</td></tr>';
    }).join('');
    const winPct = Math.round(((win && win.knownShare) || 0) * 100);
    const note = winPct >= 45
      ? 'Жирным и зелёным — лучший чтец на этой странице. 45 % и выше — страница прочитана уверенно.'
      : 'Жирным и зелёным — лучший из чтецов. ' + winPct + ' % ниже 45 %: страница мелкая или шумная, '
        + 'и все чтецы на ней слабее обычного. Чтец всё равно выбирается лучший по замеру, '
        + 'но текст на такой странице будет рваным — это видно по репликам ниже.';
    box.innerHTML = '<table style="width:100%;font-size:12px">'
      + '<tr><th>чтец</th><th>строк</th><th>слов по словарю</th><th>время</th></tr>'
      + rows + '</table><div class="hint" style="margin-top:6px">'
      + 'Слов по словарю — доля прочитанных слов, которые есть в русском словаре. '
      + note + '</div>';
  };
  /** Применить чтеца к книге (запоминается у неё одной). */
  const applyEngine = async (eng, why, user) => {
    Reader.engine = eng;
    if (Reader.book) {
      Reader.book = Object.assign({}, Reader.book, {
        engine: eng, engineAuto: !user, engineUser: !!user,
      });
      await DB.put('books', Reader.book);
      // Текст прежним чтецом больше не годится — стираем его у этой книги.
      try {
        const rows = (await DB.all('kv') || []).filter(r => typeof r.k === 'string'
          && r.k.startsWith('buf:' + Reader.book.id + ':'));
        for (const r of rows) await DB.del('kv', r.k);
      } catch (e) { /* не критично */ }
      Reader.regions.clear(); Reader.bandCache.clear();
      if (Reader.paintAllFrames) Reader.paintAllFrames();
    }
    syncSettingsUI();
    if (why) toast(why, 5000);
  };

  if ($('#btnProbe')) $('#btnProbe').onclick = async () => {
    const box = $('#engProbe');
    if (box) box.textContent = 'Считаю всех чтецов на этой странице…';
    const r = await probeNow();
    renderProbe(r);
    const best = bestOf(r);
    if (!r.ok || !best) return;
    const list = r.engines || [];
    const second = list.filter(e => e !== best && e.lines).sort((a, b) => (b.knownShare || 0) - (a.knownShare || 0))[0];
    const cmp = second
      ? ' (' + Math.round((best.knownShare || 0) * 100) + ' % против ' + Math.round((second.knownShare || 0) * 100) + ' %)'
      : '';
    await applyEngine(best.engine, 'Чтец этой книги выбран по замеру: ' + (ENG_NAMES[best.engine] || best.engine) + cmp, false);
  };
  if ($('#btnAutoEngine')) $('#btnAutoEngine').onclick = async () => {
    const r = await probeNow();
    renderProbe(r);
    const best = bestOf(r);
    if (!r.ok || !best) return;
    await applyEngine(best.engine, 'Подобрано: ' + (ENG_NAMES[best.engine] || best.engine), false);
  };

  // Автоподбор чтеца при первом открытии книги: один раз, только если человек
  // сам не выбирал. Иначе «по словарю» опять решает за него.
  window.__komaAutoEngine = async function () {
    try {
      if (!Reader.book || Reader.book.engineUser) return;
      if (Reader.book.engineAuto) return;
      const b = (typeof NativeOcr !== 'undefined') ? NativeOcr.bridge() : null;
      if (!b || typeof b.probeAsync !== 'function') return;
      if (!Reader.canvases || !Reader.canvases[Reader.page]) return;
      const r = await probeNow();
      const best = bestOf(r);
      if (!r.ok || !best) return;
      if ((best.knownShare || 0) < 0.3) return;      // мерить не на чем — не трогаем
      const cur = Reader.engine || 'auto';
      if (best.engine === cur) {
        Reader.book = Object.assign({}, Reader.book, { engineAuto: true });
        await DB.put('books', Reader.book);
        return;
      }
      await applyEngine(best.engine, 'Для этой книги чтец выбран замером на странице: '
        + (ENG_NAMES[best.engine] || best.engine) + ' (' + Math.round((best.knownShare || 0) * 100)
        + ' % слов по словарю). Поменять — ⚙ → ЧТЕЦ ДЛЯ ЭТОЙ КНИГИ', false);
    } catch (e) { console.warn('автоподбор чтеца', e); }
  };

  if ($('#btnProfReset')) $('#btnProfReset').onclick = async () => {
    if (!Reader.book) return;
    const D = ReadDefaults.v;
    Reader.book = Object.assign({}, Reader.book, {
      profUser: false, mode: D.mode, dir: D.dir, voice: !!D.voice, engine: D.engine || 'auto',
    });
    await DB.put('books', Reader.book);
    Reader.modeUser = false;
    Reader.mode = D.mode; Reader.dir = D.dir; Reader.voiceOn = !!D.voice;
    Reader.engine = D.engine || 'auto';
    Reader.buildStrip().then(() => { Reader.syncSub(); syncSettingsUI(); });
    toast('Эта книга снова как по умолчанию', 3000);
  };
  // Умолчание — то, что получат все книги без своего профиля.
  $('#defModeChips').onclick = async (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    ReadDefaults.v.mode = chip.dataset.mode;
    if (chip.dataset.mode === 'vertical') ReadDefaults.v.voice = false;
    await ReadDefaults.save();
    syncSettingsUI();
    toast('По умолчанию: ' + (chip.textContent || '').trim(), 3000);
  };
  $('#defDirChips').onclick = async (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    ReadDefaults.v.dir = chip.dataset.dir;
    await ReadDefaults.save();
    syncSettingsUI();
  };
  if ($('#cbVoiceDefault')) $('#cbVoiceDefault').onchange = async (e) => {
    ReadDefaults.v.voice = !!e.target.checked;
    await ReadDefaults.save();
    syncSettingsUI();
  };
  $('#cbAuto').onchange = (e) => {
    if (e.target.checked) Reader.scanCurrent(false, null, 'авточтение: включили').then(() => TTS.readVisible());
    else TTS.stop();
  };
  $('#cbSemi').onchange = (e) => { State.semi = e.target.checked; RULES.semiManual = e.target.checked; };
  $('#numSettle').onchange = async (e) => {
    RULES.semiManualSettleMs = clamp(+e.target.value || 0, 0, 5000);
    await DB.put('kv', { k: 'rules', v: JSON.stringify(RULES) });
  };
  $('#cbFrames').onchange = async (e) => {
    Reader.frames = e.target.checked;
    RULES.frames = Reader.frames;
    $('#btnFrames').classList.toggle('hot', Reader.frames);
    Reader.paintAllFrames();
    await DB.put('kv', { k: 'rules', v: JSON.stringify(RULES) });
  };
  $('#cbFollow').onchange = (e) => { Reader.follow = e.target.checked; };
  $('#reader').addEventListener('click', (e) => {
    if (e.target.closest('.frame') || e.target.closest('button') || e.target.closest('.bottombar')) return;
    // Постраничный режим: листать можно пальцем — левая половина назад,
    // правая вперёд (для манги справа налево — наоборот). Раньше страницы
    // листались ТОЛЬКО стрелками клавиатуры, которых на телефоне нет.
    if (Reader.mode !== 'vertical' && e.target.tagName === 'IMG') {
      const right = e.clientX > window.innerWidth / 2;
      const forward = (Reader.dir === 'rtl') ? !right : right;
      turnPage(forward ? 1 : -1);
      return;
    }
    if (e.target.tagName === 'IMG') {
      $('#readerBar').classList.toggle('hide');
      $('#readerHeader').style.transform =
        $('#readerBar').classList.contains('hide') ? 'translateY(-110%)' : 'translateY(0)';
    }
  });
}
/**
 * Строка про движок в настройках. Движок теперь ОДИН (локальные модели в
 * фоне), поэтому здесь только честный текст, без переключателей: раньше
 * кнопка «В файле» выглядела выбранной всегда, даже когда был включён Lens.
 */
function syncEngineUI() {
  const hdr = $('#btnLensHdr');
  if (hdr) hdr.style.display = 'none';        // кнопки Lens больше нет
  const sub = $('#rSub');
  if (sub && Reader && Reader.pages && Reader.pages.length) sub.textContent = 'KOMA · в файле';
  const priv = $('#privacyNote');
  if (priv) {
    priv.textContent = 'Распознавание целиком на телефоне: ни один кадр никуда не уходит. '
      + 'Онлайн остаются только голоса Edge — и только если вы их выбрали сами.';
    priv.style.color = '';
  }
  // Скрываем только то, чего больше нет в разметке; честный текст про движок
  // (#engineHint2, #engineNote2) остаётся на месте — иначе под заголовком
  // «ДВИЖОК РАСПОЗНАВАНИЯ» было бы пусто (скриншот 4.11).
  for (const id of ['engineLocal', 'engineLens', 'engineLocal2', 'engineLens2',
                    'engineLensNote', 'engineChips', 'engineChips2', 'lensRelayState']) {
    const el = $('#' + id);
    if (el) el.style.display = 'none';
  }
}

async function saveRules() {
  RULES = sanitizeRules(RULES);
  await DB.put('kv', { k: 'rules', v: JSON.stringify(RULES) });
}

const ENG_NAMES = { auto: 'Авто · по словарю', rec: 'Основной (rec)', eslav: 'Эслав',
  r3: 'Стилевой А (r3)', r4: 'Стилевой Б (r4)' };
/**
 * Подпись под списком чтецов. Здесь же — цифры замера, чтобы выбор был не
 * «на веру»: две стилевые модели по замеру хуже основных, и «авто» их не берёт.
 */
function renderEngHint() {
  const h = $('#engHint'); if (!h) return;
  const now = ENG_NAMES[Reader.engine || 'auto'] || 'Авто';
  const nat = (typeof NativeOcr !== 'undefined' && NativeOcr.ready && NativeOcr.ready());
  h.innerHTML = 'Сейчас: <b>' + now + '</b>. ' + (nat
    ? 'Читает нативный движок приложения.'
    : 'В браузере чтец не переключается — он выбирается в приложении.')
    + '<br>Замер на настоящих страницах (детектор → резка на строки → чтец), доля найденных слов эталона:'
    + ' манга — rec 78 %, eslav 44 %; маньхуа — rec 43 %, eslav 14 %; вебтун — rec 89 %, eslav 46 %;'
    + ' комикс — eslav 19 %, rec 5 %; r3 и r4 — от 0 до 17 % на всём.'
    + '<br>Мой прежний замер по нарезанным строкам с телефоном не сошёлся — верь кнопке ниже,'
    + ' она мерит на твоей странице.';
}

function syncSettingsUI() {
  $$('#modeChips .chip').forEach(c => c.classList.toggle('on', c.dataset.mode === Reader.mode));
  $$('#speedChips .chip').forEach(c => c.classList.toggle('on', c.dataset.speed === RULES.speed));
  const hint = $('#speedHint');
  if (hint) {
    // На телефоне распознаёт НАТИВНЫЙ движок: один проход, и профиль скорости
    // на текст не влияет вообще. Раньше подсказка обещала «≈80 с на страницу»
    // и разное качество — человек проверил все профили и увидел, что разницы
    // нет (жалоба 4.11). Обещать надо то, что есть.
    const nat = (typeof NativeOcr !== 'undefined' && NativeOcr.chosen && NativeOcr.chosen() === 'native');
    hint.textContent = (nat
      ? (SPEED_NAMES[RULES.speed] || '') + ' — но на телефоне распознавание идёт '
        + 'нативным движком одним проходом: профиль скорости на текст и на время не влияет.'
      : (SPEED_NAMES[RULES.speed] || '') + ' ' + (SPEED_APPROX[RULES.speed] || '')
        + ' на страницу (замер на 720×2960). Медленнее — только для трудных страниц.'
        + ((typeof SPEED_NOTES !== 'undefined' && SPEED_NOTES[RULES.speed]) || ''));
  }
  $$('#dirChips .chip').forEach(c => c.classList.toggle('on', c.dataset.dir === (Reader.dir || 'rtl')));
  // Умолчание и профиль книги видны отдельно, чтобы не гадать, что к чему.
  const D = (typeof ReadDefaults !== 'undefined') ? ReadDefaults.v : null;
  if (D) {
    $$('#defModeChips .chip').forEach(c => c.classList.toggle('on', c.dataset.mode === D.mode));
    $$('#defDirChips .chip').forEach(c => c.classList.toggle('on', c.dataset.dir === D.dir));
    const cvd = $('#cbVoiceDefault'); if (cvd) cvd.checked = !!D.voice;
  }
  const cvb = $('#cbVoiceBook'); if (cvb) cvb.checked = !!Reader.voiceOn;
  $$('#engChips .chip').forEach(c => c.classList.toggle('on', c.dataset.eng === (Reader.engine || 'auto')));
  $$('#defEngChips .chip').forEach(c => c.classList.toggle('on', c.dataset.eng === ((D && D.engine) || 'auto')));
  if (typeof renderEngHint === 'function') renderEngHint();
  const ps = $('#profState');
  if (ps) ps.textContent = !Reader.book ? 'книга не открыта'
    : (Reader.modeUser ? 'своё, не как по умолчанию' : 'как по умолчанию');
  $('#cbSemi').checked = !!RULES.semiManual;
  $('#cbFrames').checked = Reader.frames;
  $('#cbFollow').checked = Reader.follow;
  $('#numSettle').value = RULES.semiManualSettleMs;
  $('#cbAuto').checked = !TTS.stopped;
}

/**
 * Блок «Плагины» в настройках: сколько их, откуда и что не прочиталось.
 * Без этого человек не узнал бы, что его JSON вообще подхватился.
 */
function syncPluginsUI() {
  const box = $('#pluginsState');
  if (!box) return;
  try {
    box.textContent = Plugins.describe();
  } catch (e) {
    box.textContent = 'плагины не показались: ' + ((e && e.message) || e);
  }
}

/* ───────────────────────── 13. Старт ───────────────────────── */
// Ошибки не должны прятаться в консоли: иначе кнопка «молчит», и непонятно почему.
window.addEventListener('error', (e) => {
  const msg = e.message || (e.error && e.error.message) || 'ошибка';
  toast('Ошибка: ' + msg, 5000);
  console.error(e.error || msg);
});
window.addEventListener('unhandledrejection', (e) => {
  toast('Ошибка: ' + ((e.reason && e.reason.message) || e.reason || 'неизвестно'), 5000);
  console.error(e.reason);
});

const ENV = {
  sandboxed: (() => { try { return window.self !== window.top; } catch (e) { return true; } })(),
  android: /Android/i.test(navigator.userAgent),
};

function showEnvBanner() {
  const b = $('#envBanner');
  const lines = [];
  // Никаких адресов в тексте: сборка обязана оставаться без сетевых ссылок
  // (гейт в CI считает их и падает — как и случилось 05.11).
  if (ENV.sandboxed) lines.push('Открыто в предпросмотре: браузер блокирует хранилище и выбор файлов. Откройте этот же файл в Chrome или на телефоне — там всё работает.');
  if (DB.inMemory) lines.push('Хранилище недоступно — библиотека живёт только до перезагрузки страницы.');
  b.style.display = lines.length ? 'block' : 'none';
  b.innerHTML = lines.join('<br>');
}
async function selfCheck() {
  const det = await DB.get('kv', 'model:det');
  const parts = [];
  parts.push('OCR: ' + (OCR.engine === 'native'
    ? 'нативно (ONNX Runtime в АПК)' + (OCR.nativeNote ? ' — ' + OCR.nativeNote : '')
    : OCR.statusText()));
  parts.push('словарь: ' + (Words.ready ? Words.size.toLocaleString('ru-RU') + ' слов (' + (Words.source || 'вшит') + ')' : 'не загрузился'));
  parts.push(typeof ort === 'undefined' ? 'onnxruntime-web не загружен (нужна сеть)' : 'onnxruntime-web загружен');
  // Голос есть/нет — по фасаду, без прямого speechSynthesis: в WebView его нет.
  const vc = (typeof VOICE !== 'undefined') ? VOICE.voices().length : 0;
  // Для онлайн-голоса список голосов Android ни при чём: «голосов 0» рядом с
  // «Edge TTS (онлайн)» читалось как противоречие (скриншот 04.11).
  const voiceLine = (typeof VOICE !== 'undefined' && VOICE.edge && VOICE.edge())
    ? VOICE.kind() + ', ' + EDGE.label() + (EDGE.uaOk() ? '' : ', UA без Edg/')
    : VOICE.kind() + ', голосов ' + vc;
  parts.push('голос: ' + (VOICE && VOICE.available() ? voiceLine : 'нет синтеза'));
  if (ENV.android) parts.push('Android: папки нет, выбирайте файлы/CBZ');
  // Браузер и поддержка синтаксиса — чтобы по скриншоту ⚙ было видно, на чём
  // именно не поднялось (старый WebView, предпросмотр, приватный режим).
  try {
    const probe = window.__komaProbe || {};
    const ua = navigator.userAgent;
    const name = /Chrome\/(\d+)/.test(ua) ? 'Chrome ' + RegExp.$1
      : /Firefox\/(\d+)/.test(ua) ? 'Firefox ' + RegExp.$1
      : /YaBrowser/.test(ua) ? 'Yandex'
      : /Safari/.test(ua) ? 'Safari' : 'браузер';
    parts.push('браузер: ' + name + (probe.modern === false ? ', без ?. и ??' : ''));
  } catch (e) {}
  // Строка состояния — единственное место, где видно правду о загрузке.
  // Если что-то не поднялось, пишем это здесь, а не оставляем на экране
  // «Скрипты страницы не выполнились» (эта надпись — только для случая, когда
  // не выполнился вообще ни один скрипт).
  const errs = (State.bootErrors || []);
  const tail = errs.length ? ' ⚠ не поднялось — ' + errs.join('; ') : '';
  const full = 'KOMA Web ' + VERSION + ' · ' + parts.join(' · ') + tail;
  // Полная строка состояния живёт в ⚙ → «Сборка»: на экране библиотеки она
  // выглядела как отладочный вывод («OCR: моделей нет · onnxruntime-web не
  // загружен · голосов 0») и мешала обложкам.
  const fullEl = $('#selfCheckFull');
  if (fullEl) fullEl.textContent = full;
  // А на библиотеке — только когда что-то действительно не поднялось.
  const sc = $('#selfCheck');
  const storageOnly = errs.length > 0 && errs.every(x => /localStorage|IndexedDB|SecurityError/i.test(x));
  const bad = errs.length > 0;
  sc.textContent = !bad ? ''
    : storageOnly
      ? 'Открыто в предпросмотре: браузер запретил хранилище. Откройте этот же файл в Chrome или на телефоне — там всё работает.'
      : ('Не поднялось: ' + errs.join('; ') + ' — подробности в ⚙ → Сборка');
  sc.style.display = bad ? 'block' : 'none';
  sc.dataset.ok = bad ? '0' : '1';
  sc.style.background = bad ? '#7a303022' : 'transparent';
  sc.style.color = bad ? '#ffb4b4' : 'var(--dim)';
}

/**
 * ПРОВЕРКА ОБНОВЛЕНИЯ.
 *
 * На телефоне 06.11 (13:00) человек обновил страницу, а баги остались: service
 * worker отдавал старую оболочку из кеша, и приложение продолжало работать
 * прошлой сборкой. Снаружи это выглядит как «правки не доехали».
 *
 * Поэтому приложение само сверяет свою версию с version.json на сервере
 * (в PWA его кладёт build.sh). Если версия другая — чистим кеши, снимаем
 * service worker и один раз перезагружаемся. Один раз — по отметке в
 * sessionStorage, чтобы не попасть в петлю перезагрузок.
 */
async function checkAppUpdate() {
  if (!/^https?:$/.test(location.protocol)) return false;   // файл с диска — проверять нечего
  let real = '';
  try {
    const r = await fetch('./version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    real = String((j && j.v) || '');
  } catch (e) { return false; }
  if (!real || real === VERSION) return false;
  const key = 'koma.upd.' + real;
  let tried = false;
  try { tried = sessionStorage.getItem(key) === '1'; } catch (e) { /* нет storage */ }
  toast('Вышла новая версия ' + real + ' — обновляю…', 5000);
  console.warn('обновление: сервер ' + real + ', приложение ' + VERSION);
  if (tried) return true;                       // уже пытались — не зацикливаемся
  try { sessionStorage.setItem(key, '1'); } catch (e) { /* не критично */ }
  await new Promise(r => setTimeout(r, 1200));
  try {
    if (window.caches) {
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
    }
  } catch (e) { console.warn('обновление: кеш не почистился', e); }
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('koma:drop');
    }
  } catch (e) { console.warn('обновление: service worker не снялся', e); }
  location.replace(location.pathname + '?v=' + Date.now());
  return true;
}
try { if (typeof window !== 'undefined') window.checkAppUpdate = checkAppUpdate; } catch (e) {}


/* ── ЖУРНАЛ: отрисовка и кнопки ─────────────────────────────────────────── */
function renderJournal() {
  const box = $('#jrnEvents');
  const cnt = $('#jrnCount');
  if (!box) return;
  const ev = Journal.events.slice(-200).reverse();
  if (cnt) cnt.textContent = '· всего ' + Journal.events.length;
  const colorOf = (cat) => (/голос/i.test(cat) ? '#b9a8ff'
    : /ошибк|обрыв|проглот/i.test(cat) ? '#ff9c9c'
      : /распозна/i.test(cat) ? '#8fe0b0'
        : /обновлен/i.test(cat) ? '#ffd479' : '#93a0b8');
  box.innerHTML = ev.length
    ? ev.map(e => `<div style="padding:3px 0;border-bottom:1px solid #1c2130">`
      + `<span style="color:#68738a">${escapeHtml(e.t)}</span> `
      + `<span style="color:${colorOf(e.cat)}">${escapeHtml(e.cat)}</span> · `
      + `${escapeHtml(e.text)}</div>`).join('')
    : '<div class="hint">Пока пусто: событий ещё не было.</div>';
  const known = $('#jrnKnown');
  if (known) {
    const badge = (st) => st === 'fixed'
      ? '<span style="color:#8fe0b0;font-size:11.5px">исправлено</span>'
      : st === 'open' ? '<span style="color:#ffd479;font-size:11.5px">открыто</span>'
        : '<span style="color:#93a0b8;font-size:11.5px">под наблюдением</span>';
    known.innerHTML = Journal.known.map(k =>
      `<div style="padding:9px 0;border-bottom:1px solid #1c2130">`
      + `<div style="font-weight:600;font-size:13.5px">${escapeHtml(k.title)} ${badge(k.status)}`
      + (k.since && k.since !== '—' ? ` <span class="hint">· ${escapeHtml(k.since)}</span>` : '') + `</div>`
      + (k.check ? `<div class="hint" style="margin-top:4px"><b>Как проверить:</b> ${escapeHtml(k.check)}</div>` : '')
      + (k.fix ? `<div class="hint" style="margin-top:2px"><b>Что делать:</b> ${escapeHtml(k.fix)}</div>` : '')
      + (k.more ? `<div class="hint" style="margin-top:2px">${escapeHtml(k.more)}</div>` : '')
      + `</div>`).join('');
  }
}
function openJournal() {
  openSheet('sheetJournal');
  renderJournal();
}
/** Состояние синтеза: показываем в «Движок и модели» числами. */
async function renderVoiceState(extra) {
  const el = $('#voiceState');
  if (!el) return;
  const last = TTS.lastCheck || null;
  const bits = [];
  bits.push(VOICE.available() ? ('движок: ' + VOICE.kind()) : 'синтеза речи в этой среде нет');
  try { bits.push('голосов: ' + VOICE.voices().length); } catch (e) { /* ignore */ }
  if (last) {
    bits.push(last.ok ? 'проверен' : 'ПРОВЕРКА НЕ ПРОШЛА');
    if (last.started) bits.push('старт ' + (last.startMs || 0) + ' мс');
    if (last.ended) bits.push('звучал ' + (last.ms / 1000).toFixed(1) + ' с');
    if (last.error) bits.push('ошибка: ' + last.error);
    bits.push('в ' + (TTS.lastCheckAt || ''));
  } else {
    bits.push('автопроверка ещё не проходила');
  }
  if (extra) bits.push(extra);
  el.textContent = bits.join(' · ');
}
async function runVoiceCheck(silent) {
  TTS.prewarm();
  try { TTS.prime(); } catch (e) { /* ignore */ }
  const r = await ttsSelfTest({ silent: !!silent });
  TTS.lastCheck = r;
  TTS.lastCheckAt = new Date().toLocaleTimeString('ru-RU');
  await renderVoiceState();
  if (!silent) {
    toast(r.ok ? ('Голос работает: ' + (r.ms / 1000).toFixed(1) + ' с · старт ' + (r.startMs || 0) + ' мс'
        + (r.heard ? '' : ' (по состоянию движка)'))
      : ('Голос молчит: ' + (r.error || 'нет старта') + '. Смотрите журнал.'), 8000);
  }
  return r;
}
try { if (typeof window !== 'undefined') { window.renderJournal = renderJournal; window.runVoiceCheck = runVoiceCheck; } } catch (e) {}

(async function boot() {
  // Каждый шаг запуска отдельно. 28.10 на телефоне первый же вызов голоса
  // (`speechSynthesis` в WebView не существует) обрывал весь boot: не грузились
  // правила, библиотека, модели, и на экране висело «Скрипты страницы не
  // выполнились» — хотя кнопки при этом работали. Теперь падение одного шага
  // не мешает остальным, а его причина честно пишется в строку состояния.
  State.bootErrors = State.bootErrors || [];
  // Флаг для аварийного пробника в начале страницы: приложение действительно
  // пошло. Без него он не может отличить «скрипты не выполнились» от «работает».
  try { window.__komaBoot = VERSION; } catch (e) {}
  // Синтез речи греем сразу при запуске: список голосов запрашиваем здесь, а
  // разблокировку — на первом касании экрана. Просьба 06.11, 12:22: «до
  // открытия книги уже держи tts включённым, чтобы задержка была поменьше».
  try { if (typeof TTS !== 'undefined' && TTS.prewarm) TTS.prewarm(); } catch (e) { /* не критично */ }
  // АВТОПРОВЕРКА ГОЛОСА ПРИ ЗАПУСКЕ (просьба 06.11, 17:05: «сделай при запуске в
  // настройках проверить tts: он подтянется, а потом на страницах будет шустрый»).
  // Проверка тихая: одно короткое слово почти без громкости. Она поднимает
  // движок и список голосов заранее, результат пишется в журнал и в настройки.
  try {
    const runStartCheck = async () => {
      if (TTS._startChecked) return;          // одна автопроверка за сеанс
      TTS._startChecked = true;
      try { await Journal.init(); } catch (e) { /* ignore */ }
      try {
        const r = await runVoiceCheck(true);
        TTS.lastCheck = r;
        TTS.lastCheckAt = new Date().toLocaleTimeString('ru-RU');
        await renderVoiceState();
      } catch (e) { Journal.add('голос', 'автопроверка не удалась: ' + (e && e.message ? e.message : e)); }
    };
    // Первый жест человека = разрешение на озвучку. Раньше ждём его, потом проверяем.
    const once = () => {
      document.removeEventListener('pointerdown', once, true);
      document.removeEventListener('touchstart', once, true);
      // Разблокировка — ПРЯМО В ЖЕСТЕ, синхронно. Раньше «прогрев при запуске»
      // запускался таймером, без жеста: Chrome такой синтез глушит, и в журнале
      // было «не заговорил», хотя при нажатии кнопки голос звучал
      // (06.11, 18:02:36 против 18:03:11).
      try { TTS.prime(); } catch (e) { /* ignore */ }
      setTimeout(runStartCheck, 350);
    };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('touchstart', once, true);
    setTimeout(runStartCheck, 4000);      // на случай, если жестов не будет (стенд/автотест)
  } catch (e) { /* не критично */ }
  // Сверка версии с сервером: чтобы «обновил страницу, а баги те же» больше не
  // случалось (старая сборка из кеша service worker).
  try {
    setTimeout(() => { checkAppUpdate().catch(() => {}); }, 4000);
    setInterval(() => { checkAppUpdate().catch(() => {}); }, 300000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkAppUpdate().catch(() => {});
    });
  } catch (e) { /* не критично */ }
  // Надпись «Скрипты страницы не выполнились» — аварийная, для случая, когда не
  // выполнился НИ ОДИН скрипт. Как только boot начался, она врёт: меняем на
  // «Загрузка», а итог пишет selfCheck в конце.
  try {
    const scEl = document.getElementById('selfCheck');
    if (scEl) { scEl.textContent = 'Загрузка KOMA ' + VERSION + '…'; scEl.style.color = 'var(--dim)'; scEl.style.background = 'transparent'; }
  } catch (e) {}
  const step = async (name, fn) => {
    try { await fn(); } catch (e) {
      State.bootErrors.push(name + ': ' + ((e && e.message) || e));
      console.error('boot, шаг «' + name + '»', e);
    }
  };

  await step('кнопки', () => bindUI());
  await step('словарь', () => Words.load().catch(e => console.warn('словарь не загрузился', e)));
  await step('прокрутка', () => watchScroll());
  await step('голос', () => TTS.init());
  await step('голос из плагинов', () => {
    if (typeof Plugins === 'undefined' || !Plugins.present()) return;
    const v = Plugins.voice();
    if (v.engine) { try { VOICE.useEngine(v.engine); } catch (e) {} }
    if (v.rate > 0) { TTS.rate = v.rate; const r = $('#rngRate'); if (r) r.value = v.rate; }
    if (v.voice) {
      TTS.voice = (VOICE.voices() || []).find(x => x.name === v.voice) || null;
    }
  });
  await step('плагины: перечитать по событию', () => {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('koma-plugins', async () => {
      await Plugins.load();
      toast('Плагины перечитаны: ' + Plugins.list.length, 3000);
      syncPluginsUI();
    });
  });
  // Выбранный движок читаем ДО первой страницы: иначе первый же скан мог уйти
  // не туда (в сеть или, наоборот, локально) вопреки сохранённому выбору.
  await step('вид движка', () => syncEngineUI());
  await step('плагины', () => Plugins.load());
  await step('правила', async () => {
    const saved = await DB.get('kv', 'rules');
    // Правила прогоняем через sanitizeRules ВСЕГДА, даже без сохранённых:
    // иначе на чистой установке профиль скорости не применялся, и «Быстро»
    // (pageSide 1280, без перебора) оставалось только словом в настройках.
    let parsedRules = {};
    if (saved) { try { parsedRules = JSON.parse(saved.v) || {}; } catch (e) { console.warn(e); } }
    // Плагины главнее сохранённых настроек: это правка, которую принесли файлом.
    const fromPlugins = (typeof Plugins !== 'undefined') ? Plugins.rules() : {};
    const fixes = (typeof Plugins !== 'undefined') ? Plugins.wordFixes() : {};
    RULES = sanitizeRules(parsedRules, fromPlugins);
    if (Object.keys(fixes).length) {
      RULES.wordFixes = { ...(RULES.wordFixes || {}), ...fixes };
    }
  });
  await step('рамки', () => {
    // Раньше эта настройка жила только в памяти Reader: после перезапуска
    // приложения рамки пропадали. Теперь она в правилах — по умолчанию включена.
    Reader.frames = RULES.frames !== false;
    const b = $('#btnFrames'); if (b) b.classList.toggle('hot', Reader.frames);
    const cb = $('#cbFrames'); if (cb) cb.checked = Reader.frames;
    Reader.paintAllFrames();
  });
  await step('настройки чтения по умолчанию', () => ReadDefaults.load());
  await step('библиотека', () => Library.load());
  await step('модели: список', () => renderModels());
  await step('движок распознавания', () => {
    // Нативный путь не требует ни WASM, ни 11 МБ движка в странице: страница
    // только спрашивает у приложения, готовы ли модели.
    if (typeof NativeOcr !== 'undefined' && NativeOcr.ready() && RULES.ocrEngine !== 'wasm') {
      OCR.ready = true; OCR.engine = 'native';
    }
  });
  await step('модели: загрузка', async () => {
    if (OCR.ready && OCR.engine === 'native') return;   // считаем нативно
    const ok = await OCR.loadModels().catch(e => { console.warn('модели не загрузились', e); return false; });
    if (!ok) {
      // В АПК страница собирается БЕЗ onnxruntime-web (build.sh: LITE): считает
      // нативный движок. Если и он не поднялся — говорим прямо, а не «нужна сеть».
      const ortOff = (typeof ort === 'undefined');
      toast(ortOff
        ? 'Распознавание недоступно: в этой сборке нет встроенного движка, а нативный не поднялся. Откройте ⚙ и посмотрите состояние моделей'
        : 'Модели есть, но движок не загрузился — нужна сеть для onnxruntime-web', 6000);
    }
    // Модели НЕ вшиты в файл (так файл в 2,5 раза легче). Их даёт человек через
    // ⚙ → Модели: detection.onnx, cyrillic.onnx, cyrillic.txt.
    if (!(await DB.get('kv', 'model:det'))) {
      toast('Модели не загружены. Откройте ⚙ → Модели и выберите 3 файла (det, rec, словарь)', 8000);
    }
  });
  await step('сведения о правилах', () => renderRulesInfo());
  await step('плагины: показать', () => syncPluginsUI());
  await step('подсказка о движке', () => {
  });
  await step('баннер среды', () => showEnvBanner());
  await step('самопроверка', () => selfCheck());
  if (typeof setTimeout === 'function') setTimeout(() => { selfCheck().catch(() => {}); }, 2500);
  await step('состояние движка', () => {
    if (typeof ort === 'undefined') {
      $('#ortState').textContent = 'onnxruntime-web не загрузился: нет сети или открыто в предпросмотре без интернета.';
    }
  });
// ── PWA (1.0.27) ───────────────────────────────────────────────────────────
// Та же страница ставится на главный экран и работает без сети: service worker
// держит в кеше саму страницу и модели. Регистрация нужна только по http(s):
// в АПК страница лежит в file:// и service worker там невозможен — молча выходим.
// В песочнице (sandbox="allow-scripts" без allow-same-origin) даже чтение
// navigator.serviceWorker бросает SecurityError — и человек видел «Ошибка: …».
// Поэтому весь блок под try/catch: нет офлайн-кеша — просто идём дальше.
// Регистрируем только рядом с app-shell (index.html или корень): иначе одиночный
// файл вроде koma-standalone.html просил несуществующий sw.js и в консоли
// появлялся 404 — пусть и безвредный, но человек читает его как поломку.
const isAppShell = /(\/|index\.html)$/.test(location.pathname);
if (isAppShell && /^https?:$/.test(location.protocol)) try {
  if ('serviceWorker' in navigator) {
  // Регистрируем сразу, а не по событию load: скрипт стоит в конце документа,
  // к этому моменту DOM готов, а ждать load на 11-МБ странице — терять секунды.
  navigator.serviceWorker.register('sw.js', { scope: './' }).then(reg => {
    // Пока приложение открыто, проверяем обновление раз в час — иначе новая
    // версия всплывает только после перезапуска.
    setInterval(() => reg.update().catch(() => {}), 3600 * 1000);
  }).catch(e => console.warn('service worker не зарегистрировался', e));
  }
} catch (e) { console.warn('service worker недоступен в этой среде', e); }
})();
</script>
</body>
</html>
