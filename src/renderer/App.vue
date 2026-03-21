<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  DEFAULT_SESSION_DATA,
  DEFAULT_PANEL_LAYOUT,
  GLOBAL_WORKSPACE_ID,
  GLOBAL_WORKSPACE_SESSION_KEY,
  cloneDismissedWorktreePaths,
  clonePanelLayoutsByWorkspace,
  cloneProjectTitlesByContext,
  cloneWorkspaceIndicatorVisibilitySettings,
  cloneWorkspaceTabDefaults,
  cloneWorkspaceRepoPanelState,
  cloneWorkspaceRepoPanelStates,
  cloneWorkspaceDescriptors,
  cloneWorkspaceSessionState,
  cloneWorkspaceSessions,
  normalizeAppAppearance,
  normalizeEditorTheme,
  resolveThemeVariant,
  resolveWorkspaceFileTabType,
  type AppAppearance,
  type EditorTheme,
  type ResolvedEditorTheme,
  type GitDiffMode,
  type GitChange,
  type GitLogEntry,
  type GitStatusSummary,
  type GitWorktreeSummary,
  type PanelLayout,
  type ProjectSettingsFormData,
  type RepoPanelSectionState,
  type RecentRepoEntry,
  type TerminalCommandPreset,
  type WorktreeDetectionInterval,
  type WorkspaceIndicatorVisibilitySettings,
  type WorkspaceTabDefaults,
  type WorkspaceDescriptor,
  type WorkspaceDescriptorsById,
  type WorkspaceOverviewItem,
  type WorkspaceRepoPanelState,
  type WorkspaceSessionState,
  type WorkspaceSessionsById,
  type WorkspaceTabState,
} from '../shared/bridgegit';
import { useGit } from './composables/useGit';
import { useSession } from './composables/useSession';
import RepoPanel from './components/RepoPanel.vue';
import StatusBar from './components/StatusBar.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import {
  CURRENT_INFO_NOTE_REVISION,
  WELCOME_NOTE_TAB_ID,
  buildOnboardingWorkspaceSessions,
  hasWorkspaceTabs,
  upsertWelcomeNoteTab,
} from './onboarding';
import { SHORTCUTS, matchesCommandSlotShortcut, matchesShortcut } from './shortcuts';

const CommitHistoryDialog = defineAsyncComponent(() => import('./components/CommitHistoryDialog.vue'));
const DiffViewer = defineAsyncComponent(() => import('./components/DiffViewer.vue'));
const ProjectSettingsDialog = defineAsyncComponent(() => import('./components/ProjectSettingsDialog.vue'));

const shellRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const terminalPanelRef = ref<{
  addShellTab: () => void;
  addNoteTab: () => void;
  closeActiveTab: () => void;
  focusPreviousTab: () => void;
  focusNextTab: () => void;
  executePresetBySlot: (slot: number) => Promise<boolean>;
  openCreationMenu: () => void;
  openFile: () => Promise<unknown>;
  openNoteFilePath: (filePath: string) => Promise<unknown>;
  openWorkspaceFilePath: (filePath: string) => Promise<unknown>;
} | null>(null);
const sidebarWidth = ref(DEFAULT_PANEL_LAYOUT.sidebarWidth);
const terminalHeight = ref(DEFAULT_PANEL_LAYOUT.terminalHeight);
const terminalWidth = ref(DEFAULT_PANEL_LAYOUT.terminalWidth);
const contentLayout = ref(DEFAULT_PANEL_LAYOUT.contentLayout);
const sidebarCollapsed = ref(DEFAULT_PANEL_LAYOUT.sidebarCollapsed);
const diffCollapsed = ref(DEFAULT_PANEL_LAYOUT.diffCollapsed);
const terminalCollapsed = ref(DEFAULT_PANEL_LAYOUT.terminalCollapsed);
const panelLayoutsByWorkspace = ref<Record<string, PanelLayout>>({});
const workspaceRepoPanelStates = ref<Record<string, WorkspaceRepoPanelState>>({});
const projectTitlesByContext = ref<Record<string, string>>({});
const appAppearance = ref<AppAppearance>(DEFAULT_SESSION_DATA.appAppearance);
const editorTheme = ref<EditorTheme>(DEFAULT_SESSION_DATA.editorTheme);
const workspaceIndicatorVisibility = ref<WorkspaceIndicatorVisibilitySettings>(
  cloneWorkspaceIndicatorVisibilitySettings(DEFAULT_SESSION_DATA.workspaceIndicatorVisibility),
);
const workspaceTabDefaults = ref<WorkspaceTabDefaults>(
  cloneWorkspaceTabDefaults(DEFAULT_SESSION_DATA.workspaceTabDefaults),
);
const worktreeDetectionIntervalMs = ref<WorktreeDetectionInterval>(
  DEFAULT_SESSION_DATA.worktreeDetectionIntervalMs,
);
const dismissedWorktreePaths = ref<string[]>(
  cloneDismissedWorktreePaths(DEFAULT_SESSION_DATA.dismissedWorktreePaths),
);
const soundNotificationsEnabled = ref(true);
const projectTitleSaveToast = ref<string | null>(null);
const isSettingsOpen = ref(false);
const isCommitHistoryOpen = ref(false);
const commitHistorySearchToken = ref(0);
const commitMessage = ref('');
const recentRepos = ref<RecentRepoEntry[]>([]);
const workspaceDescriptors = ref<WorkspaceDescriptorsById>({});
const workspaceOrder = ref<string[]>([]);
const terminalCommandPresets = ref<TerminalCommandPreset[]>([]);
const workspaceSessions = ref<WorkspaceSessionsById>({});
const workspaceTabs = ref<WorkspaceTabState[]>([]);
const workspaceRecentActivityByTabId = ref<Record<string, boolean>>({});
const workspaceRecentActivityByWorkspaceId = ref<Record<string, Record<string, boolean>>>({});
const workspaceAttentionByWorkspaceId = ref<Record<string, Record<string, boolean>>>({});
const activeWorkspaceId = ref<string | null>(GLOBAL_WORKSPACE_ID);
const activeWorkspaceTabId = ref<string | null>(null);
const workspaceGitSummaryById = ref<Record<string, {
  branch: string | null;
  changedCount: number | null;
  untrackedCount: number | null;
  conflictedCount: number | null;
}>>({});
const gitRepositoryValidityByPath = ref<Record<string, boolean>>({});
const infoNoteLastSeenRevision = ref<string | null>(null);
const detectedWorktrees = ref<GitWorktreeSummary[]>([]);
const sessionReady = ref(false);
const isSwitchingWorkspaceContext = ref(false);
const isCheckingWorktrees = ref(false);

const runtimeInfo = window.bridgegit ?? {
  platform: 'unknown',
  versions: {
    chrome: 'n/a',
    electron: 'n/a',
    node: 'n/a',
  },
};

const { session, loadSession, saveSession } = useSession();
const {
  repoPath,
  status,
  branches,
  log,
  selectedPath,
  selectedDiffMode,
  selectedCommit,
  diff,
  commitDiff,
  isLoading,
  isLoadingLog,
  isLoadingCommitDiff,
  error,
  commitDiffError,
  refresh: refreshRepoStatus,
  loadLog,
  setRepoPath,
  ensureFullStatus,
  selectFile,
  openCommitDiff,
  stageFiles,
  unstageFiles,
  discardFile,
  discardHunk,
  commitChanges,
  checkoutBranch,
  dispose,
} = useGit();

type PanelId = 'sidebar' | 'diff' | 'terminal';
type ResizeTarget = 'sidebar' | 'content' | null;

const activeResize = ref<ResizeTarget>(null);
const INACTIVE_WORKSPACE_GIT_SUMMARY_POLL_MS = 15_000;
let persistTimer: number | null = null;
let projectTitleSaveToastTimer: number | null = null;
let inactiveWorkspaceGitSummaryTimer: number | null = null;
let worktreeDetectionTimer: number | null = null;
const commitDiffDateFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const visiblePanelCount = computed(() => (
  Number(!sidebarCollapsed.value)
  + Number(!diffCollapsed.value)
  + Number(!terminalCollapsed.value)
));
const hasVisibleRightPanels = computed(() => !diffCollapsed.value || !terminalCollapsed.value);
const showShellDivider = computed(() => !sidebarCollapsed.value && hasVisibleRightPanels.value);
const showContentDivider = computed(() => !diffCollapsed.value && !terminalCollapsed.value);
const canCollapseSidebar = computed(() => !sidebarCollapsed.value && visiblePanelCount.value > 1);
const canCollapseDiff = computed(() => !diffCollapsed.value && visiblePanelCount.value > 1);
const canCollapseTerminal = computed(() => !terminalCollapsed.value && visiblePanelCount.value > 1);
const appThemeVariant = computed(() => resolveThemeVariant(appAppearance.value));
const resolvedEditorTheme = computed<ResolvedEditorTheme>(() => (
  editorTheme.value === 'follow-app' ? appAppearance.value : editorTheme.value
));
const resolvedEditorThemeVariant = computed(() => (
  resolveThemeVariant(resolvedEditorTheme.value)
));
const collapsedPanels = computed(() => {
  const panels: Array<{ id: PanelId; label: string; shortcut: string }> = [];

  if (sidebarCollapsed.value) {
    panels.push({ id: 'sidebar', label: 'Repo', shortcut: SHORTCUTS.panelRepoToggle.display });
  }

  if (diffCollapsed.value) {
    panels.push({ id: 'diff', label: 'Diff', shortcut: SHORTCUTS.panelDiffToggle.display });
  }

  if (terminalCollapsed.value) {
    panels.push({
      id: 'terminal',
      label: repoPath.value ? getRepoName(repoPath.value) : 'Workspace',
      shortcut: SHORTCUTS.panelTerminalToggle.display,
    });
  }

  return panels;
});
const terminalTabIndicators = computed(() => (
  workspaceTabs.value.map((tab) => ({
    id: tab.id,
    title: tab.title,
    isActive: tab.id === activeWorkspaceTabId.value,
    hasRecentActivity: Boolean(workspaceRecentActivityByTabId.value[tab.id]),
  }))
));

function getWorkspaceTabsSnapshot(nextWorkspaceId: string) {
  if (nextWorkspaceId === getCurrentWorkspaceId()) {
    return workspaceTabs.value;
  }

  return workspaceSessions.value[nextWorkspaceId]?.tabs ?? [];
}

function getWorkspacePanelIndicators(nextWorkspaceId: string) {
  const tabs = getWorkspaceTabsSnapshot(nextWorkspaceId);
  const recentActivity = workspaceRecentActivityByWorkspaceId.value[nextWorkspaceId] ?? {};
  const attention = workspaceAttentionByWorkspaceId.value[nextWorkspaceId] ?? {};

  return {
    hasPanelActivity: tabs.some((tab) => Boolean(recentActivity[tab.id])),
    hasPanelAttention: tabs.some((tab) => Boolean(attention[tab.id])),
  };
}

function buildWorkspaceGitSummary(nextStatus: GitStatusSummary, nextBranch: string | null) {
  return {
    branch: nextStatus.currentBranch ?? nextBranch ?? null,
    changedCount: nextStatus.staged.length + nextStatus.unstaged.length + nextStatus.conflicted.length,
    untrackedCount: nextStatus.untracked.length,
    conflictedCount: nextStatus.conflicted.length,
  };
}

async function isGitRepositoryPath(nextRepoPath: string | null): Promise<boolean> {
  if (!nextRepoPath || !window.bridgegit?.git) {
    return false;
  }

  const cachedValidity = gitRepositoryValidityByPath.value[nextRepoPath];

  if (cachedValidity !== undefined) {
    return cachedValidity;
  }

  const isRepository = await window.bridgegit.git.isRepository(nextRepoPath);
  gitRepositoryValidityByPath.value = {
    ...gitRepositoryValidityByPath.value,
    [nextRepoPath]: isRepository,
  };

  return isRepository;
}

