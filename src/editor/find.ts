/* Find & replace: a small floating box in the top right corner of the editor, VS Code style, in
   place of CodeMirror's bar across the bottom. Only the look is ours — the query, the matching,
   the highlighting and every command are CodeMirror's search (ADR-0002).

     ›  [ 查找            Aa ab .* ]  3/17  ↑ ↓ ×
        [ 替换                     ]  替换  全部替换      ← › opens this row

   ⌘F opens it (the selected text becomes the query), ⌥⌘F opens it with the replace row.
   In the find field Enter is next, ⇧Enter previous; in the replace field Enter replaces one,
   ⌘Enter all; Esc closes. While typing, the first match from where the caret was is selected. */

import { EditorSelection } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import type { Panel, ViewUpdate } from '@codemirror/view';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from '@codemirror/search';

/** counting stops here (shown as "9999+") */
const MAX_COUNT = 9999;

const ICON = {
  chevron: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 10 8 5.5 12.5 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function iconButton(cls: string, title: string, html: string, run: () => void): HTMLButtonElement {
  const b = el('button', 'fx-btn ' + cls, { type: 'button', title, 'aria-label': title });
  b.innerHTML = html;
  // keep the focus in the field: clicking ↓ three times should not leave the input
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', run);
  return b;
}

/** the open panel of each editor, for ⌥⌘F to reach */
const panels = new WeakMap<EditorView, FindPanel>();

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private query: SearchQuery;
  private find: HTMLInputElement;
  private replace: HTMLInputElement;
  private toggles: { caseSensitive: HTMLButtonElement; wholeWord: HTMLButtonElement; regexp: HTMLButtonElement };
  private count: HTMLElement;
  /** where the caret was when the query last changed by typing: the first match from here is shown */
  private origin: number;
  private recount: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly view: EditorView) {
    panels.set(view, this);
    this.query = getSearchQuery(view.state);
    this.origin = view.state.selection.main.from;
    const q = this.query;

    this.find = el('input', 'fx-input', { placeholder: '查找', 'aria-label': '查找', 'main-field': 'true', spellcheck: 'false' });
    this.find.value = q.search;
    this.replace = el('input', 'fx-input', { placeholder: '替换', 'aria-label': '替换', spellcheck: 'false' });
    this.replace.value = q.replace;
    for (const input of [this.find, this.replace]) input.addEventListener('input', () => this.commit(input === this.find));

    const toggle = (cls: string, title: string, label: string, on: boolean) => {
      const b = iconButton('fx-opt ' + cls, title, label, () => {
        b.classList.toggle('on');
        b.setAttribute('aria-pressed', String(b.classList.contains('on')));
        this.commit(true);
      });
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      return b;
    };
    this.toggles = {
      caseSensitive: toggle('fx-case', '区分大小写', 'Aa', q.caseSensitive),
      wholeWord: toggle('fx-word', '全词匹配', '<span>ab</span>', q.wholeWord),
      regexp: toggle('fx-re', '正则表达式', '.*', q.regexp),
    };

    const findField = el('div', 'fx-field');
    const opts = el('span', 'fx-opts');
    opts.append(this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regexp);
    findField.append(this.find, opts);
    this.count = el('span', 'fx-count', { 'aria-live': 'polite' });
    const findRow = el('div', 'fx-row');
    findRow.append(
      findField,
      this.count,
      iconButton('fx-prev', '上一个（⇧Enter）', ICON.up, () => findPrevious(view)),
      iconButton('fx-next', '下一个（Enter）', ICON.down, () => findNext(view)),
      iconButton('fx-close', '关闭（Esc）', ICON.close, () => closeSearchPanel(view)),
    );

    const replaceField = el('div', 'fx-field');
    replaceField.append(this.replace);
    const textButton = (cls: string, title: string, label: string, run: () => void) => {
      const b = iconButton('fx-text ' + cls, title, '', run);
      b.textContent = label;
      return b;
    };
    const replaceRow = el('div', 'fx-row fx-replace');
    replaceRow.append(
      replaceField,
      textButton('fx-one', '替换（Enter）', '替换', () => replaceNext(view)),
      textButton('fx-all', '全部替换（⌘Enter）', '全部替换', () => replaceAll(view)),
    );

    const expand = iconButton('fx-expand', '替换', ICON.chevron, () => this.setExpanded(!this.dom.classList.contains('open')));
    const rows = el('div', 'fx-rows');
    rows.append(findRow, replaceRow);
    this.dom = el('div', 'fx', { role: 'search' }); // not .cm-search: CodeMirror's base theme styles that
    this.dom.append(expand, rows);
    this.dom.addEventListener('keydown', (e) => this.keydown(e));
    this.showCount();
  }

  /** show or hide the replace row */
  setExpanded(on: boolean) {
    this.dom.classList.toggle('open', on);
    this.dom.querySelector('.fx-expand')?.setAttribute('aria-expanded', String(on));
    if (on && this.dom.contains(document.activeElement)) this.replace.focus();
  }

  private commit(typedInFind: boolean) {
    const query = new SearchQuery({
      search: this.find.value,
      caseSensitive: this.toggles.caseSensitive.classList.contains('on'),
      wholeWord: this.toggles.wholeWord.classList.contains('on'),
      regexp: this.toggles.regexp.classList.contains('on'),
      replace: this.replace.value,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    const effects = [setSearchQuery.of(query)];
    // typing the query: select its first match from where the caret was, like the browser's find
    const hit = typedInFind ? firstMatch(this.view.state, query, this.origin) : null;
    if (hit)
      this.view.dispatch({
        effects: [...effects, EditorView.scrollIntoView(hit.from, { y: 'center' })],
        selection: EditorSelection.single(hit.from, hit.to),
        userEvent: 'select.search',
      });
    else this.view.dispatch({ effects });
  }

  private keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && e.target === this.find && !e.isComposing) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === 'Enter' && e.target === this.replace && !e.isComposing) {
      e.preventDefault();
      (e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(this.view);
    } else if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
    }
  }

  update(u: ViewUpdate) {
    for (const tr of u.transactions)
      for (const e of tr.effects)
        if (e.is(setSearchQuery) && !e.value.eq(this.query)) {
          // from outside (⌘F again, with something selected)
          this.query = e.value;
          this.find.value = e.value.search;
          this.replace.value = e.value.replace;
          for (const k of ['caseSensitive', 'wholeWord', 'regexp'] as const) {
            this.toggles[k].classList.toggle('on', e.value[k]);
            this.toggles[k].setAttribute('aria-pressed', String(e.value[k]));
          }
        }
    // the caret moved by itself (a click, the arrow keys): the next query typed searches from there
    if (u.selectionSet && !u.transactions.some((t) => t.isUserEvent('select.search'))) {
      if (!this.dom.contains(document.activeElement)) this.origin = u.state.selection.main.from;
    }
    if (u.docChanged) {
      // counting walks the whole document: not on every keystroke
      clearTimeout(this.recount);
      this.recount = setTimeout(() => this.showCount(), 150);
    } else if (u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) {
      this.showCount();
    }
  }

  /** "3/17": which match is selected, of how many */
  private showCount() {
    const q = this.query;
    const empty = !q.search;
    this.dom.classList.toggle('bad', !empty && !q.valid);
    if (empty || !q.valid) {
      this.count.textContent = empty ? '' : '正则有误';
      this.dom.classList.remove('none');
      return;
    }
    const main = this.view.state.selection.main;
    let n = 0;
    let at = 0;
    const cur = q.getCursor(this.view.state);
    for (let r = cur.next(); !r.done; r = cur.next()) {
      n++;
      if (r.value.from === main.from && r.value.to === main.to) at = n;
      if (n >= MAX_COUNT) break;
    }
    this.dom.classList.toggle('none', n === 0);
    this.count.textContent = n === 0 ? '无结果' : `${at || '–'}/${n >= MAX_COUNT ? MAX_COUNT + '+' : n}`;
  }

  mount() {
    this.find.select();
  }

  destroy() {
    clearTimeout(this.recount);
    if (panels.get(this.view) === this) panels.delete(this.view);
  }
}

/** The first match at or after `from`, wrapping round to the start. */
function firstMatch(state: EditorState, q: SearchQuery, from: number): { from: number; to: number } | null {
  if (!q.search || !q.valid) return null;
  const after = q.getCursor(state, from).next();
  if (!after.done) return after.value;
  const wrapped = q.getCursor(state, 0, from).next();
  return wrapped.done ? null : wrapped.value;
}

const createPanel = (view: EditorView) => new FindPanel(view);

/** the search extension, with this panel; matches are scrolled to the middle so the box never hides one */
export const find = search({
  top: true,
  createPanel,
  scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: 'center' }),
});

/** ⌥⌘F: open with the replace row showing */
export function openReplacePanel(view: EditorView): boolean {
  openSearchPanel(view);
  panels.get(view)?.setExpanded(true);
  view.dom.querySelector<HTMLInputElement>('.fx-replace .fx-input')?.focus();
  return true;
}
