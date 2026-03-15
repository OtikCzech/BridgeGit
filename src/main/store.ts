import {
  DEFAULT_SESSION_DATA,
  GLOBAL_WORKSPACE_SESSION_KEY,
  getDefaultTerminalCommandPresets,
  normalizeNoteFontSize,
  type ProjectTitleMode,
  type RecentRepoEntry,
  type SessionData,
  type TerminalCommandPreset,
  type TerminalCommandStep,
  type WorkspaceTabState,
  type WorkspaceSessionState,
  type WorkspaceSessionsByContext,
} from '../shared/bridgegit';
import { normalizeStoredPath, normalizeTerminalCwd } from './path-utils';

interface PartialTerminalCommandStep {
  id?: string;
  type?: TerminalCommandStep['type'];
  value?: string;
  submit?: boolean;
  pattern?: string;
  delayMs?: number;
}

interface PartialTerminalCommandPreset {
  id?: string;
  name?: string;
  target?: TerminalCommandPreset['target'];
  shortcutSlot?: number | null;
  steps?: PartialTerminalCommandStep[];
}

interface LegacyTerminalTabState {
  id?: string;
  title?: string;
  cwd?: string;
}

interface PartialWorkspaceShellTabState {
  id?: string;
  type?: 'shell';
  title?: string;
  cwd?: string;
  launcherProfileId?: string | null;
}

interface PartialWorkspaceNoteTabState {
  id?: string;
  type?: 'note';
  title?: string;
  filePath?: string | null;
  content?: string;
  savedContent?: string;
  viewMode?: 'source' | 'split' | 'preview';
  fontSize?: number;
}

type PartialWorkspaceTabState = PartialWorkspaceShellTabState | PartialWorkspaceNoteTabState;

interface PartialWorkspaceSessionState {
  tabs?: PartialWorkspaceTabState[];
  activeTabId?: string | null;
}

interface LegacySessionData extends Partial<Omit<SessionData, 'workspaceSessions'>> {
  terminalTabs?: Array<Partial<LegacyTerminalTabState>>;
  workspaceTabs?: PartialWorkspaceTabState[];
  activeWorkspaceTabId?: string | null;
  activeTerminalTabId?: string | null;
  workspaceSessions?: Record<string, PartialWorkspaceSessionState>;
}

interface SessionStore {
  store: SessionData;
  get<Key extends keyof SessionData>(key: Key): SessionData[Key];
  set(value: Partial<SessionData> | SessionData): void;
}

let storePromise: Promise<SessionStore> | null = null;

function getRepoName(repoPath: string): string {
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? repoPath;
}

function getPathLeafName(pathValue: string): string {
  const parts = pathValue.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? pathValue;
}

function normalizeWorkspaceContextKey(contextKey: string | null | undefined): string {
  if (!contextKey || contextKey === GLOBAL_WORKSPACE_SESSION_KEY) {
    return GLOBAL_WORKSPACE_SESSION_KEY;
  }

  return normalizeStoredPath(contextKey) ?? GLOBAL_WORKSPACE_SESSION_KEY;
}

function normalizeTimestamp(value: string | undefined): string {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isNaN(timestamp) ? new Date().toISOString() : new Date(timestamp).toISOString();
}

function normalizeRecentRepos(
  recentRepos: Array<string | Partial<RecentRepoEntry>> | undefined,
  lastRepoPath: string | null,
): RecentRepoEntry[] {
  const repoMap = new Map<string, RecentRepoEntry>();

  for (const item of recentRepos ?? []) {
    const repoPath = normalizeStoredPath(typeof item === 'string' ? item : item.path);

    if (!repoPath) {
      continue;
    }

    const existingEntry = repoMap.get(repoPath);
    const nextEntry: RecentRepoEntry = {
      path: repoPath,
      name: typeof item === 'string' ? getRepoName(repoPath) : item.name?.trim() || getRepoName(repoPath),
      lastUsedAt: normalizeTimestamp(typeof item === 'string' ? undefined : item.lastUsedAt),
    };

    if (!existingEntry || Date.parse(nextEntry.lastUsedAt) >= Date.parse(existingEntry.lastUsedAt)) {
      repoMap.set(repoPath, nextEntry);
    }
  }

  if (lastRepoPath && !repoMap.has(lastRepoPath)) {
    repoMap.set(lastRepoPath, {
      path: lastRepoPath,
      name: getRepoName(lastRepoPath),
      lastUsedAt: new Date().toISOString(),
    });
  }

  return [...repoMap.values()]
    .sort((left, right) => {
      if (left.path === lastRepoPath) {
        return -1;
      }

      if (right.path === lastRepoPath) {
        return 1;
      }

      return Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt);
    })
    .slice(0, 12);
}