async function loadWorkspaceGitSummary(nextWorkspaceId: string, nextRepoPath: string) {
  if (!window.bridgegit?.git || !(await isGitRepositoryPath(nextRepoPath))) {
    workspaceGitSummaryById.value = {
      ...workspaceGitSummaryById.value,
      [nextWorkspaceId]: {
        branch: null,
        changedCount: null,
        untrackedCount: null,
        conflictedCount: null,
      },
    };
    return;
  }

  try {
    const [nextStatus, nextBranches] = await Promise.all([
      window.bridgegit.git.status(nextRepoPath),
      window.bridgegit.git.branches(nextRepoPath),
    ]);

    workspaceGitSummaryById.value = {
      ...workspaceGitSummaryById.value,
      [nextWorkspaceId]: buildWorkspaceGitSummary(nextStatus, nextBranches.current),
    };
  } catch {
    // Keep the last known summary if refresh fails.
  }
}

async function loadAllWorkspaceGitSummaries() {
  const workspaceEntries = Object.values(workspaceDescriptors.value)
    .filter((workspaceDescriptor) => workspaceDescriptor.kind === 'project' && workspaceDescriptor.repoPath)
    .map((workspaceDescriptor) => ({
      workspaceId: workspaceDescriptor.id,
      repoPath: workspaceDescriptor.repoPath!,
    }));

  await Promise.all(
    workspaceEntries.map((workspaceEntry) => (
      loadWorkspaceGitSummary(workspaceEntry.workspaceId, workspaceEntry.repoPath)
    )),
  );
}

async function loadInactiveWorkspaceGitSummaries() {
  const currentWorkspaceId = getCurrentWorkspaceId();
  const workspaceEntries = Object.values(workspaceDescriptors.value)
    .filter((workspaceDescriptor) => (
      workspaceDescriptor.kind === 'project'
      && workspaceDescriptor.repoPath
      && workspaceDescriptor.id !== currentWorkspaceId
    ))
    .map((workspaceDescriptor) => ({
      workspaceId: workspaceDescriptor.id,
      repoPath: workspaceDescriptor.repoPath!,
    }));

  await Promise.all(
    workspaceEntries.map((workspaceEntry) => (
      loadWorkspaceGitSummary(workspaceEntry.workspaceId, workspaceEntry.repoPath)
    )),
  );
}

function startInactiveWorkspaceGitSummaryPolling() {
  if (inactiveWorkspaceGitSummaryTimer) {
    window.clearInterval(inactiveWorkspaceGitSummaryTimer);
  }

  inactiveWorkspaceGitSummaryTimer = window.setInterval(() => {
    if (!sessionReady.value || isSwitchingWorkspaceContext.value || document.visibilityState !== 'visible') {
      return;
    }

    void loadInactiveWorkspaceGitSummaries();
  }, INACTIVE_WORKSPACE_GIT_SUMMARY_POLL_MS);
}

function handleWorkspaceRecentActivityUpdate(nextWorkspaceId: string, nextRecentActivity: Record<string, boolean>) {
  workspaceRecentActivityByWorkspaceId.value = {
    ...workspaceRecentActivityByWorkspaceId.value,
    [nextWorkspaceId]: { ...nextRecentActivity },
  };

  if (nextWorkspaceId === getCurrentWorkspaceId()) {
    workspaceRecentActivityByTabId.value = { ...nextRecentActivity };
  }
}

function handleWorkspaceAttentionUpdate(nextWorkspaceId: string, nextAttention: Record<string, boolean>) {
  workspaceAttentionByWorkspaceId.value = {
    ...workspaceAttentionByWorkspaceId.value,
    [nextWorkspaceId]: { ...nextAttention },
  };
}
const workspaceOverviewItems = computed<WorkspaceOverviewItem[]>(() => {
  const recentRepoMap = new Map(recentRepos.value.map((entry) => [entry.path, entry]));
  const seenWorkspaceIds = new Set<string>();
  const orderedWorkspaceIds: string[] = [];

  workspaceOrder.value.forEach((workspaceId) => {
    if (!workspaceId || seenWorkspaceIds.has(workspaceId) || !workspaceDescriptors.value[workspaceId]) {
      return;
    }

    seenWorkspaceIds.add(workspaceId);
    orderedWorkspaceIds.push(workspaceId);
  });

  Object.keys(workspaceDescriptors.value).forEach((workspaceId) => {
    if (workspaceId === GLOBAL_WORKSPACE_ID || seenWorkspaceIds.has(workspaceId)) {
      return;
    }

    seenWorkspaceIds.add(workspaceId);
    orderedWorkspaceIds.push(workspaceId);
  });

  return orderedWorkspaceIds.flatMap((workspaceId) => {
    const workspaceDescriptor = workspaceDescriptors.value[workspaceId];

    if (!workspaceDescriptor || workspaceDescriptor.kind !== 'project' || !workspaceDescriptor.repoPath) {
      return [];
    }

    const recentRepoEntry = recentRepoMap.get(workspaceDescriptor.repoPath);
    const title = resolveProjectTitleFromContext(workspaceDescriptor.id, workspaceDescriptor.repoPath)
      || recentRepoEntry?.name
      || resolveAutoProjectTitle(workspaceDescriptor.repoPath);
    const cachedSummary = workspaceGitSummaryById.value[workspaceId];
    const panelIndicators = getWorkspacePanelIndicators(workspaceId);

    return [{
      workspaceId,
      path: workspaceDescriptor.repoPath,
      title,
      repoName: getRepoName(workspaceDescriptor.repoPath),
      branch: cachedSummary?.branch ?? null,
      changedCount: cachedSummary?.changedCount ?? null,
      untrackedCount: cachedSummary?.untrackedCount ?? null,
      conflictedCount: cachedSummary?.conflictedCount ?? null,
      hasPanelActivity: panelIndicators.hasPanelActivity,
      hasPanelAttention: panelIndicators.hasPanelAttention,
      isCurrent: workspaceId === getCurrentWorkspaceId(),
    }];
  });
});
const activeDetectedWorktree = computed(() => detectedWorktrees.value[0] ?? null);
const hasUnreadInfoNote = computed(() => infoNoteLastSeenRevision.value !== CURRENT_INFO_NOTE_REVISION);
const shellColumns = computed(() => {
  if (sidebarCollapsed.value) {
    return 'minmax(0, 1fr)';
  }

  return showShellDivider.value
    ? 'minmax(280px, var(--sidebar-width)) 8px minmax(0, 1fr)'
    : 'minmax(280px, var(--sidebar-width)) minmax(0, 1fr)';
});
const shellRowsMobile = computed(() => {
  if (sidebarCollapsed.value) {
    return 'minmax(0, 1fr)';
  }

  return hasVisibleRightPanels.value
    ? 'minmax(220px, auto) 8px minmax(0, 1fr)'
    : 'minmax(220px, auto) minmax(0, 1fr)';
});
const contentColumns = computed(() => {
  if (!showContentDivider.value) {
    return 'minmax(0, 1fr)';
  }

  return contentLayout.value === 'side-by-side'
    ? 'minmax(0, 1fr) 8px minmax(280px, var(--terminal-width))'
    : 'minmax(0, 1fr)';
});
const contentRows = computed(() => {
  if (!showContentDivider.value) {
    return 'minmax(0, 1fr)';
  }

  return contentLayout.value === 'stacked'
    ? 'minmax(0, 1fr) 8px minmax(180px, var(--terminal-height))'
    : 'minmax(0, 1fr)';
});
const appStyle = computed(() => ({
  '--sidebar-width': `${sidebarWidth.value}px`,
  '--terminal-height': `${terminalHeight.value}px`,
  '--terminal-width': `${terminalWidth.value}px`,
  '--shell-columns': shellColumns.value,
  '--shell-rows': 'minmax(0, 1fr)',
  '--shell-columns-mobile': '1fr',
  '--shell-rows-mobile': shellRowsMobile.value,
  '--content-columns': contentColumns.value,
  '--content-rows': contentRows.value,
}));

const changedCount = computed(() => {
  if (!status.value) {
    return 0;
  }

  return (
    status.value.staged.length +
    status.value.unstaged.length +
    status.value.conflicted.length
  );
});
const repoDockSummary = computed(() => {
  if (!status.value) {
    return {
      changed: 0,
      untracked: 0,
      isClean: true,
    };
  }

  return {
    changed: status.value.staged.length + status.value.unstaged.length + status.value.conflicted.length,
    untracked: status.value.untracked.length,
    isClean: status.value.isClean,
  };
});
const branch = computed(() => (
  status.value?.currentBranch
  ?? branches.value?.current
  ?? workspaceGitSummaryById.value[getCurrentWorkspaceId()]?.branch
  ?? 'no repo'
));
const currentProjectTitle = computed(() => {
  return resolveProjectTitleFromContext(getCurrentWorkspaceId(), repoPath.value);
});
const displayProjectTitle = computed(() => currentProjectTitle.value || resolveAutoProjectTitle(repoPath.value));
const repoName = computed(() => {
  if (!repoPath.value) {
    return 'No repo';
  }

  const parts = repoPath.value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? repoPath.value;
});
const isCommitDiffMode = computed(() => Boolean(selectedCommit.value));
const diffViewerMode = computed(() => (
  isCommitDiffMode.value ? 'commit' as const : 'working-tree' as const
));
const diffViewerTitle = computed(() => (
  isCommitDiffMode.value
    ? selectedCommit.value?.message ?? 'Commit diff'
    : selectedPath.value ?? 'No file selected'
));
const diffViewerTitleMeta = computed(() => {
  if (!selectedCommit.value) {
    return null;
  }

  const parsedDate = Date.parse(selectedCommit.value.date);
  const formattedDate = Number.isNaN(parsedDate)
    ? selectedCommit.value.date
    : commitDiffDateFormatter.format(new Date(parsedDate));

  return `${selectedCommit.value.shortHash} · ${selectedCommit.value.authorName} · ${formattedDate}`;
});
const activeDiff = computed(() => (
  isCommitDiffMode.value ? commitDiff.value : diff.value
));
const activeDiffError = computed(() => (
  isCommitDiffMode.value ? commitDiffError.value : error.value
));
const activeDiffLoading = computed(() => (
  isCommitDiffMode.value ? isLoadingCommitDiff.value : isLoading.value
));
const diffHasTarget = computed(() => (
  isCommitDiffMode.value ? Boolean(selectedCommit.value) : Boolean(selectedPath.value)
));
const infoMessage = computed(() => (
  commitDiffError.value
  ?? error.value
  ?? (selectedCommit.value ? selectedCommit.value.shortHash : selectedPath.value)
  ?? 'Ready'
));
const terminalCwd = computed(() => (
  repoPath.value
  ?? session.value.terminalCwd
  ?? (runtimeInfo.platform === 'win32' ? 'C:\\' : '/')
));
const diffPathQueue = computed(() => buildDiffPathQueue(status.value));
const currentDiffIndex = computed(() => {
  if (!selectedPath.value) {
    return -1;
  }

  return diffPathQueue.value.indexOf(selectedPath.value);
});
const currentDiffPosition = computed(() => (
  currentDiffIndex.value >= 0 ? currentDiffIndex.value + 1 : 0
));
const canSelectPreviousDiff = computed(() => !diffCollapsed.value && currentDiffIndex.value > 0);
const canSelectNextDiff = computed(() => (
  !diffCollapsed.value
  && currentDiffIndex.value >= 0
  && currentDiffIndex.value < diffPathQueue.value.length - 1
));
const canStageCurrentDiff = computed(() => {
  if (diffCollapsed.value || !status.value || !selectedPath.value) {
    return false;
  }

  return [...status.value.unstaged, ...status.value.untracked].some((item) => item.path === selectedPath.value);
});
const currentDiscardableChange = computed(() => {
  if (diffCollapsed.value || !status.value || !selectedPath.value) {
    return null;
  }

  if (selectedDiffMode.value === 'staged') {
    return status.value.staged.find((item) => item.path === selectedPath.value) ?? null;
  }

  return status.value.untracked.find((item) => item.path === selectedPath.value)
    ?? status.value.unstaged.find((item) => item.path === selectedPath.value)
    ?? status.value.conflicted.find((item) => item.path === selectedPath.value)
    ?? status.value.staged.find((item) => item.path === selectedPath.value)
    ?? null;
});
const canDiscardCurrentDiff = computed(() => !isCommitDiffMode.value && Boolean(currentDiscardableChange.value));
const canOpenCurrentDiffInEditor = computed(() => (
  Boolean(selectedPath.value)
  && !isCommitDiffMode.value
  && resolveWorkspaceFileTabType(selectedPath.value ?? '') !== 'unsupported'
));
const stageActionLabel = computed(() => (
  canSelectNextDiff.value ? 'Stage & next' : 'Stage current'
));

