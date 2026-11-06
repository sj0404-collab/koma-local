#!/usr/bin/env node
/**
 * Тест склейки слова, разорванного переносом («ВЛ ИТЬ» → «ВЛИТЬ»).
 *
 * Запуск:  node tools/test_glue.cjs
 *
 * Тест берёт НАСТОЯЩИЙ словарь из part0-dict.js (тот же, что вшит в страницу),
 * настоящий исходник функции из part3.js — и проверяет ровно те случаи, на
 * которые жаловался человек 4.11:
 *   «Некоторые читает только одну строку из нескольких… слово на две части
 *    разбивает и читает не как одно целое: Вл ить, Вол нуе…»
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const PART3 = fs.readFileSync(path.join(ROOT, 'part3.js'), 'utf8');
const DICT = fs.readFileSync(path.join(ROOT, 'part0-dict.js'), 'utf8');

function extract(name) {
  const start = PART3.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('в part3.js нет функции ' + name);
  let depth = 0, i = PART3.indexOf('{', start);
  for (let j = i; j < PART3.length; j++) {
    if (PART3[j] === '{') depth++;
    else if (PART3[j] === '}') { depth--; if (depth === 0) return PART3.slice(start, j + 1); }
  }
  throw new Error('не нашёл конца функции ' + name);
}

// ── словарь: те же rank, что строит Words.load() ─────────────────────────────
const b64 = /DICT_GZ_B64 = '([^']+)'/.exec(DICT)[1];
const text = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
const rank = new Map();
let n = 0;
for (const line of text.split('\n')) {
  const w = line.split(/\s+/)[0];
  if (!w) continue;
  const low = w.toLowerCase();
  if (!rank.has(low)) rank.set(low, n);
  n++;
}
const KNOWN_RANK = 50000;
const Words = {
  ready: n > 1000,
  rank,
  isKnown(w) { const r = rank.get(String(w).toLowerCase()); return r !== undefined && r <= KNOWN_RANK; },
  inDict(w) { return rank.get(String(w).toLowerCase()) !== undefined; },
};

const sandbox = { Words, console };
const src = [
  extract('median'),
  extract('glueSplitWords'),
  'module.exports = { glueSplitWords, median };',
].join('\n');
const mod = { exports: {} };
new Function('Words', 'module', 'console', src)(Words, mod, console);
const { glueSplitWords } = mod.exports;

// ── случаи: [вход, ожидание] ─────────────────────────────────────────────────
const CASES = [
  // жалоба 4.11 дословно
  ['МНЕ НАДО ВЛ ить это', 'МНЕ НАДО ВЛИТЬ это'],
  ['ОН ВОЛ НУ ЕТСЯ КАЖДЫЙ ДЕНЬ', 'ОН ВОЛНУЕТСЯ КАЖДЫЙ ДЕНЬ'],
  ['ОН ВОЛ НУЕТСЯ КАЖДЫЙ ДЕНЬ', 'ОН ВОЛНУЕТСЯ КАЖДЫЙ ДЕНЬ'],
  ['ВОЛ нуе тся', 'ВОЛНУЕТСЯ'],
  ['ВЛ ИТЬ', 'ВЛИТЬ'],
  ['У МЕНЯ ЕСТЬ ДЕ ЛО', 'У МЕНЯ ЕСТЬ ДЕЛО'],
  // не должно трогать настоящие фразы
  ['ДА НЕТ', 'ДА НЕТ'],
  ['ПОЧЕМУ БЫ И НЕТ', 'ПОЧЕМУ БЫ И НЕТ'],
  ['ОНА ВСЁ ЕЩЁ ШЕПЧЕТ', 'ОНА ВСЁ ЕЩЁ ШЕПЧЕТ'],
  ['ПОЖАЛУЙСТА, ПОЗВОЛЬ МНЕ ДО ОТВАЛА ПОЕСТЬ ВКУСНОЙ ЕДЫ',
   'ПОЖАЛУЙСТА, ПОЗВОЛЬ МНЕ ДО ОТВАЛА ПОЕСТЬ ВКУСНОЙ ЕДЫ'],
  ['Я НЕ МОГУ ПОВЕРИТЬ ЧТО ТЫ СДЕЛАЛ ЭТО СОБСТВЕННЫМИ РУКАМИ',
   'Я НЕ МОГУ ПОВЕРИТЬ ЧТО ТЫ СДЕЛАЛ ЭТО СОБСТВЕННЫМИ РУКАМИ'],
  ['ПО ТОМУ БЕРЕГУ', 'ПО ТОМУ БЕРЕГУ'],       // «по воде» ≠ «поводе»
  // Регрессия 06.11, 20:41 (v1.9.98): «склейка обрывков» склеивала ДВА
  // настоящих слова — «НЕ ОН ВЫБРОСИЛ» читалось «НЕОНИВЫБРОСИЛ», «НА
  // УРЕЗАНИЕ» — «наурезание». Частые слова (не, он, на, то, же) не склеиваем.
  ['РАЗВЕ НЕ ОН ВЫБРОСИЛ ТАКИМ ОБРАЗОМ ПАНТЕЮ', 'РАЗВЕ НЕ ОН ВЫБРОСИЛ ТАКИМ ОБРАЗОМ ПАНТЕЮ'],
  ['НОЯ НЕ ЖАЛУЮСЬ НА УРЕЗАНИЕ РАСХОДОВ,', 'НОЯ НЕ ЖАЛУЮСЬ НА УРЕЗАНИЕ РАСХОДОВ,'],
  ['И СПОКОЙНО ЛИШИЛ ТИТУЛА НАСЛЕДНИКА?', 'И СПОКОЙНО ЛИШИЛ ТИТУЛА НАСЛЕДНИКА?'],
];

let bad = 0;
for (const [input, want] of CASES) {
  const got = glueSplitWords(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? '  ок  ' : '  БЕДА') + '  ' + JSON.stringify(input) + ' → ' + JSON.stringify(got)
    + (ok ? '' : '   ожидалось ' + JSON.stringify(want)));
}
console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nвсё зелёное: склейка переноса работает, настоящие фразы не тронуты');
process.exit(bad ? 1 : 0);
