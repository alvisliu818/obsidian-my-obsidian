/**
 * Word engine: renders .docx as flowing HTML via mammoth.
 *
 * Ported from `siyuan-editor/src/office/document.ts`, minus the Quill editing
 * surface — see the read-only rationale in `./types.ts`.
 *
 * mammoth's browser build is imported directly: the Node entry pulls in `fs`
 * and `path`, which a plugin bundle must not reach for.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
import mammoth from 'mammoth/mammoth.browser.js';
import JSZip from 'jszip';
import { escapeHTML, type OfficeEngine, type OfficeToolbarAction } from './types';

/**
 * mammoth emits a handful of elements Obsidian's own CSS does not style
 * (footnote anchors, page-break spans). Dropping them keeps the preview inside
 * the vault's typography instead of fighting it.
 */
function sanitize(html: string): string {
  return html
    .replace(/<sup[^>]*>\s*<a[^>]*>\[\d+\]<\/a>\s*<\/sup>/gi, '')
    .replace(/<a[^>]*id="footnote[^"]*"[^>]*><\/a>/gi, '');
}

/** .odt is a ZIP holding `content.xml`; pull the paragraphs out of it. */
async function renderOdt(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const f = zip.file('content.xml');
  if (!f) throw new Error('无效的 .odt 文件(缺少 content.xml)');
  const xml = await f.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: string[] = [];
  // text:p holds paragraphs; text:h holds headings.
  const blocks = Array.from(doc.getElementsByTagName('*')).filter((el) => {
    const ln = el.localName;
    return ln === 'p' || ln === 'h';
  });
  for (const el of blocks) {
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const isHeading = el.localName === 'h';
    const level = isHeading ? Math.min(6, Math.max(1, Number(el.getAttribute('text:outline-level') || 2))) : 0;
    out.push(isHeading ? `<h${level}>${escapeHTML(text)}</h${level}>` : `<p>${escapeHTML(text)}</p>`);
  }
  return out.join('\n') || '<p>(空文档)</p>';
}

/** .rtf: strip control words and keep the visible text. */
function renderRtf(data: ArrayBuffer): string {
  const raw = new TextDecoder('utf-8').decode(data);
  // Drop the header block, control words (`\word`), and destination groups
  // we do not understand. What survives is the document's visible text.
  let s = raw.replace(/\\f\d+|\\fs\d+|\\cf\d+|\\lang\d+/g, '');
  s = s.replace(/\\[a-z]+-?\d* ?/gi, '');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const paras = s
    .split(/\r?\n|\\par\b/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.length
    ? paras.map((p) => `<p>${escapeHTML(p)}</p>`).join('\n')
    : '<p>(空文档)</p>';
}

export async function createDocumentEngine(data: ArrayBuffer, ext: string): Promise<OfficeEngine> {
  const root = document.createElement('div');
  root.className = 'lg-office lg-office--doc';

  const scroll = document.createElement('div');
  scroll.className = 'lg-office__doc-scroll';
  const article = document.createElement('article');
  article.className = 'lg-office__doc-body';
  scroll.appendChild(article);
  root.appendChild(scroll);

  let html: string;
  if (ext === 'odt') {
    html = await renderOdt(data);
  } else if (ext === 'rtf') {
    html = renderRtf(data);
  } else {
    const res = await mammoth.convertToHtml({ arrayBuffer: data });
    html = sanitize(res.value);
    // mammoth reports style mappings it could not resolve; surface them once,
    // quietly, so a user wondering why a heading looks plain has an answer.
    if (res.messages?.length) {
      console.debug('[obsidian-logseq] mammoth messages:', res.messages);
    }
  }
  article.innerHTML = html || '<p>(空文档)</p>';

  let zoom = 1;
  function applyZoom(): void {
    article.style.fontSize = `${zoom}em`;
  }
  applyZoom();

  const toolbarActions: OfficeToolbarAction[] = [
    { label: 'A-', onClick: () => {
      zoom = Math.max(0.6, Number((zoom - 0.1).toFixed(2)));
      applyZoom();
    } },
    { label: 'A+', onClick: () => {
      zoom = Math.min(2, Number((zoom + 0.1).toFixed(2)));
      applyZoom();
    } },
  ];

  return {
    root,
    editable: false,
    dispose: () => {
      article.innerHTML = '';
    },
    toolbarActions,
  };
}