function getRepoName(nextRepoPath: string): string {
  const parts = nextRepoPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? nextRepoPath;
}

function getProjectTitleContextKeys(
  nextWorkspaceId: string | null | undefined,
  nextRepoPath: string | null,
): string[] {
  const contextKeys = [
    nextWorkspaceId && nextWorkspaceId !== GLOBAL_WORKSPACE_ID ? nextWorkspaceId : null,
    nextRepoPath,
  ].filter((contextKey): contextKey is string => Boolean(contextKey));

  return [...new Set(contextKeys)];
}

function getWorkspaceContextKey(
  nextWorkspaceId: string | null | undefined,
  nextRepoPath: string | null,
): string {
  return getProjectTitleContextKeys(nextWorkspaceId, nextRepoPath)[0] ?? GLOBAL_WORKSPACE_SESSION_KEY;
}

function resolveProjectTitleFromContext(
  nextWorkspaceId: string | null | undefined,
  nextRepoPath: string | null,
): string {
  return getProjectTitleContextKeys(nextWorkspaceId, nextRepoPath)
    .map((contextKey) => projectTitlesByContext.value[contextKey]?.trim() ?? '')
    .find(Boolean) ?? '';
}

function buildProjectWorkspaceId(nextRepoPath: string) {
  const baseWorkspaceId = `workspace:${nextRepoPath}`;

  if (!workspaceDescriptors.value[baseWorkspaceId]) {
    return baseWorkspaceId;
  }

  let duplicateIndex = 2;
  let nextWorkspaceId = `${baseWorkspaceId}#${duplicateIndex}`;

  while (workspaceDescriptors.value[nextWorkspaceId]) {
    duplicateIndex += 1;
    nextWorkspaceId = `${baseWorkspaceId}#${duplicateIndex}`;
  }

  return nextWorkspaceId;
}

function getWorkspaceDescriptorById(workspaceId: string | null | undefined): WorkspaceDescriptor | null {
  if (!workspaceId) {
    return null;
  }

  return workspaceDescriptors.value[workspaceId] ?? null;
}

function getCurrentWorkspaceId() {
  return activeWorkspaceId.value ?? GLOBAL_WORKSPACE_ID;
}

function buildWorkspaceSessionState(
  tabs = workspaceTabs.value,
  activeTabId = activeWorkspaceTabId.value,
): WorkspaceSessionState {
  return cloneWorkspaceSessionState({
    tabs,
    activeTabId,
  });
}

function buildPersistedWorkspaceSessions(): WorkspaceSessionsById {
  const nextWorkspaceSessions = cloneWorkspaceSessions(workspaceSessions.value);
  nextWorkspaceSessions[getCurrentWorkspaceId()] = buildWorkspaceSessionState();
  return nextWorkspaceSessions;
}

function applyWorkspaceSession(nextWorkspaceId: string | null) {
  const workspaceSession = workspaceSessions.value[nextWorkspaceId ?? GLOBAL_WORKSPACE_ID];
  const nextWorkspaceSession = workspaceSession
    ? cloneWorkspaceSessionState(workspaceSession)
    : {
        tabs: [],
        activeTabId: null,
      };

  workspaceTabs.value = nextWorkspaceSession.tabs;
  activeWorkspaceTabId.value = nextWorkspaceSession.activeTabId;
}

function captureWorkspaceSession(nextWorkspaceId: string | null) {
  workspaceSessions.value = {
    ...workspaceSessions.value,
    [nextWorkspaceId ?? GLOBAL_WORKSPACE_ID]: buildWorkspaceSessionState(),
  };
}

function buildDefaultRepoPanelSectionState(): RepoPanelSectionState {
  return {
    staged: false,
    changed: false,
    untracked: true,
    conflicts: false,
  };
}

function buildDefaultWorkspaceRepoPanelState(): WorkspaceRepoPanelState {
  return {
    fontSize: DEFAULT_SESSION_DATA.workspaceTabDefaults.noteFontSize,
    historyOpen: false,
    workspaceDetailExpanded: true,
    files: {
      expanded: true,
      viewMode: 'list',
      showAll: false,
      collapsedSections: buildDefaultRepoPanelSectionState(),
    },
  };
}

function currentWorkspaceRepoPanelStateValue(): WorkspaceRepoPanelState {
  return cloneWorkspaceRepoPanelState(
    workspaceRepoPanelStates.value[getCurrentWorkspaceId()]
    ?? buildDefaultWorkspaceRepoPanelState(),
  );
}

const currentWorkspaceRepoPanelState = computed(() => currentWorkspaceRepoPanelStateValue());

function getWorkspaceRepoPanelStateValue(nextWorkspaceId: string | null | undefined): WorkspaceRepoPanelState {
  return cloneWorkspaceRepoPanelState(
    workspaceRepoPanelStates.value[nextWorkspaceId ?? GLOBAL_WORKSPACE_ID]
    ?? buildDefaultWorkspaceRepoPanelState(),
  );
}

function buildCurrentPanelLayout(): PanelLayout {
  return {
    sidebarWidth: sidebarWidth.value,
    terminalHeight: terminalHeight.value,
    terminalWidth: terminalWidth.value,
    contentLayout: contentLayout.value,
    sidebarCollapsed: sidebarCollapsed.value,
    diffCollapsed: diffCollapsed.value,
    terminalCollapsed: terminalCollapsed.value,
  };
}

function applyPanelLayout(nextPanelLayout: PanelLayout) {
  sidebarWidth.value = nextPanelLayout.sidebarWidth;
  terminalHeight.value = nextPanelLayout.terminalHeight;
  terminalWidth.value = nextPanelLayout.terminalWidth;
  contentLayout.value = nextPanelLayout.contentLayout;
  sidebarCollapsed.value = nextPanelLayout.sidebarCollapsed;
  diffCollapsed.value = nextPanelLayout.diffCollapsed;
  terminalCollapsed.value = nextPanelLayout.terminalCollapsed;
}

function buildPersistedPanelLayoutsByWorkspace(): Record<string, PanelLayout> {
  return {
    ...clonePanelLayoutsByWorkspace(panelLayoutsByWorkspace.value),
    [getCurrentWorkspaceId()]: buildCurrentPanelLayout(),
  };
}

function buildPersistedWorkspaceRepoPanelStates(): Record<string, WorkspaceRepoPanelState> {
  return {
    ...cloneWorkspaceRepoPanelStates(workspaceRepoPanelStates.value),
    [getCurrentWorkspaceId()]: currentWorkspaceRepoPanelStateValue(),
  };
}

function buildKnownProjectRepoPaths(): Set<string> {
  const knownProjectRepoPaths = new Set<string>();

  recentRepos.value.forEach((recentRepo) => {
    knownProjectRepoPaths.add(recentRepo.path);
  });

  Object.values(workspaceDescriptors.value).forEach((workspaceDescriptor) => {
    if (workspaceDescriptor.kind === 'project' && workspaceDescriptor.repoPath) {
      knownProjectRepoPaths.add(workspaceDescriptor.repoPath);
    }
  });

  return knownProjectRepoPaths;
}

function buildVisibleWorktreeSuggestions(
  worktrees: GitWorktreeSummary[],
  options: { includeDismissed?: boolean } = {},
): GitWorktreeSummary[] {
  const knownProjectRepoPaths = buildKnownProjectRepoPaths();
  const includeDismissed = options.includeDismissed ?? false;

  return worktrees.filter((worktree) => {
    if (!worktree.path || worktree.current || worktree.path === repoPath.value) {
      return false;
    }

    if (knownProjectRepoPaths.has(worktree.path)) {
      return false;
    }

    if (!includeDismissed && dismissedWorktreePaths.value.includes(worktree.path)) {
      return false;
    }

    return true;
  });
}

function resolvePersistedLastRepoPath(nextRepoPath: string | null = repoPath.value) {
  if (nextRepoPath) {
    return nextRepoPath;
  }

  const activeWorkspaceDescriptor = getWorkspaceDescriptorById(activeWorkspaceId.value);

  if (activeWorkspaceDescriptor?.kind === 'project') {
    return activeWorkspaceDescriptor.repoPath;
  }

  return session.value.lastRepoPath ?? recentRepos.value[0]?.path ?? null;
}

function buildSessionSavePayload(
  options: {
    activeWorkspaceId?: string | null;
    lastRepoPath?: string | null;
  } = {},
) {
  const hasExplicitLastRepoPath = Object.prototype.hasOwnProperty.call(options, 'lastRepoPath');

  return {
    lastRepoPath: resolvePersistedLastRepoPath(
      hasExplicitLastRepoPath ? options.lastRepoPath ?? null : repoPath.value,
    ),
    activeWorkspaceId: options.activeWorkspaceId ?? activeWorkspaceId.value,
    recentRepos: recentRepos.value,
    workspaceDescriptors: workspaceDescriptors.value,
    workspaceOrder: workspaceOrder.value,
    terminalCwd: terminalCwd.value,
    projectTitle: '',
    projectTitleMode: 'auto' as const,
    projectTitlesByContext: projectTitlesByContext.value,
    appAppearance: appAppearance.value,
    editorTheme: editorTheme.value,
    workspaceIndicatorVisibility: workspaceIndicatorVisibility.value,
    workspaceTabDefaults: workspaceTabDefaults.value,
    worktreeDetectionIntervalMs: worktreeDetectionIntervalMs.value,
    dismissedWorktreePaths: dismissedWorktreePaths.value,
    soundNotificationsEnabled: soundNotificationsEnabled.value,
    infoNoteLastSeenRevision: infoNoteLastSeenRevision.value,
    terminalCommandPresets: terminalCommandPresets.value,
    workspaceSessions: buildPersistedWorkspaceSessions(),
    panelLayout: buildCurrentPanelLayout(),
    panelLayoutsByWorkspace: buildPersistedPanelLayoutsByWorkspace(),
    workspaceRepoPanelStates: buildPersistedWorkspaceRepoPanelStates(),
  };
}

function applyWorkspacePanelLayout(nextWorkspaceId: string | null) {
  const currentSidebarWidth = sidebarWidth.value;
  applyPanelLayout(
    panelLayoutsByWorkspace.value[nextWorkspaceId ?? GLOBAL_WORKSPACE_ID]
    ?? session.value.panelLayout,
  );
  sidebarWidth.value = currentSidebarWidth;
}