function normalizeWorkspaceTabs(
  workspaceTabs: PartialWorkspaceTabState[] | undefined,
  legacyTerminalTabs: Array<Partial<LegacyTerminalTabState>> | undefined,
  fallbackCwd: string,
): WorkspaceTabState[] {
  const seenIds = new Set<string>();
  const hasWorkspaceTabs = Boolean(workspaceTabs?.length);
  const sourceTabs = hasWorkspaceTabs
    ? workspaceTabs ?? []
    : (legacyTerminalTabs?.map((tab) => ({ ...tab, type: 'shell' as const })) ?? []);
  const normalizedTabs: WorkspaceTabState[] = [];

  for (const tab of sourceTabs) {
    const id = tab.id?.trim();
    const title = tab.title?.trim();

    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);

    if (tab.type === 'note') {
      const filePath = normalizeStoredPath(tab.filePath);
      const content = tab.content ?? '';
      const savedContent = tab.savedContent ?? content;

      normalizedTabs.push({
        id,
        type: 'note',
        title: title || (filePath ? getPathLeafName(filePath) : 'Notes'),
        filePath,
        content,
        savedContent,
        viewMode: normalizeNoteTabViewMode(tab.viewMode),
        fontSize: normalizeNoteFontSize(tab.fontSize),
      });
      continue;
    }

    const shellTab = tab as PartialWorkspaceShellTabState;

    normalizedTabs.push({
      id,
      type: 'shell',
      title: title || 'Shell',
      cwd: normalizeTerminalCwd(shellTab.cwd, fallbackCwd),
      launcherProfileId: shellTab.launcherProfileId?.trim() || null,
    });
  }

  return normalizedTabs;
}

function normalizeWorkspaceSessionState(
  workspaceSession: PartialWorkspaceSessionState | undefined,
  legacyWorkspaceTabs: PartialWorkspaceTabState[] | undefined,
  legacyTerminalTabs: Array<Partial<LegacyTerminalTabState>> | undefined,
  requestedActiveTabId: string | null | undefined,
  fallbackCwd: string,
): WorkspaceSessionState {
  const tabs = normalizeWorkspaceTabs(
    workspaceSession?.tabs ?? legacyWorkspaceTabs,
    workspaceSession?.tabs ? undefined : legacyTerminalTabs,
    fallbackCwd,
  );
  const activeTabId = tabs.find((tab) => tab.id === (workspaceSession?.activeTabId ?? requestedActiveTabId))?.id
    ?? tabs[0]?.id
    ?? null;

  return {
    tabs,
    activeTabId,
  };
}

