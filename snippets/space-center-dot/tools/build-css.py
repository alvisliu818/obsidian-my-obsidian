"""Build the two self-contained Obsidian CSS snippets from tools/b64.json.

Usage (from anywhere):

    python tools/gen-fonts.py     # regenerate the inline WOFF2 fonts
    python tools/build-css.py     # rebuild both CSS files

Outputs, next to this ``tools/`` directory:

    ../space-center-dot.css      -- 300 variant (Obsidian default text stack)
    ../space-center-dot-cjk.css  -- 500 variant (CJK fonts, half-width space
                                   ~0.5em, e.g. LXGW WenKai / 霞鹜文楷)

Deploy manually: copy ONE of them into ``<vault>/.obsidian/snippets/`` and
enable it under Settings > Appearance > CSS snippets. No plugin is needed --
the six WOFF2 fonts are embedded as data URIs inside the single CSS file.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SNIPPET_DIR = HERE.parent
B64 = json.loads((HERE / "b64.json").read_text(encoding="utf-8"))

FACES = []
for tag in ("250", "300", "330", "500", "600", "1000"):
    name = "ObsSpaceDotFull" if tag == "1000" else "ObsSpaceDot" + tag
    rng = "U+3000" if tag == "1000" else "U+0020, U+00A0"
    FACES.append(
        '@font-face {\n'
        f'  font-family: "{name}";\n'
        f'  src: url("data:font/woff2;base64,{B64[tag]}") format("woff2");\n'
        f'  unicode-range: {rng};\n'
        '  font-weight: 100 900;\n'
        '  font-style: normal;\n'
        '  font-display: swap;\n'
        '}\n'
    )

TEMPLATE = """/* ===========================================================
   space-center-dot · 空格显示小中心圆点
   纯 CSS / 不依赖任何插件 / 字体已内嵌，单文件可用。
__BANNER__
   原理：@font-face + unicode-range 只接管空格字符
   (U+0020 半角空格、U+00A0 不换行空格、U+3000 全角空格)，
   把它们画成一个几何居中的小圆点（水平 = 空格宽的一半，
   垂直 = em 框正中）；其它字符仍由原字体渲染，文字本身
   的颜色、字重、字号、主题字体设置都不受影响。
   注：COLR 层字形的 hmtx.lsb 必须与轮廓 xMin 一致，否则
   Chrome 会把圆点整体左移，看起来不居中（2026-11-15 已修）。

   圆点是 COLR 彩色字形，颜色写在内嵌字体的 CPAL 调色板里：
   默认 rgba(110,116,124,.50) = 中性灰 + 半透明，不再跟随正文黑色；
   深色主题由下方 @font-palette-values 覆盖为 rgba(214,219,228,.78)。

   【部署】把本文件复制到 <库>/.obsidian/snippets/，
     设置 → 外观 → CSS 片段 → 刷新并启用；停用即关闭，无残留。
   【选变体】正文为西文 / Obsidian 默认字体栈用
     space-center-dot.css（300 变体）；正文为中文（霞鹜文楷等，
     半角空格 ≈ 0.5em）用 space-center-dot-cjk.css（500 变体）。
     可用开发者工具测「空格宽度 ÷ font-size」得到实际比值。
   【阅读视图】默认只作用于编辑区（源码模式 + 实时预览）。
     需要阅读视图也显示，删掉文件末尾「阅读视图」段首尾的两处注释标记。
   【调宽度】下面两个变量要跟当前库的正文字体空格宽度一致，
   否则每个空格会变宽/变窄、排版会移动：
     ObsSpaceDot250 ≈ 0.25em  多数西文比例字体
     ObsSpaceDot300 ≈ 0.30em  Obsidian 默认字体栈（实测 0.296em）
     ObsSpaceDot330 ≈ 0.33em  略宽的系统 UI 字体
     ObsSpaceDot500 ≈ 0.50em  中文半角空格（如霞鹜文楷）
     ObsSpaceDot600 ≈ 0.60em  等宽字体（如 Cascadia Mono）
   【调颜色/透明度】改 tools/gen-fonts.py 的 DOT_COLOR；
     深色主题色改下方 @font-palette-values 的 override-colors。
   【调点的大小】改 DOT_RADIUS 后重新生成即可。
   【重建】python tools/gen-fonts.py && python tools/build-css.py
   =========================================================== */

__FACES__
:root {
  --space-dot-text: __TEXT_VARIANT__;  /* 正文空格宽度，见上方说明 */
  --space-dot-mono: "ObsSpaceDot600";  /* 代码/等宽区空格宽度 */
}

/* ---- 深色主题：把调色板换成更亮的灰；浅色主题用字体内置 CPAL ---- */
@font-palette-values --space-dot-dark {
  font-family: "ObsSpaceDot250", "ObsSpaceDot300", "ObsSpaceDot330",
               "ObsSpaceDot500", "ObsSpaceDot600", "ObsSpaceDotFull";
  override-colors: 0 rgba(214, 219, 228, 0.78);
}
.theme-dark .markdown-source-view.mod-cm6 .cm-editor,
.theme-dark .markdown-source-view.mod-cm6 .cm-line {
  font-palette: --space-dot-dark;
}

/* ---- 编辑区：源码模式 + 实时预览 ---- */
.markdown-source-view.mod-cm6 .cm-editor,
.markdown-source-view.mod-cm6 .cm-scroller,
.markdown-source-view.mod-cm6 .cm-content,
.markdown-source-view.mod-cm6 .cm-line {
  font-family: var(--space-dot-text), "ObsSpaceDotFull", var(--font-text) !important;
}

/* ---- 代码块 / 行内代码 / frontmatter（等宽字体） ---- */
.markdown-source-view.mod-cm6 .cm-line.HyperMD-codeblock,
.markdown-source-view.mod-cm6 .cm-line.HyperMD-frontmatter,
.markdown-source-view.mod-cm6 .cm-hmd-codeblock,
.markdown-source-view.mod-cm6 .cm-hmd-frontmatter,
.markdown-source-view.mod-cm6 .cm-inline-code {
  font-family: var(--space-dot-mono), "ObsSpaceDotFull", var(--font-monospace) !important;
}

/* ---- 阅读视图：默认关闭，需要时删掉本段首尾的注释标记 ---- */
/*
.markdown-reading-view .markdown-preview-view,
.markdown-reading-view .markdown-rendered {
  font-family: var(--space-dot-text), "ObsSpaceDotFull", var(--font-text) !important;
}
.markdown-reading-view .markdown-rendered :is(code, pre, kbd) {
  font-family: var(--space-dot-mono), "ObsSpaceDotFull", var(--font-monospace) !important;
}
*/
"""

CJK_BANNER = """   【变体】本文件正文空格宽度 0.5em，适配霞鹜文楷等中文正文字体；
     西文/Obsidian 默认字体栈请改用同目录 space-center-dot.css。"""


def write(name, text_variant, banner=""):
    css = (TEMPLATE
           .replace("__FACES__", "\n".join(FACES))
           .replace("__TEXT_VARIANT__", '"ObsSpaceDot' + text_variant + '"')
           .replace("__BANNER__", banner))
    out = SNIPPET_DIR / name
    out.write_text(css, encoding="utf-8")
    print("wrote", out, len(css), "chars")


def main():
    write("space-center-dot.css", "300")
    write("space-center-dot-cjk.css", "500", CJK_BANNER)


if __name__ == "__main__":
    main()