function captureWorkspacePanelLayout(nextWorkspaceId: string | null) {
  panelLayoutsByWorkspace.value = {
    ...panelLayoutsByWorkspace.value,
    [nextWorkspaceId ?? GLOBAL_WORKSPACE_ID]: buildCurrentPanelLayout(),
  };
}

function applyWorkspaceRepoPanelState(nextWorkspaceId: string | null) {
  const nextRepoPanelState = cloneWorkspaceRepoPanelState(
    workspaceRepoPanelStates.value[nextWorkspaceId ?? GLOBAL_WORKSPACE_ID]
    ?? buildDefaultWorkspaceRepoPanelState(),
  );

  isCommitHistoryOpen.value = nextRepoPanelState.historyOpen;
}

function applyAppTheme(nextAppearance: AppAppearance) {
  const normalizedAppearance = normalizeAppAppearance(nextAppearance);
  document.documentElement.dataset.appTheme = normalizedAppearance;
  document.documentElement.style.colorScheme = resolveThemeVariant(normalizedAppearance);
}

function captureWorkspaceRepoPanelState(nextWorkspaceId: string | null) {
  workspaceRepoPanelStates.value = {
    ...workspaceRepoPanelStates.value,
    [nextWorkspaceId ?? GLOBAL_WORKSPACE_ID]: currentWorkspaceRepoPanelStateValue(),
  };
}

function shouldLoadDetailedGitStatus(repoPanelState: WorkspaceRepoPanelState): boolean {
  return repoPanelState.workspaceDetailExpanded
    && repoPanelState.files.expanded
    && Object.values(repoPanelState.files.collapsedSections).some((isCollapsed) => !isCollapsed);
}

async function updateCurrentWorkspaceRepoPanelState(nextRepoPanelState: WorkspaceRepoPanelState) {
  workspaceRepoPanelStates.value = {
    ...workspaceRepoPanelStates.value,
    [getCurrentWorkspaceId()]: cloneWorkspaceRepoPanelState(nextRepoPanelState),
  };

  if (repoPath.value && shouldLoadDetailedGitStatus(nextRepoPanelState) && !status.value && !isLoading.value) {
    void ensureFullStatus();
  }
}

function mergeWorkspaceOrder(...workspaceLists: Array<Array<string | null | undefined>>) {
  const nextOrder: string[] = [];
  const seenWorkspaceIds = new Set<string>();

  workspaceLists.forEach((workspaceList) => {
    workspaceList.forEach((workspaceId) => {
      if (!workspaceId || seenWorkspaceIds.has(workspaceId)) {
        return;
      }

      seenWorkspaceIds.add(workspaceId);
      nextOrder.push(workspaceId);
    });
  });

  return nextOrder;
}

function omitRecordEntry<T>(entries: Record<string, T>, entryKey: string) {
  const nextEntries = { ...entries };
  delete nextEntries[entryKey];
  return nextEntries;
}

function appendWorkspaceToOrder(nextWorkspaceId: string | null) {
  if (!nextWorkspaceId) {
    return workspaceOrder.value;
  }

  return mergeWorkspaceOrder(workspaceOrder.value, [nextWorkspaceId]);
}

function ensureProjectWorkspace(
  nextRepoPath: string,
  options: { allowDuplicate?: boolean } = {},
): WorkspaceDescriptor {
  const existingWorkspace = !options.allowDuplicate
    ? Object.values(workspaceDescriptors.value).find((workspaceDescriptor) => (
      workspaceDescriptor.kind === 'project' && workspaceDescriptor.repoPath === nextRepoPath
    ))
    : null;

  if (existingWorkspace) {
    return existingWorkspace;
  }

  const nextWorkspaceDescriptor: WorkspaceDescriptor = {
    id: buildProjectWorkspaceId(nextRepoPath),
    kind: 'project',
    repoPath: nextRepoPath,
  };

  workspaceDescriptors.value = {
    ...workspaceDescriptors.value,
    [nextWorkspaceDescriptor.id]: nextWorkspaceDescriptor,
  };

  return nextWorkspaceDescriptor;
}

function resolveAutoProjectTitle(nextRepoPath: string | null): string {
  return nextRepoPath ? getRepoName(nextRepoPath) : 'BridgeGit';
}

function buildProjectTitlesByContext(
  titlesByContext: Record<string, string>,
  nextWorkspaceId: string | null | undefined,
  nextRepoPath: string | null,
): Record<string, string> {
  const nextTitlesByContext = cloneProjectTitlesByContext(titlesByContext);

  if (!nextRepoPath) {
    return nextTitlesByContext;
  }

  const contextKey = getWorkspaceContextKey(nextWorkspaceId, nextRepoPath);
  const currentTitle = getProjectTitleContextKeys(nextWorkspaceId, nextRepoPath)
    .map((currentContextKey) => nextTitlesByContext[currentContextKey]?.trim() ?? '')
    .find(Boolean);

  if (currentTitle) {
    nextTitlesByContext[contextKey] = currentTitle;
    return nextTitlesByContext;
  }

  nextTitlesByContext[contextKey] = getRepoName(nextRepoPath);
  return nextTitlesByContext;
}

