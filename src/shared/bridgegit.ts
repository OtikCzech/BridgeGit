export type GitChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechanged'
  | 'untracked'
  | 'conflicted'
  | 'unknown';

export interface GitChange {
  path: string;
  type: GitChangeKind;
  originalPath?: string;
}

export interface GitStatusSummary {
  currentBranch: string | null;
  trackingBranch: string | null;
  ahead: number;
  behind: number;
  isClean: boolean;
  staged: GitChange[];
  unstaged: GitChange[];
  untracked: GitChange[];
  conflicted: GitChange[];
}

export interface BranchInfo {
  name: string;
  current: boolean;
}

export interface BranchSummary {
  current: string | null;
  all: BranchInfo[];
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  parentHashes: string[];
  date: string;
  message: string;
  authorName: string;
  refs: GitCommitRef[];
}

export interface GitLogResult {
  total: number;
  items: GitLogEntry[];
}

export interface GitCommitRef {
  name: string;
  shortName: string;
  kind: 'head' | 'local-branch' | 'remote-branch' | 'tag' | 'other';
  current: boolean;
}

export interface PanelLayout {
  sidebarWidth: number;
  terminalHeight: number;
  terminalWidth: number;
  contentLayout: 'stacked' | 'side-by-side';
  sidebarCollapsed: boolean;
  diffCollapsed: boolean;
  terminalCollapsed: boolean;
}

export interface PtyCreateOptions {
  shell?: string;
  cwd?: string | null;
  cols?: number;
  rows?: number;
}

export interface PtySessionInfo {
  ptyId: string;
  shell: string;
  cwd: string;
}

export interface PtyDataEvent {
  ptyId: string;
  data: string;
}

export interface PtyExitEvent {
  ptyId: string;
  exitCode: number;
  signal: number | null;
}

export interface RecentRepoEntry {
  path: string;
  name: string;
  lastUsedAt: string;
}

export interface WorkspaceShellTabState {
  id: string;
  type: 'shell';
  title: string;
  cwd: string;
  launcherProfileId?: string | null;
}

export interface WorkspaceNoteTabState {
  id: string;
  type: 'note';
  title: string;
  filePath: string | null;
  content: string;
  savedContent: string;
  viewMode: 'source' | 'split' | 'preview';
  fontSize: number;
}

export type WorkspaceTabState = WorkspaceShellTabState | WorkspaceNoteTabState;

export interface WorkspaceSessionState {
  tabs: WorkspaceTabState[];
  activeTabId: string | null;
}

export type WorkspaceSessionsByContext = Record<string, WorkspaceSessionState>;

export interface NoteFileHandle {
  path: string;
  content: string;
}

export const GLOBAL_WORKSPACE_SESSION_KEY = '__global__';
export const DEFAULT_NOTE_FONT_SIZE = 14;
export const MIN_NOTE_FONT_SIZE = 12;
export const MAX_NOTE_FONT_SIZE = 24;

export type TerminalCommandTarget = 'active-tab' | 'new-tab';

export interface TerminalCommandWriteStep {
  id: string;
  type: 'write';
  value: string;
  submit: boolean;
}

export interface TerminalCommandWaitStep {
  id: string;
  type: 'wait-for-prompt';
  pattern: string;
}

export interface TerminalCommandDelayStep {
  id: string;
  type: 'delay';
  delayMs: number;
}

export type TerminalCommandStep =
  | TerminalCommandWriteStep
  | TerminalCommandWaitStep
  | TerminalCommandDelayStep;

export interface TerminalCommandPreset {
  id: string;
  name: string;
  target: TerminalCommandTarget;
  shortcutSlot: number | null;
  steps: TerminalCommandStep[];
}

export type ProjectTitleMode = 'auto' | 'custom';

export interface SessionData {
  lastRepoPath: string | null;
  recentRepos: RecentRepoEntry[];
  panelLayout: PanelLayout;
  terminalCwd: string | null;
  projectTitle: string;
  projectTitleMode: ProjectTitleMode;
  soundNotificationsEnabled: boolean;
  infoNoteLastSeenRevision: string | null;
  terminalCommandPresets: TerminalCommandPreset[];
  workspaceSessions: WorkspaceSessionsByContext;
}

