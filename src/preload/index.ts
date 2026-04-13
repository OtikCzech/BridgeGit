import { contextBridge, ipcRenderer } from 'electron';
import type {
  BranchSummary,
  CreateBranchOptions,
  CreateBranchResult,
  DeleteBranchResult,
  GitChange,
  GitCommitDetail,
  GitDiffMode,
  GitLogRequest,
  GitLogScope,
  GitLogResult,
  GitStatusRequestOptions,
  GitStatusSummary,
  GitTextSearchMatch,
  GitTextReplaceRequest,
  GitTextReplaceResult,
  GitTextSearchOptions,
  GitWorktreeSummary,
  MergeWorktreeIntoPrimaryBranchResult,
  NoteFileHandle,
  NoteFileStat,
  PtyCreateOptions,
  PtyDataEvent,
  PtyExitEvent,
  PtySessionInfo,
  RemoveWorktreeResult,
  RemoveWorktreeAndDeleteBranchResult,
  RepoDirectoryEntry,
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
    openRepo: (defaultPath?: string | null) =>
      ipcRenderer.invoke('dialog:openRepo', defaultPath) as Promise<string | null>,
  },
  notes: {
    openFile: () => ipcRenderer.invoke('notes:openFile') as Promise<NoteFileHandle | null>,
    readFile: (filePath: string) => ipcRenderer.invoke('notes:readFile', filePath) as Promise<NoteFileHandle>,
    inspectFile: (filePath: string) => ipcRenderer.invoke('notes:inspectFile', filePath) as Promise<NoteFileHandle | null>,
    statFile: (filePath: string) => ipcRenderer.invoke('notes:statFile', filePath) as Promise<NoteFileStat | null>,
    resolveLink: (baseFilePath: string | null, href: string) =>
      ipcRenderer.invoke('notes:resolveLink', baseFilePath, href) as Promise<string | null>,
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
    isRepository: (repoPath: string) =>
      ipcRenderer.invoke('git:isRepository', repoPath) as Promise<boolean>,
    initRepository: (repoPath: string) =>
      ipcRenderer.invoke('git:initRepository', repoPath) as Promise<void>,
    status: (repoPath: string, options?: GitStatusRequestOptions) =>
      ipcRenderer.invoke('git:status', repoPath, options) as Promise<GitStatusSummary>,
    branches: (repoPath: string) =>
      ipcRenderer.invoke('git:branches', repoPath) as Promise<BranchSummary>,
    listDirectory: (repoPath: string, relativePath?: string) =>
      ipcRenderer.invoke('git:listDirectory', repoPath, relativePath) as Promise<RepoDirectoryEntry[]>,
    listFiles: (repoPath: string) =>
      ipcRenderer.invoke('git:listFiles', repoPath) as Promise<string[]>,
    searchFiles: (repoPath: string, query: string, limit?: number) =>
      ipcRenderer.invoke('git:searchFiles', repoPath, query, limit) as Promise<string[]>,
    searchText: (repoPath: string, query: string, limit?: number, options?: GitTextSearchOptions) =>
      ipcRenderer.invoke('git:searchText', repoPath, query, limit, options) as Promise<GitTextSearchMatch[]>,
    replaceText: (repoPath: string, request: GitTextReplaceRequest) =>
      ipcRenderer.invoke('git:replaceText', repoPath, request) as Promise<GitTextReplaceResult>,
    worktrees: (repoPath: string) =>
      ipcRenderer.invoke('git:worktrees', repoPath) as Promise<GitWorktreeSummary[]>,
    diff: (repoPath: string, filePath?: string, mode?: GitDiffMode) =>
      ipcRenderer.invoke('git:diff', repoPath, filePath, mode) as Promise<string>,
    commitDiff: (repoPath: string, commitHash: string, parentHash?: string | null, filePath?: string | null) =>
      ipcRenderer.invoke('git:commitDiff', repoPath, commitHash, parentHash, filePath) as Promise<string>,
    log: (repoPath: string, request?: GitLogRequest) =>
      ipcRenderer.invoke('git:log', repoPath, request) as Promise<GitLogResult>,
    commitDetail: (repoPath: string, commitHash: string) =>
      ipcRenderer.invoke('git:commitDetail', repoPath, commitHash) as Promise<GitCommitDetail>,
    updateCommitMessage: (repoPath: string, commitHash: string, message: string) =>
      ipcRenderer.invoke('git:updateCommitMessage', repoPath, commitHash, message) as Promise<GitCommitDetail>,
    stage: (repoPath: string, files: string[]) =>
      ipcRenderer.invoke('git:stage', repoPath, files) as Promise<GitStatusSummary>,
    unstage: (repoPath: string, files: string[]) =>
      ipcRenderer.invoke('git:unstage', repoPath, files) as Promise<GitStatusSummary>,
    discard: (repoPath: string, change: GitChange) =>
      ipcRenderer.invoke('git:discard', repoPath, change) as Promise<GitStatusSummary>,
    discardHunk: (repoPath: string, patch: string, mode: GitDiffMode) =>
      ipcRenderer.invoke('git:discardHunk', repoPath, patch, mode) as Promise<GitStatusSummary>,
    commit: (repoPath: string, message: string) =>
      ipcRenderer.invoke('git:commit', repoPath, message) as Promise<GitStatusSummary>,
    checkout: (repoPath: string, branchName: string) =>
      ipcRenderer.invoke('git:checkout', repoPath, branchName) as Promise<BranchSummary>,
    createBranch: (repoPath: string, branchName: string, options?: CreateBranchOptions) =>
      ipcRenderer.invoke('git:createBranch', repoPath, branchName, options) as Promise<CreateBranchResult>,
    deleteBranch: (repoPath: string, branchName: string) =>
      ipcRenderer.invoke('git:deleteBranch', repoPath, branchName) as Promise<DeleteBranchResult>,
    mergeWorktreeIntoPrimaryBranch: (repoPath: string) =>
      ipcRenderer.invoke('git:mergeWorktreeIntoPrimaryBranch', repoPath) as Promise<MergeWorktreeIntoPrimaryBranchResult>,
    removeWorktree: (repoPath: string) =>
      ipcRenderer.invoke('git:removeWorktree', repoPath) as Promise<RemoveWorktreeResult>,
    removeWorktreeAndDeleteBranch: (repoPath: string) =>
      ipcRenderer.invoke('git:removeWorktreeAndDeleteBranch', repoPath) as Promise<RemoveWorktreeAndDeleteBranchResult>,
    pull: (repoPath: string) =>
      ipcRenderer.invoke('git:pull', repoPath) as Promise<GitStatusSummary>,
    push: (repoPath: string) =>
      ipcRenderer.invoke('git:push', repoPath) as Promise<GitStatusSummary>,
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
