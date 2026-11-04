#!/usr/bin/env node
/**
 * Тест последней чистки реплики (polishLineText) на строках С ТЕЛЕФОНА.
 *
 * Источник случаев — скриншоты 4.11 (v1.9.62, нативный движок): именно они
 * показали, что починка двойников не доходит до реплик, которые приложение
 * собрало у себя. Тест берёт настоящие функции из part3.js и настоящий словарь.
 *
 * Запуск: node tools/test_lines.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const PART3 = fs.readFileSync(path.join(ROOT, 'part3.js'), 'utf8');
const DICT = fs.readFileSync(path.join(ROOT, 'part0-dict.js'), 'utf8');

function extractBlock(head) {
  const start = PART3.indexOf(head);
  if (start < 0) throw new Error('в part3.js нет ' + head.slice(0, 50));
  const paren = PART3.indexOf('(', start);
  let pd = 0, closeParen = paren;
  for (let k = paren; k < PART3.length; k++) {
    if (PART3[k] === '(') pd++;
    else if (PART3[k] === ')') { pd--; if (pd === 0) { closeParen = k; break; } }
  }
  let depth = 0, i = PART3.indexOf('{', closeParen);
  for (let j = i; j < PART3.length; j++) {
    if (PART3[j] === '{') depth++;
    else if (PART3[j] === '}') { depth--; if (depth === 0) return PART3.slice(start, j + 1); }
  }
  throw new Error('не нашёл конца ' + head.slice(0, 50));
}
function extractStmt(head) {
  const start = PART3.indexOf(head);
  if (start < 0) throw new Error('нет ' + head);
  const end = PART3.indexOf(';\n', start);
  return PART3.slice(start, end + 1);
}

// ── словарь: те же rank/isKnown/inDict, что строит Words.load() ─────────────
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
  ready: true,
  isKnown(w) { const r = rank.get(String(w).toLowerCase()); return r !== undefined && r <= KNOWN_RANK; },
  inDict(w) { return rank.get(String(w).toLowerCase()) !== undefined; },
};

const lookStart = PART3.indexOf('const LOOKALIKES = {');
const lookEnd = PART3.indexOf('\n};', lookStart) + 3;
const body = [
  PART3.slice(lookStart, lookEnd),
  extractStmt('const LOOKALIKE_BASE ='),
  extractStmt('const GREEK = new Set('),
  extractLine('const isRusLetter ='),
  extractStmt('const LATIN_KEEP ='),
  extractBlock('function fixLookalikes(raw, opts = {})'),
  extractBlock('function cyrifyInsideWords(text)'),
  extractBlock('function splitGluedWords(text)'),
  extractBlock('function glueBrokenHalves(text)'),
  extractBlock('function polishLineText(raw)'),
  extractBlock('function isLookalikeOnly(text, opts = {})'),
  extractBlock('function fixLookalikesForced(raw, opts = {})'),
  extractStmt('const SHORT_COMMON ='),
  extractBlock('function fixConfusedShortWords(text)'),
  extractStmt('const SINGLE_TWINS ='),
  extractBlock('function cyrifySingleLetters(text)'),
  extractBlock('function trimJunkEdges(text)'),
  extractBlock('function fixCaseInCaps(text)'),
  extractBlock('function median('),
  extractBlock('function glueSplitWords(text)'),
  'module.exports = { polishLineText };',
].join('\n');
function extractLine(head) {
  const start = PART3.indexOf(head);
  if (start < 0) throw new Error('нет ' + head);
  const end = PART3.indexOf('\n', start);
  return PART3.slice(start, end);
}

const mod = { exports: {} };
new Function('Words', 'module', 'console', body)(Words, mod, console);
const { polishLineText } = mod.exports;

// Строки дословно со скриншотов телефона (v1.9.62, 4.11).
// null — строку надо выбросить целиком (это не реплика, а мусор).
const CASES = [
  ['ЭЙ, МИЧИРУЯ ТУТ ПОДУМАЛАw', 'ЭЙ, МИЧИРУЯ ТУТ ПОДУМАЛА'],
  ['сапьYwb', 'сапь'],
  ['оГО ПОХОЖЕ УЫ ОЧЕНЬ ЗАНЯТА!', 'ОГО ПОХОЖЕ ВЫ ОЧЕНЬ ЗАНЯТА!'],
  ['ПОКА НЕ СОБИРА ЮСЬ.', 'ПОКА НЕ СОБИРАЮСЬ.'],
  ['ЗНА4ИТ ТЫМОЖЕШЬ И От НаС УЕХАТЬ?', 'ЗНАЧИТ ТЫ МОЖЕШЬ И ОТ НАС УЕХАТЬ?'],
  ['О ЧЕМ ТЬ?', 'О ЧЕМ ТЫ?'],
  ['ПРОСТО КОГДА ТЫYowb ГОВОРИЛА ПО ТЕЛЕФОНУ ХОРОШО.', 'ПРОСТО КОГДА ТЫ ГОВОРИЛА ПО ТЕЛЕФОНУ ХОРОШО.'],
  ['ПОДР ЖИЛИ', 'ПОДР ЖИЛИ'],
  ['БЫЛО БЫВ ФРЫСТНО ЕСЛИ БЫ ТЫ УЕХАЛА.', 'БЫЛО БЫВ ФРЫСТНО ЕСЛИ БЫ ТЫ УЕХАЛА.'],
  ['А ПОЧЕМУ ТЫ ПЕРЕВЕЛАСЬ В НАШУ ШКОЛУ?', 'А ПОЧЕМУ ТЫ ПЕРЕВЕЛАСЬ В НАШУ ШКОЛУ?'],
  ['ДУМАЮ МНЕ ПРИС НИТС9 КОШМАР.', 'ДУМАЮ МНЕ ПРИСНИТСЯ КОШМАР.'],
];

let bad = 0, mixed = 0;
for (const [input, want] of CASES) {
  const got = polishLineText(input);
  const ok = got === want;
  if (!ok) bad++;
  const mixedWords = got.split(/\s+/).filter(w => /[\u0400-\u04FF]/.test(w) && /[A-Za-z]/.test(w));
  if (mixedWords.length) mixed++;
  console.log((ok ? '  ок  ' : '  БЕДА') + '  ' + JSON.stringify(input) + ' → ' + JSON.stringify(got)
    + (ok ? '' : '   ожидалось ' + JSON.stringify(want)));
}
console.log(mixed ? `\nсмесь латиницы с кириллицей осталась: ${mixed}` : '\nсмеси латиницы с кириллицей в строках нет');
console.log(bad ? `ПРОВАЛОВ: ${bad}` : 'всё зелёное');
process.exit(bad ? 1 : 0);