function buildDiffPathQueue(nextStatus: GitStatusSummary | null): string[] {
  if (!nextStatus) {
    return [];
  }

  const seenPaths = new Set<string>();
  const orderedPaths = [
    ...nextStatus.unstaged,
    ...nextStatus.untracked,
    ...nextStatus.conflicted,
    ...nextStatus.staged,
  ];

  return orderedPaths
    .map((item) => item.path)
    .filter((path) => {
      if (seenPaths.has(path)) {
        return false;
      }

      seenPaths.add(path);
      return true;
    });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isPanelCollapsed(panelId: PanelId): boolean {
  switch (panelId) {
    case 'sidebar':
      return sidebarCollapsed.value;
    case 'diff':
      return diffCollapsed.value;
    case 'terminal':
      return terminalCollapsed.value;
  }
}

function setPanelCollapsed(panelId: PanelId, nextCollapsed: boolean) {
  if (panelId === 'sidebar') {
    sidebarCollapsed.value = nextCollapsed;
    return;
  }

  if (panelId === 'diff') {
    diffCollapsed.value = nextCollapsed;
    return;
  }

  terminalCollapsed.value = nextCollapsed;
}

function togglePanel(panelId: PanelId) {
  const currentlyCollapsed = isPanelCollapsed(panelId);

  if (!currentlyCollapsed && visiblePanelCount.value <= 1) {
    return;
  }

  stopResize();
  setPanelCollapsed(panelId, !currentlyCollapsed);
  scheduleSessionSave();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')) {
    return false;
  }

  if (
    target instanceof HTMLElement
    && target.closest('.xterm')
    && target.classList.contains('xterm-helper-textarea')
  ) {
    return false;
  }

  return (
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isTextPasteTarget(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')) {
    return false;
  }

  if (target instanceof HTMLTextAreaElement) {
    return true;
  }

  if (!(target instanceof HTMLInputElement)) {
    return false;
  }

  return !new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']).has(target.type);
}

async function readClipboardText() {
  try {
    if (window.bridgegit?.clipboard) {
      return await Promise.resolve(window.bridgegit.clipboard.readText());
    }
  } catch {
    // Fall back to the browser clipboard API when the Electron bridge is unavailable.
  }

  return navigator.clipboard.readText();
}

function updateTextFieldValue(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = target instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

  if (descriptor?.set) {
    descriptor.set.call(target, value);
  } else {
    target.value = value;
  }

  target.dispatchEvent(new Event('input', { bubbles: true }));
}

async function handleGlobalEditableContextMenu(event: MouseEvent) {
  const target = event.target;

  if (!isTextPasteTarget(target) || target.disabled || target.readOnly) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const clipboardText = (await readClipboardText()).replace(/\r\n/g, '\n');

  if (!clipboardText) {
    return;
  }

  const selectionStart = target.selectionStart ?? target.value.length;
  const selectionEnd = target.selectionEnd ?? target.value.length;
  const nextValue = `${target.value.slice(0, selectionStart)}${clipboardText}${target.value.slice(selectionEnd)}`;
  const nextCursorPosition = selectionStart + clipboardText.length;

  updateTextFieldValue(target, nextValue);
  target.focus();

  try {
    target.setSelectionRange(nextCursorPosition, nextCursorPosition);
  } catch {
    // Some input types do not support programmatic selection ranges.
  }
}

function handlePointerMove(event: PointerEvent) {
  if (activeResize.value === 'sidebar') {
    const shellElement = shellRef.value;

    if (!shellElement) {
      return;
    }

    const bounds = shellElement.getBoundingClientRect();
    const maxSidebarWidth = Math.max(250, bounds.width * 0.46);
    sidebarWidth.value = Math.round(clamp(event.clientX - bounds.left, 250, maxSidebarWidth));
    return;
  }

  const contentElement = contentRef.value;

  if (!contentElement) {
    return;
  }

  const bounds = contentElement.getBoundingClientRect();

  if (contentLayout.value === 'stacked') {
    const maxTerminalHeight = Math.max(180, bounds.height - 220);
    terminalHeight.value = Math.round(clamp(bounds.bottom - event.clientY, 180, maxTerminalHeight));
    return;
  }

  const maxTerminalWidth = Math.max(280, bounds.width * 0.62);
  terminalWidth.value = Math.round(clamp(bounds.right - event.clientX, 280, maxTerminalWidth));
}

function stopResize() {
  activeResize.value = null;
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', stopResize);
  window.removeEventListener('pointercancel', stopResize);
}

function scheduleSessionSave() {
  if (!sessionReady.value || isSwitchingWorkspaceContext.value) {
    return;
  }

  if (persistTimer) {
    window.clearTimeout(persistTimer);
  }

  persistTimer = window.setTimeout(() => {
    void saveSession(buildSessionSavePayload());
  }, 180);
}

async function detectWorktrees(
  options: { includeDismissed?: boolean } = {},
) {
  const currentRepoPath = repoPath.value;

  if (!currentRepoPath || !window.bridgegit?.git) {
    detectedWorktrees.value = [];
    return;
  }

  if (isCheckingWorktrees.value) {
    return;
  }

  isCheckingWorktrees.value = true;

  try {
    const nextWorktrees = await window.bridgegit.git.worktrees(currentRepoPath);

    if (repoPath.value !== currentRepoPath) {
      return;
    }

    detectedWorktrees.value = buildVisibleWorktreeSuggestions(nextWorktrees, options);
  } catch {
    if (repoPath.value === currentRepoPath) {
      detectedWorktrees.value = [];
    }
  } finally {
    if (repoPath.value === currentRepoPath) {
      isCheckingWorktrees.value = false;
    } else {
      isCheckingWorktrees.value = false;
    }
  }
}

function startWorktreeDetectionPolling() {
  if (worktreeDetectionTimer) {
    window.clearInterval(worktreeDetectionTimer);
  }

  if (!worktreeDetectionIntervalMs.value) {
    return;
  }

  worktreeDetectionTimer = window.setInterval(() => {
    if (!sessionReady.value || isSwitchingWorkspaceContext.value || !repoPath.value || document.visibilityState !== 'visible') {
      return;
    }

    void detectWorktrees();
  }, worktreeDetectionIntervalMs.value);
}

async function handleRefreshRepo() {
  await refreshRepoStatus();
  await detectWorktrees({ includeDismissed: true });
}

async function handleDismissDetectedWorktree(path: string) {
  const nextDismissedWorktreePaths = cloneDismissedWorktreePaths([
    ...new Set([...dismissedWorktreePaths.value, path]),
  ]);

  dismissedWorktreePaths.value = nextDismissedWorktreePaths;
  detectedWorktrees.value = detectedWorktrees.value.filter((worktree) => worktree.path !== path);
  const savedSession = await saveSession({
    dismissedWorktreePaths: nextDismissedWorktreePaths,
  });
  dismissedWorktreePaths.value = cloneDismissedWorktreePaths(savedSession.dismissedWorktreePaths);
}

async function handleAddDetectedWorktree(path: string) {
  dismissedWorktreePaths.value = dismissedWorktreePaths.value.filter((dismissedPath) => dismissedPath !== path);
  detectedWorktrees.value = detectedWorktrees.value.filter((worktree) => worktree.path !== path);
  await handleSelectRepo(path);
}

function startResize(target: Exclude<ResizeTarget, null>, event: PointerEvent) {
  activeResize.value = target;
  const handle = event.currentTarget as HTMLElement | null;

  handle?.setPointerCapture?.(event.pointerId);

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', stopResize);
  window.addEventListener('pointercancel', stopResize);
}

function showProjectTitleSavedToast(message: string) {
  projectTitleSaveToast.value = message;

  if (projectTitleSaveToastTimer) {
    window.clearTimeout(projectTitleSaveToastTimer);
  }

  projectTitleSaveToastTimer = window.setTimeout(() => {
    projectTitleSaveToast.value = null;
  }, 1800);
}

function toggleContentLayout() {
  contentLayout.value = contentLayout.value === 'stacked' ? 'side-by-side' : 'stacked';
  scheduleSessionSave();
}

function handleOpenWelcomeNote() {
  workspaceTabs.value = upsertWelcomeNoteTab(workspaceTabs.value, workspaceTabDefaults.value);
  activeWorkspaceTabId.value = WELCOME_NOTE_TAB_ID;
  infoNoteLastSeenRevision.value = CURRENT_INFO_NOTE_REVISION;
  void saveSession({
    infoNoteLastSeenRevision: CURRENT_INFO_NOTE_REVISION,
  });

  if (terminalCollapsed.value) {
    terminalCollapsed.value = false;
  }

  scheduleSessionSave();
}

function markInfoNoteAsSeenWhenActive() {
  const activeTab = workspaceTabs.value.find((tab) => tab.id === activeWorkspaceTabId.value);

  if (!activeTab || activeTab.id !== WELCOME_NOTE_TAB_ID || activeTab.type !== 'note') {
    return;
  }

  if (infoNoteLastSeenRevision.value === CURRENT_INFO_NOTE_REVISION) {
    return;
  }

  infoNoteLastSeenRevision.value = CURRENT_INFO_NOTE_REVISION;
}

async function handleSaveSettings(nextSettings: ProjectSettingsFormData) {
  const trimmedTitle = nextSettings.projectTitle.trim();
  const nextWorkspaceRepoPanelState = {
    ...currentWorkspaceRepoPanelStateValue(),
    fontSize: nextSettings.workspacePanelFontSize,
  };
  const nextProjectTitlesByContext = repoPath.value
    ? {
        ...projectTitlesByContext.value,
        [getWorkspaceContextKey(getCurrentWorkspaceId(), repoPath.value)]: trimmedTitle || getRepoName(repoPath.value),
      }
    : projectTitlesByContext.value;

  projectTitlesByContext.value = nextProjectTitlesByContext;
  contentLayout.value = nextSettings.contentLayout;
  appAppearance.value = normalizeAppAppearance(nextSettings.appAppearance);
  editorTheme.value = normalizeEditorTheme(nextSettings.editorTheme);
  applyAppTheme(appAppearance.value);
  workspaceRepoPanelStates.value = {
    ...workspaceRepoPanelStates.value,
    [getCurrentWorkspaceId()]: cloneWorkspaceRepoPanelState(nextWorkspaceRepoPanelState),
  };
  workspaceIndicatorVisibility.value = cloneWorkspaceIndicatorVisibilitySettings(nextSettings.workspaceIndicatorVisibility);
  workspaceTabDefaults.value = cloneWorkspaceTabDefaults(nextSettings.workspaceTabDefaults);
  worktreeDetectionIntervalMs.value = nextSettings.worktreeDetectionIntervalMs;
  soundNotificationsEnabled.value = nextSettings.soundNotificationsEnabled;
  terminalCommandPresets.value = nextSettings.terminalCommandPresets;

  const savedSession = await saveSession({
    activeWorkspaceId: activeWorkspaceId.value,
    projectTitle: '',
    projectTitleMode: 'auto',
    projectTitlesByContext: nextProjectTitlesByContext,
    appAppearance: nextSettings.appAppearance,
    editorTheme: nextSettings.editorTheme,
    workspaceIndicatorVisibility: nextSettings.workspaceIndicatorVisibility,
    workspaceTabDefaults: nextSettings.workspaceTabDefaults,
    worktreeDetectionIntervalMs: nextSettings.worktreeDetectionIntervalMs,
    soundNotificationsEnabled: nextSettings.soundNotificationsEnabled,
    infoNoteLastSeenRevision: infoNoteLastSeenRevision.value,
    terminalCommandPresets: nextSettings.terminalCommandPresets,
    workspaceSessions: buildPersistedWorkspaceSessions(),
    workspaceDescriptors: workspaceDescriptors.value,
    workspaceOrder: workspaceOrder.value,
    panelLayout: buildCurrentPanelLayout(),
    panelLayoutsByWorkspace: buildPersistedPanelLayoutsByWorkspace(),
    workspaceRepoPanelStates: {
      ...buildPersistedWorkspaceRepoPanelStates(),
      [getCurrentWorkspaceId()]: cloneWorkspaceRepoPanelState(nextWorkspaceRepoPanelState),
    },
  });

  projectTitlesByContext.value = cloneProjectTitlesByContext(savedSession.projectTitlesByContext);
  appAppearance.value = savedSession.appAppearance;
  editorTheme.value = savedSession.editorTheme;
  applyAppTheme(savedSession.appAppearance);
  workspaceIndicatorVisibility.value = cloneWorkspaceIndicatorVisibilitySettings(savedSession.workspaceIndicatorVisibility);
  workspaceTabDefaults.value = cloneWorkspaceTabDefaults(savedSession.workspaceTabDefaults);
  worktreeDetectionIntervalMs.value = savedSession.worktreeDetectionIntervalMs;
  dismissedWorktreePaths.value = cloneDismissedWorktreePaths(savedSession.dismissedWorktreePaths);
  soundNotificationsEnabled.value = savedSession.soundNotificationsEnabled;
  panelLayoutsByWorkspace.value = clonePanelLayoutsByWorkspace(savedSession.panelLayoutsByWorkspace);
  workspaceRepoPanelStates.value = cloneWorkspaceRepoPanelStates(savedSession.workspaceRepoPanelStates);
  applyWorkspacePanelLayout(savedSession.activeWorkspaceId);
  applyWorkspaceRepoPanelState(savedSession.activeWorkspaceId);
  terminalCommandPresets.value = savedSession.terminalCommandPresets;
  activeWorkspaceId.value = savedSession.activeWorkspaceId;
  workspaceDescriptors.value = cloneWorkspaceDescriptors(savedSession.workspaceDescriptors);
  workspaceOrder.value = [...savedSession.workspaceOrder];
  workspaceSessions.value = cloneWorkspaceSessions(savedSession.workspaceSessions);
  isSettingsOpen.value = false;
  showProjectTitleSavedToast('Settings saved locally');
}

function buildRecentRepos(nextRepoPath: string): RecentRepoEntry[] {
  const nextEntry: RecentRepoEntry = {
    path: nextRepoPath,
    name: getRepoName(nextRepoPath),
    lastUsedAt: new Date().toISOString(),
  };

  return [nextEntry, ...recentRepos.value.filter((repo) => repo.path !== nextRepoPath)].slice(0, 12);
}

async function activateWorkspace(nextWorkspaceId: string | null) {
  const previousWorkspaceId = getCurrentWorkspaceId();
  const nextWorkspaceDescriptor = getWorkspaceDescriptorById(nextWorkspaceId ?? GLOBAL_WORKSPACE_ID);
  const requestedRepoPath = nextWorkspaceDescriptor?.kind === 'project' ? nextWorkspaceDescriptor.repoPath : null;
  const nextRepoPath = await isGitRepositoryPath(requestedRepoPath) ? requestedRepoPath : null;
  const nextWorkspaceOrder = appendWorkspaceToOrder(nextWorkspaceId);
  const nextRepoPanelState = getWorkspaceRepoPanelStateValue(nextWorkspaceId ?? GLOBAL_WORKSPACE_ID);
  const shouldForceOpenWorkspaceDetail = previousWorkspaceId !== (nextWorkspaceDescriptor?.id ?? GLOBAL_WORKSPACE_ID)
    && nextWorkspaceDescriptor?.kind === 'project';
  const nextRepoPanelStateForActivation = shouldForceOpenWorkspaceDetail
    ? {
        ...nextRepoPanelState,
        workspaceDetailExpanded: true,
      }
    : nextRepoPanelState;

  commitMessage.value = '';
  isSwitchingWorkspaceContext.value = true;

  try {
    captureWorkspaceSession(previousWorkspaceId);
    captureWorkspacePanelLayout(previousWorkspaceId);
    captureWorkspaceRepoPanelState(previousWorkspaceId);
    isCommitHistoryOpen.value = false;
    activeWorkspaceId.value = nextWorkspaceDescriptor?.id ?? GLOBAL_WORKSPACE_ID;
    if (shouldForceOpenWorkspaceDetail) {
      workspaceRepoPanelStates.value = {
        ...workspaceRepoPanelStates.value,
        [activeWorkspaceId.value]: cloneWorkspaceRepoPanelState(nextRepoPanelStateForActivation),
      };
    }
    applyWorkspaceSession(activeWorkspaceId.value);
    workspaceRecentActivityByTabId.value = {
      ...(workspaceRecentActivityByWorkspaceId.value[activeWorkspaceId.value] ?? {}),
    };
    applyWorkspacePanelLayout(activeWorkspaceId.value);
    applyWorkspaceRepoPanelState(activeWorkspaceId.value);
    workspaceOrder.value = nextWorkspaceOrder;

    if (requestedRepoPath && nextRepoPath) {
      recentRepos.value = buildRecentRepos(nextRepoPath);
    }

    const nextProjectTitlesByContext = buildProjectTitlesByContext(
      projectTitlesByContext.value,
      activeWorkspaceId.value,
      requestedRepoPath,
    );
    projectTitlesByContext.value = nextProjectTitlesByContext;
    await saveSession(buildSessionSavePayload({
      activeWorkspaceId: activeWorkspaceId.value,
      lastRepoPath: nextRepoPath,
    }));
    await setRepoPath(nextRepoPath, {
      loadMode: 'branches',
    });
    await detectWorktrees();

    if (nextWorkspaceDescriptor?.id && requestedRepoPath) {
      void loadWorkspaceGitSummary(nextWorkspaceDescriptor.id, requestedRepoPath);
    }

    if (nextRepoPath && shouldLoadDetailedGitStatus(nextRepoPanelStateForActivation)) {
      void ensureFullStatus();
    }
  } finally {
    isSwitchingWorkspaceContext.value = false;
  }
}

async function handleSelectWorkspace(nextWorkspaceId: string | null) {
  await activateWorkspace(nextWorkspaceId);
}

async function handleRenameWorkspace(workspaceId: string, title: string) {
  const workspaceDescriptor = getWorkspaceDescriptorById(workspaceId);

  if (!workspaceDescriptor?.repoPath) {
    return;
  }

  const nextProjectTitlesByContext = {
    ...projectTitlesByContext.value,
    [getWorkspaceContextKey(workspaceId, workspaceDescriptor.repoPath)]:
      title.trim() || getRepoName(workspaceDescriptor.repoPath),
  };

  projectTitlesByContext.value = nextProjectTitlesByContext;

  const savedSession = await saveSession({
    ...buildSessionSavePayload(),
    projectTitlesByContext: nextProjectTitlesByContext,
  });

  projectTitlesByContext.value = cloneProjectTitlesByContext(savedSession.projectTitlesByContext);
  showProjectTitleSavedToast('Workspace renamed locally');
}

async function handleRemoveWorkspace(workspaceId: string) {
  const workspaceDescriptor = getWorkspaceDescriptorById(workspaceId);

  if (!workspaceDescriptor || workspaceDescriptor.kind !== 'project') {
    return;
  }

  const previousWorkspaceOrder = [...workspaceOrder.value];
  const nextWorkspaceDescriptors = omitRecordEntry(workspaceDescriptors.value, workspaceId);
  const nextWorkspaceOrder = workspaceOrder.value.filter((entryWorkspaceId) => entryWorkspaceId !== workspaceId);
  const nextWorkspaceSessions = omitRecordEntry(workspaceSessions.value, workspaceId);
  const nextPanelLayoutsByWorkspace = omitRecordEntry(panelLayoutsByWorkspace.value, workspaceId);
  const nextWorkspaceRepoPanelStates = omitRecordEntry(workspaceRepoPanelStates.value, workspaceId);
  const nextWorkspaceGitSummaryById = omitRecordEntry(workspaceGitSummaryById.value, workspaceId);
  const nextWorkspaceRecentActivityByWorkspaceId = omitRecordEntry(workspaceRecentActivityByWorkspaceId.value, workspaceId);
  const nextWorkspaceAttentionByWorkspaceId = omitRecordEntry(workspaceAttentionByWorkspaceId.value, workspaceId);
  const nextProjectTitlesByContext = cloneProjectTitlesByContext(projectTitlesByContext.value);

  if (workspaceDescriptor.repoPath) {
    delete nextProjectTitlesByContext[getWorkspaceContextKey(workspaceId, workspaceDescriptor.repoPath)];

    const hasRemainingWorkspaceForRepoPath = Object.values(nextWorkspaceDescriptors).some((descriptor) => (
      descriptor.kind === 'project' && descriptor.repoPath === workspaceDescriptor.repoPath
    ));

    if (!hasRemainingWorkspaceForRepoPath) {
      delete nextProjectTitlesByContext[workspaceDescriptor.repoPath];
      recentRepos.value = recentRepos.value.filter((entry) => entry.path !== workspaceDescriptor.repoPath);
    }
  }

  workspaceDescriptors.value = nextWorkspaceDescriptors;
  workspaceOrder.value = nextWorkspaceOrder;
  workspaceSessions.value = nextWorkspaceSessions;
  panelLayoutsByWorkspace.value = nextPanelLayoutsByWorkspace;
  workspaceRepoPanelStates.value = nextWorkspaceRepoPanelStates;
  workspaceGitSummaryById.value = nextWorkspaceGitSummaryById;
  workspaceRecentActivityByWorkspaceId.value = nextWorkspaceRecentActivityByWorkspaceId;
  workspaceAttentionByWorkspaceId.value = nextWorkspaceAttentionByWorkspaceId;
  projectTitlesByContext.value = nextProjectTitlesByContext;

  if (workspaceId !== getCurrentWorkspaceId()) {
    await saveSession({
      ...buildSessionSavePayload(),
      workspaceDescriptors: nextWorkspaceDescriptors,
      workspaceOrder: nextWorkspaceOrder,
      workspaceSessions: nextWorkspaceSessions,
      panelLayoutsByWorkspace: nextPanelLayoutsByWorkspace,
      workspaceRepoPanelStates: nextWorkspaceRepoPanelStates,
      projectTitlesByContext: nextProjectTitlesByContext,
    });
    showProjectTitleSavedToast('Workspace removed from list');
    return;
  }

  const currentWorkspaceIndex = previousWorkspaceOrder.indexOf(workspaceId);
  const nextActiveWorkspaceId = nextWorkspaceOrder[currentWorkspaceIndex] ?? nextWorkspaceOrder[currentWorkspaceIndex - 1] ?? GLOBAL_WORKSPACE_ID;
  const nextActiveWorkspaceDescriptor = nextWorkspaceDescriptors[nextActiveWorkspaceId] ?? null;
  const nextRepoPath = nextActiveWorkspaceDescriptor?.kind === 'project' ? nextActiveWorkspaceDescriptor.repoPath : null;

  isSwitchingWorkspaceContext.value = true;

  try {
    isCommitHistoryOpen.value = false;
    activeWorkspaceId.value = nextActiveWorkspaceId;
    applyWorkspaceSession(nextActiveWorkspaceId);
    workspaceRecentActivityByTabId.value = {
      ...(nextWorkspaceRecentActivityByWorkspaceId[nextActiveWorkspaceId] ?? {}),
    };
    applyWorkspacePanelLayout(nextActiveWorkspaceId);
    applyWorkspaceRepoPanelState(nextActiveWorkspaceId);

    const savedSession = await saveSession({
      ...buildSessionSavePayload({
        activeWorkspaceId: nextActiveWorkspaceId,
        lastRepoPath: nextRepoPath,
      }),
      workspaceDescriptors: nextWorkspaceDescriptors,
      workspaceOrder: nextWorkspaceOrder,
      workspaceSessions: nextWorkspaceSessions,
      panelLayoutsByWorkspace: nextPanelLayoutsByWorkspace,
      workspaceRepoPanelStates: nextWorkspaceRepoPanelStates,
      projectTitlesByContext: nextProjectTitlesByContext,
    });

    activeWorkspaceId.value = savedSession.activeWorkspaceId;
    workspaceDescriptors.value = cloneWorkspaceDescriptors(savedSession.workspaceDescriptors);
    workspaceOrder.value = [...savedSession.workspaceOrder];
    workspaceSessions.value = cloneWorkspaceSessions(savedSession.workspaceSessions);
    panelLayoutsByWorkspace.value = clonePanelLayoutsByWorkspace(savedSession.panelLayoutsByWorkspace);
    workspaceRepoPanelStates.value = cloneWorkspaceRepoPanelStates(savedSession.workspaceRepoPanelStates);
    projectTitlesByContext.value = cloneProjectTitlesByContext(savedSession.projectTitlesByContext);
    await setRepoPath(nextRepoPath, {
      loadMode: 'branches',
    });

    if (nextActiveWorkspaceId !== GLOBAL_WORKSPACE_ID && nextRepoPath) {
      void loadWorkspaceGitSummary(nextActiveWorkspaceId, nextRepoPath);
    }
  } finally {
    isSwitchingWorkspaceContext.value = false;
  }

  showProjectTitleSavedToast('Workspace removed from list');
}

async function handleSelectRepo(nextRepoPath: string, options: { allowDuplicate?: boolean } = {}) {
  const workspaceDescriptor = ensureProjectWorkspace(nextRepoPath, options);
  await activateWorkspace(workspaceDescriptor.id);
}

function buildWorkspaceSummaryPlaceholder() {
  return {
    branch: null,
    changedCount: null,
    untrackedCount: null,
    conflictedCount: null,
  };
}

async function handleChangeWorkspaceRepo(workspaceId: string) {
  const workspaceDescriptor = getWorkspaceDescriptorById(workspaceId);

  if (!workspaceDescriptor || workspaceDescriptor.kind !== 'project') {
    return;
  }

  const nextRepoPath = await window.bridgegit?.dialog.openRepo(workspaceDescriptor.repoPath);

  if (!nextRepoPath || nextRepoPath === workspaceDescriptor.repoPath) {
    return;
  }

  const nextWorkspaceDescriptors = {
    ...workspaceDescriptors.value,
    [workspaceId]: {
      ...workspaceDescriptor,
      repoPath: nextRepoPath,
    },
  };
  const nextProjectTitlesByContextBase = cloneProjectTitlesByContext(projectTitlesByContext.value);

  if (workspaceDescriptor.repoPath) {
    const hasRemainingWorkspaceForPreviousRepoPath = Object.values(nextWorkspaceDescriptors).some((descriptor) => (
      descriptor.id !== workspaceId
      && descriptor.kind === 'project'
      && descriptor.repoPath === workspaceDescriptor.repoPath
    ));

    if (!hasRemainingWorkspaceForPreviousRepoPath) {
      delete nextProjectTitlesByContextBase[workspaceDescriptor.repoPath];
    }
  }

  const nextProjectTitlesByContext = buildProjectTitlesByContext(
    nextProjectTitlesByContextBase,
    workspaceId,
    nextRepoPath,
  );

  workspaceDescriptors.value = nextWorkspaceDescriptors;
  projectTitlesByContext.value = nextProjectTitlesByContext;
  recentRepos.value = buildRecentRepos(nextRepoPath);
  workspaceGitSummaryById.value = {
    ...workspaceGitSummaryById.value,
    [workspaceId]: buildWorkspaceSummaryPlaceholder(),
  };

  if (workspaceId === getCurrentWorkspaceId()) {
    await activateWorkspace(workspaceId);
  } else {
    const savedSession = await saveSession({
      ...buildSessionSavePayload(),
      workspaceDescriptors: nextWorkspaceDescriptors,
      projectTitlesByContext: nextProjectTitlesByContext,
      recentRepos: recentRepos.value,
    });

    recentRepos.value = [...savedSession.recentRepos];
    workspaceDescriptors.value = cloneWorkspaceDescriptors(savedSession.workspaceDescriptors);
    projectTitlesByContext.value = cloneProjectTitlesByContext(savedSession.projectTitlesByContext);
    workspaceSessions.value = cloneWorkspaceSessions(savedSession.workspaceSessions);
    panelLayoutsByWorkspace.value = clonePanelLayoutsByWorkspace(savedSession.panelLayoutsByWorkspace);
    workspaceRepoPanelStates.value = cloneWorkspaceRepoPanelStates(savedSession.workspaceRepoPanelStates);
    workspaceOrder.value = [...savedSession.workspaceOrder];
  }

  void loadWorkspaceGitSummary(workspaceId, nextRepoPath);
  showProjectTitleSavedToast('Workspace repository updated');
}

function handleReorderWorkspaces(nextWorkspaceIds: string[]) {
  workspaceOrder.value = mergeWorkspaceOrder(nextWorkspaceIds);
}

async function handleOpenRepo() {
  const nextRepoPath = await window.bridgegit?.dialog.openRepo(repoPath.value);

  if (nextRepoPath) {
    await handleSelectRepo(nextRepoPath, { allowDuplicate: true });
  }
}

async function handleToggleCommitHistory() {
  if (!repoPath.value) {
    return;
  }

  const nextState = !isCommitHistoryOpen.value;
  isCommitHistoryOpen.value = nextState;
  await updateCurrentWorkspaceRepoPanelState({
    ...currentWorkspaceRepoPanelStateValue(),
    historyOpen: nextState,
  });

  if (nextState) {
    await ensureFullStatus();
    await loadLog();
  }
}

async function handleOpenCommitHistory() {
  if (!repoPath.value || isCommitHistoryOpen.value) {
    return;
  }

  isCommitHistoryOpen.value = true;
  await updateCurrentWorkspaceRepoPanelState({
    ...currentWorkspaceRepoPanelStateValue(),
    historyOpen: true,
  });
  await ensureFullStatus();
  await loadLog();
}

async function focusCommitHistorySearch() {
  if (!repoPath.value) {
    return;
  }

  const shouldLoadLog = !isCommitHistoryOpen.value;

  if (!isCommitHistoryOpen.value) {
    isCommitHistoryOpen.value = true;
    await updateCurrentWorkspaceRepoPanelState({
      ...currentWorkspaceRepoPanelStateValue(),
      historyOpen: true,
    });
  }

  commitHistorySearchToken.value += 1;

  if (shouldLoadLog) {
    await ensureFullStatus();
    await loadLog();
  }
}

async function handleSelectFile(filePath: string, diffMode?: GitDiffMode) {
  if (diffCollapsed.value) {
    diffCollapsed.value = false;
    scheduleSessionSave();
  }

  await selectFile(filePath, { diffMode });
}

async function handleOpenCommitDiff(commit: GitLogEntry) {
  isCommitHistoryOpen.value = false;
  void updateCurrentWorkspaceRepoPanelState({
    ...currentWorkspaceRepoPanelStateValue(),
    historyOpen: false,
  });

  if (diffCollapsed.value) {
    diffCollapsed.value = false;
    scheduleSessionSave();
  }

  await openCommitDiff(commit);
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (isCommitHistoryOpen.value) {
      event.preventDefault();
      isCommitHistoryOpen.value = false;
      void updateCurrentWorkspaceRepoPanelState({
        ...currentWorkspaceRepoPanelStateValue(),
        historyOpen: false,
      });
      return;
    }

    if (isSettingsOpen.value) {
      event.preventDefault();
      isSettingsOpen.value = false;
      return;
    }
  }

  if (matchesShortcut(event, SHORTCUTS.historyOpen) && repoPath.value && !isCommitHistoryOpen.value) {
    event.preventDefault();
    void handleOpenCommitHistory();
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.historySearch) && repoPath.value) {
    event.preventDefault();
    void focusCommitHistorySearch();
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.panelRepoToggle)) {
    event.preventDefault();
    togglePanel('sidebar');
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.panelDiffToggle)) {
    event.preventDefault();
    togglePanel('diff');
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.panelTerminalToggle)) {
    event.preventDefault();
    togglePanel('terminal');
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.terminalPreviousTab) && sessionReady.value) {
    event.preventDefault();
    terminalPanelRef.value?.focusPreviousTab();
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.terminalNextTab) && sessionReady.value) {
    event.preventDefault();
    terminalPanelRef.value?.focusNextTab();
    return;
  }

  if (
    matchesShortcut(event, SHORTCUTS.workspaceNewTabMenu)
    && sessionReady.value
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();
    terminalPanelRef.value?.openCreationMenu();
    return;
  }

  if (isEditableTarget(event.target) || isSettingsOpen.value || isCommitHistoryOpen.value) {
    return;
  }

  if (sessionReady.value) {
    for (let slot = 1; slot <= 9; slot += 1) {
      if (!matchesCommandSlotShortcut(event, slot)) {
        continue;
      }

      const hasAssignedPreset = terminalCommandPresets.value.some((preset) => preset.shortcutSlot === slot);

      if (!hasAssignedPreset) {
        return;
      }

      event.preventDefault();

      if (terminalCollapsed.value) {
        terminalCollapsed.value = false;
        scheduleSessionSave();
      }

      void terminalPanelRef.value?.executePresetBySlot(slot);
      return;
    }
  }

  if (matchesShortcut(event, SHORTCUTS.terminalCloseTab) && sessionReady.value) {
    event.preventDefault();
    terminalPanelRef.value?.closeActiveTab();
    return;
  }

  if (isCommitDiffMode.value || diffCollapsed.value) {
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.diffPrevious) && canSelectPreviousDiff.value) {
    event.preventDefault();
    void handleSelectAdjacentDiff(-1);
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.diffNext) && canSelectNextDiff.value) {
    event.preventDefault();
    void handleSelectAdjacentDiff(1);
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.diffStageAndContinue) && canStageCurrentDiff.value) {
    event.preventDefault();
    void handleStageCurrentAndAdvance();
  }
}

