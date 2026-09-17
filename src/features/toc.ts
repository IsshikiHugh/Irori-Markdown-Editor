/* The left-hand table of contents: h1–h3, click to scroll, current section highlighted.

   Note what is NOT special-cased here: the document's first `#` heading. It is a
   heading like any other, because in this editor the title IS that line (CONTEXT.md →
   **标题**) — no detached title field, no exclusion from the outline. */

import type { EditorView } from '@codemirror/view';
import type { Glide } from './glide';

const HEAD = /^(#{1,3})\s+(.*)$/;

export type Heading = { level: number; text: string; pos: number };

export function scanHeadings(doc: { lines: number; line: (n: number) => { text: string; from: number } }): Heading[] {
  const out: Heading[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const m = line.text.match(HEAD);
    if (m) out.push({ level: m[1].length, text: m[2], pos: line.from });
  }
  return out;
}

export function createTOC(
  view: EditorView,
  list: HTMLElement,
  spyLine: () => number,
  glide: Glide,
  /** 聚焦正文但不改滚动位置（WebKit 会把光标滚进视野，那会打断这次跳转） */
  focusEditor: () => void,
) {
  let heads: Heading[] = [];

  function rebuild() {
    heads = scanHeadings(view.state.doc);
    list.innerHTML = '';
    for (const h of heads) {
      const li = document.createElement('li');
      li.className = 'toc-item';
      const a = document.createElement('a');
      a.className = 'toc-link lvl' + h.level;
      a.textContent = h.text;
      a.onclick = (e) => {
        e.preventDefault();
        // 滑过去，而不是瞬移：同一条渐入渐出曲线（features/glide.ts）
        glide.to(() => view.lineBlockAt(h.pos).top + view.documentPadding.top - 20);
        focusEditor();
      };
      li.appendChild(a);
      list.appendChild(li);
    }
    spy();
  }

  function spy() {
    const line = spyLine();
    let idx = -1;
    heads.forEach((h, i) => {
      const y = view.documentTop + view.lineBlockAt(h.pos).top;
      if (y <= line) idx = i;
    });
    list.querySelectorAll('.toc-link').forEach((a, i) => a.classList.toggle('active', i === idx));
  }

  return { rebuild, spy, headings: () => heads };
}
