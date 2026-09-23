/* Typewriter mode: the caret's row stays at one height on the screen and the paper moves
   under it, instead of the eye chasing the caret down the page.

   Two halves, and both are needed for the height to actually hold:

   1. **Padding.** The first line can only sit at the anchor if there is that much space
      above it, and the last line only if there is room below. The padding is computed
      here but written by focus mode's measure cycle (features/focus.ts), because two
      writers of `.cm-content`'s padding would fight each other.
   2. **Following.** After every caret move the scroller is shifted by the difference
      between the caret's middle and the anchor — one line after Enter, a screen after a
      click far away. Every one of those moves goes through the shared glide
      (features/glide.ts), the same motion the TOC, the minimap and focus mode scroll
      with: one line and one page must start, run and come to rest the same way.
      The move waits for the caret to hold still first (FOLLOW_DELAY): each further caret
      move inside that window replaces the pending one and restarts the wait, so a burst
      of Enters moves the paper once, at its end, rather than tugging it on every key.
      Only this mode's own following waits; a TOC or minimap click, focus mode and the
      switch itself still move at once.

   With focus mode on as well, the anchor is clamped into the focus band: the caret must
   stay in the part of the page that is not faded out. */

import type { EditorView } from '@codemirror/view';
import type { Glide } from './glide';

export type TypewriterPrefs = {
  on: boolean;
  /** where the caret's row sits, in percent of the editor's height */
  anchor: number;
};

export type TypewriterEls = {
  seg: HTMLElement;
  row: HTMLElement;
  slider: HTMLInputElement;
  value: HTMLElement;
  /** the hairline shown while the anchor is being dragged */
  guide: HTMLElement;
};

/** Below this much (a fraction of a line) there is nothing to animate: it is the pixel or two a
    glide lands off by once the lines it crossed have really been measured. */
const SNAP = 0.5;

/** How long the caret must hold still (ms) before the row is pulled back to the anchor. Every
    caret move inside the window restarts it, so the paper moves once per pause, not per key. */
export const FOLLOW_DELAY = 250;

/** Space above and below the text so that the first and the last line can both reach the anchor:
    everything above the anchor, and everything below it. */
export function typewriterPads(height: number, anchor: number) {
  const top = (height * anchor) / 100;
  return { top, bottom: Math.max(0, height - top) };
}

/** Where the anchor may sit (percent) when focus mode keeps a band: a whole line inside it. */
export function clampAnchor(anchor: number, band: { top: number; bottom: number } | null, linePct: number): number {
  if (!band) return anchor;
  const lo = band.top + linePct / 2;
  const hi = band.bottom - linePct / 2;
  if (hi <= lo) return (band.top + band.bottom) / 2;
  return Math.min(hi, Math.max(lo, anchor));
}

