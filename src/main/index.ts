import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerGitIpcHandlers } from './git';
import { cleanupPtysForWebContents, registerPtyIpcHandlers } from './pty';
import { loadSession, saveSession } from './store';
import type { SessionData } from '../shared/bridgegit';

let mainWindow: BrowserWindow | null = null;

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const WINDOWS_APP_ID = 'cz.otik.bridgegit';
const NOTE_FILE_FILTERS = [
  {
    name: 'Markdown and text',
    extensions: ['md', 'markdown', 'txt'],
  },
  {
    name: 'All files',
    extensions: ['*'],
  },
];

function getPreloadPath() {
  return join(__dirname, '../preload/index.js');
}

function getRendererIndexPath() {
  return join(__dirname, '../renderer/index.html');
}

function getWindowIconPath() {
  const packagedIconPath = join(process.resourcesPath, 'assets/icons/bridgegit.ico');
  if (app.isPackaged && existsSync(packagedIconPath)) {
    return packagedIconPath;
  }

  return join(app.getAppPath(), 'assets/icons/bridgegit.ico');
}

function getDialogWindow() {
  return BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Unexpected file system error.';
}

async function createMainWindow() {
  const windowIcon = nativeImage.createFromPath(getWindowIconPath());

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: '#0b0f14',
    title: 'BridgeGit',
    icon: windowIcon.isEmpty() ? undefined : windowIcon,
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    if (!windowIcon.isEmpty()) {
      mainWindow?.setIcon(windowIcon);
    }

    mainWindow?.show();

    // if (isDevelopment) {
    //   mainWindow?.webContents.openDevTools({ mode: 'detach' });
    // }
  });

  const activeWebContentsId = mainWindow.webContents.id;

  mainWindow.on('closed', () => {
    cleanupPtysForWebContents(activeWebContentsId);
    mainWindow = null;
  });

  if (isDevelopment) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    await mainWindow.loadFile(getRendererIndexPath());
  }
}

function registerCoreIpcHandlers() {
  registerGitIpcHandlers();
  registerPtyIpcHandlers();

  ipcMain.handle('dialog:openRepo', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Git Repository',
      properties: ['openDirectory'],
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('notes:openFile', async () => {
    const options: OpenDialogOptions = {
      title: 'Open Note File',
      properties: ['openFile'],
      filters: NOTE_FILE_FILTERS,
    };
    const dialogWindow = getDialogWindow();
    const result = dialogWindow
      ? await dialog.showOpenDialog(dialogWindow, options)
      : await dialog.showOpenDialog(options);

    const filePath = result.canceled ? null : result.filePaths[0] ?? null;

    if (!filePath) {
      return null;
    }

    try {
      return {
        path: filePath,
        content: await readFile(filePath, 'utf8'),
      };
    } catch (error) {
      dialog.showErrorBox('Unable to open note file', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('notes:readFile', async (_event, filePath: string) => {
    try {
      return {
        path: filePath,
        content: await readFile(filePath, 'utf8'),
      };
    } catch (error) {
      dialog.showErrorBox('Unable to open note file', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('notes:saveFile', async (_event, filePath: string, content: string) => {
    try {
      await writeFile(filePath, content, 'utf8');
      return filePath;
    } catch (error) {
      dialog.showErrorBox('Unable to save note file', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('notes:saveFileAs', async (_event, content: string, defaultPath?: string | null) => {
    const options: SaveDialogOptions = {
      title: 'Save Note File',
      defaultPath: defaultPath?.trim() || undefined,
      filters: NOTE_FILE_FILTERS,
    };
    const dialogWindow = getDialogWindow();
    const result = dialogWindow
      ? await dialog.showSaveDialog(dialogWindow, options)
      : await dialog.showSaveDialog(options);

    const filePath = result.canceled ? null : result.filePath ?? null;

    if (!filePath) {
      return null;
    }

    try {
      await writeFile(filePath, content, 'utf8');
      return filePath;
    } catch (error) {
      dialog.showErrorBox('Unable to save note file', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('clipboard:writeText', async (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle('clipboard:readText', async () => clipboard.readText());
  ipcMain.handle('system:beep', async () => {
    if (process.env.WSL_DISTRO_NAME) {
      // WSL2 has no audio device — call PowerShell on the Windows host.
      execFile('powershell.exe', ['-NoProfile', '-c', '[console]::beep(1000,200)']);
    } else {
      shell.beep();
    }
  });

  ipcMain.handle('session:load', async () => loadSession());
  ipcMain.handle('session:save', async (_event, session: Partial<SessionData>) =>
    saveSession(session),
  );
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_ID);
  }

  registerCoreIpcHandlers();
  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
