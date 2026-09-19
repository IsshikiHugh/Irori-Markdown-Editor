/* The self-update offer. Once per app run the host is asked whether a newer release is out; if
   so, a small note sits in the bottom-left corner until it is answered. Nothing is downloaded
   without a click, and none of it may get in the way of writing: a failed check says nothing,
   and the note's buttons never take focus from the text. */

import type { Platform } from '../platform/types';

export async function offerUpdate(platform: Platform) {
  const box = document.getElementById('update') as HTMLElement;
  const text = document.getElementById('utext') as HTMLElement;
  const yes = document.getElementById('uyes') as HTMLButtonElement;
  const no = document.getElementById('uno') as HTMLButtonElement;

  const info = await platform.checkUpdate().catch(() => null);
  if (!info) return;

  const close = () => box.classList.remove('open');
  const busy = (on: boolean) => {
    yes.disabled = no.disabled = on;
  };
  box.addEventListener('mousedown', (e) => e.preventDefault());
  text.textContent = `Irori ${info.version} 已发布` + (info.quits ? '（安装时 Irori 会关闭，请先保存）' : '');
  no.onclick = close;
  yes.onclick = async () => {
    busy(true);
    text.textContent = '正在下载更新…';
    try {
      await platform.installUpdate();
      // Windows never gets here: the installer takes over and the app quits
      text.textContent = `已更新到 ${info.version}，下次打开 Irori 时生效`;
      yes.hidden = no.hidden = true;
      setTimeout(close, 6000);
    } catch (err) {
      text.textContent = '更新失败：' + String((err as Error)?.message ?? err);
      yes.textContent = '重试';
      busy(false);
    }
  };
  box.classList.add('open');
}