export function createTypewriter(
  view: EditorView,
  els: TypewriterEls,
  prefs: TypewriterPrefs,
  persist: (p: TypewriterPrefs) => void,
  glide: Glide,
  /** the anchor or the padding changed: the caller re-runs focus mode's pad cycle */
  onChange: () => void,
  /** focus mode's band in viewport pixels while it is on, null otherwise */
  band: () => { top: number; bottom: number } | null,
  /** what the top padding becomes once this mode stops asking for any */
  padTopWhenOff: (height: number) => number,
) {
  els.slider.value = String(prefs.anchor);

  const isOn = () => document.body.classList.contains('typewriter');
  const lineHeight = () => view.defaultLineHeight || 39;
  const save = () => persist({ on: isOn(), anchor: +els.slider.value });

  /** the anchor in percent, kept inside the focus band when focus mode is on */
  function anchorPct(height = view.scrollDOM.clientHeight): number {
    const rect = view.scrollDOM.getBoundingClientRect();
    const b = band();
    const inPct = b && rect.height ? { top: ((b.top - rect.top) / rect.height) * 100, bottom: ((b.bottom - rect.top) / rect.height) * 100 } : null;
    return clampAnchor(+els.slider.value, inPct, height ? (lineHeight() / height) * 100 : 0);
  }

  /** viewport y of the anchor line */
  function anchorY(): number {
    const rect = view.scrollDOM.getBoundingClientRect();
    return rect.top + (rect.height * anchorPct(rect.height)) / 100;
  }

  /** what focus mode's measure cycle must reserve (0 when the mode is off) */
  function pads(height: number) {
    if (!isOn()) return { top: 0, bottom: 0 };
    return typewriterPads(height, anchorPct(height));
  }

  /* ---- following the caret ---- */
  let pending = 0;
  /** run `fn` as soon as no glide is in flight (never drop it: typing right after a jump must
      still end up at the anchor) */
  function whenIdle(fn: () => void) {
    if (pending) return;
    const tick = () => {
      if (glide.running()) {
        pending = requestAnimationFrame(tick);
        return;
      }
      pending = 0;
      fn();
    };
    pending = requestAnimationFrame(tick);
  }

  /** how far the scroller is from having the caret's row on the anchor */
  function shift(): number {
    const head = Math.min(view.state.selection.main.head, view.state.doc.length);
    // coordsAtPos is null for a line that is not rendered (the caret just jumped far away);
    // the height map still knows where that line will be
    const block = view.lineBlockAt(head);
    const c = view.coordsAtPos(head) ?? {
      top: view.documentTop + block.top,
      bottom: view.documentTop + block.top + block.height,
    };
    return (c.top + c.bottom) / 2 - anchorY();
  }

  /** bring the caret's row to the anchor now (the switch, and the landing check after a glide) */
  function followNow(afterGlide = false) {
    if (!isOn()) return;
    // a glide is already carrying the view somewhere: re-aim once it lands rather than fighting it
    // frame by frame (the same rule focus mode follows)
    if (glide.running()) {
      whenIdle(() => followNow(afterGlide));
      return;
    }
    const dy = shift();
    if (Math.abs(dy) < SNAP) return;
    // Just landed: what is left is the error from line heights that were only estimates on the way
    // here. Half a line or less is a correction, not a move — snapping it is invisible, gliding it
    // would be a visible crawl. More than that means the landing really missed; glide once more.
    if (afterGlide && Math.abs(dy) <= lineHeight() / 2) {
      view.scrollDOM.scrollTop += dy;
      return;
    }
    glide.to(() => view.scrollDOM.scrollTop + shift());
    whenIdle(() => followNow(true));
  }

  /** The caret moved: bring its row to the anchor once it has held still for FOLLOW_DELAY. A
      further move inside the window replaces this one — the wait starts over. */
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  function follow() {
    if (!isOn()) return;
    if (delayTimer) clearTimeout(delayTimer);
    delayTimer = setTimeout(() => {
      delayTimer = null;
      followNow();
    }, FOLLOW_DELAY);
  }

  /** Keep the caret's row where the eye last saw it while the padding under it changes.

      Switching the mode (or moving the anchor) rewrites `.cm-content`'s top padding, which shoves
      the whole text up or down by that difference in one frame — a jump cut, and then the glide
      starts from somewhere the eye did not expect. Reading the caret's coordinates after the
      change flushes CodeMirror's pending measure, so the padding is already in effect here and the
      scroller can absorb the difference in the same frame. Turning the mode OFF is nothing but
      this: the row stays at the height it was held at. The one case it cannot hold is a caret near
      the very top of the document, where there is no text left above to scroll up — the scroller
      clamps at 0 and the row ends up as high as the text allows. */
  function withoutMoving(change: () => void) {
    const head = Math.min(view.state.selection.main.head, view.state.doc.length);
    const before = view.coordsAtPos(head)?.top ?? null;
    change();
    const after = view.coordsAtPos(head)?.top ?? null;
    if (before == null || after == null) return;
    const dy = after - before;
    if (Math.abs(dy) > 0.5) view.scrollDOM.scrollTop += dy;
  }

  /* ---- the drawer ---- */
  let guideTimer: ReturnType<typeof setTimeout> | null = null;
  function showGuide() {
    els.guide.style.top = anchorY() - view.scrollDOM.getBoundingClientRect().top + 'px';
    els.guide.classList.add('show');
    if (guideTimer) clearTimeout(guideTimer);
    guideTimer = setTimeout(() => els.guide.classList.remove('show'), 900);
  }
  function reflect() {
    els.value.textContent = els.slider.value + '%';
  }
  /** the anchor moved (the slider): the row tracks it 1:1 — dragging is direct manipulation, and
      an animation chasing every input event would only lag behind the thumb */
  function apply() {
    withoutMoving(() => {
      reflect();
      onChange();
    });
    if (!isOn()) return;
    glide.cancel();
    const dy = shift();
    if (Math.abs(dy) >= SNAP) view.scrollDOM.scrollTop += dy;
  }
  /** The caret's own height inside the scroller (its middle), or null while its line is unrendered. */
  function caretY(): number | null {
    const head = Math.min(view.state.selection.main.head, view.state.doc.length);
    const c = view.coordsAtPos(head);
    return c ? (c.top + c.bottom) / 2 - view.scrollDOM.getBoundingClientRect().top : null;
  }

  /** Where to scroll to before the mode goes off, or null when the row can simply stay put.

      Switching off trades this mode's padding for the ordinary one, and the scroller absorbs the
      difference so the row does not move. Near the top of the document there is nothing left to
      absorb it with — the scroller is already at 0 — and the row has to rise to wherever the page
      allows. That is a move like any other, so it is glided there FIRST, while the tall padding is
      still in place and there is room to do it; the swap afterwards is then an exact trade and
      changes nothing on screen. */
  function offTarget(): number | null {
    const el = view.scrollDOM;
    const padNow = view.documentPadding.top;
    const padNext = padTopWhenOff(el.clientHeight);
    if (el.scrollTop + padNext - padNow >= 0) return null; // the height can be kept
    const y = caretY();
    if (y == null) return null;
    // the row's distance from the top of the text, which the swap does not change
    const inText = y + el.scrollTop - padNow;
    return el.scrollTop + y - (padNext + inText);
  }

  function reflectSeg(on: boolean) {
    [...els.seg.children].forEach((x) => x.classList.toggle('on', ((x as HTMLElement).dataset.on === '1') === on));
  }
  function swap(on: boolean) {
    withoutMoving(() => {
      document.body.classList.toggle('typewriter', on);
      reflectSeg(on);
      onChange();
    });
    // the page is standing still again: from here the row glides to the anchor, one single motion
    // (at once: the switch was just clicked, a wait here would read as the click not taking)
    if (on) followNow();
    save();
  }
  function setOn(on: boolean) {
    const target = on ? null : offTarget();
    if (target == null) {
      swap(on);
      return;
    }
    // the row cannot keep its height: move it there first, then swap (see offTarget)
    reflectSeg(on); // the switch answers the click at once; the padding follows the animation
    glide.to(target);
    whenIdle(() => swap(on));
  }

  els.seg.onclick = () => setOn(!isOn());
  els.slider.oninput = () => {
    apply();
    if (isOn()) showGuide();
  };
  els.slider.onchange = save;

  reflect();
  reflectSeg(prefs.on);
  if (prefs.on) document.body.classList.add('typewriter');

  return { isOn, setOn, follow, pads, anchorY, anchorPct, apply, delay: FOLLOW_DELAY };
}
