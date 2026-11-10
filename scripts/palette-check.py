#!/usr/bin/env python3
"""
THE PALETTE, MEASURED (comments tab decisions 7.3; 2026-11-10).

Reads the channel colours and the state tones from app/globals.css, the one
place they are written, and prints:
  - each colour's contrast (WCAG 2.x) on a card, the ground, the field's
    darkest point, and a dark ground;
  - every pair's CIEDE2000 distance as seen with normal vision,
    deuteranopia, protanopia and tritanopia (Machado 2009, severity 1.0),
    flagging any pair under 10.
Run it after changing a colour: the numbers in the --channel-* comment in
globals.css came from it.

    python3 scripts/palette-check.py
"""
import itertools
import math
import pathlib
import re

CSS = pathlib.Path(__file__).resolve().parent.parent / 'app' / 'globals.css'
CHANNELS = ['whatsapp', 'facebook', 'instagram', 'website']
STATES = ['positive', 'critical', 'neutral']
GROUNDS = {'card~white': '#ffffff', 'ground': '#f5f5f6', 'field-darkest': '#fbe9d6', 'dark-ground': '#161616'}


def tokens():
    root = CSS.read_text().split(':root {', 1)[1].split('\n}\n', 1)[0]
    values = dict(re.findall(r'--([a-z0-9-]+):\s*([^;]+);', root))

    def resolve(value):
        value = value.strip()
        ref = re.fullmatch(r'var\(--([a-z0-9-]+)\)', value)
        return resolve(values[ref.group(1)]) if ref else value

    out = {name: resolve(values[f'channel-{name}']) for name in CHANNELS}
    out.update({name: resolve(values[name]) for name in STATES})
    for name, value in out.items():
        assert re.fullmatch(r'#[0-9a-fA-F]{6}', value), f'{name} is not a 6-digit hex: {value}'
    return out


def rgb(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def unlin(c):
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def luminance(h):
    r, g, b = [lin(x) for x in rgb(h)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    hi, lo = sorted([luminance(a), luminance(b)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


MACHADO = {
    'deutan': [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    'protan': [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    'tritan': [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
}


def simulate(h, kind):
    if kind == 'normal':
        return rgb(h)
    v = [lin(x) for x in rgb(h)]
    m = MACHADO[kind]
    return [unlin(sum(m[i][j] * v[j] for j in range(3))) for i in range(3)]


def lab(c):
    r, g, b = [lin(x) for x in c]
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))


def ciede2000(p, q):
    l1, a1, b1 = p
    l2, a2, b2 = q
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)
    cb = (c1 + c2) / 2
    g = 0.5 * (1 - math.sqrt(cb ** 7 / (cb ** 7 + 25 ** 7)))
    a1p, a2p = a1 * (1 + g), a2 * (1 + g)
    c1p, c2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1 = math.degrees(math.atan2(b1, a1p)) % 360
    h2 = math.degrees(math.atan2(b2, a2p)) % 360
    dl, dc = l2 - l1, c2p - c1p
    dh = h2 - h1
    if c1p * c2p == 0:
        dh = 0
    elif dh > 180:
        dh -= 360
    elif dh < -180:
        dh += 360
    dhh = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(dh / 2))
    lb, cbp = (l1 + l2) / 2, (c1p + c2p) / 2
    hb = (h1 + h2) / 2 if abs(h1 - h2) <= 180 else (h1 + h2 + 360) / 2
    if c1p * c2p == 0:
        hb = h1 + h2
    t = (1 - 0.17 * math.cos(math.radians(hb - 30)) + 0.24 * math.cos(math.radians(2 * hb))
         + 0.32 * math.cos(math.radians(3 * hb + 6)) - 0.2 * math.cos(math.radians(4 * hb - 63)))
    sl = 1 + 0.015 * (lb - 50) ** 2 / math.sqrt(20 + (lb - 50) ** 2)
    sc, sh = 1 + 0.045 * cbp, 1 + 0.015 * cbp * t
    rt = -2 * math.sqrt(cbp ** 7 / (cbp ** 7 + 25 ** 7)) * math.sin(math.radians(60 * math.exp(-((hb - 275) / 25) ** 2)))
    return math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dhh / sh) ** 2 + rt * (dc / sc) * (dhh / sh))


def main():
    palette = tokens()
    print(f'from {CSS}\ncontrast:')
    for name, value in palette.items():
        print(f'  {name:10} {value}  ' + '  '.join(f'{g} {contrast(value, gv):.2f}' for g, gv in GROUNDS.items()))
    print('pairwise CIEDE2000 (normal / deutan / protan / tritan); under 10 flagged:')
    for (a, av), (b, bv) in itertools.combinations(palette.items(), 2):
        d = [ciede2000(lab(simulate(av, k)), lab(simulate(bv, k))) for k in ('normal', 'deutan', 'protan', 'tritan')]
        print(f'  {a:10} {b:10} ' + ' / '.join(f'{x:5.1f}' for x in d) + (' <--' if min(d) < 10 else ''))


if __name__ == '__main__':
    main()
