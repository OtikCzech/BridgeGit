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

export type GitDiffMode = 'working-tree' | 'staged';

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

export interface GitStatusRequestOptions {
  fetchOrigin?: boolean;
}

export type BranchKind = 'local' | 'remote';

export type BranchSyncStatus =
  | 'local-only'
  | 'remote-untracked'
  | 'tracked-synced'
  | 'tracked-ahead'
  | 'tracked-behind'
  | 'tracked-diverged'
  | 'tracked-gone'
  | 'remote-only';

export interface BranchInfo {
  name: string;
  shortName: string;
  displayName: string;
  kind: BranchKind;
  current: boolean;
  checkedOutElsewhere: boolean;
  worktreePath: string | null;
  remoteName: string | null;
  upstreamName: string | null;
  ahead: number;
  behind: number;
  syncStatus: BranchSyncStatus;
  hasMatchingRemote: boolean;
  hasMatchingLocal: boolean;
}

export interface BranchSummary {
  current: string | null;
  all: BranchInfo[];
  local: BranchInfo[];
  remote: BranchInfo[];
}

export interface CreateBranchOptions {
  checkout?: boolean;
  placement?: 'current-repo' | 'new-repo';
}

export interface CreateBranchResult {
  branches: BranchSummary;
  repoPath: string;
}

export interface DeleteBranchResult {
  branches: BranchSummary;
  deletedBranch: string;
}