function resolveRepoFilePath(repoRoot: string, relativePath: string) {
  const separator = runtimeInfo.platform === 'win32' ? '\\' : '/';
  const normalizedRelativePath = relativePath.replace(/[\\/]/g, separator);

  if (repoRoot.endsWith(separator)) {
    return `${repoRoot}${normalizedRelativePath}`;
  }

  return `${repoRoot}${separator}${normalizedRelativePath}`;
}

async function handleOpenWorkspaceFile(relativePath: string) {
  if (!repoPath.value || !sessionReady.value) {
    return;
  }

  if (terminalCollapsed.value) {
    terminalCollapsed.value = false;
    scheduleSessionSave();
  }

  const filePath = resolveRepoFilePath(repoPath.value, relativePath);
  await terminalPanelRef.value?.openWorkspaceFilePath(filePath);
}

async function handleOpenCurrentDiffInWorkspace() {
  if (!selectedPath.value) {
    return;
  }

  await handleOpenWorkspaceFile(selectedPath.value);
}

async function handleCommit() {
  const trimmedMessage = commitMessage.value.trim();

  if (!trimmedMessage) {
    return;
  }

  await commitChanges(trimmedMessage);

  if (!error.value) {
    commitMessage.value = '';
  }
}

async function handleCheckout(branchName: string) {
  if (!branchName) {
    return;
  }

  await checkoutBranch(branchName);
}

