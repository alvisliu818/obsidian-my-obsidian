/**
 * PowerPoint engine: renders .pptx slides (OOXML inside a ZIP) as a scrollable
 * column of slides with their text boxes and images laid out at their real
 * positions.
 *
 * Ported from `siyuan-editor/src/office/presentation.ts`. Read-only here — see
 * the note in `./types.ts`. Text boxes therefore render as ordinary HTML rather
 * than `contentEditable` regions, and no XML is ever written back.
 */

import JSZip from 'jszip';
import { escapeHTML, type OfficeEngine, type OfficeToolbarAction } from './types';

/** 1 px = 9525 EMU (914400 EMU/inch ÷ 96 px/inch). */
const EMU_PER_PX = 9525;

function emuToPx(v: number): number {
  return v / EMU_PER_PX;
}

/** First element with the given local name, any namespace. */
function firstNS(el: Document | Element, name: string): Element | null {
  const list = el.getElementsByTagNameNS('*', name);
  return list.length ? list[0] : null;
}

/** Attribute lookup by LOCAL name (handles namespaced attrs such as `r:embed`). */
function attrByLocalName(el: Element, localName: string): string | null {
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.localName === localName || a.name === localName) return a.value;
  }
  return null;
}

/** `<a:solidFill><a:srgbClr val="RRGGBB">` colour of a run properties node. */
function solidColor(el: Element | null): string {
  if (!el) return '';
  const c = firstNS(el, 'srgbClr');
  return c ? c.getAttribute('val') || '' : '';
}

/** Resolve a relationship target (relative to `ppt/slides/`) into a zip path. */
function resolveRelTarget(target: string): string {
  const parts = `ppt/slides/${target}`.split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

const MEDIA_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** Draw a `<a:txBody>` as a stack of aligned, run-styled HTML lines. */
function parasToHTML(txBody: Element): string {
  const paras = Array.from(txBody.getElementsByTagNameNS('*', 'p'));
  return paras
    .map((p) => {
      const pPr = firstNS(p, 'pPr');
      const algn = pPr ? pPr.getAttribute('algn') || '' : '';
      let align = 'left';
      if (algn === 'ctr') align = 'center';
      else if (algn === 'r') align = 'right';
      else if (algn === 'j') align = 'justify';
      const inner = Array.from(p.getElementsByTagNameNS('*', 'r'))
        .map((r) => {
          const t = firstNS(r, 't');
          const text = escapeHTML(t ? t.textContent || '' : '');
          if (!text) return '';
          const rPr = firstNS(r, 'rPr');
          let style = '';
          if (rPr) {
            if (rPr.getAttribute('b') === '1') style += 'font-weight:700;';
            if (rPr.getAttribute('i') === '1') style += 'font-style:italic;';
            const u = rPr.getAttribute('u');
            if (u && u !== 'none') style += 'text-decoration:underline;';
            const sz = Number(rPr.getAttribute('sz'));
            if (sz > 0) style += `font-size:${(sz / 100).toFixed(1)}pt;`;
            const color = solidColor(rPr);
            if (color) style += `color:#${color};`;
          }
          return `<span style="${style}">${text}</span>`;
        })
        .join('');
      return `<div style="text-align:${align};min-height:1em;">${inner || '&nbsp;'}</div>`;
    })
    .join('');
}

/** Build the slide-number → relationships map for one slide. */
async function relsOf(zip: JSZip, slideFile: string): Promise<Record<string, string>> {
  const base = slideFile.split('/').pop() || '';
  const relFile = zip.file(`ppt/slides/_rels/${base}.rels`);
  const out: Record<string, string> = {};
  if (!relFile) return out;
  const text = await relFile.async('string');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  Array.from(doc.getElementsByTagNameNS('*', 'Relationship')).forEach((rel) => {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) out[id] = target;
  });
  return out;
}

/**
 * Render a .pptx into a scrollable stage.
 * @param data raw file bytes
 */
