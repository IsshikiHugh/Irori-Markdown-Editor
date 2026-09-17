/* Where a pasted image goes. v1 is pinned to exactly one strategy — a folder
   beside the document, named after it — and forbids building a plugin seam for the
   others. So: one function, one rule, easy to change later, nothing pre-built. */

import type { Platform } from '../platform/types';
import { sidecarDir, sidecarRef, uniqueName } from '../platform/paths';

export class UnsavedDocumentError extends Error {
  constructor() {
    super('请先保存文档，再插入图片');
  }
}

function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return `paste-${Date.now()}.${ext}`;
}

/** Writes the image next to the document and returns the markdown-relative path. */
export async function storeImage(platform: Platform, docPath: string | null, file: File): Promise<string> {
  if (!docPath) throw new UnsavedDocumentError();
  const dir = sidecarDir(docPath);
  await platform.mkdirp(dir);
  const existing = new Set(await platform.listDir(dir));
  const name = uniqueName((n) => existing.has(n), pastedName(file));
  const bytes = new Uint8Array(await file.arrayBuffer());
  await platform.writeBinary(`${dir}/${name}`, bytes);
  return sidecarRef(docPath, name);
}
