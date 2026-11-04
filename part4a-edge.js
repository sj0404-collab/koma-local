/**
 * EDGE TTS — нейроголоса Microsoft Edge прямо из страницы, без сервера.
 *
 * Зачем: в Android WebView нет Web Speech, а системный Android TTS на стенде
 * часто без русского голоса. Голоса Edge (ru-RU-Дмитрий, ru-RU-Светлана)
 * заметно живее системных, а весь синтез — один WebSocket-апдейт к
 * speech.platform.bing.com: ни ключей, ни аккаунта, ни своего сервера.
 *
 * Что пришлось сделать (и почему это не «просто fetch»):
 *  • сервис требует подпись Sec-MS-GEC версии 2 — «<CS64>-<SHA-256>» от
 *    текущего времени, округлённого вниз до 5 минут, и токена клиента. Это
 *    НЕ обычный SHA-256: библиотека edge-tts использует подправленные
 *    константы (антибот). Порт этих констант и CS64-свёртки — ниже; свере­но
 *    с edge-tts побайтово на фиксированных метках времени;
 *  • сервис отклоняет (403) любой User-Agent, где нет «Edg/». Поэтому в АПК
 *    WebView представляется Edge (см. MainActivity), а здесь мы честно
 *    проверяем, что нас пустили, и говорим причину, если нет;
 *  • аудио приходит кусками по 48 кбит/с (audio-24khz-48kbitrate-mono-mp3) —
 *    собираем в Blob и играем обычным <audio>, поэтому подсветка реплик и
 *    очередь чтения работают как с системным синтезом.
 *
 * Замер (лаборатория, Chromium, реальная сеть, 04.11):
 *   «Ты видишь меня? Ах, не ответила в LINE.» → 27 936 Б mp3 за 2,6 с
 *   «Проверка.» (ru-RU-SvetlanaNeural)        → 11 232 Б за 0,6 с
 * Дальше строки кэшируются по (голос, скорость, текст) — повтор без сети.
 */
