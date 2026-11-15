"""Generate the tiny inline WOFF2 fonts used by the space-center-dot snippet.

Usage (from anywhere):

    python tools/gen-fonts.py

Writes ``tools/b64.json`` -- base64 of six self-contained WOFF2 fonts. No
binary font files are left on disk. Requires ``fonttools`` and ``brotli``
(``pip install --user fonttools brotli``). Then run ``build-css.py`` to
rebuild both CSS snippets.

The space glyph (U+0020 / U+00A0 / U+3000) is empty; its visible dot is a
COLRv0 layer glyph painted from CPAL, so the dot has its own grey colour +
alpha instead of inheriting ``currentColor`` (solid black text).

!! TrueType detail that cost a debugging round: ``hmtx.lsb`` MUST equal the
!! layer glyph's ``xMin``. With lsb = 0 Chrome applies an ``lsb - xMin``
!! correction while rasterising the colour layer and the dot lands at
!! ``x = lsb + radius`` instead of ``x = advance / 2`` -- visibly left of the
!! space centre. Setting lsb = xMin removes the correction.
"""
import base64
import io
import json
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.colorLib.builder import buildCOLR, buildCPAL

OUT = Path(__file__).with_name("b64.json")

UPM = 1000
ASCENT, DESCENT = 800, -200
# CPAL colour of the dot: neutral grey, 50% alpha. The dark theme overrides
# palette entry 0 with a brighter grey in the CSS (@font-palette-values).
DOT_COLOR = (110 / 255, 116 / 255, 124 / 255, 0.50)  # rgba(110,116,124,.50)

# advance width in font units -> fraction of em. Pick the variant that matches
# the vault's text font so layout does not shift.
VARIANTS = {
    "250": 250,    # most proportional Latin UI fonts (~0.25em)
    "300": 300,    # Obsidian default text stack, measured ~0.296em
    "330": 330,    # Segoe UI / system UI on Windows (~0.33em)
    "500": 500,    # CJK fonts, half-width space (~0.5em)
    "600": 600,    # monospace fonts such as Cascadia Mono (~0.6em)
    "1000": 1000,  # full-width space
}
DOT_RADIUS = 58          # ~0.116em diameter => ~1.9px at 16px
# Exact geometric centre of the em box: from DESCENT(-200) to ASCENT(800).
# Horizontal centre is advance/2, so the dot is centred in every space glyph.
DOT_CENTER_Y = (ASCENT + DESCENT) / 2
CUBIC_K = 0.5522847498307936


def dot_glyph(cx):
    ttpen = TTGlyphPen(None)
    pen = Cu2QuPen(ttpen, 1.0)
    r, cy, k = DOT_RADIUS, DOT_CENTER_Y, DOT_RADIUS * CUBIC_K
    pen.moveTo((cx, cy + r))
    pen.curveTo((cx + k, cy + r), (cx + r, cy + k), (cx + r, cy))
    pen.curveTo((cx + r, cy - k), (cx + k, cy - r), (cx, cy - r))
    pen.curveTo((cx - k, cy - r), (cx - r, cy - k), (cx - r, cy))
    pen.curveTo((cx - r, cy + k), (cx - k, cy + r), (cx, cy + r))
    pen.closePath()
    return ttpen.glyph()


def build(tag, advance):
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder([".notdef", "space", "dot"])
    # The full-width variant owns only U+3000; the others own ASCII/NBSP spaces.
    cmap = {0x3000: "space"} if tag == "1000" else {0x20: "space", 0xA0: "space"}
    fb.setupCharacterMap(cmap)
    # "space" is an empty base glyph; its visible dot is a colour layer ("dot").
    fb.setupGlyf({
        ".notdef": TTGlyphPen(None).glyph(),
        "space": TTGlyphPen(None).glyph(),
        "dot": dot_glyph(advance / 2),
    })
    # hmtx.lsb of the layer glyph MUST equal its xMin (= advance/2 - radius).
    # advance is kept equal to the base "space" glyph for metric consistency.
    dot_lsb = int(advance / 2 - DOT_RADIUS)
    fb.setupHorizontalMetrics({".notdef": (500, 0), "space": (advance, 0),
                               "dot": (advance, dot_lsb)})
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT)
    family = "ObsSpaceDot" + tag
    fb.setupNameTable({
        "familyName": family,
        "styleName": "Regular",
        "uniqueFontIdentifier": "ObsSpaceDot " + tag + " 2026",
        "fullName": family + " Regular",
        "psName": family.replace(" ", "") + "-Regular",
        "version": "Version 1.000",
    })
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=DESCENT,
                usWinAscent=ASCENT, usWinDescent=-DESCENT)
    fb.setupPost()
    fb.font["COLR"] = buildCOLR({"space": [("dot", 0)]})
    fb.font["CPAL"] = buildCPAL([[DOT_COLOR]])
    fb.font.flavor = "woff2"
    buf = io.BytesIO()
    fb.font.save(buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def main():
    result = {tag: build(tag, adv) for tag, adv in VARIANTS.items()}
    OUT.write_text(json.dumps(result, indent=1), encoding="utf-8")
    for tag, b64 in result.items():
        print(tag, "woff2 bytes:", len(base64.b64decode(b64)), "base64:", len(b64))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