export async function createPresentationEngine(data: ArrayBuffer): Promise<OfficeEngine> {
  const zip = await JSZip.loadAsync(data);

  // Slide size, defaulting to 4:3.
  let slideW = emuToPx(9144000);
  let slideH = emuToPx(6858000);
  const presFile = zip.file('ppt/presentation.xml');
  if (presFile) {
    const presDoc = new DOMParser().parseFromString(await presFile.async('string'), 'application/xml');
    const sldSz = firstNS(presDoc, 'sldSz');
    if (sldSz) {
      const cx = Number(sldSz.getAttribute('cx'));
      const cy = Number(sldSz.getAttribute('cy'));
      if (cx > 0) slideW = emuToPx(cx);
      if (cy > 0) slideH = emuToPx(cy);
    }
  }

  // Media → data URIs.
  const media: Record<string, string> = {};
  await Promise.all(
    zip.file(/^ppt\/media\/.+/).map(async (f) => {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const mime = MEDIA_MIME[ext];
      if (!mime) return; // emf/wmf — the browser cannot draw them
      try {
        media[f.name] = `data:${mime};base64,${await f.async('base64')}`;
      } catch {
        // one bad image must not sink the deck
      }
    }),
  );

  const slideFiles = zip
    .file(/^ppt\/slides\/slide\d+\.xml$/)
    .slice()
    .sort((a, b) => {
      const na = Number((a.name.match(/(\d+)\.xml$/) || [])[1] || 0);
      const nb = Number((b.name.match(/(\d+)\.xml$/) || [])[1] || 0);
      return na - nb;
    });
  if (slideFiles.length === 0) throw new Error('未找到任何幻灯片(ppt/slides/slideN.xml)');

  const root = document.createElement('div');
  root.className = 'lg-office lg-office--ppt';

  const zoomBar = document.createElement('div');
  zoomBar.className = 'lg-office__ppt-zoombar';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'lg-office__zoom';
  zoomBar.appendChild(zoomLabel);
  root.appendChild(zoomBar);

  const scroll = document.createElement('div');
  scroll.className = 'lg-office__ppt-scroll';
  const stage = document.createElement('div');
  stage.className = 'lg-office__ppt-stage';
  scroll.appendChild(stage);
  root.appendChild(scroll);

  let zoom = 1;
  function applyZoom(): void {
    stage.style.zoom = String(zoom);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }
  function fitWidth(): void {
    const avail = scroll.clientWidth - 32;
    if (avail > 0 && slideW > 0) zoom = Math.min(3, Math.max(0.1, avail / slideW));
    applyZoom();
  }
  applyZoom();

  for (const [i, f] of slideFiles.entries()) {
    const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    const slideEl = document.createElement('div');
    slideEl.className = 'lg-office__ppt-slide';
    slideEl.style.width = `${slideW}px`;
    slideEl.style.height = `${slideH}px`;

    // Text shapes.
    for (const sp of Array.from(doc.getElementsByTagNameNS('*', 'sp'))) {
      const txBody = firstNS(sp, 'txBody');
      const xfrm = firstNS(sp, 'xfrm');
      const off = xfrm ? firstNS(xfrm, 'off') : null;
      const ext = xfrm ? firstNS(xfrm, 'ext') : null;
      if (!txBody || !off || !ext) continue;
      const el = document.createElement('div');
      el.className = 'lg-office__ppt-shape';
      el.style.cssText = `left:${emuToPx(Number(off.getAttribute('x') || 0))}px;top:${emuToPx(
        Number(off.getAttribute('y') || 0),
      )}px;width:${emuToPx(Number(ext.getAttribute('cx') || 0))}px;height:${emuToPx(
        Number(ext.getAttribute('cy') || 0),
      )}px;`;
      const inner = document.createElement('div');
      inner.className = 'lg-office__ppt-text';
      inner.innerHTML = parasToHTML(txBody);
      el.appendChild(inner);
      slideEl.appendChild(el);
    }

    // Images (via the slide's relationships).
    const rels = await relsOf(zip, f.name);
    for (const pic of Array.from(doc.getElementsByTagNameNS('*', 'pic'))) {
      const spPr = firstNS(pic, 'spPr');
      const xfrm = spPr ? firstNS(spPr, 'xfrm') : null;
      const off = xfrm ? firstNS(xfrm, 'off') : null;
      const ext = xfrm ? firstNS(xfrm, 'ext') : null;
      const blip = firstNS(pic, 'blip');
      if (!off || !ext || !blip) continue;
      const rid = attrByLocalName(blip, 'embed');
      if (!rid || !rels[rid]) continue;
      const src = media[resolveRelTarget(rels[rid])];
      if (!src) continue;
      const img = document.createElement('img');
      img.className = 'lg-office__ppt-pic';
      img.style.cssText = `left:${emuToPx(Number(off.getAttribute('x') || 0))}px;top:${emuToPx(
        Number(off.getAttribute('y') || 0),
      )}px;width:${emuToPx(Number(ext.getAttribute('cx') || 0))}px;height:${emuToPx(
        Number(ext.getAttribute('cy') || 0),
      )}px;`;
      img.src = src;
      img.draggable = false;
      slideEl.appendChild(img);
    }

    const idx = document.createElement('div');
    idx.className = 'lg-office__ppt-index';
    idx.textContent = String(i + 1);
    slideEl.appendChild(idx);
    stage.appendChild(slideEl);
  }

  const toolbarActions: OfficeToolbarAction[] = [
    { label: '缩小', onClick: () => {
      zoom = Math.max(0.1, Number((zoom - 0.1).toFixed(2)));
      applyZoom();
    } },
    { label: '放大', onClick: () => {
      zoom = Math.min(3, Number((zoom + 0.1).toFixed(2)));
      applyZoom();
    } },
    { label: '适应宽度', onClick: () => fitWidth() },
  ];

  return {
    root,
    editable: false,
    resize: () => fitWidth(),
    dispose: () => {
      stage.innerHTML = '';
    },
    toolbarActions,
  };
}
