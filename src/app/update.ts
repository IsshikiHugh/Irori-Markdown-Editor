/* Self-update. The host is asked at launch and then every hour whether a newer release is out
   (it really checks at most once a day, in one window), and the drawer's 「检查更新」 asks on
   demand; a release found is offered in a small note in the bottom-left corner. Nothing is
   downloaded without a click. Once it is, the app restarts into the new version by itself:
   every window first gets ready (doc.prepareRestart — a named file is saved, an unnamed one
   asks to be saved) and then stops taking edits until the restart, or until it is called off;
   the same documents open again afterwards.

   None of it may get in the way of writing: the automatic check says nothing when it fails, and
   the note's buttons never take focus from the text. */

import type { Platform } from '../platform/types';
import type { DocumentSession } from './document';

export function createUpdates(
  platform: Platform,
  doc: DocumentSession,
  toast: (msg: string) => void,
  /** stop (true) or resume taking edits */
  lock: (on: boolean) => void,
) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const box = $('update');
  const text = $('utext');
  const yes = $<HTMLButtonElement>('uyes');
  const no = $<HTMLButtonElement>('uno');
  const check = $<HTMLButtonElement>('updbtn');

  void platform
    .appVersion()
    .then((v) => ($('verv').textContent = v))
    .catch(() => {});
  // every window gets ready for the restart, whichever one started it
  platform.onPrepareRestart(async () => {
    const ok = await doc.prepareRestart();
    if (ok) lock(true); // saved: nothing typed from here on could be kept
    return { ok, path: doc.path };
  });
  platform.onRestartCancelled(() => lock(false));

  const busy = (on: boolean) => {
    yes.disabled = no.disabled = on;
  };
  let version = '';
  const offer = (v: string) => {
    version = v;
    text.textContent = `Irori ${v} 已发布`;
    yes.textContent = '更新';
    busy(false);
    box.classList.add('open');
  };

  box.addEventListener('mousedown', (e) => e.preventDefault());
  no.onclick = () => box.classList.remove('open');
  yes.onclick = async () => {
    busy(true);
    try {
      text.textContent = '正在下载更新…';
      await platform.downloadUpdate();
      text.textContent = '正在重启…';
      // on success the app is gone before this returns
      if (!(await platform.applyUpdate())) {
        text.textContent = `${version} 已下载，重启已取消`;
        yes.textContent = '重启并更新';
        busy(false);
      }
    } catch (err) {
      text.textContent = '更新失败：' + String((err as Error)?.message ?? err);
      yes.textContent = '重试';
      busy(false);
    }
  };

  check.onclick = async () => {
    check.disabled = true;
    check.textContent = '检查中…';
    try {
      const info = await platform.checkUpdate(true);
      if (info) {
        document.body.classList.remove('menuopen');
        offer(info.version);
      } else {
        toast('已是最新版本');
      }
    } catch (err) {
      toast('检查更新失败：' + String((err as Error)?.message ?? err));
    } finally {
      check.disabled = false;
      check.textContent = '检查更新';
    }
  };

  const auto = async () => {
    const info = await platform.checkUpdate(false).catch(() => null);
    if (info && !box.classList.contains('open')) offer(info.version);
  };
  return {
    /** the background check: now, then every hour (the host decides whether to really ask) */
    auto() {
      void auto();
      setInterval(() => void auto(), 3600_000);
    },
  };
}
