/// <reference types="vite/client" />

import type {
  BranchSummary,
  CreateBranchOptions,
  CreateBranchResult,
  DeleteBranchResult,
  DockerContainerInfo,
  DockerImageInfo,
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

export {};

declare global {
  interface Window {
    bridgegit?: {
      platform: string;
      versions: {
        chrome: string;
        electron: string;
        node: string;
      };
      app: {
        setTerminalFocusState: (focused: boolean) => void;
      };
      dialog: {
        openRepo: (defaultPath?: string | null) => Promise<string | null>;
      };
      notes: {
        openFile: () => Promise<NoteFileHandle | null>;
        readFile: (filePath: string) => Promise<NoteFileHandle>;
        inspectFile: (filePath: string) => Promise<NoteFileHandle | null>;
        statFile: (filePath: string) => Promise<NoteFileStat | null>;
        resolveLink: (baseFilePath: string | null, href: string) => Promise<string | null>;
        saveFile: (filePath: string, content: string) => Promise<string>;
        saveFileAs: (content: string, defaultPath?: string | null) => Promise<string | null>;
      };
      clipboard: {
        writeText: (text: string) => Promise<void>;
        readText: () => Promise<string>;
      };
      system: {
        beep: () => Promise<void>;
      };
      session: {
        load: () => Promise<SessionData>;
        save: (session: Partial<SessionData>) => Promise<SessionData>;
        saveSync: (session: Partial<SessionData>) => SessionData | null;
        onCloseRequested: (callback: () => void) => () => void;
        notifyCloseReady: () => void;
      };
      git: {
        isRepository: (repoPath: string) => Promise<boolean>;
        initRepository: (repoPath: string) => Promise<void>;
        status: (repoPath: string, options?: GitStatusRequestOptions) => Promise<GitStatusSummary>;
        branches: (repoPath: string) => Promise<BranchSummary>;
        listDirectory: (repoPath: string, relativePath?: string) => Promise<RepoDirectoryEntry[]>;
        listFiles: (repoPath: string) => Promise<string[]>;
        searchFiles: (repoPath: string, query: string, limit?: number) => Promise<string[]>;
        searchText: (
          repoPath: string,
          query: string,
          limit?: number,
          options?: GitTextSearchOptions,
        ) => Promise<GitTextSearchMatch[]>;
        replaceText: (
          repoPath: string,
          request: GitTextReplaceRequest,
        ) => Promise<GitTextReplaceResult>;
        worktrees: (repoPath: string) => Promise<GitWorktreeSummary[]>;
        diff: (repoPath: string, filePath?: string, mode?: GitDiffMode) => Promise<string>;
        commitDiff: (
          repoPath: string,
          commitHash: string,
          parentHash?: string | null,
          filePath?: string | null,
        ) => Promise<string>;
        log: (repoPath: string, request?: GitLogRequest) => Promise<GitLogResult>;
        commitDetail: (repoPath: string, commitHash: string) => Promise<GitCommitDetail>;
        updateCommitMessage: (
          repoPath: string,
          commitHash: string,
          message: string,
        ) => Promise<GitCommitDetail>;
        stage: (repoPath: string, files: string[]) => Promise<GitStatusSummary>;
        unstage: (repoPath: string, files: string[]) => Promise<GitStatusSummary>;
        discard: (repoPath: string, change: GitChange) => Promise<GitStatusSummary>;
        discardHunk: (repoPath: string, patch: string, mode: GitDiffMode) => Promise<GitStatusSummary>;
        commit: (repoPath: string, message: string) => Promise<GitStatusSummary>;
        checkout: (repoPath: string, branchName: string) => Promise<BranchSummary>;
        createBranch: (
          repoPath: string,
          branchName: string,
          options?: CreateBranchOptions,
        ) => Promise<CreateBranchResult>;
        deleteBranch: (repoPath: string, branchName: string) => Promise<DeleteBranchResult>;
        mergeWorktreeIntoPrimaryBranch: (repoPath: string) => Promise<MergeWorktreeIntoPrimaryBranchResult>;
        removeWorktree: (repoPath: string) => Promise<RemoveWorktreeResult>;
        removeWorktreeAndDeleteBranch: (repoPath: string) => Promise<RemoveWorktreeAndDeleteBranchResult>;
        pull: (repoPath: string) => Promise<GitStatusSummary>;
        push: (repoPath: string) => Promise<GitStatusSummary>;
      };
      terminal: {
        create: (options: PtyCreateOptions) => Promise<PtySessionInfo>;
        write: (ptyId: string, data: string) => void;
        resize: (ptyId: string, cols: number, rows: number) => void;
        kill: (ptyId: string) => void;
        onData: (listener: (payload: PtyDataEvent) => void) => () => void;
        onExit: (listener: (payload: PtyExitEvent) => void) => () => void;
      };
      docker: {
        available: () => Promise<boolean>;
        containers: () => Promise<DockerContainerInfo[]>;
        images: () => Promise<DockerImageInfo[]>;
        containerAction: (
          containerId: string,
          action: 'start' | 'stop' | 'restart' | 'remove',
        ) => Promise<void>;
        removeImage: (imageId: string) => Promise<void>;
        composeUp: (cwd: string) => Promise<void>;
        composeDown: (cwd: string) => Promise<void>;
        composeRestart: (cwd: string) => Promise<void>;
        resetBackend: () => Promise<void>;
        logsCommand: (containerId: string) => Promise<{ shell: string; command: string }>;
      };
    };
  }
}
