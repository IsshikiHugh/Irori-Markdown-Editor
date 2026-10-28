/* The left-hand table of contents: h1–h3, click to scroll, current section highlighted.

   Note what is NOT special-cased here: the document's first `#` heading. It is a
   heading like any other, because in this editor the title IS that line — no detached
   title field, no exclusion from the outline. */

import type { EditorView } from '@codemirror/view';
import type { Glide } from './glide';
import { fenceRanges } from '../editor/tokens';

const HEAD = /^(#{1,3})\s+(.*)$/;

export type Heading = { level: number; text: string; pos: number };

export function scanHeadings(doc: { lines: number; line: (n: number) => { text: string; from: number } }): Heading[] {
  const out: Heading[] = [];
  // a `#` line inside a code block is code (a shell comment, say), not a heading
  const code = new Uint8Array(doc.lines + 2);
  for (const r of fenceRanges((n) => doc.line(n).text, doc.lines)) code.fill(1, r.from, r.to + 1);
  for (let n = 1; n <= doc.lines; n++) {
    if (code[n]) continue;
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
  /** where a clicked heading lands, in px below the top of the scroller: near the top normally,
      the top of the focus band in focus mode (above it the text is faded) */
  landAt: () => number,
  glide: Glide,
  /** focus the text without changing the scroll position (WebKit would scroll the caret into
      view, which interrupts this jump) */
  focusEditor: () => void,
) {
  let heads: Heading[] = [];
  /** A heading's position as of now: the list is rebuilt a moment after an edit (main.ts), and a
      scroll in between (deleting the end of the text scrolls) must not ask for a position past
      the end of the shorter document — CodeMirror throws on that. */
  const at = (h: Heading) => Math.min(h.pos, view.state.doc.length);
  const target = (h: Heading) => view.lineBlockAt(at(h)).top + view.documentPadding.top - landAt();
  /** The entry the user clicked stays highlighted while the view glides to it and rests there,
      even where the scroll position alone would pick another one (a short section, or a heading
      near the end that cannot scroll up to the line). The user scrolling away releases it. */
  let pinned: Heading | null = null;

  function rebuild() {
    heads = scanHeadings(view.state.doc);
    // the list is rebuilt after an edit; the pinned entry may be gone or moved
    pinned = null;
    list.innerHTML = '';
    for (const h of heads) {
      const li = document.createElement('li');
      li.className = 'toc-item';
      const a = document.createElement('a');
      a.className = 'toc-link lvl' + h.level;
      a.textContent = h.text;
      a.onclick = (e) => {
        e.preventDefault();
        pinned = h;
        // glide there instead of teleporting: the same ease-in/ease-out curve (features/glide.ts)
        glide.to(() => target(h));
        focusEditor();
        spy();
      };
      li.appendChild(a);
      list.appendChild(li);
    }
    spy();
  }

  function spy() {
    if (pinned) {
      const el = view.scrollDOM;
      const want = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, target(pinned)));
      if (glide.running() || Math.abs(el.scrollTop - want) <= 2) return mark(heads.indexOf(pinned));
      pinned = null;
    }
    const line = spyLine();
    let idx = -1;
    heads.forEach((h, i) => {
      const y = view.documentTop + view.lineBlockAt(at(h)).top;
      if (y <= line) idx = i;
    });
    mark(idx);
  }

  function mark(idx: number) {
    list.querySelectorAll('.toc-link').forEach((a, i) => a.classList.toggle('active', i === idx));
  }

  return { rebuild, spy, headings: () => heads };
}
