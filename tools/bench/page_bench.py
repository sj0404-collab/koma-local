# -*- coding: utf-8 -*-
"""Замер чтецов ЧЕРЕЗ НАСТОЯЩИЙ ПУТЬ: страница → детектор → резка на строки → чтец.

Прошлый замер (engine_bench.py) мерил заранее нарезанные чистые строки, и его
цифры не сошлись с телефоном — на настоящей странице кропы другие: с фоном
облачка, с шумом JPEG, с масштабом. Здесь тот же путь, что в приложении:
детектор ищет блоки, блок режется на строки по проекции, и уже ЭТА строка
уходит чтецу. Один и тот же детектор и одна и та же резка для всех чтецов.

Метрики по странице:
  · найдено слов (сколько настоящих слов эталона встретилось);
  · точность (доля верных среди того, что чтец выдал);
  · сколько строк прошло порог уверенности 0.25.
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, '/home/user/lab')
import pipeline as P  # noqa: E402

A = Path('/home/user/kl/apk/app/src/main/assets/models')
PAGES = Path('/home/user/manhwa-shots/pages')
LABEL = Path('/home/user/label-work')

DICT_BIG = [""] + (A / 'charset.txt').read_text(encoding='utf-8').splitlines() + [" "]
DICT_SMALL = list((A / 'eslav-charset.txt').read_text(encoding='utf-8').rstrip('\n'))
BLANK_SMALL = 109

ENGINES = {
    'rec': dict(path=A / 'rec.onnx', kind='big'),
    'eslav': dict(path=A / 'eslav.onnx', kind='small'),
    'r3': dict(path=A / 'best_base_r3.onnx', kind='small'),
    'r4': dict(path=A / 'best_finetuned_r4.onnx', kind='small'),
}

# страница → (эталон, стиль)
CASES = [
    ('comic1x5-p1.png', 'comic1x5.gt.txt', 'комикс'),
    ('comic1x7-p1.png', 'comic1x7.gt.txt', 'комикс'),
    ('kuro-p2.png', 'kuro-p2.gt.txt', 'манга'),
    ('manhua2-p2.png', 'manhua2-p2.gt.txt', 'маньхуа'),
    ('manhua3x2-p1.png', 'manhua3x2.gt.txt', 'маньхуа'),
    ('tyrant-p1.png', 'tyrant-p1.gt.txt', 'вебтун'),
    ('tyrant-p2.png', 'tyrant-p2.gt.txt', 'вебтун'),
]


def norm_words(s):
    s = (s or '').upper().replace('Ё', 'Е')
    s = re.sub(r'[^А-ЯA-Z0-9 ]+', ' ', s)
    return [w for w in s.split() if w]


class Engine:
    def __init__(self, cfg):
        self.s = ort.InferenceSession(str(cfg['path']), providers=['CPUExecutionProvider'])
        self.kind = cfg['kind']
        self.inp = self.s.get_inputs()[0].name

    def read(self, crop_rgb):
        if self.kind == 'big':
            ch, cw = crop_rgb.shape[:2]
            width = int(np.clip(round(48 * cw / ch), 8, 960))
            padded = max(320, width)
            canvas = np.full((48, padded, 3), 128, dtype=np.uint8)
            canvas[:, :width] = P.resize_to(crop_rgb, width, 48)
            x = np.transpose((canvas.astype(np.float32) / 255.0 - 0.5) / 0.5, (2, 0, 1))[None]
            logits = self.s.run(None, {self.inp: x})[0][0]
            return self._ctc(logits, DICT_BIG, 0)
        gray = (0.299 * crop_rgb[:, :, 0] + 0.587 * crop_rgb[:, :, 1] + 0.114 * crop_rgb[:, :, 2]).astype(np.uint8)
        ch, cw = gray.shape[:2]
        width = int(np.clip(round(32 * cw / ch), 8, 2000))
        im = Image.fromarray(gray).resize((width, 32), Image.BILINEAR)
        a = np.asarray(im).astype(np.float32) / 255.0
        x = (a * 2 - 1)[None, None]
        logits = self.s.run(None, {self.inp: x})[0]
        logits = logits.reshape(-1, logits.shape[-1])
        return self._ctc(logits, DICT_SMALL, BLANK_SMALL)

    @staticmethod
    def _ctc(logits, dictionary, blank):
        out, prev = [], blank
        for row in logits:
            best = int(np.argmax(row))
            if best != blank and best != prev and best < len(dictionary):
                out.append(dictionary[best])
            prev = best
        return ''.join(out)


def page_lines(img, boxes):
    out = []
    for box in boxes[:400]:
        for line in P.text_lines(img, box):
            crop = img[line[1]:line[3], line[0]:line[2]]
            if crop.size == 0:
                continue
            if crop.shape[0] > crop.shape[1] * 1.8:
                crop = np.rot90(crop, k=-1)
            out.append(crop)
    return out


def gt_words(name):
    words = []
    for raw in (LABEL / name).read_text(encoding='utf-8').splitlines():
        if not raw.strip():
            continue
        body = raw.split(':', 1)[1] if ':' in raw else raw
        for part in body.split('|'):
            words += norm_words(part.replace('*', ''))
    return words


def run(only=None):
    det = P.Models()
    engines = {name: Engine(cfg) for name, cfg in ENGINES.items()}
    result = {}
    for page, gtfile, style in CASES:
        path = PAGES / page
        if not path.exists():
            print('нет страницы', page)
            continue
        if only and style not in only:
            continue
        img = np.array(Image.open(path).convert('RGB'))
        H, W = img.shape[:2]
        boxes = P.detect_page(det, img)[:400]
        crops = page_lines(img, boxes)
        want = gt_words(gtfile)
        print('\n=== %-18s %-8s блоков %2d, строк %3d, слов в эталоне %3d'
              % (page, style, len(boxes), len(crops), len(want)))
        for name, eng in engines.items():
            got = []
            passed = 0
            for crop in crops:
                t = eng.read(crop)
                if t.strip():
                    passed += 1
                    got += norm_words(t)
            gs = set(got)
            found = sum(1 for w in want if w in gs)
            hit = sum(1 for w in got if w in set(want))
            prec = hit / len(got) if got else 0.0
            rec = found / len(want) if want else 0.0
            result.setdefault(name, {}).setdefault(style, []).append((rec, prec, passed))
            print('   %-6s строк %3d/%3d  слов %3d  нашли %2.0f %%  точность %2.0f %%'
                  % (name, passed, len(crops), len(got), rec * 100, prec * 100))
    print('\n=== итог по стилям (нашли / точность)')
    for name, per in result.items():
        line = []
        for style, vals in per.items():
            r = sum(v[0] for v in vals) / len(vals)
            p = sum(v[1] for v in vals) / len(vals)
            line.append('%s: %2.0f/%2.0f %%' % (style, r * 100, p * 100))
        print('   %-6s ' % name + '   '.join(line))
    Path('/home/user/kl/tools/bench/page_bench.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    run(set(sys.argv[1:]) or None)