function normalizeWorkspaceSessions(
  workspaceSessions: Record<string, PartialWorkspaceSessionState> | undefined,
  legacyWorkspaceTabs: PartialWorkspaceTabState[] | undefined,
  legacyTerminalTabs: Array<Partial<LegacyTerminalTabState>> | undefined,
  legacyActiveWorkspaceTabId: string | null | undefined,
  legacyActiveTerminalTabId: string | null | undefined,
  lastRepoPath: string | null,
  fallbackCwd: string,
): WorkspaceSessionsByContext {
  const normalizedSessions: WorkspaceSessionsByContext = {};

  for (const [rawContextKey, workspaceSession] of Object.entries(workspaceSessions ?? {})) {
    const contextKey = normalizeWorkspaceContextKey(rawContextKey);
    normalizedSessions[contextKey] = normalizeWorkspaceSessionState(
      workspaceSession,
      undefined,
      undefined,
      undefined,
      fallbackCwd,
    );
  }

  const hasLegacyWorkspaceTabs = Boolean(legacyWorkspaceTabs?.length || legacyTerminalTabs?.length);

  if (hasLegacyWorkspaceTabs) {
    const legacyContextKey = normalizeWorkspaceContextKey(lastRepoPath);

    if (!normalizedSessions[legacyContextKey]) {
      normalizedSessions[legacyContextKey] = normalizeWorkspaceSessionState(
        undefined,
        legacyWorkspaceTabs,
        legacyTerminalTabs,
        legacyActiveWorkspaceTabId ?? legacyActiveTerminalTabId,
        fallbackCwd,
      );
    }
  }

  return normalizedSessions;
}

function normalizeNoteTabViewMode(mode: 'source' | 'split' | 'preview' | undefined): 'source' | 'split' | 'preview' {
  if (mode === 'source' || mode === 'preview') {
    return mode;
  }

  return 'split';
}

function normalizeShortcutSlot(slot: number | null | undefined): number | null {
  if (slot === null || slot === undefined) {
    return null;
  }

  if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
    return null;
  }

  return slot;
}

function normalizeTerminalCommandSteps(
  presetId: string,
  steps: PartialTerminalCommandStep[] | undefined,
): TerminalCommandStep[] {
  const seenIds = new Set<string>();

  return (steps ?? [])
    .map((step, index) => {
      const stepId = step.id?.trim() || `${presetId}-step-${index + 1}`;

      if (seenIds.has(stepId)) {
        return null;
      }

      seenIds.add(stepId);

      if (step.type === 'delay') {
        return {
          id: stepId,
          type: 'delay' as const,
          delayMs: Math.max(50, Math.min(60_000, Math.round(step.delayMs ?? 600))),
        };
      }

      if (step.type === 'wait-for-prompt') {
        return {
          id: stepId,
          type: 'wait-for-prompt' as const,
          pattern: step.pattern?.trim() || '^.+[>#\\$]\\s?$',
        };
      }

      return {
        id: stepId,
        type: 'write' as const,
        value: step.value ?? '',
        submit: step.submit ?? true,
      };
    })
    .filter((step): step is TerminalCommandStep => Boolean(step));
}

function normalizeTerminalCommandPresets(
  presets: Array<string | PartialTerminalCommandPreset> | undefined,
): TerminalCommandPreset[] {
  const seenIds = new Set<string>();
  const usedSlots = new Set<number>();

  return (presets ?? [])
    .map((preset, index) => {
      const id = typeof preset === 'string'
        ? `command-${index + 1}`
        : preset.id?.trim() || `command-${index + 1}`;

      if (!id || seenIds.has(id)) {
        return null;
      }

      seenIds.add(id);

      const normalizedSlot = normalizeShortcutSlot(typeof preset === 'string' ? null : preset.shortcutSlot);
      const shortcutSlot = normalizedSlot && !usedSlots.has(normalizedSlot) ? normalizedSlot : null;

      if (shortcutSlot) {
        usedSlots.add(shortcutSlot);
      }

      const normalizedSteps = normalizeTerminalCommandSteps(
        id,
        typeof preset === 'string'
          ? [{ type: 'write', value: preset, submit: true }]
          : preset.steps,
      );

      return {
        id,
        name: typeof preset === 'string' ? preset.trim() || `Command ${index + 1}` : preset.name?.trim() || `Command ${index + 1}`,
        target: typeof preset === 'string'
          ? 'active-tab'
          : (preset.target === 'new-tab' ? 'new-tab' : 'active-tab'),
        shortcutSlot,
        steps: normalizedSteps.length
          ? normalizedSteps
          : normalizeTerminalCommandSteps(id, [{ type: 'write', value: '', submit: true }]),
      };
    })
    .filter((preset): preset is TerminalCommandPreset => Boolean(preset));
}

