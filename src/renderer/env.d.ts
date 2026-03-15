/// <reference types="vite/client" />

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
        openRepo: () => Promise<string | null>;
      };
      notes: {
        openFile: () => Promise<NoteFileHandle | null>;
        readFile: (filePath: string) => Promise<NoteFileHandle>;
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
        status: (repoPath: string) => Promise<GitStatusSummary>;
        branches: (repoPath: string) => Promise<BranchSummary>;
        diff: (repoPath: string, filePath?: string) => Promise<string>;
        commitDiff: (
          repoPath: string,
          commitHash: string,
          parentHash?: string | null,
        ) => Promise<string>;
        log: (repoPath: string, limit?: number) => Promise<GitLogResult>;
        stage: (repoPath: string, files: string[]) => Promise<GitStatusSummary>;
        unstage: (repoPath: string, files: string[]) => Promise<GitStatusSummary>;
        commit: (repoPath: string, message: string) => Promise<GitStatusSummary>;
        checkout: (repoPath: string, branchName: string) => Promise<BranchSummary>;
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
