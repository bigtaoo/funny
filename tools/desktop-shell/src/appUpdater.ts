import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { showUpdateNotice } from './updateNotifier';

/**
 * 壳级安装包自动更新，见 design/tools/desktop-shell/DESIGN.md §4.1。
 * 需要真实发布到 GitHub Releases（package.json `build.publish`）才查得到更新；
 * 未打包运行（`electron .` 直跑源码）时 electron-updater 无 app-update.yml，直接跳过。
 */

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时

export function initAppUpdater(): void {
  if (!app.isPackaged) {
    console.log('[desktop-shell] 开发模式（未打包），跳过壳级自动更新检查');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (err) => {
    console.error('[desktop-shell] 壳级自动更新出错：', err);
  });

  autoUpdater.on('update-downloaded', () => {
    showUpdateNotice('app', undefined, () => autoUpdater.quitAndInstall());
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[desktop-shell] checkForUpdates 失败：', err);
    });
  };

  setTimeout(check, 10_000);
  setInterval(check, CHECK_INTERVAL_MS);
}