export interface MergeWorktreeIntoPrimaryBranchResult {
  repoPath: string;
  primaryRepoPath: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface RemoveWorktreeResult {
  repoPath: string;
  primaryRepoPath: string;
  removedBranch: string | null;
}

export interface RemoveWorktreeAndDeleteBranchResult {
  repoPath: string;
  primaryRepoPath: string;
  removedBranch: string | null;
  deletedBranch: string | null;
}

export interface RepoDirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
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

export interface GitWorktreeSummary {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  current: boolean;
}

const COMPARABLE_WSL_UNC_PATH_PATTERN = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i;
const COMPARABLE_WINDOWS_DRIVE_PATH_PATTERN = /^([A-Za-z]):(?:\/(.*))?$/;
const COMPARABLE_WSL_MOUNT_PATH_PATTERN = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;

function trimComparablePathSuffix(pathValue: string): string {
  if (pathValue === '/') {
    return pathValue;
  }

  return pathValue.replace(/\/+$/, '');
}

function normalizeComparablePosixPath(pathValue: string): string {
  return trimComparablePathSuffix(pathValue.replace(/\/+/g, '/')) || '/';
}

function extractComparableLinuxPath(comparablePath: string): string | null {
  if (comparablePath.startsWith('posix:')) {
    return comparablePath.slice('posix:'.length);
  }

  if (comparablePath.startsWith('wsl:')) {
    const firstSlashIndex = comparablePath.indexOf('/', 'wsl:'.length);

    return firstSlashIndex >= 0 ? comparablePath.slice(firstSlashIndex) : '/';
  }

  return null;
}

export function normalizeRepoPathForComparison(pathValue: string | null | undefined): string {
  const trimmedPath = pathValue?.trim();

  if (!trimmedPath) {
    return '';
  }

  const normalizedPath = trimComparablePathSuffix(trimmedPath.replace(/\\/g, '/'));
  const comparableWslPath = COMPARABLE_WSL_UNC_PATH_PATTERN.exec(normalizedPath);

  if (comparableWslPath) {
    const [, distro, suffix = ''] = comparableWslPath;
    const linuxPath = normalizeComparablePosixPath(suffix || '/');

    return `wsl:${distro.toLowerCase()}${linuxPath}`;
  }

  const comparableWslMount = COMPARABLE_WSL_MOUNT_PATH_PATTERN.exec(normalizedPath);

  if (comparableWslMount) {
    const [, driveLetter, suffix = ''] = comparableWslMount;
    const normalizedSuffix = suffix.replace(/\/+/g, '/');

    return normalizedSuffix
      ? `drive:${driveLetter.toLowerCase()}/${normalizedSuffix}`
      : `drive:${driveLetter.toLowerCase()}`;
  }

  const comparableWindowsDrivePath = COMPARABLE_WINDOWS_DRIVE_PATH_PATTERN.exec(normalizedPath);

  if (comparableWindowsDrivePath) {
    const [, driveLetter, suffix = ''] = comparableWindowsDrivePath;
    const normalizedSuffix = suffix.replace(/\/+/g, '/');

    return normalizedSuffix
      ? `drive:${driveLetter.toLowerCase()}/${normalizedSuffix}`
      : `drive:${driveLetter.toLowerCase()}`;
  }

  if (normalizedPath.startsWith('/')) {
    return `posix:${normalizeComparablePosixPath(normalizedPath)}`;
  }

  return `path:${normalizedPath.toLowerCase()}`;
}

export function areRepoPathsEquivalent(
  leftPath: string | null | undefined,
  rightPath: string | null | undefined,
): boolean {
  const normalizedLeftPath = normalizeRepoPathForComparison(leftPath);
  const normalizedRightPath = normalizeRepoPathForComparison(rightPath);

  if (!normalizedLeftPath || !normalizedRightPath) {
    return false;
  }

  if (normalizedLeftPath === normalizedRightPath) {
    return true;
  }

  const leftLinuxPath = extractComparableLinuxPath(normalizedLeftPath);
  const rightLinuxPath = extractComparableLinuxPath(normalizedRightPath);

  return Boolean(leftLinuxPath && rightLinuxPath && leftLinuxPath === rightLinuxPath);
}

export interface PanelLayout {
  sidebarWidth: number;
  terminalHeight: number;
  terminalWidth: number;
  sidebarSide: 'left' | 'right';
  diffPlacement: 'left' | 'right' | 'top' | 'bottom';
  sidebarCollapsed: boolean;
  diffCollapsed: boolean;
  terminalCollapsed: boolean;
}

export type PanelLayoutsByWorkspace = Record<string, PanelLayout>;
export type RepoPanelFileListMode = 'list' | 'tree';
export type RepoPanelSectionId = 'staged' | 'changed' | 'untracked' | 'conflicts';
export type RepoPanelSectionState = Record<RepoPanelSectionId, boolean>;

export interface WorkspaceRepoPanelFilesState {
  expanded: boolean;
  viewMode: RepoPanelFileListMode;
  showAll: boolean;
  collapsedSections: RepoPanelSectionState;
}

export interface WorkspaceRepoPanelState {
  fontSize: number;
  historyOpen: boolean;
  workspaceDetailExpanded: boolean;
  workspaceFamilyFocus: boolean;
  files: WorkspaceRepoPanelFilesState;
}

export type WorkspaceRepoPanelStatesById = Record<string, WorkspaceRepoPanelState>;

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
  fontSize: number;
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

export interface WorkspaceCodeTabState {
  id: string;
  type: 'code';
  title: string;
  filePath: string;
  content: string;
  savedContent: string;
  fontSize: number;
}

export interface WorkspaceEditorPaneState {
  id: string;
  row: 0 | 1;
  col: 0 | 1;
  tabId: string | null;
}

export interface WorkspaceEditorPaneLayout {
  panes: WorkspaceEditorPaneState[];
  activePaneId: string | null;
}

export interface CodeNavigationTarget {
  filePath: string;
  line?: number;
  column?: number;
}

export interface CodeNavigationRequest extends CodeNavigationTarget {
  token: number;
}

export interface GitTextSearchMatch {
  path: string;
  filePath: string;
  line: number;
  column: number;
  text: string;
}

export type WorkspaceExternalFileChangeState = 'changed' | 'unavailable' | 'session-dirty';

export type WorkspaceTabState = WorkspaceShellTabState | WorkspaceNoteTabState | WorkspaceCodeTabState;

export interface WorkspaceSessionState {
  tabs: WorkspaceTabState[];
  activeTabId: string | null;
  editorPaneLayout: WorkspaceEditorPaneLayout;
}

export type WorkspaceKind = 'global' | 'project';

export interface WorkspaceDescriptor {
  id: string;
  kind: WorkspaceKind;
  repoPath: string | null;
}

export type WorkspaceDescriptorsById = Record<string, WorkspaceDescriptor>;
export type WorkspaceSessionsById = Record<string, WorkspaceSessionState>;

export interface WorkspaceOverviewItem {
  workspaceId: string;
  path: string | null;
  title: string;
  repoName: string;
  branch: string | null;
  changedCount: number | null;
  untrackedCount: number | null;
  conflictedCount: number | null;
  worktreeRole: 'primary' | 'linked' | null;
  hasPanelActivity: boolean;
  hasPanelAttention: boolean;
  isCurrent: boolean;
}

export interface WorkspaceIndicatorVisibilitySettings {
  repo: boolean;
  activity: boolean;
  attention: boolean;
}

export type AppAppearance = 'bridgegit-dark' | 'bridgegit-light' | 'github-dark' | 'github-light' | 'nord';
export type EditorThemePreset = AppAppearance;
export type EditorTheme = 'follow-app' | EditorThemePreset;
export type ResolvedEditorTheme = EditorThemePreset;
export type ThemeVariant = 'dark' | 'light';

export interface WorkspaceTabDefaults {
  shellFontSize: number;
  noteFontSize: number;
}

export type WorktreeDetectionInterval = 60_000 | 180_000 | 300_000 | 900_000 | null;

export interface NoteFileStat {
  path: string;
  lastModifiedMs: number;
  size: number;
}

export interface NoteFileHandle extends NoteFileStat {
  content: string;
}

export type WorkspaceFileTabType = 'note' | 'code' | 'unsupported';

export const GLOBAL_WORKSPACE_SESSION_KEY = '__global__';
export const GLOBAL_WORKSPACE_ID = 'workspace-global';
export const DEFAULT_SHELL_FONT_SIZE = 13;
export const MIN_SHELL_FONT_SIZE = 11;
export const MAX_SHELL_FONT_SIZE = 22;
export const DEFAULT_NOTE_FONT_SIZE = 14;
export const MIN_NOTE_FONT_SIZE = 12;
export const MAX_NOTE_FONT_SIZE = 24;
const WORKSPACE_NOTE_FILE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const WORKSPACE_CODE_FILE_EXTENSIONS = new Set([
  'bash',
  'bat',
  'c',
  'cc',
  'cfg',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'env',
  'gitignore',
  'gitattributes',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'log',
  'lua',
  'mjs',
  'php',
  'pl',
  'ps1',
  'psm1',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);
const WORKSPACE_CODE_FILE_NAMES = new Set([
  '.editorconfig',
  '.env',
  '.env.example',
  '.eslintignore',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  'dockerfile',
  'makefile',
  'readme',
]);

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
  activeWorkspaceId: string | null;
  recentRepos: RecentRepoEntry[];
  workspaceOrder: string[];
  workspaceDescriptors: WorkspaceDescriptorsById;
  panelLayout: PanelLayout;
  panelLayoutsByWorkspace: PanelLayoutsByWorkspace;
  workspaceRepoPanelStates: WorkspaceRepoPanelStatesById;
  repoPanelFontSize: number;
  terminalCwd: string | null;
  projectTitle: string;
  projectTitleMode: ProjectTitleMode;
  projectTitlesByContext: Record<string, string>;
  appAppearance: AppAppearance;
  editorTheme: EditorTheme;
  workspaceIndicatorVisibility: WorkspaceIndicatorVisibilitySettings;
  workspaceTabDefaults: WorkspaceTabDefaults;
  worktreeDetectionIntervalMs: WorktreeDetectionInterval;
  dismissedWorktreePaths: string[];
  soundNotificationsEnabled: boolean;
  seenInfoNoteRevisions: string[];
  terminalCommandPresets: TerminalCommandPreset[];
  workspaceSessions: WorkspaceSessionsById;
}

export interface ProjectSettingsFormData {
  projectTitle: string;
  sidebarSide: PanelLayout['sidebarSide'];
  diffPlacement: PanelLayout['diffPlacement'];
  appAppearance: AppAppearance;
  editorTheme: EditorTheme;
  workspacePanelFontSize: number;
  workspaceIndicatorVisibility: WorkspaceIndicatorVisibilitySettings;
  workspaceTabDefaults: WorkspaceTabDefaults;
  worktreeDetectionIntervalMs: WorktreeDetectionInterval;
  soundNotificationsEnabled: boolean;
  terminalCommandPresets: TerminalCommandPreset[];
}

export function cloneWorkspaceIndicatorVisibilitySettings(
  workspaceIndicatorVisibility: WorkspaceIndicatorVisibilitySettings,
): WorkspaceIndicatorVisibilitySettings {
  return { ...workspaceIndicatorVisibility };
}

export function cloneWorkspaceTabDefaults(workspaceTabDefaults: WorkspaceTabDefaults): WorkspaceTabDefaults {
  return { ...workspaceTabDefaults };
}

export function cloneDismissedWorktreePaths(dismissedWorktreePaths: string[]): string[] {
  return [...dismissedWorktreePaths];
}

export function cloneSeenInfoNoteRevisions(seenInfoNoteRevisions: string[]): string[] {
  return [...seenInfoNoteRevisions];
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

export function cloneWorkspaceEditorPaneLayout(
  workspaceEditorPaneLayout: WorkspaceEditorPaneLayout,
): WorkspaceEditorPaneLayout {
  return {
    panes: workspaceEditorPaneLayout.panes.map((pane) => ({ ...pane })),
    activePaneId: workspaceEditorPaneLayout.activePaneId,
  };
}

export function cloneWorkspaceSessionState(workspaceSession: WorkspaceSessionState): WorkspaceSessionState {
  return {
    tabs: cloneWorkspaceTabs(workspaceSession.tabs),
    activeTabId: workspaceSession.activeTabId,
    editorPaneLayout: cloneWorkspaceEditorPaneLayout(workspaceSession.editorPaneLayout),
  };
}

export function cloneWorkspaceDescriptors(workspaceDescriptors: WorkspaceDescriptorsById): WorkspaceDescriptorsById {
  return Object.fromEntries(
    Object.entries(workspaceDescriptors).map(([workspaceId, workspaceDescriptor]) => (
      [workspaceId, { ...workspaceDescriptor }]
    )),
  );
}

export function cloneWorkspaceSessions(workspaceSessions: WorkspaceSessionsById): WorkspaceSessionsById {
  return Object.fromEntries(
    Object.entries(workspaceSessions).map(([workspaceId, workspaceSession]) => (
      [workspaceId, cloneWorkspaceSessionState(workspaceSession)]
    )),
  );
}

export function clonePanelLayoutsByWorkspace(panelLayoutsByWorkspace: PanelLayoutsByWorkspace): PanelLayoutsByWorkspace {
  return Object.fromEntries(
    Object.entries(panelLayoutsByWorkspace).map(([workspaceId, panelLayout]) => (
      [workspaceId, { ...panelLayout }]
    )),
  );
}

export function cloneRepoPanelSectionState(repoPanelSectionState: RepoPanelSectionState): RepoPanelSectionState {
  return { ...repoPanelSectionState };
}

export function cloneWorkspaceRepoPanelState(workspaceRepoPanelState: WorkspaceRepoPanelState): WorkspaceRepoPanelState {
  return {
    fontSize: workspaceRepoPanelState.fontSize,
    historyOpen: workspaceRepoPanelState.historyOpen,
    workspaceDetailExpanded: workspaceRepoPanelState.workspaceDetailExpanded,
    workspaceFamilyFocus: workspaceRepoPanelState.workspaceFamilyFocus,
    files: {
      expanded: workspaceRepoPanelState.files.expanded,
      viewMode: workspaceRepoPanelState.files.viewMode,
      showAll: workspaceRepoPanelState.files.showAll,
      collapsedSections: cloneRepoPanelSectionState(workspaceRepoPanelState.files.collapsedSections),
    },
  };
}

export function cloneWorkspaceRepoPanelStates(
  workspaceRepoPanelStates: WorkspaceRepoPanelStatesById,
): WorkspaceRepoPanelStatesById {
  return Object.fromEntries(
    Object.entries(workspaceRepoPanelStates).map(([workspaceId, workspaceRepoPanelState]) => (
      [workspaceId, cloneWorkspaceRepoPanelState(workspaceRepoPanelState)]
    )),
  );
}

export function cloneProjectTitlesByContext(projectTitlesByContext: Record<string, string>): Record<string, string> {
  return { ...projectTitlesByContext };
}

export function normalizeAppAppearance(appAppearance: AppAppearance | null | undefined): AppAppearance {
  if (
    appAppearance === 'bridgegit-light'
    || appAppearance === 'github-dark'
    || appAppearance === 'github-light'
    || appAppearance === 'nord'
  ) {
    return appAppearance;
  }

  return 'bridgegit-dark';
}

export function normalizeEditorTheme(editorTheme: EditorTheme | null | undefined): EditorTheme {
  if (
    editorTheme === 'bridgegit-dark'
    || editorTheme === 'bridgegit-light'
    || editorTheme === 'github-dark'
    || editorTheme === 'github-light'
    || editorTheme === 'nord'
  ) {
    return editorTheme;
  }

  return 'follow-app';
}

export function resolveThemeVariant(theme: AppAppearance | EditorTheme | ResolvedEditorTheme): ThemeVariant {
  return theme === 'bridgegit-light' || theme === 'github-light' ? 'light' : 'dark';
}

export function normalizeNoteFontSize(fontSize: number | null | undefined): number {
  if (typeof fontSize !== 'number' || Number.isNaN(fontSize) || !Number.isFinite(fontSize)) {
    return DEFAULT_NOTE_FONT_SIZE;
  }

  return Math.min(MAX_NOTE_FONT_SIZE, Math.max(MIN_NOTE_FONT_SIZE, Math.round(fontSize)));
}

export function getWorkspaceFileExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
  const fileNameParts = fileName.split('.');

  if (fileName.startsWith('.') && fileNameParts.length === 2) {
    return fileName.slice(1).toLowerCase();
  }

  return fileNameParts.length > 1
    ? fileNameParts.at(-1)?.toLowerCase() ?? ''
    : '';
}

export function getWorkspaceFileBaseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? filePath.toLowerCase();
}

