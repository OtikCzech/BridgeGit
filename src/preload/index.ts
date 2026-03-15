import { contextBridge, ipcRenderer } from 'electron';
import type {
  BranchSummary,
  GitLogResult,
  GitStatusSummary,
  NoteFileHandle,
  PtyCreateOptions,
  PtyDataEvent,
  PtyExitEvent,
  PtySessionInfo,
  SessionData,
} from '../shared/bridgegit';

const bridgegitApi = {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  dialog: {
    openRepo: () => ipcRenderer.invoke('dialog:openRepo') as Promise<string | null>,
  },
  notes: {
    openFile: () => ipcRenderer.invoke('notes:openFile') as Promise<NoteFileHandle | null>,
    readFile: (filePath: string) => ipcRenderer.invoke('notes:readFile', filePath) as Promise<NoteFileHandle>,
    saveFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('notes:saveFile', filePath, content) as Promise<string>,
    saveFileAs: (content: string, defaultPath?: string | null) =>
      ipcRenderer.invoke('notes:saveFileAs', content, defaultPath) as Promise<string | null>,
  },
  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke('clipboard:writeText', text) as Promise<void>,
    readText: () =>
      ipcRenderer.invoke('clipboard:readText') as Promise<string>,
  },
  system: {
    beep: () => ipcRenderer.invoke('system:beep') as Promise<void>,
  },
  session: {
    load: () => ipcRenderer.invoke('session:load') as Promise<SessionData>,
    save: (session: Partial<SessionData>) =>
      ipcRenderer.invoke('session:save', session) as Promise<SessionData>,
  },
  git: {
    status: (repoPath: string) =>
      ipcRenderer.invoke('git:status', repoPath) as Promise<GitStatusSummary>,
    branches: (repoPath: string) =>
      ipcRenderer.invoke('git:branches', repoPath) as Promise<BranchSummary>,
    diff: (repoPath: string, filePath?: string) =>
      ipcRenderer.invoke('git:diff', repoPath, filePath) as Promise<string>,
    commitDiff: (repoPath: string, commitHash: string, parentHash?: string | null) =>
      ipcRenderer.invoke('git:commitDiff', repoPath, commitHash, parentHash) as Promise<string>,
    log: (repoPath: string, limit?: number) =>
      ipcRenderer.invoke('git:log', repoPath, limit) as Promise<GitLogResult>,
    stage: (repoPath: string, files: string[]) =>
      ipcRenderer.invoke('git:stage', repoPath, files) as Promise<GitStatusSummary>,
    unstage: (repoPath: string, files: string[]) =>
      ipcRenderer.invoke('git:unstage', repoPath, files) as Promise<GitStatusSummary>,
    commit: (repoPath: string, message: string) =>
      ipcRenderer.invoke('git:commit', repoPath, message) as Promise<GitStatusSummary>,
    checkout: (repoPath: string, branchName: string) =>
      ipcRenderer.invoke('git:checkout', repoPath, branchName) as Promise<BranchSummary>,
  },
  terminal: {
    create: (options: PtyCreateOptions) =>
      ipcRenderer.invoke('pty:create', options) as Promise<PtySessionInfo>,
    write: (ptyId: string, data: string) => {
      ipcRenderer.send('pty:write', ptyId, data);
    },
    resize: (ptyId: string, cols: number, rows: number) => {
      ipcRenderer.send('pty:resize', ptyId, cols, rows);
    },
    kill: (ptyId: string) => {
      ipcRenderer.send('pty:kill', ptyId);
    },
    onData: (listener: (payload: PtyDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent) => {
        listener(payload);
      };

      ipcRenderer.on('pty:data', handler);

      return () => {
        ipcRenderer.off('pty:data', handler);
      };
    },
    onExit: (listener: (payload: PtyExitEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent) => {
        listener(payload);
      };

      ipcRenderer.on('pty:exit', handler);

      return () => {
        ipcRenderer.off('pty:exit', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('bridgegit', bridgegitApi);
