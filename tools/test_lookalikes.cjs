#!/usr/bin/env node
/**
 * Тест починки двойников: латиница и греческий внутри русских реплик.
 *
 * Жалоба 4.11: «в репликах знаки дельта, лямбда вместо кириллицы». Тест берёт
 * НАСТОЯЩИЕ функции из part3.js (не копии) и проверяет известные случаи.
 *
 * Запуск: node tools/test_lookalikes.cjs
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PART3 = fs.readFileSync(path.join(ROOT, 'part3.js'), 'utf8');

function extractBlock(head) {
  const start = PART3.indexOf(head);
  if (start < 0) throw new Error('в part3.js нет ' + head.slice(0, 40));
  // Параметры могут содержать {} (например, opts = {}), поэтому ищем тело
  // функции ПОСЛЕ закрывающей скобки параметров, иначе совпадение ломается.
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
  throw new Error('не нашёл конца ' + head.slice(0, 40));
}
function extractStmt(head) {
  const start = PART3.indexOf(head);
  if (start < 0) throw new Error('в part3.js нет ' + head);
  const end = PART3.indexOf(';\n', start);
  return PART3.slice(start, end + 1);
}
function extractLine(head) {
  const start = PART3.indexOf(head);
  if (start < 0) throw new Error('в part3.js нет ' + head);
  const end = PART3.indexOf('\n', start);
  return PART3.slice(start, end);
}

// LOOKALIKES — многострочный объект: берём до закрывающей «};» на нулевой колонке.
const lookStart = PART3.indexOf('const LOOKALIKES = {');
const lookEnd = PART3.indexOf('\n};', lookStart) + 3;
const LOOKALIKES_SRC = PART3.slice(lookStart, lookEnd);

const body = [
  LOOKALIKES_SRC,
  extractStmt("const GREEK = new Set("),
  extractLine("const isRusLetter ="),
  extractStmt('const LATIN_KEEP ='),
  extractStmt('const LOOKALIKE_BASE ='),
  extractBlock('function fixLookalikes(raw, opts = {})'),
  extractBlock('function cyrifyInsideWords(text)'),
  extractBlock('function isLookalikeOnly(text, opts = {})'),
  extractBlock('function fixLookalikesForced(raw, opts = {})'),
  'module.exports = { fixLookalikes, cyrifyInsideWords, isLookalikeOnly, fixLookalikesForced };',
].join('\n');

const mod = { exports: {} };
new Function('module', 'console', body)(mod, console);
const { fixLookalikes, cyrifyInsideWords } = mod.exports;

// Слово, где есть кириллица, не должно содержать латиницы или греческого.
const mixedWords = (line) => line.split(/\s+/).filter(w =>
  /[\u0400-\u04FF]/.test(w) && /[A-Za-z\u0370-\u03FF]/.test(w));

const CASES = [
  // жалоба 4.11 — греческий вместо кириллицы
  ['ΔЕЛЬТА', 'ДЕЛЬТА'],
  ['ΛЮБОВЬ', 'ЛЮБОВЬ'],
  ['ΛЮБОВЬ И ΔРУЖБА', 'ЛЮБОВЬ И ДРУЖБА'],
  ['λЮБОВЬ', 'ЛЮБОВЬ'],
  ['ΔλЯ ТЕБЯ', 'ДЛЯ ТЕБЯ'],
  ['OΦИΓETЬ', 'ОФИГЕТЬ'],          // мягкий знак в капсе — «b» → «Ь»
  ['ΣЛУШАЙ', 'СЛУШАЙ'],
  ['ΠРИВЕТ', 'ПРИВЕТ'],
  // заглавные латинские пары, которых не было в таблице
  ['DА, ЭТО Я', 'ДА, ЭТО Я'],
  ['HОЧЬ', 'НОЧЬ'],
  ['SТРАШНО', 'СТРАШНО'],
  ['VСЁ ХОРОШО', 'ВСЁ ХОРОШО'],
  ['ZДЕСЬ', 'ЗДЕСЬ'],
  ['WЁПОТ', 'ШЁПОТ'],
  // цифра в конце русского слова
  ['ДУМАЮ МНЕ ПРИС НИТС9 КОШМАР.', 'ДУМАЮ МНЕ ПРИС НИТСЯ КОШМАР.'],
  // настоящую латиницу и числа не трогаем
  ['АХ, НЕ ОТВЕТИЛА В LINE', 'АХ, НЕ ОТВЕТИЛА В LINE'],
  ['МНЕ 25 ЛЕТ', 'МНЕ 25 ЛЕТ'],
  ['WIFI WI-FI OK', 'WIFI WI-FI OK'],
  ['ЭТО KOMA 1.0.12', 'ЭТО KOMA 1.0.12'],
  // уже правильное не меняем
  ['ТЫ ВИДИШЬ МЕНЯ?', 'ТЫ ВИДИШЬ МЕНЯ?'],
  ['ОФИГЕТЬ!', 'ОФИГЕТЬ!'],
];

let bad = 0, leftNonCyr = 0;
for (const [input, want] of CASES) {
  const got = cyrifyInsideWords(fixLookalikes(input));
  const ok = got === want;
  if (!ok) bad++;
  const mixed = mixedWords(got);
  if (mixed.length) { leftNonCyr++; console.log('       осталась смесь: ' + mixed.join(', ')); }
  console.log((ok ? '  ок  ' : '  БЕДА') + '  ' + JSON.stringify(input) + ' → ' + JSON.stringify(got)
    + (ok ? '' : '   ожидалось ' + JSON.stringify(want)));
}
console.log(leftNonCyr ? `\nСМЕСЬ латиницы/греческого с кириллицей: ${leftNonCyr} строк` : '\nсмеси латиницы/греческого с кириллицей нет');
console.log(bad ? `ПРОВАЛОВ: ${bad}` : 'всё зелёное');
process.exit(bad || leftNonCyr ? 1 : 0);