async function handleDiscardFile(change: GitChange) {
  await discardFile(change);
}

async function handleDiscardCurrentDiff() {
  if (!currentDiscardableChange.value) {
    return;
  }

  await discardFile(currentDiscardableChange.value);
}

async function handleDiscardHunk(patch: string) {
  await discardHunk(patch, selectedDiffMode.value);
}

async function handleSelectAdjacentDiff(direction: -1 | 1) {
  const nextIndex = currentDiffIndex.value + direction;
  const nextPath = diffPathQueue.value[nextIndex];

  if (!nextPath) {
    return;
  }

  await selectFile(nextPath);
}

async function handleStageCurrentAndAdvance() {
  if (!selectedPath.value || !canStageCurrentDiff.value) {
    return;
  }

  const nextPath = diffPathQueue.value[currentDiffIndex.value + 1]
    ?? diffPathQueue.value[currentDiffIndex.value - 1]
    ?? null;

  await stageFiles([selectedPath.value]);

  if (nextPath && nextPath !== selectedPath.value) {
    await selectFile(nextPath);
  }
}

watch([sidebarWidth, terminalHeight, terminalWidth, contentLayout, sidebarCollapsed, diffCollapsed, terminalCollapsed], () => {
  scheduleSessionSave();
});

watch(repoPath, () => {
  if (!repoPath.value) {
    detectedWorktrees.value = [];
  }

  scheduleSessionSave();
});

watch([recentRepos, workspaceOrder, appAppearance, editorTheme, workspaceIndicatorVisibility, workspaceTabDefaults, soundNotificationsEnabled, terminalCommandPresets, workspaceTabs, activeWorkspaceTabId, workspaceRepoPanelStates], () => {
  scheduleSessionSave();
}, { deep: true });

watch([worktreeDetectionIntervalMs, repoPath], () => {
  if (!sessionReady.value) {
    return;
  }

  startWorktreeDetectionPolling();
});

watch(
  () => [
    getCurrentWorkspaceId(),
    repoPath.value,
    status.value?.currentBranch ?? branches.value?.current ?? null,
    status.value?.staged.length ?? null,
    status.value?.unstaged.length ?? null,
    status.value?.untracked.length ?? null,
    status.value?.conflicted.length ?? null,
  ],
  () => {
    if (!repoPath.value) {
      return;
    }

    workspaceGitSummaryById.value = {
      ...workspaceGitSummaryById.value,
      [getCurrentWorkspaceId()]: {
        branch: status.value?.currentBranch ?? branches.value?.current ?? null,
        changedCount: status.value ? status.value.staged.length + status.value.unstaged.length + status.value.conflicted.length : null,
        untrackedCount: status.value ? status.value.untracked.length : null,
        conflictedCount: status.value ? status.value.conflicted.length : null,
      },
    };
  },
);

watch(infoNoteLastSeenRevision, () => {
  scheduleSessionSave();
});

watch(isCommitHistoryOpen, (nextIsOpen) => {
  if (isSwitchingWorkspaceContext.value) {
    return;
  }

  void updateCurrentWorkspaceRepoPanelState({
    ...currentWorkspaceRepoPanelStateValue(),
    historyOpen: nextIsOpen,
  });
});

watch([workspaceTabs, activeWorkspaceTabId], () => {
  markInfoNoteAsSeenWhenActive();
}, { deep: true });

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, true);
  window.addEventListener('contextmenu', handleGlobalEditableContextMenu, true);
  applyAppTheme(appAppearance.value);

  let initialSession = await loadSession();

  if (!hasWorkspaceTabs(initialSession.workspaceSessions)) {
    const onboardingCwd = initialSession.lastRepoPath
      ?? initialSession.terminalCwd
      ?? (runtimeInfo.platform === 'win32' ? 'C:\\' : '/');

    initialSession = await saveSession({
      terminalCwd: initialSession.terminalCwd ?? onboardingCwd,
      infoNoteLastSeenRevision: initialSession.infoNoteLastSeenRevision,
      workspaceSessions: buildOnboardingWorkspaceSessions(
        initialSession.lastRepoPath,
        onboardingCwd,
        initialSession.workspaceTabDefaults,
      ),
    });
  }

  soundNotificationsEnabled.value = initialSession.soundNotificationsEnabled;
  projectTitlesByContext.value = cloneProjectTitlesByContext(initialSession.projectTitlesByContext);
  appAppearance.value = initialSession.appAppearance;
  editorTheme.value = initialSession.editorTheme;
  applyAppTheme(initialSession.appAppearance);
  workspaceIndicatorVisibility.value = cloneWorkspaceIndicatorVisibilitySettings(initialSession.workspaceIndicatorVisibility);
  workspaceTabDefaults.value = cloneWorkspaceTabDefaults(initialSession.workspaceTabDefaults);
  worktreeDetectionIntervalMs.value = initialSession.worktreeDetectionIntervalMs;
  dismissedWorktreePaths.value = cloneDismissedWorktreePaths(initialSession.dismissedWorktreePaths);
  recentRepos.value = initialSession.recentRepos;
  activeWorkspaceId.value = initialSession.activeWorkspaceId;
  workspaceDescriptors.value = cloneWorkspaceDescriptors(initialSession.workspaceDescriptors);
  workspaceOrder.value = [...initialSession.workspaceOrder];
  panelLayoutsByWorkspace.value = clonePanelLayoutsByWorkspace(initialSession.panelLayoutsByWorkspace);
  workspaceRepoPanelStates.value = cloneWorkspaceRepoPanelStates(initialSession.workspaceRepoPanelStates);
  terminalCommandPresets.value = initialSession.terminalCommandPresets;
  workspaceSessions.value = cloneWorkspaceSessions(initialSession.workspaceSessions);
  infoNoteLastSeenRevision.value = initialSession.infoNoteLastSeenRevision;
  sidebarWidth.value = initialSession.panelLayout.sidebarWidth;
  applyWorkspaceSession(initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID);
  workspaceRecentActivityByTabId.value = {
    ...(workspaceRecentActivityByWorkspaceId.value[initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID] ?? {}),
  };
  applyWorkspacePanelLayout(initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID);
  applyWorkspaceRepoPanelState(initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID);

  const initialWorkspaceDescriptor = getWorkspaceDescriptorById(initialSession.activeWorkspaceId);
  const requestedInitialRepoPath = initialWorkspaceDescriptor?.kind === 'project'
    ? initialWorkspaceDescriptor.repoPath
    : null;
  const initialRepoPath = await isGitRepositoryPath(requestedInitialRepoPath) ? requestedInitialRepoPath : null;
  const initialRepoPanelState = getWorkspaceRepoPanelStateValue(initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID);
  void loadAllWorkspaceGitSummaries();

    if (requestedInitialRepoPath) {
      const nextProjectTitlesByContext = buildProjectTitlesByContext(
        projectTitlesByContext.value,
        initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID,
        requestedInitialRepoPath,
      );
      projectTitlesByContext.value = nextProjectTitlesByContext;
    }

    if (initialRepoPath) {
      await setRepoPath(initialRepoPath, {
        loadMode: 'branches',
      });
      await detectWorktrees();

      if (shouldLoadDetailedGitStatus(initialRepoPanelState)) {
        void ensureFullStatus();
      }
    } else {
      await setRepoPath(null);
    }

  markInfoNoteAsSeenWhenActive();

  sessionReady.value = true;
  startInactiveWorkspaceGitSummaryPolling();
  startWorktreeDetectionPolling();
});

