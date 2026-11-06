#!/usr/bin/env node
/**
 * Тест «найденный текст не теряется при повторных проходах».
 *
 * Жалоба 06.11: «после распознавания текст, который он сканировал, теряется
 * неожиданно на последнем проходе — либо на 3-м, либо 4-м». Причина: результат
 * нового прохода полосы ЗАМЕНЯЛ прежний. Проверяем keepOldLines из part4.js:
 *   • реплика прежнего прохода, которой нет в новом, возвращается;
 *   • на том же месте остаётся ЛУЧШЕЕ чтение (по оценке текста);
 *   • порядок — сверху вниз.
 *
 * Запуск: node tools/test_keep.cjs
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PART4 = fs.readFileSync(path.join(ROOT, 'part4.js'), 'utf8');

function extract(name) {
  const start = PART4.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('в part4.js нет функции ' + name);
  let depth = 0;
  const i = PART4.indexOf('{', start);
  for (let j = i; j < PART4.length; j++) {
    if (PART4[j] === '{') depth++;
    else if (PART4[j] === '}') { depth--; if (depth === 0) return PART4.slice(start, j + 1); }
  }
  throw new Error('нет конца функции ' + name);
}

const Words = {
  ready: true, rank: new Map([['не', 1], ['он', 9], ['ты', 5], ['наследника', 800],
    ['жалуюсь', 400], ['урезание', 140889], ['расходов', 300]]),
  isKnown: (w) => ['не', 'он', 'ты', 'наследника', 'жалуюсь', 'расходов'].includes(w),
};
const code = extract('textScore') + '\n' + extract('keepOldLines') + '\nreturn { textScore, keepOldLines };';
const { keepOldLines } = new Function('Words', code)(Words);

const L = (text, top, left = 0.1, right = 0.6) => ({ text, top, bottom: top + 0.03, left, right });
let bad = 0;
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  ок    ' + name); return; }
  bad++; console.log('  БЕДА  ' + name + '\n        получено: ' + JSON.stringify(got) + '\n        ожидалось: ' + JSON.stringify(want));
};

// 1. Новый проход нашёл меньше — прежние реплики возвращаются.
check('новый проход нашёл 1 из 3 — все три остаются',
  keepOldLines([L('первая', 0.1), L('вторая', 0.3), L('третья', 0.5)], [L('вторая', 0.3)]).map(x => x.text),
  ['первая', 'вторая', 'третья']);

// 2. На том же месте новое чтение ЛУЧШЕ — остаётся новое.
check('лучшее чтение вытесняет прежнее',
  keepOldLines([L('туланаследника', 0.2)], [L('тула наследника', 0.2)]).map(x => x.text),
  ['тула наследника']);

// 3. На том же месте новое чтение ХУЖЕ — остаётся прежнее.
check('худшее чтение не затирает прежнее',
  keepOldLines([L('Ноя не жалуюсь на урезание расходов', 0.4)], [L('ИН', 0.4)]).map(x => x.text),
  ['Ноя не жалуюсь на урезание расходов']);

// 4. Разные места с одинаковым текстом не схлопываются.
check('две одинаковые реплики в разных местах',
  keepOldLines([L('ТЫ ВИДИШЬ МЕНЯ?', 0.2, 0.1, 0.4)], [L('ТЫ ВИДИШЬ МЕНЯ?', 0.2, 0.7, 0.95)]).map(x => x.text).length,
  2);

// 5. Порядок сверху вниз.
check('порядок сверху вниз',
  keepOldLines([L('низ', 0.7)], [L('верх', 0.1)]).map(x => x.text),
  ['верх', 'низ']);

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nвсё зелёное: найденный текст при повторных проходах не теряется');
process.exit(bad ? 1 : 0);
