import { app, BrowserWindow, BrowserView, ipcMain, Menu, MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import { TOOLS, DEFAULT_TOOL_ID } from './tools';
import { registerGitSyncHandlers } from './gitSync';

const SIDEBAR_WIDTH = 180;

let mainWindow: BrowserWindow | null = null;
let sidebarView: BrowserView | null = null;
let contentView: BrowserView | null = null;
let activeToolId = DEFAULT_TOOL_ID;

function layoutViews(): void {
  if (!mainWindow || !sidebarView || !contentView) return;
  const [width, height] = mainWindow.getContentSize();
  sidebarView.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  contentView.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
}

function switchTool(toolId: string): void {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool || !contentView) return;
  activeToolId = tool.id;
  contentView.webContents.loadURL(tool.devUrl).catch((err) => {
    console.error(`[desktop-shell] 加载工具 ${tool.id} 失败：`, err);
  });
  sidebarView?.webContents.send('tool:active', activeToolId);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Notebook Wars — 工具箱',
  });

  sidebarView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preloadSidebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.addBrowserView(sidebarView);
  sidebarView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  contentView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.addBrowserView(contentView);

  layoutViews();
  mainWindow.on('resize', layoutViews);
  mainWindow.on('closed', () => {
    mainWindow = null;
    sidebarView = null;
    contentView = null;
  });

  switchTool(activeToolId);
  buildMenu();
}

function buildMenu(): void {
  const devSimulateMenu: MenuItemConstructorOptions = {
    label: '开发调试',
    submenu: [
      {
        label: '模拟：内容有新版本',
        click: () => contentView?.webContents.send('nw:update-available', { kind: 'content', toolId: activeToolId }),
      },
      {
        label: '模拟：请求当前工具保存',
        click: () => contentView?.webContents.send('nw:request-save'),
      },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([devSimulateMenu]));
}

ipcMain.handle('tools:list', () => TOOLS);
ipcMain.handle('tool:switch', (_e, toolId: string) => switchTool(toolId));
ipcMain.on('nw:save-ack', () => {
  console.log(`[desktop-shell] 工具 ${activeToolId} 已确认保存`);
});

registerGitSyncHandlers();

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