const EDGE = {
  VOICES: [
    { id: 'ru-RU-DmitryNeural', label: 'Дмитрий (ru, мужской)' },
    { id: 'ru-RU-SvetlanaNeural', label: 'Светлана (ru, женский)' },
    { id: 'ru-RU-DariyaNeural', label: 'Дария (ru, женский)' },
    { id: 'en-US-AriaNeural', label: 'Aria (en)' },
  ],
  _cache: new Map(),
  _audio: null, _url: '', _run: 0, _lastError: '',

  /** Выбранный онлайн-голос; пусто — движок выключен. */
  chosen() {
    try { return localStorage.getItem('koma.edgeVoice') || ''; } catch (e) { return ''; }
  },
  setChosen(id) {
    try { localStorage.setItem('koma.edgeVoice', String(id || '')); } catch (e) { /* приватный режим */ }
  },
  /** Готов ли движок вообще: есть WebSocket и выбран голос. */
  active() { return !!this.chosen() && typeof WebSocket !== 'undefined'; },
  /** Пустит ли сервис этот User-Agent (ему нужен «Edg/»). */
  uaOk() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return /Edg\//.test(ua);
  },
  label() {
    const v = this.VOICES.find(x => x.id === this.chosen());
    return 'Edge: ' + (v ? v.label : this.chosen());
  },
  lastError() { return this._lastError; },

  // ── подпись запроса (порт edge-tts/drm.py) ────────────────────────────────
  _sha(dataBytes) {
    const U32 = 0xFFFFFFFF;
    const u = (x) => x >>> 0;
    const rotr = (v, n) => u((u(v) >>> n) | (u(v) << (32 - n)));
    const sig0 = (v) => u(rotr(v, 7) ^ rotr(v, 18) ^ (u(v) >>> 3));
    const sig1 = (v) => u(rotr(v, 17) ^ rotr(v, 19) ^ (u(v) >>> 10));
    const bs0 = (v) => u(rotr(v, 2) ^ rotr(v, 13) ^ rotr(v, 22));
    const bs1 = (v) => u(rotr(v, 6) ^ rotr(v, 11) ^ rotr(v, 25));
    const mul = (a, b) => u(Math.imul(a, b));
    const INIT = [0x6A09E667,0xBB67AE85,0x3C6EF372,0xA54FF53A,0x510E527F,0x9B05688C,0x1F83D9AB,0x5BE0CD19];
    const STATE = [0xFD9FBEA2,0x91243CE7,0xBE499094,0xCD2E1E0A,0x6C006F49,0x04BD35AB,0xFEB0A7E4,0x03EFFBD2];
    const SCHED = [0xEB24BF9E,0x1558691F,0xA0C09EE2,0x0CFA32BA,0xA622EE8C,0xD1DD9491,0xC0DD25A0,
      0xF9E70AB6,0xF0C31573,0x7058CE4E,0x7188E606,0x00E5AB33,0xD258B060,0x72766564];
    const ROUND = [0x428A2F98,0x71374491,0xB5C0FBCF,0xE9B5DBA5,0x3956C25B,0x59F111F1,0x923F82A4,0xAB1C5ED5,
      0xD807AA98,0x12835B01,0x243185BE,0x550C7DC3,0x72BE5D74,0x80DEB1FE,0x9BDC06A7,0xC19BF174,0xE49B69C1,0xEFBE4786,
      0x0FC19DC6,0x240CA1CC,0x2DE92C6F,0x4A7484AA,0x5CB0A9DC,0x76F988DA,0x983E5152,0xA831C66D,0xB00327C8,0xBF597FC7,
      0xC6E00BF3,0xD5A79147,0x06CA6351,0x14292967,0x27B70A85,0x2E1B2138,0x4D2C6DFC,0x53380D13,0x650A7354,0x766A0ABB,
      0x81C2C92E,0x92722C85,0xA2BFE8A1,0xA81A664B,0xC24B8B70,0xC76C51A3,0xD192E819,0xD6990624,0xF40E3585,0x106AA070,
      0x19A4C116,0x1E376C08,0x2748774C,0x34B0BCB5,0x391C0CB3,0x4ED8AA4A,0x5B9CCA4F,0x682E6FF3,0x748F82EE,0x78A5636F,
      0x84C87814,0x8CC70208,0x90BEFFFA,0xA4506CEB,0xBEF9A3F7,0xC67178F2];
    const ADJ = 0xC9DC06A7;
    const BLOCK = ROUND.slice(0, 14).concat([ADJ], ROUND.slice(15));
    const SIG0_ADJ = 0x059C0B80, SIG1_ADJ = 0x000B92C0;
    const expand = (w, first) => {
      for (let i = first || 16; i < 64; i++) w.push(u(sig1(w[i - 2]) + w[i - 7] + sig0(w[i - 15]) + w[i - 16]));
    };
    const rounds = (state, words, firstRound) => {
      let [a, b, c, d, e, f, g, h] = state.map(u);
      const K = firstRound === 14 ? BLOCK : ROUND;
      for (let i = firstRound || 0; i < 64; i++) {
        const t1 = u(h + bs1(e) + (g ^ (e & (f ^ g))) + K[i] + (words[i] || 0));
        const t2 = u(bs0(a) + ((a & b) | (c & (a | b))));
        h = g; g = f; f = e; e = u(d + t1); d = c; c = b; b = a; a = u(t1 + t2);
      }
      return [a, b, c, d, e, f, g, h];
    };
    const head = dataBytes.slice(0, 7);
    const words = new Array(14).fill(0);
    words.push(u((head[0] << 16) | (head[1] << 8) | head[2]));
    words.push(u((head[3] << 24) | (head[4] << 16) | (head[5] << 8) | head[6]));
    for (let i = 16; i < 30; i++) {
      let v = SCHED[i - 16];
      if (i - 2 >= 14) v += (i === 16) ? u(sig1(words[i - 2]) ^ SIG1_ADJ) : sig1(words[i - 2]);
      if (i - 7 >= 14) v += words[i - 7];
      if (i - 15 >= 14) v += (i === 29) ? u(sig0(words[i - 15]) ^ SIG0_ADJ) : sig0(words[i - 15]);
      words.push(u(v));
    }
    words.push(u(sig1(words[28]) + words[23] + sig0(words[15]) + words[14] + ADJ - ROUND[14]));
    expand(words, 31);
    const working = rounds(STATE, words, 14);
    let state = INIT.map((x, i) => u(x + working[i]));
    const length = 57 + dataBytes.length;
    const padded = dataBytes.slice(7).concat([0x80]);
    const zeros = (((55 - length) % 64) + 64) % 64;    // как в Python: считаем НУЛИ
    for (let i = 0; i < zeros; i++) padded.push(0);
    const bits = BigInt(length * 8);
    for (let i = 7; i >= 0; i--) padded.push(Number((bits >> BigInt(i * 8)) & 0xFFn));
    for (let off = 0; off + 64 <= padded.length; off += 64) {
      const w = [];
      for (let i = 0; i < 16; i++) {
        const p = off + i * 4;
        w.push(u((padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3]));
      }
      expand(w);
      const out = rounds(state, w, 0);
      state = state.map((x, i) => u(x + out[i]));
    }
    const bytes = [];
    for (const v of state) bytes.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF);
    return bytes;
  },
  _cs64(dataBytes, digest) {
    const U32 = 0xFFFFFFFF;
    const u = (x) => x >>> 0;
    const mul = (a, b) => u(Math.imul(a, b));
    const rol16 = (v) => u((u(v) << 16) | (u(v) >>> 16));
    const CO = [[0xE82E91B1,0xB32700D0],[0x44DE24C6,0x88DFF51D],[0x3BEB65BC,0x29514038],[0xC89C5933,0xB328CBDF],
      [0x8D1EC211,0xD405B4D5],[0x314EF5D5,0x26E55F3C],[0xE92491B1,0x607801C6],[0xF0A5B9D5,0x82B2C1FB],
      [0x06064CF3,0xFA51A3DA],[0xDA79FA60,0x207CC464],[0xBED20560,0x3C3C74F3],[0x89F9C9F8,0xD2D14B61],
      [0x35FA38C6,0xBB04A2C1],[0xCB49E3C6,0xC5626167]];
    const FACTOR = 0x82893933, ADJ0 = 0xF2F90B1A, ADJ1 = 0x0B1A0000;
    const keyA = u(((digest[0]) | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) | 1);
    const keyB = u(((digest[4]) | (digest[5] << 8) | (digest[6] << 16) | (digest[7] << 24)) | 1);
    const factors = [mul(keyA, FACTOR), mul(keyB, FACTOR)];
    const terms = CO.map(([c], i) => mul(c, factors[i % 2]));
    const offsets = CO.map(([, o]) => u(o));
    const src = [0].concat(dataBytes);
    while (src.length % 4) src.push(0);
    const w4 = [];
    for (let i = 0; i < src.length; i += 4)
      w4.push(u(src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)));
    if (w4.length % 2) w4.push(0);
    w4.forEach((word, i) => {
      let term = mul(word, i % 2 === 0 ? keyA : keyB);
      let off = mul(rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
      if (i === 0) { term = u(term + mul(ADJ0, factors[0])); off = u(off + ADJ1); }
      terms.push(u(term)); offsets.push(u(off));
    });
    let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
    for (let i = 0; i < terms.length; i += 2) {
      const x = terms[i], y = terms[i + 1];
      let t = rol16(u(offsets[i] + x));
      let q = mul(t, 0x76F50F34);
      swapAcc = u(swapAcc + u(mul(rol16(q), 0xC3EFEA97) + q));
      t = rol16(u(offsets[i + 1] + y));
      q = mul(t, 0x1881CE3C);
      swapLast = u(mul(rol16(q), 0x35BD1EC9) + q);
      swapAcc = u(swapAcc + swapLast);
      state = u(mul(state, keyA) + x);
      state = mul(rol16(state), 0xCF98B111);
      state = mul(rol16(state), 0x87085B9F);
      state = mul(rol16(state), 0x12CEB96D);
      state = mul(rol16(state), 0x257E1D83);
      acc = u(acc + state);
      t = u(mul(state, keyB) + y);
      t = mul(rol16(t), 0xA27416F5);
      t = mul(rol16(t), 0xD38396FF);
      state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69);
      acc = u(acc + state);
    }
    return [u(swapLast ^ state), u(swapAcc ^ acc)];
  },
  /** Sec-MS-GEC v2 для момента unixTime (секунды). */
  gec(unixTime) {
    const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    let ticks = (unixTime == null ? Date.now() / 1000 : unixTime) + 11644473600;
    ticks -= ticks % 300;
    ticks = ticks * 1e9 / 100;
    const text = String(Math.round(ticks)) + TRUSTED;
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
    const digest = this._sha(bytes);
    const cs = this._cs64(bytes, digest);
    const le = (a) => [a & 0xFF, (a >>> 8) & 0xFF, (a >>> 16) & 0xFF, (a >>> 24) & 0xFF];
    const hex = (arr) => arr.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex(le(cs[0]).concat(le(cs[1]))) + '-' + hex(digest);
  },

  // ── сеть ─────────────────────────────────────────────────────────────────
  _hex16() {
    const b = new Uint8Array(16);
    try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0; }
    return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  },
  /** Синтез одной фразы: mp3 байтами. */
  synth(text, voice, rate) {
    const v = voice || this.chosen() || this.VOICES[0].id;
    const pct = Math.round((Math.max(0.5, Math.min(2, rate || 1)) - 1) * 100);
    const prosody = (pct >= 0 ? '+' : '') + pct + '%';
    const safe = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
      + '?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'
      + '&Sec-MS-GEC=' + this.gec()
      + '&Sec-MS-GEC-Version=2-143.0.3650.75'
      + '&ConnectionId=' + this._hex16();
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(new Error('WebSocket недоступен')); return; }
      ws.binaryType = 'arraybuffer';
      const chunks = [];
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch (e) { /* уже закрыт */ }
        if (err) { this._lastError = err.message || String(err); reject(err); }
        else resolve(new Blob(chunks, { type: 'audio/mpeg' }));
      };
      const timer = setTimeout(() => done(new Error('Edge не ответил за 15 с')), 15000);
      ws.onopen = () => {
        const d = new Date().toUTCString();
        ws.send('X-Timestamp:' + d + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
          + JSON.stringify({ context: { synthesis: { audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
        const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'>"
          + "<voice name='" + v + "'><prosody pitch='+0Hz' rate='" + prosody + "' volume='+0%'>"
          + safe + '</prosody></voice></speak>';
        ws.send('X-RequestId:' + this._hex16() + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:'
          + d + '\r\nPath:ssml\r\n\r\n' + ssml);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          if (ev.data.indexOf('turn.end') >= 0) done(null);
          return;
        }
        const buf = new Uint8Array(ev.data);
        if (buf.length < 2) return;
        const hl = (buf[0] << 8) | buf[1];
        const head = (typeof TextDecoder !== 'undefined')
          ? new TextDecoder().decode(buf.subarray(2, 2 + hl)) : '';
        if (head.indexOf('Path:audio') >= 0 || !head) chunks.push(buf.slice(2 + hl));
      };
      ws.onerror = () => done(new Error(this.uaOk()
        ? 'Edge отклонил соединение (403): проверьте интернет'
        : 'Edge пускает только браузер Edge: в этой обёртке другой User-Agent'));
      ws.onclose = (e) => { if (chunks.length) done(null); else done(new Error('Edge закрыл соединение: ' + (e && e.code))); };
    });
  },

  // ── чтение ───────────────────────────────────────────────────────────────
  speak(text, opts) {
    opts = opts || {};
    this.stop();
    const run = ++this._run;
    const voice = this.chosen() || this.VOICES[0].id;
    const key = voice + '|' + (opts.rate || 1) + '|' + text;
    const play = (blob) => {
      if (run !== this._run) return;
      try {
        this._url = URL.createObjectURL(blob);
        const a = new Audio(this._url);
        this._audio = a;
        a.onplaying = () => { if (run === this._run && opts.onstart) opts.onstart(); };
        a.onended = () => { if (run === this._run && opts.onend) opts.onend(); };
        // stop() обнуляет src — это НЕ ошибка сети и не повод пугать человека
        // тостом «Голос не сказал: edge:audio» (поймано скриншотом 04.11).
        a.onerror = () => {
          if (run !== this._run) return;
          if (opts.onerror) opts.onerror({ error: 'edge:audio' });
        };
        const p = a.play();
        if (p && p.catch) p.catch((e) => { if (opts.onerror) opts.onerror({ error: 'edge:' + (e && e.name) }); });
      } catch (e) { if (opts.onerror) opts.onerror({ error: 'edge:play' }); }
    };
    const cached = this._cache.get(key);
    if (cached) { play(cached); return true; }
    this.synth(text, voice, opts.rate)
      .then((blob) => {
        if (this._cache.size > 40) this._cache.clear();
        this._cache.set(key, blob);
        play(blob);
      })
      .catch((err) => { if (run === this._run && opts.onerror) opts.onerror({ error: 'edge:' + (err.message || err) }); });
    return true;
  },
  /** Заранее синтезировать следующую реплику: без этого между репликами
   *  слышна пауза в 0,8–4 с (сеть). Замер: старт без заготовки 787–3941 мс,
   *  из кэша — 7 мс. */
  prefetch(text, rate, voice) {
    if (!this.active()) return;
    const v = voice || this.chosen() || this.VOICES[0].id;
    const key = v + '|' + (rate || 1) + '|' + text;
    if (!text || this._cache.has(key)) return;
    this.synth(text, v, rate)
      .then((blob) => { if (this._cache.size > 40) this._cache.clear(); this._cache.set(key, blob); })
      .catch(() => { /* заготовка не обязана удаваться */ });
  },
  pause() { if (this._audio) { try { this._audio.pause(); return true; } catch (e) { return false; } } return false; },
  resume() { if (this._audio) { try { const p = this._audio.play(); if (p && p.catch) p.catch(() => {}); return true; } catch (e) { return false; } } return false; },
  stop() {
    this._run++;
    if (this._audio) {
      try { this._audio.pause(); this._audio.src = ''; } catch (e) { /* уже нет */ }
      this._audio = null;
    }
    if (this._url) { try { URL.revokeObjectURL(this._url); } catch (e) { /* ignore */ } this._url = ''; }
  },
};
