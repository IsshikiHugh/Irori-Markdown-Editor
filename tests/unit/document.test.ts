import { afterEach, describe, expect, it } from 'vitest';
import { DocumentSession } from '../../src/app/document';
import type { Platform } from '../../src/platform/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** an in-memory disk whose writes take a moment, like a real one */
function setup() {
  const files: Record<string, string> = { '/a.md': 'one', '/c.md': 'other' };
  let mtime = 1;
  const asked: string[] = [];
  const picks: string[] = [];
  const events = { reloads: 0, conflicts: 0 };
  const platform = {
    readText: async (p: string) => files[p],
    stat: async (p: string) => (p in files ? { mtimeMs: mtime } : null),
    openDialog: async () => picks.shift() ?? null,
    writeText: async (p: string, t: string) => {
      await sleep(30);
      files[p] = t;
      mtime++;
    },
    saveDialog: async () => '/b.md',
    confirm: async (q: string) => (asked.push(q), true),
  } as unknown as Platform;
  const states: string[] = [];
  const doc = new DocumentSession(
    platform,
    {
      onState: (s) => states.push(s),
      onPath() {},
      onConflict: () => void events.conflicts++,
      onReload: () => void events.reloads++,
      onToast() {},
    },
    () => ({ autosave: false, autosaveDelay: 10 }),
  );
  return { files, platform, doc, states, asked, picks, events, bump: () => mtime++ };
}

let open: DocumentSession[] = [];
afterEach(() => {
  for (const d of open) d.stopWatch();
  open = [];
});

describe('document session', () => {
  it('keeps what is typed while a save is being written', async () => {
    const { files, doc, states } = setup();
    open.push(doc);
    await doc.open('/a.md');
    doc.setText('one two');
    const saving = doc.save();
    await sleep(10);
    doc.setText('one two three'); // typed while the write is under way
    await saving;
    expect(files['/a.md']).toBe('one two');
    expect(doc.dirty).toBe(true);
    expect(states[states.length - 1]).toBe('dirty');
    // so closing still flushes it
    expect(await doc.requestClose()).toBe(true);
    expect(files['/a.md']).toBe('one two three');
  });

  it('a Save As that fails keeps the old path and says so', async () => {
    const { platform, doc, states } = setup();
    open.push(doc);
    await doc.open('/a.md');
    doc.setText('changed');
    platform.writeText = async () => {
      throw new Error('disk full');
    };
    expect(await doc.saveAs()).toBe(false);
    expect(doc.path).toBe('/a.md');
    expect(doc.dirty).toBe(true);
    expect(states[states.length - 1]).toBe('dirty');
  });

  it('⌘O saves a named document with what was typed up to the switch itself', async () => {
    const { files, doc, picks } = setup();
    open.push(doc);
    await doc.open('/a.md');
    doc.setText('one two');
    picks.push('/c.md');
    // a key pressed while the new file is being got ready still belongs to the old one
    const opened = await doc.openDialog(async () => doc.setText('one two three'));
    expect(opened).toBe('/c.md');
    expect(files['/a.md']).toBe('one two three');
    expect(doc.path).toBe('/c.md');
    expect(doc.text).toBe('other');
    expect(doc.dirty).toBe(false);
  });

  it('⌘O asks about an unsaved page before the file picker, and a no keeps everything', async () => {
    const { platform, doc, asked, picks } = setup();
    open.push(doc);
    doc.setText('scribbles');
    picks.push('/c.md');
    platform.confirm = async (q: string) => (asked.push(q), false);
    expect(await doc.openDialog()).toBe(null);
    expect(asked.length).toBe(1);
    expect(picks.length).toBe(1); // the picker never came up
    expect(doc.text).toBe('scribbles');
  });

  it('a file that has gone missing is asked about as missing, not as never saved', async () => {
    const { files, doc, asked } = setup();
    open.push(doc);
    await doc.open('/a.md');
    delete files['/a.md'];
    await doc.checkDisk();
    doc.setText(' ');
    expect(await doc.requestClose()).toBe(true);
    expect(asked.length).toBe(1);
    expect(asked[0].includes('已不存在')).toBe(true);
  });

  it('two saves at once land in order, and ⌘O waits for them', async () => {
    const { files, platform, doc, picks } = setup();
    open.push(doc);
    await doc.open('/a.md');
    const write = platform.writeText;
    let calls = 0;
    platform.writeText = async (p: string, t: string) => {
      if (calls++ === 0) await sleep(100); // the first write is slow: it must still not land last
      await write(p, t);
    };
    doc.setText('one two');
    const late = doc.save();
    await sleep(5); // the slow write has 'one two' in hand
    doc.setText('one two three');
    picks.push('/c.md');
    await doc.openDialog();
    await late;
    expect(files['/a.md']).toBe('one two three');
    expect(doc.path).toBe('/c.md');
    expect(doc.dirty).toBe(false);
  });

  it('the watcher does not take a save that ran while it was reading for an outside change', async () => {
    const { platform, doc, events, bump } = setup();
    open.push(doc);
    await doc.open('/a.md');
    bump(); // someone else touched the file: the watcher will read it
    const read = platform.readText;
    platform.readText = async (p: string) => {
      const text = await read(p);
      // meanwhile the person types and a whole save goes through
      doc.setText('mine');
      await doc.save();
      return text;
    };
    await doc.checkDisk();
    expect(events.reloads).toBe(0);
    expect(events.conflicts).toBe(0);
    expect(doc.text).toBe('mine');
    expect(doc.dirty).toBe(false);
  });

  it('⌘O asks before dropping edits whose file went missing while the picker was open', async () => {
    const { files, platform, doc, asked } = setup();
    open.push(doc);
    await doc.open('/a.md');
    doc.setText('one two');
    platform.openDialog = async () => {
      delete files['/a.md']; // moved away in the file manager meanwhile
      await doc.checkDisk();
      return '/c.md';
    };
    platform.confirm = async (q: string) => (asked.push(q), false);
    expect(await doc.openDialog()).toBe(null);
    expect(asked.length).toBe(1);
    expect(doc.text).toBe('one two');
    expect(doc.path).toBe('/a.md');
  });

  it('⌘O on the file already open shows what was just saved, with nothing to reload', async () => {
    const { files, doc, picks, events } = setup();
    open.push(doc);
    await doc.open('/a.md');
    doc.setText('one two');
    picks.push('/a.md');
    expect(await doc.openDialog()).toBe('/a.md');
    expect(files['/a.md']).toBe('one two');
    expect(doc.text).toBe('one two');
    expect(doc.dirty).toBe(false);
    await doc.checkDisk();
    expect(events.reloads).toBe(0);
    expect(events.conflicts).toBe(0);
  });
});
