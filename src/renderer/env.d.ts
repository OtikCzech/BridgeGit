/// <reference types="vite/client" />

import type {
  BranchSummary,
  CreateBranchOptions,
  CreateBranchResult,
  DeleteBranchResult,
  GitChange,
  GitDiffMode,
  GitLogResult,
  GitStatusRequestOptions,
  GitStatusSummary,
  GitTextSearchMatch,
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
      };
      git: {
        isRepository: (repoPath: string) => Promise<boolean>;
        initRepository: (repoPath: string) => Promise<void>;
        status: (repoPath: string, options?: GitStatusRequestOptions) => Promise<GitStatusSummary>;
        branches: (repoPath: string) => Promise<BranchSummary>;
        listDirectory: (repoPath: string, relativePath?: string) => Promise<RepoDirectoryEntry[]>;
        searchFiles: (repoPath: string, query: string, limit?: number) => Promise<string[]>;
        searchText: (
          repoPath: string,
          query: string,
          limit?: number,
          wholeWord?: boolean,
        ) => Promise<GitTextSearchMatch[]>;
        worktrees: (repoPath: string) => Promise<GitWorktreeSummary[]>;
        diff: (repoPath: string, filePath?: string, mode?: GitDiffMode) => Promise<string>;
        commitDiff: (
          repoPath: string,
          commitHash: string,
          parentHash?: string | null,
        ) => Promise<string>;
        log: (repoPath: string, limit?: number) => Promise<GitLogResult>;
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
    };
  }
}