function normalizeProjectTitleMode(
  mode: ProjectTitleMode | undefined,
  title: string | undefined,
  lastRepoPath: string | null,
): ProjectTitleMode {
  if (mode === 'auto' || mode === 'custom') {
    return mode;
  }

  const trimmedTitle = title?.trim();
  const repoName = lastRepoPath ? getRepoName(lastRepoPath) : null;

  if (!trimmedTitle || trimmedTitle === DEFAULT_SESSION_DATA.projectTitle || trimmedTitle === repoName) {
    return 'auto';
  }

  return 'custom';
}

function normalizeSession(session: LegacySessionData): SessionData {
  const lastRepoPath = normalizeStoredPath(session.lastRepoPath ?? DEFAULT_SESSION_DATA.lastRepoPath);
  const fallbackCwd = normalizeTerminalCwd(session.terminalCwd, lastRepoPath);
  const recentRepos = normalizeRecentRepos(
    session.recentRepos as Array<string | Partial<RecentRepoEntry>> | undefined,
    lastRepoPath,
  );
  const workspaceSessions = normalizeWorkspaceSessions(
    session.workspaceSessions,
    session.workspaceTabs as PartialWorkspaceTabState[] | undefined,
    session.terminalTabs,
    session.activeWorkspaceTabId,
    session.activeTerminalTabId,
    lastRepoPath,
    fallbackCwd,
  );
  const hasStoredTerminalCommandPresets = Array.isArray(session.terminalCommandPresets);
  const normalizedTerminalCommandPresets = normalizeTerminalCommandPresets(
    hasStoredTerminalCommandPresets
      ? (session.terminalCommandPresets as Array<string | PartialTerminalCommandPreset>)
      : getDefaultTerminalCommandPresets(),
  );
  const terminalCommandPresets = normalizedTerminalCommandPresets.length
    ? normalizedTerminalCommandPresets
    : (hasStoredTerminalCommandPresets ? [] : getDefaultTerminalCommandPresets());
  const projectTitleMode = normalizeProjectTitleMode(session.projectTitleMode, session.projectTitle, lastRepoPath);

  return {
    lastRepoPath,
    recentRepos,
    panelLayout: {
      ...DEFAULT_SESSION_DATA.panelLayout,
      ...session.panelLayout,
    },
    terminalCwd: fallbackCwd,
    projectTitle: session.projectTitle?.trim() || DEFAULT_SESSION_DATA.projectTitle,
    projectTitleMode,
    soundNotificationsEnabled: session.soundNotificationsEnabled ?? DEFAULT_SESSION_DATA.soundNotificationsEnabled,
    infoNoteLastSeenRevision: session.infoNoteLastSeenRevision?.trim() || null,
    terminalCommandPresets,
    workspaceSessions,
  };
}

async function createStore(): Promise<SessionStore> {
  // electron-store is ESM-only, so keep the native dynamic import in CommonJS output.
  const loadStoreModule = new Function(
    'return import("electron-store")',
  ) as () => Promise<{ default: new (options?: unknown) => SessionStore }>;

  const { default: Store } = await loadStoreModule();

  return new Store({
    name: 'bridgegit-session',
    defaults: DEFAULT_SESSION_DATA,
  });
}

async function getStore(): Promise<SessionStore> {
  if (!storePromise) {
    storePromise = createStore();
  }

  return storePromise;
}

export async function loadSession(): Promise<SessionData> {
  const store = await getStore();
  return normalizeSession(store.store as LegacySessionData);
}

export async function saveSession(session: Partial<SessionData>): Promise<SessionData> {
  const store = await getStore();
  const nextSession = normalizeSession({
    ...(store.store as LegacySessionData),
    ...session,
    panelLayout: {
      ...DEFAULT_SESSION_DATA.panelLayout,
      ...(store.get('panelLayout') ?? {}),
      ...session.panelLayout,
    },
  });

  store.set(nextSession);

  return nextSession;
}
