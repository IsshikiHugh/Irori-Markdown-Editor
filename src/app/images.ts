/* Where a pasted image goes: one folder, taken from the settings as a path template
   (default: beside the document, named after it — paths.ts: imageDir). Still one rule
   and no plugin seam: image hosts and the like are not built for. */

import type { Platform } from '../platform/types';
import { imageDir, imageRef, join, safeFileName, uniqueName } from '../platform/paths';

export class UnsavedDocumentError extends Error {
  constructor() {
    super('请先保存文档，再插入图片');
  }
}

/** The file's own name (made safe), or paste-<time>.<ext> for an anonymous screenshot. */
function pastedName(file: File): string {
  const own = file.name && file.name !== 'image.png' ? safeFileName(file.name) : null;
  if (own) return own;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  return `paste-${Date.now()}.${ext}`;
}

/** Writes the image into the folder `template` names (paths.ts: imageDir) and returns the
    markdown-relative path. */
export async function storeImage(platform: Platform, docPath: string | null, file: File, template?: string): Promise<string> {
  if (!docPath) throw new UnsavedDocumentError();
  const dir = imageDir(docPath, template);
  await platform.mkdirp(dir); // every missing folder on the way, like mkdir -p
  // names compare case-blind: on macOS and Windows "Shot.png" and "shot.png" are one file
  const taken = new Set((await platform.listDir(dir)).map((n) => n.toLowerCase()));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const wanted = pastedName(file);
  // the listing only picks a likely-free name; createBinary refuses a taken one itself, so a file
  // that appeared since (or that the listing missed) is never overwritten — we move on to the next
  for (let tries = 0; tries < 50; tries++) {
    const name = uniqueName((n) => taken.has(n.toLowerCase()), wanted);
    if (await platform.createBinary(join(dir, name), bytes)) return imageRef(docPath, dir, name);
    taken.add(name.toLowerCase());
  }
  throw new Error('找不到可用的文件名');
}