export function resolveWorkspaceFileTabType(filePath: string): WorkspaceFileTabType {
  const extension = getWorkspaceFileExtension(filePath);

  if (WORKSPACE_NOTE_FILE_EXTENSIONS.has(extension)) {
    return 'note';
  }

  if (WORKSPACE_CODE_FILE_EXTENSIONS.has(extension) || WORKSPACE_CODE_FILE_NAMES.has(getWorkspaceFileBaseName(filePath))) {
    return 'code';
  }

  return 'unsupported';
}

export function normalizeShellFontSize(fontSize: number | null | undefined): number {
  if (typeof fontSize !== 'number' || Number.isNaN(fontSize) || !Number.isFinite(fontSize)) {
    return DEFAULT_SHELL_FONT_SIZE;
  }

  return Math.min(MAX_SHELL_FONT_SIZE, Math.max(MIN_SHELL_FONT_SIZE, Math.round(fontSize)));
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
  sidebarSide: 'left',
  diffPlacement: 'top',
  sidebarCollapsed: false,
  diffCollapsed: false,
  terminalCollapsed: false,
};

export const DEFAULT_SESSION_DATA: SessionData = {
  lastRepoPath: null,
  activeWorkspaceId: GLOBAL_WORKSPACE_ID,
  recentRepos: [],
  workspaceOrder: [],
  workspaceDescriptors: {
    [GLOBAL_WORKSPACE_ID]: {
      id: GLOBAL_WORKSPACE_ID,
      kind: 'global',
      repoPath: null,
    },
  },
  panelLayout: { ...DEFAULT_PANEL_LAYOUT },
  panelLayoutsByWorkspace: {
    [GLOBAL_WORKSPACE_ID]: { ...DEFAULT_PANEL_LAYOUT },
  },
  workspaceRepoPanelStates: {},
  repoPanelFontSize: DEFAULT_NOTE_FONT_SIZE,
  terminalCwd: null,
  projectTitle: 'BridgeGit',
  projectTitleMode: 'auto',
  projectTitlesByContext: {},
  appAppearance: 'bridgegit-dark',
  editorTheme: 'follow-app',
  workspaceIndicatorVisibility: {
    repo: true,
    activity: true,
    attention: true,
  },
  workspaceTabDefaults: {
    shellFontSize: DEFAULT_SHELL_FONT_SIZE,
    noteFontSize: DEFAULT_NOTE_FONT_SIZE,
  },
  worktreeDetectionIntervalMs: 180_000,
  dismissedWorktreePaths: [],
  soundNotificationsEnabled: true,
  seenInfoNoteRevisions: [],
  terminalCommandPresets: getDefaultTerminalCommandPresets(),
  workspaceSessions: {},
};