export interface ProjectSettingsFormData {
  projectTitle: string;
  contentLayout: PanelLayout['contentLayout'];
  soundNotificationsEnabled: boolean;
  terminalCommandPresets: TerminalCommandPreset[];
}

export function cloneTerminalCommandPresets(presets: TerminalCommandPreset[]): TerminalCommandPreset[] {
  return presets.map((preset) => ({
    ...preset,
    steps: preset.steps.map((step) => ({ ...step })),
  }));
}

export function cloneWorkspaceTabs(workspaceTabs: WorkspaceTabState[]): WorkspaceTabState[] {
  return workspaceTabs.map((tab) => ({ ...tab }));
}

export function cloneWorkspaceSessionState(workspaceSession: WorkspaceSessionState): WorkspaceSessionState {
  return {
    tabs: cloneWorkspaceTabs(workspaceSession.tabs),
    activeTabId: workspaceSession.activeTabId,
  };
}

export function cloneWorkspaceSessions(workspaceSessions: WorkspaceSessionsByContext): WorkspaceSessionsByContext {
  return Object.fromEntries(
    Object.entries(workspaceSessions).map(([contextKey, workspaceSession]) => (
      [contextKey, cloneWorkspaceSessionState(workspaceSession)]
    )),
  );
}

export function normalizeNoteFontSize(fontSize: number | null | undefined): number {
  if (typeof fontSize !== 'number' || Number.isNaN(fontSize) || !Number.isFinite(fontSize)) {
    return DEFAULT_NOTE_FONT_SIZE;
  }

  return Math.min(MAX_NOTE_FONT_SIZE, Math.max(MIN_NOTE_FONT_SIZE, Math.round(fontSize)));
}

const DEFAULT_TERMINAL_COMMAND_PRESETS: TerminalCommandPreset[] = [
  {
    id: 'command-codex',
    name: 'Codex',
    target: 'active-tab',
    shortcutSlot: 1,
    steps: [
      {
        id: 'command-codex-step-1',
        type: 'write',
        value: 'wsl',
        submit: true,
      },
      {
        id: 'command-codex-step-2',
        type: 'wait-for-prompt',
        pattern: '^.+[>#\\$]\\s?$',
      },
      {
        id: 'command-codex-step-3',
        type: 'write',
        value: 'codex',
        submit: true,
      },
    ],
  },
  {
    id: 'command-claude-code',
    name: 'Claude code',
    target: 'active-tab',
    shortcutSlot: 2,
    steps: [
      {
        id: 'command-claude-code-step-1',
        type: 'write',
        value: 'wsl',
        submit: true,
      },
      {
        id: 'command-claude-code-step-2',
        type: 'wait-for-prompt',
        pattern: '^.+[>#\\$]\\s?$',
      },
      {
        id: 'command-claude-code-step-3',
        type: 'write',
        value: 'claude',
        submit: true,
      },
    ],
  },
];

export function getDefaultTerminalCommandPresets(): TerminalCommandPreset[] {
  return cloneTerminalCommandPresets(DEFAULT_TERMINAL_COMMAND_PRESETS);
}

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  sidebarWidth: 310,
  terminalHeight: 520,
  terminalWidth: 420,
  contentLayout: 'stacked',
  sidebarCollapsed: false,
  diffCollapsed: false,
  terminalCollapsed: false,
};

export const DEFAULT_SESSION_DATA: SessionData = {
  lastRepoPath: null,
  recentRepos: [],
  panelLayout: { ...DEFAULT_PANEL_LAYOUT },
  terminalCwd: null,
  projectTitle: 'BridgeGit',
  projectTitleMode: 'auto',
  soundNotificationsEnabled: true,
  infoNoteLastSeenRevision: null,
  terminalCommandPresets: getDefaultTerminalCommandPresets(),
  workspaceSessions: {},
};
