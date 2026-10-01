import { afterEach, describe, expect, it } from 'vitest';
import { DocumentSession } from '../../src/app/document';
import type { Platform } from '../../src/platform/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** an in-memory disk whose writes take a moment, like a real one */
function setup() {
  const files: Record<string, string> = { '/a.md': 'one' };
  let mtime = 1;
  const platform = {
    readText: async (p: string) => files[p],
    stat: async (p: string) => (p in files ? { mtimeMs: mtime } : null),
    writeText: async (p: string, t: string) => {
      await sleep(30);
      files[p] = t;
      mtime++;
    },
    saveDialog: async () => '/b.md',
    confirm: async () => true,
  } as unknown as Platform;
  const states: string[] = [];
  const doc = new DocumentSession(
    platform,
    { onState: (s) => states.push(s), onPath() {}, onConflict() {}, onReload() {}, onToast() {} },
    () => ({ autosave: false, autosaveDelay: 10 }),
  );
  return { files, platform, doc, states };
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
});
