# -*- coding: utf-8 -*-
"""Замер движков распознавания на размеченных страницах (по строкам).

Разметка — label-work/*.gt.txt: «номер пузыря: строка | строка». Нарезки строк
лежат рядом (comic1x5-00.png …) и идут в том же порядке, что строки в gt:
сначала пузыри по порядку, внутри пузыря — строки сверху вниз. Скрипт это
проверяет (число строк = число нарезок) и только потом меряет.

Считаем на строку: точность букв (1 − Левенштейн / длина эталона) и совпала ли
строка целиком. Никакой словарной починки: меряем САМ движок.
"""
from __future__ import annotations
import glob
import json
import re
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

LABEL = Path('/home/user/label-work')
A = Path('/home/user/kl/apk/app/src/main/assets/models')
DICT_BIG = [""] + (A / 'charset.txt').read_text(encoding='utf-8').splitlines() + [" "]
# У малых движков словарь — сами 109 знаков (0…108), а пустой символ CTC — 109.
# Проверено на нарезках: с другой раскладкой выходит мусор вида «Р9Р9К9З9Ю9».
DICT_SMALL = list((A / 'eslav-charset.txt').read_text(encoding='utf-8').rstrip('\n'))
BLANK_SMALL = 109

ENGINES = {
    'основной (rec, 519 знаков)': dict(path=A / 'rec.onnx', kind='big'),
    'тёмный (base_r3)': dict(path='/home/user/koma_models/extra/best_base_r3.onnx', kind='small'),
    'светлый (ft_r4)': dict(path='/home/user/koma_models/extra/best_finetuned_r4.onnx', kind='small'),
    'славянский (eslav)': dict(path=A / 'eslav.onnx', kind='small'),
}

SETS = [
    ('comic1x5', 'comic1x5.gt.txt', 'комикс'),
    ('manhua3x2', 'manhua3x2.gt.txt', 'маньхуа'),
    ('m3x2', 'manhua3x2.gt.txt', 'маньхуа'),
]


def gt_lines(name):
    out = []
    for raw in (LABEL / name).read_text(encoding='utf-8').splitlines():
        if not raw.strip():
            continue
        body = raw.split(':', 1)[1] if ':' in raw else raw
        for part in body.split('|'):
            t = part.replace('*', '').strip()
            if t:
                out.append(t)
    return out


def norm(s):
    s = (s or '').upper().replace('Ё', 'Е')
    s = re.sub(r'[^А-ЯA-Z0-9 ]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def lev(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def decode(logits, dictionary, blank=0):
    out, prev = [], blank
    for row in logits:
        best = int(np.argmax(row))
        if best != blank and best != prev and best < len(dictionary):
            out.append(dictionary[best])
        prev = best
    return ''.join(out)


class Engine:
    def __init__(self, cfg):
        self.s = ort.InferenceSession(str(cfg['path']), providers=['CPUExecutionProvider'])
        self.kind = cfg['kind']
        self.inp = self.s.get_inputs()[0].name

    def read(self, path):
        img = Image.open(path).convert('L' if self.kind == 'small' else 'RGB')
        h = 32 if self.kind == 'small' else 48
        w = max(8, int(round(img.width * h / max(1, img.height))))
        img = img.resize((w, h), Image.BILINEAR)
        a = np.asarray(img).astype(np.float32) / 255.0
        if self.kind == 'small':
            x = ((a - 0.5) / 0.5)[None, None]
            logits = self.s.run(None, {self.inp: x})[0]
            # у разных моделей время то во второй оси, то в первой — приводим
            logits = logits.reshape(-1, logits.shape[-1])
            return decode(logits, DICT_SMALL, BLANK_SMALL)
        x = np.transpose((a - 0.5) / 0.5, (2, 0, 1))[None]
        logits = self.s.run(None, {self.inp: x})[0][0]
        return decode(logits, DICT_BIG)


def sim(a, b):
    """Похожесть двух строк 0..1 — чтобы выровнять нарезки с эталоном по порядку."""
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    return 1.0 - lev(a, b) / max(len(a), len(b))


def align(anchor, gt):
    """Выравнивание нарезок с эталоном: порядок сохраняется, пропуски с обеих
    сторон разрешены. Возвращает пары (индекс нарезки, индекс эталона)."""
    n, m = len(anchor), len(gt)
    GAP = 0.25
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = score[i - 1][0] - GAP
        back[i][0] = 'up'
    for j in range(1, m + 1):
        score[0][j] = score[0][j - 1] - GAP
        back[0][j] = 'left'
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            s = sim(anchor[i - 1], gt[j - 1])
            diag = score[i - 1][j - 1] + (s - GAP if s >= 0.15 else -GAP)
            up = score[i - 1][j] - GAP
            left = score[i][j - 1] - GAP
            best = max(diag, up, left)
            score[i][j] = best
            back[i][j] = 'diag' if best is diag else ('up' if best is up else 'left')
    pairs, i, j = [], n, m
    while i > 0 and j > 0:
        step = back[i][j]
        if step == 'diag':
            if sim(anchor[i - 1], gt[j - 1]) >= 0.15:
                pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif step == 'up':
            i -= 1
        else:
            j -= 1
    return list(reversed(pairs))


def run():
    engines = {name: Engine(cfg) for name, cfg in ENGINES.items()}
    summary = {}
    seen = set()
    for prefix, gtfile, style in SETS:
        if style in seen:
            continue
        files = sorted(glob.glob(str(LABEL / (prefix + '-[0-9][0-9].png'))))
        gt = gt_lines(gtfile)
        print('\n=== %s: %s — нарезок %d, строк в эталоне %d' % (style, gtfile, len(files), len(gt)))
        if not files or not gt:
            print('   пустой набор')
            continue
        seen.add(style)
        # Нарезок и строк в эталоне может быть разное число (в эталоне перенос
        # записан двумя строками, а нарезано одной). Поэтому сначала выравниваем
        # по порядку по самому сильному движку, а потом ВСЕ движки меряем на
        # одних и тех же парах — иначе сравнение было бы нечестным.
        reads = {}
        for name, eng in engines.items():
            reads[name] = [eng.read(f) for f in files]
        anchor_name = max(reads, key=lambda k: sum(1 for t in reads[k] if t))
        pairs = align(reads[anchor_name], gt)
        print('   пар после выравнивания: %d (нарезок %d, строк %d), опора — %s'
              % (len(pairs), len(files), len(gt), anchor_name))
        for name, eng in engines.items():
            acc_sum = exact = 0
            for fi, gi in pairs:
                got = reads[name][fi]
                a, b = norm(gt[gi]), norm(got)
                acc = 0.0 if not b else max(0.0, 1 - lev(a, b) / max(1, len(a)))
                acc_sum += acc
                exact += 1 if a == b else 0
            n = max(1, len(pairs))
            summary.setdefault(name, {})[style] = (acc_sum / n, exact / n)
            print('   %-28s буквы %5.1f %%   строки целиком %d/%d' % (name, acc_sum / n * 100, exact, len(pairs)))
    print('\n=== итог по стилям')
    for name, per in summary.items():
        print('   %-28s ' % name + '  '.join('%s: %4.1f %%' % (k, v[0] * 100) for k, v in per.items()))
    Path('/home/user/kl/tools/bench/engine_bench.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    run()
