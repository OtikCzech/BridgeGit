import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, win32 } from 'node:path';
import { registerGitIpcHandlers } from './git';
import { cleanupPtysForWebContents, registerPtyIpcHandlers } from './pty';
import { loadSession, saveSession } from './store';
import type { NoteFileHandle, NoteFileStat, SessionData } from '../shared/bridgegit';

let mainWindow: BrowserWindow | null = null;

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const WINDOWS_APP_ID = 'cz.otik.bridgegit';
const WORKSPACE_FILE_FILTERS = [
  {
    name: 'All supported',
    extensions: [
      'md', 'markdown', 'txt',
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'json', 'jsonc',
      'vue', 'html', 'htm', 'css', 'scss', 'sass', 'less',
      'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
      'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat',
      'sql', 'lua', 'pl', 'php',
      'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
      'xml', 'svg', 'csv', 'log',
      'gitignore', 'gitattributes',
    ],
  },
  {
    name: 'All files',
    extensions: ['*'],
  },
];
const NOTE_LINK_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

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

async function readNoteFileHandle(filePath: string): Promise<NoteFileHandle> {
  const [content, fileStat] = await Promise.all([
    readFile(filePath, 'utf8'),
    stat(filePath),
  ]);

  return {
    path: filePath,
    content,
    lastModifiedMs: fileStat.mtimeMs,
    size: fileStat.size,
  };
}

async function readNoteFileStat(filePath: string): Promise<NoteFileStat | null> {
  try {
    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      return null;
    }

    return {
      path: filePath,
      lastModifiedMs: fileStat.mtimeMs,
      size: fileStat.size,
    };
  } catch {
    return null;
  }
}

function normalizeNoteLinkLookup(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .trim();
}

function isLikelyWindowsPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function resolveNoteLinkBaseDirectory(baseFilePath: string | null) {
  if (!baseFilePath?.trim()) {
    return null;
  }

  return isLikelyWindowsPath(baseFilePath)
    ? win32.dirname(baseFilePath)
    : dirname(baseFilePath);
}

function resolveNoteLinkPath(baseDirectory: string | null, href: string) {
  if (isLikelyWindowsPath(href)) {
    return win32.resolve(href);
  }

  if (isAbsolute(href)) {
    return resolve(href);
  }

  if (!baseDirectory) {
    return null;
  }

  return isLikelyWindowsPath(baseDirectory)
    ? win32.resolve(baseDirectory, href)
    : resolve(baseDirectory, href);
}

async function resolveExistingNoteLink(baseFilePath: string | null, rawHref: string): Promise<string | null> {
  const href = decodeURIComponent(rawHref.trim()).split('#')[0]?.split('?')[0]?.trim() ?? '';

  if (!href || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href) && !isLikelyWindowsPath(href)) {
    return null;
  }

  if (href.startsWith('//')) {
    return null;
  }

  const baseDirectory = resolveNoteLinkBaseDirectory(baseFilePath);
  const resolvedPath = resolveNoteLinkPath(baseDirectory, href);

  if (!resolvedPath) {
    return null;
  }

  const extension = extname(resolvedPath).toLowerCase();

  if (extension && NOTE_LINK_EXTENSIONS.has(extension) && existsSync(resolvedPath)) {
    return resolvedPath;
  }

  if (!extension) {
    for (const extensionCandidate of NOTE_LINK_EXTENSIONS) {
      const candidatePath = `${resolvedPath}${extensionCandidate}`;

      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  const candidateDirectory = dirname(resolvedPath);
  const targetStem = normalizeNoteLinkLookup(basename(resolvedPath, extension));

  try {
    const entries = await readdir(candidateDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const entryExtension = extname(entry.name).toLowerCase();

      if (!NOTE_LINK_EXTENSIONS.has(entryExtension)) {
        continue;
      }

      if (normalizeNoteLinkLookup(basename(entry.name, entryExtension)) === targetStem) {
        return join(candidateDirectory, entry.name);
      }
    }
  } catch {
    return null;
  }

  return null;
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

  ipcMain.handle('dialog:openRepo', async (_event, defaultPath?: string | null) => {
    const options: OpenDialogOptions = {
      title: 'Open Git Repository',
      properties: ['openDirectory'],
      defaultPath: defaultPath ?? undefined,
    };
    const dialogWindow = getDialogWindow();
    const result = dialogWindow
      ? await dialog.showOpenDialog(dialogWindow, options)
      : await dialog.showOpenDialog(options);

    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('notes:openFile', async () => {
    const options: OpenDialogOptions = {
      title: 'Open File',
      properties: ['openFile'],
      filters: WORKSPACE_FILE_FILTERS,
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
      return await readNoteFileHandle(filePath);
    } catch (error) {
      dialog.showErrorBox('Unable to open file', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('notes:readFile', async (_event, filePath: string) => {
    try {
      return await readNoteFileHandle(filePath);
    } catch (error) {
      dialog.showErrorBox('Unable to open file', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('notes:inspectFile', async (_event, filePath: string) => {
    try {
      return await readNoteFileHandle(filePath);
    } catch {
      return null;
    }
  });
  ipcMain.handle('notes:statFile', async (_event, filePath: string) => readNoteFileStat(filePath));
  ipcMain.handle('notes:resolveLink', async (_event, baseFilePath: string | null, href: string) => {
    try {
      return await resolveExistingNoteLink(baseFilePath, href);
    } catch (error) {
      dialog.showErrorBox('Unable to resolve note link', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('notes:saveFile', async (_event, filePath: string, content: string) => {
    try {
      await writeFile(filePath, content, 'utf8');
      return filePath;
    } catch (error) {
      dialog.showErrorBox('Unable to save file', formatErrorMessage(error));
      throw error;
    }
  });
  ipcMain.handle('notes:saveFileAs', async (_event, content: string, defaultPath?: string | null) => {
    const options: SaveDialogOptions = {
      title: 'Save File',
      defaultPath: defaultPath?.trim() || undefined,
      filters: WORKSPACE_FILE_FILTERS,
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
      dialog.showErrorBox('Unable to save file', formatErrorMessage(error));
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