onBeforeUnmount(() => {
  stopResize();
  dispose();
  window.removeEventListener('keydown', handleGlobalKeydown, true);
  window.removeEventListener('contextmenu', handleGlobalEditableContextMenu, true);

  if (persistTimer) {
    window.clearTimeout(persistTimer);
  }

  if (projectTitleSaveToastTimer) {
    window.clearTimeout(projectTitleSaveToastTimer);
  }

  if (inactiveWorkspaceGitSummaryTimer) {
    window.clearInterval(inactiveWorkspaceGitSummaryTimer);
  }

  if (worktreeDetectionTimer) {
    window.clearInterval(worktreeDetectionTimer);
  }
});
</script>

<template>
  <div class="app" :style="appStyle">
    <div ref="shellRef" class="app__shell">
      <aside v-if="!sidebarCollapsed" class="app__sidebar">
        <RepoPanel
          :project-title="displayProjectTitle"
          :repo-path="repoPath"
          :appearance-theme="appAppearance"
          :appearance-theme-variant="appThemeVariant"
          :recent-repos="recentRepos"
          :workspace-items="workspaceOverviewItems"
          :workspace-indicator-visibility="workspaceIndicatorVisibility"
          :repo-panel-state="currentWorkspaceRepoPanelState"
          :project-titles-by-context="projectTitlesByContext"
          :detected-worktree="activeDetectedWorktree"
          :status="status"
          :branches="branches"
          :log="log"
          :is-history-open="isCommitHistoryOpen"
          :selected-path="selectedPath"
          :is-loading="isLoading"
          :error="error"
          :commit-message="commitMessage"
          :has-unread-info="hasUnreadInfoNote"
          :can-collapse="canCollapseSidebar"
          :collapse-shortcut-display="SHORTCUTS.panelRepoToggle.display"
          @open-info="handleOpenWelcomeNote"
          @open-settings="isSettingsOpen = true"
          @open-repo="handleOpenRepo"
          @select-repo="handleSelectRepo"
          @select-workspace="handleSelectWorkspace"
          @rename-workspace="handleRenameWorkspace"
          @remove-workspace="handleRemoveWorkspace"
          @change-workspace-repo="handleChangeWorkspaceRepo"
          @reorder-workspaces="handleReorderWorkspaces"
          @update:repo-panel-state="updateCurrentWorkspaceRepoPanelState($event)"
          @refresh="handleRefreshRepo"
          @toggle-history="handleToggleCommitHistory"
          @toggle-collapse="togglePanel('sidebar')"
          @select-file="handleSelectFile"
          @open-workspace-file="handleOpenWorkspaceFile"
          @stage="stageFiles"
          @unstage="unstageFiles"
          @discard-file="handleDiscardFile"
          @checkout="handleCheckout"
          @add-detected-worktree="handleAddDetectedWorktree"
          @dismiss-detected-worktree="handleDismissDetectedWorktree"
          @update:commit-message="commitMessage = $event"
          @commit="handleCommit"
        />
      </aside>

      <button
        v-if="showShellDivider"
        class="app__divider app__divider--vertical"
        type="button"
        aria-label="Resize git sidebar"
        @pointerdown="startResize('sidebar', $event)"
      />

      <section ref="contentRef" class="app__content">
        <div v-if="!diffCollapsed" class="app__surface app__surface--diff">
          <DiffViewer
            :repo-path="repoPath"
            :viewer-mode="diffViewerMode"
            :title="diffViewerTitle"
            :title-meta="diffViewerTitleMeta"
            :has-target="diffHasTarget"
            :diff="activeDiff"
            :git-diff-mode="selectedDiffMode"
            :is-loading="activeDiffLoading"
            :error="activeDiffError"
            :change-position="currentDiffPosition"
            :change-count="diffPathQueue.length"
            :can-select-previous="canSelectPreviousDiff"
            :can-select-next="canSelectNextDiff"
            :can-stage-current="canStageCurrentDiff"
            :can-discard-current="canDiscardCurrentDiff"
            :can-open-current-file="canOpenCurrentDiffInEditor"
            :stage-action-label="stageActionLabel"
            :can-collapse="canCollapseDiff"
            :collapse-shortcut-display="SHORTCUTS.panelDiffToggle.display"
            @select-previous="handleSelectAdjacentDiff(-1)"
            @select-next="handleSelectAdjacentDiff(1)"
            @stage-current="handleStageCurrentAndAdvance"
            @discard-current="handleDiscardCurrentDiff"
            @open-current-file="handleOpenCurrentDiffInWorkspace"
            @discard-hunk="handleDiscardHunk"
            @toggle-collapse="togglePanel('diff')"
          />
        </div>

        <button
          v-if="showContentDivider"
          class="app__divider"
          :class="contentLayout === 'stacked' ? 'app__divider--horizontal' : 'app__divider--content-vertical'"
          type="button"
          aria-label="Resize right pane split"
          @pointerdown="startResize('content', $event)"
        />

        <div v-show="!terminalCollapsed" class="app__surface app__surface--terminal">
          <TerminalPanel
            ref="terminalPanelRef"
            v-if="sessionReady"
            :workspace-id="getCurrentWorkspaceId()"
            :cwd="terminalCwd"
            :project-root="repoPath"
            :appearance-theme="appAppearance"
            :appearance-theme-variant="appThemeVariant"
            :editor-theme-variant="resolvedEditorThemeVariant"
            :editor-theme="resolvedEditorTheme"
            :presets="terminalCommandPresets"
            :sound-notifications-enabled="soundNotificationsEnabled"
            :workspace-tab-defaults="workspaceTabDefaults"
            :tabs="workspaceTabs"
            :active-tab-id="activeWorkspaceTabId"
            :can-collapse="canCollapseTerminal"
            :collapse-shortcut-display="SHORTCUTS.panelTerminalToggle.display"
            :collapsed="terminalCollapsed"
            @update:tabs="workspaceTabs = $event"
            @update:active-tab-id="activeWorkspaceTabId = $event"
            @update:recent-activity="handleWorkspaceRecentActivityUpdate($event.workspaceId, $event.recentActivity)"
            @update:attention="handleWorkspaceAttentionUpdate($event.workspaceId, $event.attention)"
            @toggle-collapse="togglePanel('terminal')"
          />
        </div>

        <div v-if="!hasVisibleRightPanels" class="app__surface app__surface--empty">
          <div class="app__empty-state">
            <span class="app__empty-eyebrow">Panels</span>
            <h2 class="app__empty-title">Diff and workspace are collapsed</h2>
            <p class="app__empty-copy">
              Restore a panel from the footer or use its keyboard shortcut.
            </p>
          </div>
        </div>
      </section>

    </div>

    <StatusBar
      :branch="branch"
      :repo-name="repoName"
      :changed-count="changedCount"
      :info-message="infoMessage"
      :content-layout="contentLayout"
      :collapsed-panels="collapsedPanels"
      :terminal-tab-indicators="terminalTabIndicators"
      :repo-dock-summary="repoDockSummary"
      @toggle-layout="toggleContentLayout"
      @toggle-panel="togglePanel"
    />

    <ProjectSettingsDialog
      v-model="isSettingsOpen"
      :project-title="currentProjectTitle"
      :content-layout="contentLayout"
      :app-appearance="appAppearance"
      :editor-theme="editorTheme"
      :workspace-panel-font-size="currentWorkspaceRepoPanelState.fontSize"
      :workspace-indicator-visibility="workspaceIndicatorVisibility"
      :workspace-tab-defaults="workspaceTabDefaults"
      :worktree-detection-interval-ms="worktreeDetectionIntervalMs"
      :sound-notifications-enabled="soundNotificationsEnabled"
      :terminal-command-presets="terminalCommandPresets"
      @save="handleSaveSettings"
    />

    <CommitHistoryDialog
      v-model="isCommitHistoryOpen"
      :commits="log?.items ?? []"
      :current-branch="branch"
      :repo-path="repoPath"
      :is-loading="isLoadingLog"
      :focus-search-token="commitHistorySearchToken"
      @open-diff="handleOpenCommitDiff"
    />

    <transition name="app-toast">
      <div v-if="projectTitleSaveToast" class="app__toast">
        {{ projectTitleSaveToast }}
      </div>
    </transition>
  </div>
</template>

<style scoped lang="scss">
.app {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  height: 100%;
  min-height: 100vh;
  padding: 3px 10px 3px 3px;
  gap: 3px;
}

.app__shell {
  display: grid;
  grid-template-columns: var(--shell-columns);
  grid-template-rows: var(--shell-rows);
  min-height: 0;
  gap: 3px;
}

.app__sidebar {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.app__content {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--content-columns);
  grid-template-rows: var(--content-rows);
}

.app__surface {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--panel-bg);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}

.app__surface--empty {
  display: grid;
  place-items: center;
}

.app__divider {
  position: relative;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: col-resize;
}

.app__divider::before {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(110, 197, 255, 0.16), rgba(110, 197, 255, 0.36));
  opacity: 0.7;
}

.app__divider--vertical::before {
  width: 3px;
  height: calc(100% - 10px);
}

.app__divider--horizontal {
  cursor: row-resize;
}

.app__divider--horizontal::before {
  width: calc(100% - 10px);
  height: 3px;
}

.app__divider--content-vertical::before {
  width: 3px;
  height: calc(100% - 10px);
}

.app__empty-state {
  display: grid;
  gap: 8px;
  justify-items: center;
  max-width: 360px;
  padding: 28px;
  text-align: center;
}

.app__empty-eyebrow {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.app__empty-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.08rem;
}

.app__empty-copy {
  margin: 0;
  color: var(--text-muted);
  line-height: 1.5;
}

.app__toast {
  position: fixed;
  right: 18px;
  bottom: 52px;
  z-index: 150;
  padding: 9px 12px;
  border: 1px solid rgba(125, 228, 176, 0.28);
  border-radius: 12px;
  background: rgba(8, 18, 12, 0.96);
  color: #dff9e8;
  font-size: 0.83rem;
  letter-spacing: 0.01em;
  box-shadow: 0 16px 34px rgba(0, 0, 0, 0.34);
}

.app-toast-enter-active,
.app-toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.app-toast-enter-from,
.app-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 980px) {
  .app__shell {
    grid-template-columns: var(--shell-columns-mobile);
    grid-template-rows: var(--shell-rows-mobile);
  }

  .app__divider--vertical {
    cursor: row-resize;
  }

  .app__divider--vertical::before {
    width: calc(100% - 10px);
    height: 3px;
  }
}
</style>
