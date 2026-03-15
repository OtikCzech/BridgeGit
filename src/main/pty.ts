import { app, ipcMain, webContents } from 'electron';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type {
  PtyCreateOptions,
  PtyDataEvent,
  PtyExitEvent,
  PtySessionInfo,
} from '../shared/bridgegit';
import { normalizeTerminalCwd } from './path-utils';

interface PtySession {
  info: PtySessionInfo;
  process: IPty;
  webContentsId: number;
}

const ptySessions = new Map<string, PtySession>();
let nextPtyId = 1;

function isPowerShellShell(shell: string): boolean {
  const normalizedShell = shell.toLowerCase();
  return normalizedShell.endsWith('powershell.exe') || normalizedShell.endsWith('pwsh.exe');
}

function isWindowsPowerShellShell(shell: string): boolean {
  const normalizedShell = shell.toLowerCase();
  return normalizedShell.endsWith('powershell.exe') || normalizedShell.endsWith('pwsh.exe');
}

function getPowerShellBootstrapCommand(): string {
  return [
    'function global:prompt {',
    '  $location = Get-Location',
    '  $providerPath = $location.ProviderPath',
    '  $displayPath = if ($providerPath) { $providerPath } else { $location.Path }',
    "  if ($displayPath -match '^\\\\\\\\wsl\\.localhost\\\\[^\\\\]+(?<path>\\\\.*)$') {",
    "    $displayPath = $Matches['path']",
    '  }',
    "  return \"PS $displayPath> \"",
    '}',
  ].join(' ');
}

function getShellArgs(shell: string): string[] {
  const normalizedShell = shell.toLowerCase();

  if (isWindowsPowerShellShell(shell) || normalizedShell.endsWith('pwsh')) {
    return ['-NoLogo', '-NoExit', '-Command', getPowerShellBootstrapCommand()];
  }

  if (normalizedShell.endsWith('bash') || normalizedShell.endsWith('zsh')) {
    return ['-l'];
  }

  return [];
}

function getShellCandidates(shell?: string): string[] {
  if (shell) {
    return [shell];
  }

  if (process.platform === 'win32') {
    return ['powershell.exe', 'pwsh.exe', 'pwsh', 'bash'];
  }

  return ['powershell.exe', 'pwsh', 'pwsh.exe', 'bash', 'zsh'];
}

function createTerminalEnv(shell: string): Record<string, string> {
  const terminalEnv: Record<string, string> = {};
  const blockedEnvKeys = new Set([
    'VITE_DEV_SERVER_URL',
  ]);

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ELECTRON_') || blockedEnvKeys.has(key)) {
      continue;
    }

    if (value !== undefined) {
      terminalEnv[key] = value;
    }
  }

  terminalEnv.TERM = 'xterm-256color';
  terminalEnv.COLORTERM = 'truecolor';

  if (isPowerShellShell(shell)) {
    terminalEnv.SystemRoot = terminalEnv.SystemRoot ?? 'C:\\Windows';
    terminalEnv.WINDIR = terminalEnv.WINDIR ?? terminalEnv.SystemRoot;
  }

  return terminalEnv;
}

function sendToRenderer<TPayload>(webContentsId: number, channel: string, payload: TPayload) {
  const target = webContents.fromId(webContentsId);

  if (!target || target.isDestroyed()) {
    return;
  }

  target.send(channel, payload);
}

function createPty(senderId: number, options: PtyCreateOptions = {}): PtySessionInfo {
  const candidates = getShellCandidates(options.shell);

  const ptyId = `pty-${nextPtyId++}`;
  const cwd = normalizeTerminalCwd(options.cwd);
  const cols = Math.max(20, options.cols ?? 120);
  const rows = Math.max(8, options.rows ?? 32);

  let lastError: unknown = null;

  for (const shell of candidates) {
    try {
      const info: PtySessionInfo = {
        ptyId,
        shell,
        cwd,
      };

      const process = pty.spawn(shell, getShellArgs(shell), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: createTerminalEnv(shell),
      });

      const session: PtySession = {
        info,
        process,
        webContentsId: senderId,
      };

      ptySessions.set(ptyId, session);

      process.onData((data) => {
        const payload: PtyDataEvent = { ptyId, data };
        sendToRenderer(session.webContentsId, 'pty:data', payload);
      });

      process.onExit(({ exitCode, signal }) => {
        const payload: PtyExitEvent = {
          ptyId,
          exitCode,
          signal: signal ?? null,
        };

        sendToRenderer(session.webContentsId, 'pty:exit', payload);
        ptySessions.delete(ptyId);
      });

      return info;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to create PTY session.');
}

function getSessionForSender(senderId: number, ptyId: string): PtySession | null {
  const session = ptySessions.get(ptyId);

  if (!session || session.webContentsId !== senderId) {
    return null;
  }

  return session;
}

export function cleanupPtysForWebContents(webContentsId: number) {
  for (const [ptyId, session] of ptySessions.entries()) {
    if (session.webContentsId !== webContentsId) {
      continue;
    }

    session.process.kill();
    ptySessions.delete(ptyId);
  }
}

export function killAllPtys() {
  for (const [ptyId, session] of ptySessions.entries()) {
    session.process.kill();
    ptySessions.delete(ptyId);
  }
}

export function registerPtyIpcHandlers() {
  ipcMain.handle('pty:create', (event, options: PtyCreateOptions) =>
    createPty(event.sender.id, options),
  );

  ipcMain.on('pty:write', (event, ptyId: string, data: string) => {
    const session = getSessionForSender(event.sender.id, ptyId);

    if (!session) {
      return;
    }

    session.process.write(data);
  });

  ipcMain.on('pty:resize', (event, ptyId: string, cols: number, rows: number) => {
    const session = getSessionForSender(event.sender.id, ptyId);

    if (!session) {
      return;
    }

    session.process.resize(Math.max(20, cols), Math.max(8, rows));
  });

  ipcMain.on('pty:kill', (event, ptyId: string) => {
    const session = getSessionForSender(event.sender.id, ptyId);

    if (!session) {
      return;
    }

    session.process.kill();
    ptySessions.delete(ptyId);
  });

  app.on('before-quit', () => {
    killAllPtys();
  });
}
