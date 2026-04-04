import {
  DEFAULT_SESSION_DATA,
  DEFAULT_PANEL_LAYOUT,
  GLOBAL_WORKSPACE_ID,
  GLOBAL_WORKSPACE_SESSION_KEY,
  getDefaultTerminalCommandPresets,
  normalizeAppAppearance,
  normalizeEditorTheme,
  normalizeNoteFontSize,
  normalizeShellFontSize,
  type PanelLayout,
  type ProjectTitleMode,
  type RecentRepoEntry,
  type RepoPanelFileListMode,
  type RepoPanelSectionId,
  type RepoPanelSectionState,
  type SessionData,
  type TerminalCommandPreset,
  type TerminalCommandStep,
  type WorktreeDetectionInterval,
  type WorkspaceTabDefaults,
  type WorkspaceDescriptor,
  type WorkspaceDescriptorsById,
  type WorkspaceRepoPanelState,
  type WorkspaceTabState,
  type WorkspaceSessionState,
  type WorkspaceSessionsById,
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
  fontSize?: number;
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

interface PartialWorkspaceCodeTabState {
  id?: string;
  type?: 'code';
  title?: string;
  filePath?: string | null;
  content?: string;
  savedContent?: string;
  fontSize?: number;
}

interface PartialWorkspaceSearchTabState {
  id?: string;
  type?: 'search';
  title?: string;
  query?: string;
}

type PartialWorkspaceTabState =
  | PartialWorkspaceShellTabState
  | PartialWorkspaceNoteTabState
  | PartialWorkspaceCodeTabState
  | PartialWorkspaceSearchTabState;

interface PartialWorkspaceSessionState {
  tabs?: PartialWorkspaceTabState[];
  activeTabId?: string | null;
  editorPaneLayout?: {
    panes?: Array<{
      id?: string;
      row?: number;
      col?: number;
      tabId?: string | null;
    }>;
    activePaneId?: string | null;
  };
}

interface PartialWorkspaceDescriptor {
  id?: string;
  kind?: WorkspaceDescriptor['kind'];
  repoPath?: string | null;
}

interface PartialWorkspaceRepoPanelFilesState {
  expanded?: boolean;
  viewMode?: RepoPanelFileListMode;
  showAll?: boolean;
  collapsedSections?: Partial<Record<RepoPanelSectionId, boolean>>;
  expandedDirectories?: string[];
}

interface PartialWorkspaceRepoPanelState {
  fontSize?: number;
  historyOpen?: boolean;
  workspaceDetailExpanded?: boolean;
  workspaceFamilyFocus?: boolean;
  files?: PartialWorkspaceRepoPanelFilesState;
}

interface LegacySessionData extends Partial<Omit<SessionData, 'workspaceSessions' | 'workspaceDescriptors' | 'panelLayoutsByWorkspace' | 'workspaceRepoPanelStates'>> {
  terminalTabs?: Array<Partial<LegacyTerminalTabState>>;
  workspaceTabs?: PartialWorkspaceTabState[];
  activeWorkspaceTabId?: string | null;
  activeTerminalTabId?: string | null;
  infoNoteLastSeenRevision?: string | null;
  workspaceSessions?: Record<string, PartialWorkspaceSessionState>;
  workspaceDescriptors?: Record<string, PartialWorkspaceDescriptor>;
  panelLayoutsByWorkspace?: Record<string, Partial<PanelLayout>>;
  workspaceRepoPanelStates?: Record<string, PartialWorkspaceRepoPanelState>;
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
  const trimmedContextKey = contextKey?.trim();

  if (
    !trimmedContextKey
    || trimmedContextKey === GLOBAL_WORKSPACE_SESSION_KEY
    || trimmedContextKey === GLOBAL_WORKSPACE_ID
  ) {
    return GLOBAL_WORKSPACE_SESSION_KEY;
  }

  if (trimmedContextKey.startsWith('workspace:')) {
    return trimmedContextKey;
  }

  return normalizeStoredPath(trimmedContextKey) ?? GLOBAL_WORKSPACE_SESSION_KEY;
}

function buildWorkspaceId(
  kind: WorkspaceDescriptor['kind'],
  repoPath: string | null,
  existingWorkspaceIds: Iterable<string> = [],
  preferredWorkspaceId?: string | null,
): string {
  if (kind === 'global') {
    return GLOBAL_WORKSPACE_ID;
  }

  const usedWorkspaceIds = new Set(existingWorkspaceIds);
  const normalizedRepoPath = normalizeStoredPath(repoPath);
  const trimmedPreferredWorkspaceId = preferredWorkspaceId?.trim();

  if (
    trimmedPreferredWorkspaceId
    && trimmedPreferredWorkspaceId !== GLOBAL_WORKSPACE_ID
    && !usedWorkspaceIds.has(trimmedPreferredWorkspaceId)
  ) {
    return trimmedPreferredWorkspaceId;
  }

  if (normalizedRepoPath) {
    const baseWorkspaceId = `workspace:${normalizedRepoPath}`;

    if (!usedWorkspaceIds.has(baseWorkspaceId)) {
      return baseWorkspaceId;
    }

    let duplicateIndex = 2;
    let nextWorkspaceId = `${baseWorkspaceId}#${duplicateIndex}`;

    while (usedWorkspaceIds.has(nextWorkspaceId)) {
      duplicateIndex += 1;
      nextWorkspaceId = `${baseWorkspaceId}#${duplicateIndex}`;
    }

    return nextWorkspaceId;
  }

  let fallbackIndex = 1;
  let nextWorkspaceId = `workspace:project:${fallbackIndex}`;

  while (usedWorkspaceIds.has(nextWorkspaceId)) {
    fallbackIndex += 1;
    nextWorkspaceId = `workspace:project:${fallbackIndex}`;
  }

  return nextWorkspaceId;
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

function normalizeSeenInfoNoteRevisions(
  seenInfoNoteRevisions: string[] | undefined,
  legacyInfoNoteLastSeenRevision: string | null | undefined,
): string[] {
  const normalizedRevisions = (seenInfoNoteRevisions ?? [])
    .map((revision) => revision.trim())
    .filter((revision, index, revisions) => revision.length > 0 && revisions.indexOf(revision) === index);

  if (normalizedRevisions.length > 0) {
    return normalizedRevisions;
  }

  const legacyRevision = legacyInfoNoteLastSeenRevision?.trim();
  return legacyRevision ? [legacyRevision] : [];
}

function normalizeWorkspaceOrder(
  workspaceOrder: string[] | undefined,
  recentRepos: RecentRepoEntry[],
  workspaceDescriptors: WorkspaceDescriptorsById,
): string[] {
  const orderedWorkspaceIds: string[] = [];
  const seenWorkspaceIds = new Set<string>();
  const projectWorkspaceIdsByPath = new Map<string, string>();

  Object.values(workspaceDescriptors).forEach((workspaceDescriptor) => {
    if (workspaceDescriptor.kind !== 'project' || !workspaceDescriptor.repoPath) {
      return;
    }

    projectWorkspaceIdsByPath.set(workspaceDescriptor.repoPath, workspaceDescriptor.id);
  });

  for (const rawWorkspaceId of workspaceOrder ?? []) {
    const normalizedWorkspaceId = rawWorkspaceId?.trim();

    if (!normalizedWorkspaceId || seenWorkspaceIds.has(normalizedWorkspaceId) || !workspaceDescriptors[normalizedWorkspaceId]) {
      continue;
    }

    seenWorkspaceIds.add(normalizedWorkspaceId);
    orderedWorkspaceIds.push(normalizedWorkspaceId);
  }

  for (const repoEntry of recentRepos) {
    const workspaceId = projectWorkspaceIdsByPath.get(repoEntry.path);

    if (!workspaceId || seenWorkspaceIds.has(workspaceId)) {
      continue;
    }

    seenWorkspaceIds.add(workspaceId);
    orderedWorkspaceIds.push(workspaceId);
  }

  for (const workspaceDescriptor of Object.values(workspaceDescriptors)) {
    if (workspaceDescriptor.kind !== 'project' || seenWorkspaceIds.has(workspaceDescriptor.id)) {
      continue;
    }

    seenWorkspaceIds.add(workspaceDescriptor.id);
    orderedWorkspaceIds.push(workspaceDescriptor.id);
  }

  return orderedWorkspaceIds;
}

function normalizeWorkspaceDescriptors(
  workspaceDescriptors: Record<string, PartialWorkspaceDescriptor> | undefined,
  legacyWorkspaceSessions: Record<string, PartialWorkspaceSessionState> | undefined,
  recentRepos: RecentRepoEntry[],
  lastRepoPath: string | null,
): WorkspaceDescriptorsById {
  const normalizedDescriptors: WorkspaceDescriptorsById = {
    [GLOBAL_WORKSPACE_ID]: {
      id: GLOBAL_WORKSPACE_ID,
      kind: 'global',
      repoPath: null,
    },
  };

  for (const [rawWorkspaceId, workspaceDescriptor] of Object.entries(workspaceDescriptors ?? {})) {
    const workspaceId = rawWorkspaceId?.trim();

    if (!workspaceId || workspaceId === GLOBAL_WORKSPACE_ID) {
      continue;
    }

    const kind = workspaceDescriptor.kind === 'global' ? 'global' : 'project';
    const repoPath = kind === 'project'
      ? normalizeStoredPath(workspaceDescriptor.repoPath)
      : null;

    if (kind === 'global' || !repoPath || repoPath.startsWith('workspace:')) {
      continue;
    }

    const normalizedWorkspaceId = buildWorkspaceId(
      'project',
      repoPath,
      Object.keys(normalizedDescriptors),
      workspaceId,
    );

    normalizedDescriptors[normalizedWorkspaceId] = {
      id: normalizedWorkspaceId,
      kind: 'project',
      repoPath,
    };
  }

  const hasExplicitProjectDescriptors = Object.values(normalizedDescriptors).some((workspaceDescriptor) => (
    workspaceDescriptor.kind === 'project' && Boolean(workspaceDescriptor.repoPath)
  ));
  if (!hasExplicitProjectDescriptors) {
    for (const rawContextKey of Object.keys(legacyWorkspaceSessions ?? {})) {
      if (!rawContextKey || rawContextKey === GLOBAL_WORKSPACE_ID || rawContextKey.startsWith('workspace:')) {
        continue;
      }

      const contextKey = normalizeWorkspaceContextKey(rawContextKey);

      if (contextKey === GLOBAL_WORKSPACE_SESSION_KEY || contextKey.startsWith('workspace:')) {
        continue;
      }

      const workspaceId = buildWorkspaceId('project', contextKey, Object.keys(normalizedDescriptors));

      normalizedDescriptors[workspaceId] = {
        id: workspaceId,
        kind: 'project',
        repoPath: contextKey,
      };
    }
  }

  if (lastRepoPath) {
    const existingWorkspace = Object.values(normalizedDescriptors).find((workspaceDescriptor) => (
      workspaceDescriptor.kind === 'project' && workspaceDescriptor.repoPath === lastRepoPath
    ));

    if (!existingWorkspace) {
      const workspaceId = buildWorkspaceId('project', lastRepoPath, Object.keys(normalizedDescriptors));
      normalizedDescriptors[workspaceId] = {
        id: workspaceId,
        kind: 'project',
        repoPath: lastRepoPath,
      };
    }
  }

  for (const recentRepo of recentRepos) {
    const existingWorkspace = Object.values(normalizedDescriptors).find((workspaceDescriptor) => (
      workspaceDescriptor.kind === 'project' && workspaceDescriptor.repoPath === recentRepo.path
    ));

    if (!existingWorkspace) {
      const workspaceId = buildWorkspaceId('project', recentRepo.path, Object.keys(normalizedDescriptors));
      normalizedDescriptors[workspaceId] = {
        id: workspaceId,
        kind: 'project',
        repoPath: recentRepo.path,
      };
    }
  }

  return normalizedDescriptors;
}

function normalizeWorkspaceTabs(
  workspaceTabs: PartialWorkspaceTabState[] | undefined,
  legacyTerminalTabs: Array<Partial<LegacyTerminalTabState>> | undefined,
  workspaceTabDefaults: WorkspaceTabDefaults,
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
        fontSize: normalizeNoteFontSize(tab.fontSize ?? workspaceTabDefaults.noteFontSize),
      });
      continue;
    }

    if (tab.type === 'code') {
      const filePath = normalizeStoredPath(tab.filePath);

      if (!filePath) {
        continue;
      }

      const content = tab.content ?? '';
      const savedContent = tab.savedContent ?? content;

      normalizedTabs.push({
        id,
        type: 'code',
        title: title || getPathLeafName(filePath),
        filePath,
        content,
        savedContent,
        fontSize: normalizeNoteFontSize(tab.fontSize ?? workspaceTabDefaults.noteFontSize),
      });
      continue;
    }

    if (tab.type === 'search') {
      continue;
    }

    const shellTab = tab as PartialWorkspaceShellTabState;

    normalizedTabs.push({
      id,
      type: 'shell',
      title: title || 'Shell',
      cwd: normalizeTerminalCwd(shellTab.cwd, fallbackCwd),
      fontSize: normalizeShellFontSize(shellTab.fontSize ?? workspaceTabDefaults.shellFontSize),
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
  workspaceTabDefaults: WorkspaceTabDefaults,
  fallbackCwd: string,
): WorkspaceSessionState {
  const tabs = normalizeWorkspaceTabs(
    workspaceSession?.tabs ?? legacyWorkspaceTabs,
    workspaceSession?.tabs ? undefined : legacyTerminalTabs,
    workspaceTabDefaults,
    fallbackCwd,
  );
  const activeTabId = tabs.find((tab) => tab.id === (workspaceSession?.activeTabId ?? requestedActiveTabId))?.id
    ?? tabs[0]?.id
    ?? null;
  const codeTabs = tabs.filter((tab) => tab.type === 'code');
  const codeTabIds = new Set(codeTabs.map((tab) => tab.id));
  const fallbackCodeTabId = (
    (activeTabId && codeTabIds.has(activeTabId) ? activeTabId : null)
    ?? codeTabs[0]?.id
    ?? null
  );
  const normalizedPanes = (workspaceSession?.editorPaneLayout?.panes ?? [])
    .map((pane, index) => {
      const id = pane.id?.trim() || `pane-${index + 1}`;

      return {
        id,
        row: pane.row === 1 ? 1 : 0,
        col: pane.col === 1 ? 1 : 0,
        tabId: pane.tabId && codeTabIds.has(pane.tabId) ? pane.tabId : fallbackCodeTabId,
      } as const;
    })
    .filter((pane, index, panes) => (
      pane.tabId
      && panes.findIndex((candidate) => candidate.row === pane.row && candidate.col === pane.col) === index
    ));
  const panes = normalizedPanes.length > 0
    ? normalizedPanes
    : (fallbackCodeTabId
      ? [{
          id: 'pane-primary',
          row: 0 as const,
          col: 0 as const,
          tabId: fallbackCodeTabId,
        }]
      : []);
  const activePaneId = panes.find((pane) => pane.id === workspaceSession?.editorPaneLayout?.activePaneId)?.id
    ?? panes.find((pane) => pane.tabId === fallbackCodeTabId)?.id
    ?? panes[0]?.id
    ?? null;

  return {
    tabs,
    activeTabId,
    editorPaneLayout: {
      panes,
      activePaneId,
    },
  };
}

function normalizeWorkspaceSessions(
  workspaceSessions: Record<string, PartialWorkspaceSessionState> | undefined,
  workspaceDescriptors: WorkspaceDescriptorsById,
  legacyWorkspaceTabs: PartialWorkspaceTabState[] | undefined,
  legacyTerminalTabs: Array<Partial<LegacyTerminalTabState>> | undefined,
  legacyActiveWorkspaceTabId: string | null | undefined,
  legacyActiveTerminalTabId: string | null | undefined,
  lastRepoPath: string | null,
  workspaceTabDefaults: WorkspaceTabDefaults,
  fallbackCwd: string,
): WorkspaceSessionsById {
  const normalizedSessions: WorkspaceSessionsById = {};

  for (const [rawContextKey, workspaceSession] of Object.entries(workspaceSessions ?? {})) {
    const normalizedWorkspaceId = rawContextKey?.trim();
    const workspaceId = normalizedWorkspaceId && workspaceDescriptors[normalizedWorkspaceId]
      ? normalizedWorkspaceId
      : (() => {
        const contextKey = normalizeWorkspaceContextKey(rawContextKey);
        return contextKey === GLOBAL_WORKSPACE_SESSION_KEY
          ? GLOBAL_WORKSPACE_ID
          : Object.values(workspaceDescriptors).find((descriptor) => (
            descriptor.kind === 'project' && descriptor.repoPath === contextKey
          ))?.id;
      })();

    if (!workspaceId) {
      continue;
    }

    normalizedSessions[workspaceId] = normalizeWorkspaceSessionState(
      workspaceSession,
      undefined,
      undefined,
      undefined,
      workspaceTabDefaults,
      fallbackCwd,
    );
  }

  const hasLegacyWorkspaceTabs = Boolean(legacyWorkspaceTabs?.length || legacyTerminalTabs?.length);

  if (hasLegacyWorkspaceTabs) {
    const legacyContextKey = normalizeWorkspaceContextKey(lastRepoPath);
    const legacyWorkspaceId = legacyContextKey === GLOBAL_WORKSPACE_SESSION_KEY
      ? GLOBAL_WORKSPACE_ID
      : Object.values(workspaceDescriptors).find((descriptor) => (
        descriptor.kind === 'project' && descriptor.repoPath === legacyContextKey
      ))?.id;

    if (legacyWorkspaceId && !normalizedSessions[legacyWorkspaceId]) {
      normalizedSessions[legacyWorkspaceId] = normalizeWorkspaceSessionState(
        undefined,
        legacyWorkspaceTabs,
        legacyTerminalTabs,
        legacyActiveWorkspaceTabId ?? legacyActiveTerminalTabId,
        workspaceTabDefaults,
        fallbackCwd,
      );
    }
  }

  Object.keys(workspaceDescriptors).forEach((workspaceId) => {
    if (!normalizedSessions[workspaceId]) {
      normalizedSessions[workspaceId] = {
        tabs: [],
        activeTabId: null,
        editorPaneLayout: {
          panes: [],
          activePaneId: null,
        },
      };
    }
  });

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

function normalizePanelLayout(panelLayout: Partial<PanelLayout> | undefined): PanelLayout {
  return {
    ...DEFAULT_PANEL_LAYOUT,
    ...panelLayout,
  };
}

function normalizePanelLayoutsByWorkspace(
  panelLayoutsByWorkspace: Record<string, Partial<PanelLayout>> | undefined,
  workspaceDescriptors: WorkspaceDescriptorsById,
  activeWorkspaceId: string,
  fallbackPanelLayout: PanelLayout,
): Record<string, PanelLayout> {
  const normalizedPanelLayouts: Record<string, PanelLayout> = {};

  Object.keys(workspaceDescriptors).forEach((workspaceId) => {
    const rawPanelLayout = panelLayoutsByWorkspace?.[workspaceId];
    const nextPanelLayout = normalizePanelLayout(
      rawPanelLayout ?? (workspaceId === activeWorkspaceId ? fallbackPanelLayout : undefined),
    );

    normalizedPanelLayouts[workspaceId] = nextPanelLayout;
  });

  if (!normalizedPanelLayouts[activeWorkspaceId]) {
    normalizedPanelLayouts[activeWorkspaceId] = normalizePanelLayout(fallbackPanelLayout);
  }

  return normalizedPanelLayouts;
}

function normalizeRepoPanelSectionState(
  sectionState: Partial<Record<RepoPanelSectionId, boolean>> | undefined,
): RepoPanelSectionState {
  return {
    staged: sectionState?.staged ?? false,
    changed: sectionState?.changed ?? false,
    untracked: sectionState?.untracked ?? true,
    conflicts: sectionState?.conflicts ?? false,
  };
}

function normalizeWorkspaceRepoPanelState(
  workspaceRepoPanelState: PartialWorkspaceRepoPanelState | undefined,
): WorkspaceRepoPanelState {
  const expandedDirectories = Array.isArray(workspaceRepoPanelState?.files?.expandedDirectories)
    ? [...new Set(
      workspaceRepoPanelState.files.expandedDirectories
        .filter((path): path is string => typeof path === 'string')
        .map((path) => path.replace(/\\/g, '/').trim())
        .filter(Boolean),
    )].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
    : [];

  return {
    fontSize: normalizeNoteFontSize(workspaceRepoPanelState?.fontSize),
    historyOpen: workspaceRepoPanelState?.historyOpen ?? false,
    workspaceDetailExpanded: workspaceRepoPanelState?.workspaceDetailExpanded ?? true,
    workspaceFamilyFocus: workspaceRepoPanelState?.workspaceFamilyFocus ?? false,
    files: {
      expanded: workspaceRepoPanelState?.files?.expanded ?? true,
      viewMode: workspaceRepoPanelState?.files?.viewMode === 'tree' ? 'tree' : 'list',
      showAll: workspaceRepoPanelState?.files?.showAll ?? false,
      collapsedSections: normalizeRepoPanelSectionState(workspaceRepoPanelState?.files?.collapsedSections),
      expandedDirectories,
    },
  };
}

function normalizeWorkspaceRepoPanelStates(
  workspaceRepoPanelStates: Record<string, PartialWorkspaceRepoPanelState> | undefined,
  workspaceDescriptors: WorkspaceDescriptorsById,
): Record<string, WorkspaceRepoPanelState> {
  return Object.fromEntries(
    Object.keys(workspaceDescriptors).map((workspaceId) => (
      [workspaceId, normalizeWorkspaceRepoPanelState(workspaceRepoPanelStates?.[workspaceId])]
    )),
  );
}

function normalizeProjectTitleMode(
  mode: ProjectTitleMode | undefined,
  title: string | undefined,
  lastRepoPath: string | null,
): ProjectTitleMode {
  const normalizedTitle = normalizeProjectTitle(title, lastRepoPath);

  if (normalizedTitle) {
    return 'custom';
  }

  if (mode === 'custom') {
    return 'auto';
  }

  return 'auto';
}

function normalizeProjectTitle(title: string | undefined, lastRepoPath: string | null): string {
  const trimmedTitle = title?.trim();
  const repoName = lastRepoPath ? getRepoName(lastRepoPath) : null;

  if (!trimmedTitle || trimmedTitle === DEFAULT_SESSION_DATA.projectTitle || trimmedTitle === repoName) {
    return '';
  }

  return trimmedTitle;
}

function normalizeProjectTitlesByContext(
  projectTitlesByContext: Record<string, string> | undefined,
  lastRepoPath: string | null,
  legacyProjectTitle: string | undefined,
): Record<string, string> {
  const normalizedTitles = new Map<string, string>();

  for (const [rawContextKey, rawTitle] of Object.entries(projectTitlesByContext ?? {})) {
    const contextKey = normalizeWorkspaceContextKey(rawContextKey);
    const title = rawTitle?.trim();

    if (!title || contextKey === GLOBAL_WORKSPACE_SESSION_KEY) {
      continue;
    }

    normalizedTitles.set(contextKey, title);
  }

  const normalizedLegacyTitle = normalizeProjectTitle(legacyProjectTitle, lastRepoPath);

  if (normalizedLegacyTitle && lastRepoPath) {
    const contextKey = normalizeWorkspaceContextKey(lastRepoPath);

    if (!normalizedTitles.has(contextKey)) {
      normalizedTitles.set(contextKey, normalizedLegacyTitle);
    }
  }

  return Object.fromEntries(normalizedTitles.entries());
}

function normalizeWorkspaceTabDefaults(
  workspaceTabDefaults: Partial<WorkspaceTabDefaults> | undefined,
): WorkspaceTabDefaults {
  return {
    shellFontSize: normalizeShellFontSize(workspaceTabDefaults?.shellFontSize),
    noteFontSize: normalizeNoteFontSize(workspaceTabDefaults?.noteFontSize),
  };
}

function normalizeWorktreeDetectionInterval(
  worktreeDetectionIntervalMs: number | null | undefined,
): WorktreeDetectionInterval {
  switch (worktreeDetectionIntervalMs) {
    case null:
    case 60_000:
    case 180_000:
    case 300_000:
    case 900_000:
      return worktreeDetectionIntervalMs;
    default:
      return DEFAULT_SESSION_DATA.worktreeDetectionIntervalMs;
  }
}

function normalizeDismissedWorktreePaths(
  dismissedWorktreePaths: Array<string | null | undefined> | undefined,
): string[] {
  const normalizedPaths = new Set<string>();

  for (const pathValue of dismissedWorktreePaths ?? []) {
    const normalizedPath = normalizeStoredPath(pathValue);

    if (!normalizedPath) {
      continue;
    }

    normalizedPaths.add(normalizedPath);
  }

  return [...normalizedPaths.values()];
}

function normalizeSession(session: LegacySessionData): SessionData {
  const lastRepoPath = normalizeStoredPath(session.lastRepoPath ?? DEFAULT_SESSION_DATA.lastRepoPath);
  const fallbackCwd = normalizeTerminalCwd(session.terminalCwd, lastRepoPath);
  const recentRepos = normalizeRecentRepos(
    session.recentRepos as Array<string | Partial<RecentRepoEntry>> | undefined,
    lastRepoPath,
  );
  const workspaceDescriptors = normalizeWorkspaceDescriptors(
    session.workspaceDescriptors,
    session.workspaceSessions,
    recentRepos,
    lastRepoPath,
  );
  const workspaceTabDefaults = normalizeWorkspaceTabDefaults(session.workspaceTabDefaults);
  const workspaceSessions = normalizeWorkspaceSessions(
    session.workspaceSessions,
    workspaceDescriptors,
    session.workspaceTabs as PartialWorkspaceTabState[] | undefined,
    session.terminalTabs,
    session.activeWorkspaceTabId,
    session.activeTerminalTabId,
    lastRepoPath,
    workspaceTabDefaults,
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
  const projectTitle = normalizeProjectTitle(session.projectTitle, lastRepoPath);
  const projectTitleMode = normalizeProjectTitleMode(session.projectTitleMode, session.projectTitle, lastRepoPath);
  const projectTitlesByContext = normalizeProjectTitlesByContext(
    session.projectTitlesByContext,
    lastRepoPath,
    session.projectTitle,
  );
  const workspaceOrder = normalizeWorkspaceOrder(session.workspaceOrder, recentRepos, workspaceDescriptors);
  const activeWorkspaceId = session.activeWorkspaceId && workspaceDescriptors[session.activeWorkspaceId]
    ? session.activeWorkspaceId
    : (lastRepoPath
      ? Object.values(workspaceDescriptors).find((descriptor) => (
        descriptor.kind === 'project' && descriptor.repoPath === lastRepoPath
      ))?.id ?? GLOBAL_WORKSPACE_ID
      : GLOBAL_WORKSPACE_ID);
  const fallbackPanelLayout = normalizePanelLayout(session.panelLayout);
  const panelLayoutsByWorkspace = normalizePanelLayoutsByWorkspace(
    session.panelLayoutsByWorkspace as Record<string, Partial<PanelLayout>> | undefined,
    workspaceDescriptors,
    activeWorkspaceId,
    fallbackPanelLayout,
  );
  const workspaceRepoPanelStates = normalizeWorkspaceRepoPanelStates(
    session.workspaceRepoPanelStates,
    workspaceDescriptors,
  );
  const workspaceIndicatorVisibility = {
    repo: session.workspaceIndicatorVisibility?.repo ?? DEFAULT_SESSION_DATA.workspaceIndicatorVisibility.repo,
    activity: session.workspaceIndicatorVisibility?.activity ?? DEFAULT_SESSION_DATA.workspaceIndicatorVisibility.activity,
    attention: session.workspaceIndicatorVisibility?.attention ?? DEFAULT_SESSION_DATA.workspaceIndicatorVisibility.attention,
  };

  return {
    lastRepoPath,
    activeWorkspaceId,
    recentRepos,
    workspaceOrder,
    workspaceDescriptors,
    panelLayout: panelLayoutsByWorkspace[activeWorkspaceId] ?? fallbackPanelLayout,
    panelLayoutsByWorkspace,
    workspaceRepoPanelStates,
    repoPanelFontSize: normalizeNoteFontSize(session.repoPanelFontSize),
    terminalCwd: fallbackCwd,
    projectTitle,
    projectTitleMode,
    projectTitlesByContext,
    appAppearance: normalizeAppAppearance(session.appAppearance),
    editorTheme: normalizeEditorTheme(session.editorTheme),
    workspaceIndicatorVisibility,
    workspaceTabDefaults,
    worktreeDetectionIntervalMs: normalizeWorktreeDetectionInterval(session.worktreeDetectionIntervalMs),
    dismissedWorktreePaths: normalizeDismissedWorktreePaths(session.dismissedWorktreePaths),
    soundNotificationsEnabled: session.soundNotificationsEnabled ?? DEFAULT_SESSION_DATA.soundNotificationsEnabled,
    seenInfoNoteRevisions: normalizeSeenInfoNoteRevisions(
      session.seenInfoNoteRevisions,
      session.infoNoteLastSeenRevision,
    ),
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
  const normalizedSession = normalizeSession(store.store as LegacySessionData);
  store.set(normalizedSession);
  return normalizedSession;
}

export async function saveSession(session: Partial<SessionData>): Promise<SessionData> {
  const store = await getStore();
  const nextSession = normalizeSession({
    ...(store.store as LegacySessionData),
    ...session,
    panelLayout: normalizePanelLayout({
      ...(store.get('panelLayout') ?? {}),
      ...session.panelLayout,
    }),
    panelLayoutsByWorkspace: {
      ...((store.get('panelLayoutsByWorkspace') ?? {}) as Record<string, Partial<PanelLayout>>),
      ...(session.panelLayoutsByWorkspace as Record<string, Partial<PanelLayout>> | undefined),
    },
    workspaceRepoPanelStates: {
      ...((store.get('workspaceRepoPanelStates') ?? {}) as Record<string, PartialWorkspaceRepoPanelState>),
      ...(session.workspaceRepoPanelStates as Record<string, PartialWorkspaceRepoPanelState> | undefined),
    },
  });

  store.set(nextSession);

  return nextSession;
}
