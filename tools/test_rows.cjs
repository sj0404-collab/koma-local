#!/usr/bin/env node
/**
 * Тест «строки облачка в правильном порядке».
 *
 * Жалоба 07.11, 09:21: титул «Как прожить / жизнь, будучи старшей / сестрой
 * тирана» читался «Как прожить сестрой тирана. жизнь будучи старшей» — третья
 * строка попадала в одну «строку» со второй (перекрытие по вертикали из-за
 * наклона каллиграфии), а внутри строки манга читается справа налево.
 *
 * Запуск: node tools/test_rows.cjs
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PART3 = fs.readFileSync(path.join(ROOT, 'part3.js'), 'utf8');

function extract(name) {
  const start = PART3.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('в part3.js нет функции ' + name);
  let depth = 0;
  const i = PART3.indexOf('{', start);
  for (let j = i; j < PART3.length; j++) {
    if (PART3[j] === '{') depth++;
    else if (PART3[j] === '}') { depth--; if (depth === 0) return PART3.slice(start, j + 1); }
  }
  throw new Error('нет конца функции ' + name);
}
const buildRows = new Function('return ' + extract('buildRows'))();
const P = (text, top, bottom, left, right) => ({ text, top, bottom, left, right });

let bad = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  ок    ' + name); return; }
  bad++; console.log('  БЕДА  ' + name + '\n        получено: ' + JSON.stringify(got) + '\n        ожидалось: ' + JSON.stringify(want));
};

// Строки каллиграфии налезают друг на друга по вертикали на 58 % меньшей
// высоты (наклонный шрифт), x-диапазоны почти совпадают — это РАЗНЫЕ строки.
// Именно такой случай дал жалобу 07.11: «Как прожить сестрой тирана. жизнь
// будучи старшей» вместо трёх строк сверху вниз.
const titleRows = [
  P('КАК ПРОЖИТЬ',           0.100, 0.160, 0.30, 0.70),
  P('жизнь, будучи старшей', 0.125, 0.185, 0.25, 0.75),
  P('сестрой тирана',        0.150, 0.210, 0.30, 0.70),
];
eq('три наклонные строки читаются сверху вниз',
  buildRows(titleRows, true).flatMap(r => r.parts.map(p => p.text)),
  ['КАК ПРОЖИТЬ', 'жизнь, будучи старшей', 'сестрой тирана']);

// «Как было» в v1.9.101 — воспроизводим старую группировку один в один, чтобы
// в отчёте был не пересказ, а вывод. Старое правило: «одна строка» = всё, что
// перекрывается по вертикали больше половины меньшей высоты; внутри строки
// сортировка по X (для манги справа налево). Никакого учёта горизонтали.
function buildRowsOld(block, rtl) {
  const rows = [];
  for (const part of block.slice().sort((a, b) => a.top - b.top)) {
    const h = Math.max(part.bottom - part.top, 1e-6);
    const row = rows.find((r) => {
      const oy = Math.min(r.bottom, part.bottom) - Math.max(r.top, part.top);
      return oy > Math.min(h, r.height) * 0.5;
    });
    if (row) {
      row.parts.push(part);
      row.top = Math.min(row.top, part.top);
      row.bottom = Math.max(row.bottom, part.bottom);
      row.height = row.bottom - row.top;
    } else {
      rows.push({ top: part.top, bottom: part.bottom, height: h, parts: [part] });
    }
  }
  for (const r of rows) r.parts.sort((a, b) => (rtl ? b.left - a.left : a.left - b.left));
  return rows;
}
const wasOld = buildRowsOld(titleRows, true).flatMap(r => r.parts.map(p => p.text));
const wasNew = buildRows(titleRows, true).flatMap(r => r.parts.map(p => p.text));
console.log('        было (v1.9.101): ' + wasOld.join(' / '));
console.log('        стало (v1.9.102): ' + wasNew.join(' / '));
eq('старое правило действительно путало порядок (контроль)',
  wasOld.join(' / '), 'КАК ПРОЖИТЬ / сестрой тирана / жизнь, будучи старшей');

// Части ОДНОЙ строки: стоят рядом по горизонтали (x не перекрываются).
const oneLine = [
  P('ВЫСО-', 0.30, 0.36, 0.55, 0.70),
  P('ЧЕСТВО', 0.305, 0.365, 0.72, 0.90),
];
eq('две части одной строки — справа налево для манги',
  buildRows(oneLine, true).flatMap(r => r.parts.map(p => p.text)),
  ['ЧЕСТВО', 'ВЫСО-']);

eq('те же части для комикса — слева направо',
  buildRows(oneLine, false).flatMap(r => r.parts.map(p => p.text)),
  ['ВЫСО-', 'ЧЕСТВО']);

// Обычное облачко: три строки с зазором.
const bubble = [
  P('УЖЕ ПОРА НА-', 0.50, 0.54, 0.2, 0.8),
  P('ЧИНАТЬ ВСТРЕЧУ,', 0.56, 0.60, 0.2, 0.8),
  P('ТАК ЧТО ЕЁ ВЫСО-', 0.62, 0.66, 0.2, 0.8),
];
eq('обычное облачко: порядок сверху вниз',
  buildRows(bubble, true).flatMap(r => r.parts.map(p => p.text)),
  ['УЖЕ ПОРА НА-', 'ЧИНАТЬ ВСТРЕЧУ,', 'ТАК ЧТО ЕЁ ВЫСО-']);

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nвсё зелёное: строки облачка собираются сверху вниз');
process.exit(bad ? 1 : 0);
