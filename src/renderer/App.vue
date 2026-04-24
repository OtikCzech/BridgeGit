<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  DEFAULT_SESSION_DATA,
  DEFAULT_PANEL_LAYOUT,
  GLOBAL_WORKSPACE_ID,
  GLOBAL_WORKSPACE_SESSION_KEY,
  areRepoPathsEquivalent,
  cloneClipboardHistoryEntries,
  cloneDismissedWorktreePaths,
  cloneDockerDialogState,
  cloneSeenInfoNoteRevisions,
  clonePanelLayoutsByWorkspace,
  cloneProjectTitlesByContext,
  cloneWorkspaceIndicatorVisibilitySettings,
  cloneWorkspaceTabDefaults,
  cloneWorkspaceRepoPanelState,
  cloneWorkspaceRepoPanelStates,
  cloneWorkspaceDescriptors,
  cloneWorkspaceEditorPaneLayout,
  cloneWorkspaceSessionState,
  cloneWorkspaceSessions,
  normalizeNoteFontSize,
  normalizeRepoPathForComparison,
  normalizeAppAppearance,
  normalizeEditorTheme,
  resolveThemeVariant,
  resolveWorkspaceFileTabType,
  type AppAppearance,
  type ClipboardHistoryEntry,
  type CodeNavigationTarget,
  type EditorTheme,
  type ResolvedEditorTheme,
  type GitDiffMode,
  type GitChange,
  type GitLogEntry,
  type GitLogScope,
  type GitStatusSummary,
  type GitWorktreeSummary,
  type PanelLayout,
  type ProjectSettingsFormData,
  type RepoPanelSectionState,
  type RecentRepoEntry,
  type TerminalCommandPreset,
  type WorktreeDetectionInterval,
  type WorkspaceEditorPaneLayout,
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
import { useTerminal } from './composables/useTerminal';
import RepoPanel from './components/RepoPanel.vue';
import StatusBar from './components/StatusBar.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import {
  CURRENT_APP_VERSION,
  CURRENT_INFO_NOTE_REVISION,
  WELCOME_NOTE_TAB_ID,
  buildOnboardingWorkspaceSessions,
  hasWorkspaceTabs,
  refreshWelcomeNoteTabs,
  upsertWelcomeNoteTab,
} from './onboarding';
import {
  CLIPBOARD_HISTORY_CAPTURE_TARGET_EVENT,
  CLIPBOARD_HISTORY_CLEAR_TARGET_EVENT,
  CLIPBOARD_HISTORY_INSERT_EVENT,
  CLIPBOARD_HISTORY_UPDATED_EVENT,
  type ClipboardHistoryUpdatedDetail,
  getClipboardHistoryEntries,
  listClipboardHistory,
  readClipboardText as readSharedClipboardText,
  setClipboardHistoryEntries,
  syncClipboardHistoryFromSystem,
} from './clipboard';
import { SHORTCUTS, matchesCommandSlotShortcut, matchesShortcut } from './shortcuts';

const CommitHistoryDialog = defineAsyncComponent(() => import('./components/CommitHistoryDialog.vue'));
const DockerDialog = defineAsyncComponent(() => import('./components/DockerDialog.vue'));
const DiffViewer = defineAsyncComponent(() => import('./components/DiffViewer.vue'));
const ProjectSettingsDialog = defineAsyncComponent(() => import('./components/ProjectSettingsDialog.vue'));

const shellRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const clipboardHistorySearchInputRef = ref<HTMLInputElement | null>(null);
const terminalPanelRef = ref<{
  addShellTab: () => void;
  addNoteTab: () => void;
  openDockerLogs: (containerId: string, containerName: string) => Promise<void>;
  closeActiveTab: () => void;
  closeEditorPane: (direction: 'left' | 'right' | 'up' | 'down') => boolean;
  focusPreviousTab: () => void;
  focusNextTab: () => void;
  executePresetBySlot: (slot: number) => Promise<boolean>;
  openAllTabsDialog: () => void;
  openQuickOpenDialog: () => void;
  openFindInFilesDialog: () => void;
  openFindInFilesDialogInMode: (mode: 'find' | 'replace') => void;
  openCreationMenu: () => void;
  openFile: () => Promise<unknown>;
  openNoteFilePath: (filePath: string) => Promise<unknown>;
  openWorkspaceFilePath: (filePath: string) => Promise<unknown>;
  openNavigationTarget: (target: CodeNavigationTarget) => Promise<unknown>;
  revealActiveFileInAllFiles: () => boolean;
  splitEditorPane: (direction: 'left' | 'right' | 'up' | 'down') => boolean;
} | null>(null);
const sidebarWidth = ref(DEFAULT_PANEL_LAYOUT.sidebarWidth);
const terminalHeight = ref(DEFAULT_PANEL_LAYOUT.terminalHeight);
const terminalWidth = ref(DEFAULT_PANEL_LAYOUT.terminalWidth);
const sidebarSide = ref(DEFAULT_PANEL_LAYOUT.sidebarSide);
const diffPlacement = ref(DEFAULT_PANEL_LAYOUT.diffPlacement);
const sidebarCollapsed = ref(DEFAULT_PANEL_LAYOUT.sidebarCollapsed);
const diffCollapsed = ref(DEFAULT_PANEL_LAYOUT.diffCollapsed);
const terminalCollapsed = ref(DEFAULT_PANEL_LAYOUT.terminalCollapsed);
const panelLayoutsByWorkspace = ref<Record<string, PanelLayout>>({});
const workspaceRepoPanelStates = ref<Record<string, WorkspaceRepoPanelState>>({});
const repoPanelFontSize = ref(DEFAULT_SESSION_DATA.repoPanelFontSize);
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
const isDockerDialogOpen = ref(false);
const isClipboardHistoryOpen = ref(false);
const commitHistorySearchToken = ref(0);
const commitMessage = ref('');
const recentRepos = ref<RecentRepoEntry[]>([]);
const workspaceDescriptors = ref<WorkspaceDescriptorsById>({});
const workspaceOrder = ref<string[]>([]);
const terminalCommandPresets = ref<TerminalCommandPreset[]>([]);
const workspaceSessions = ref<WorkspaceSessionsById>({});
const workspaceTabs = ref<WorkspaceTabState[]>([]);
const workspaceEditorPaneLayout = ref<WorkspaceEditorPaneLayout>({
  panes: [],
  activePaneId: null,
});
const workspaceMultiDisplayTabIds = ref<string[]>([]);
const workspaceRecentActivityByTabId = ref<Record<string, boolean>>({});
const workspaceRecentActivityByWorkspaceId = ref<Record<string, Record<string, boolean>>>({});
const workspaceAttentionByWorkspaceId = ref<Record<string, Record<string, boolean>>>({});
const activeWorkspaceId = ref<string | null>(GLOBAL_WORKSPACE_ID);
const activeWorkspaceTabId = ref<string | null>(null);
type WorkspaceGitSummary = {
  branch: string | null;
  changedCount: number | null;
  untrackedCount: number | null;
  conflictedCount: number | null;
  worktreeRole: 'primary' | 'linked' | null;
};

const workspaceGitSummaryById = ref<Record<string, WorkspaceGitSummary>>({});
const gitRepositoryValidityByPath = ref<Record<string, boolean>>({});
const seenInfoNoteRevisions = ref<string[]>([]);
const dockerDialogState = ref(cloneDockerDialogState(DEFAULT_SESSION_DATA.dockerDialogState));
const clipboardHistoryItems = ref<ClipboardHistoryEntry[]>([]);
const clipboardHistoryQuery = ref('');
const clipboardHistorySelectedIndex = ref(0);
const detectedWorktrees = ref<GitWorktreeSummary[]>([]);
const sessionReady = ref(false);
const sessionPersistenceEnabled = ref(false);
const isSwitchingWorkspaceContext = ref(false);
const isCheckingWorktrees = ref(false);
const repoToolbarBusyAction = ref<'pull' | 'push' | 'refresh' | null>(null);
const repoOperationStatus = ref<string | null>(null);
const revealInAllFilesPath = ref<string | null>(null);
const revealInAllFilesToken = ref(0);

const runtimeInfo = window.bridgegit ?? {
  platform: 'unknown',
  versions: {
    chrome: 'n/a',
    electron: 'n/a',
    node: 'n/a',
  },
};

const { session, loadSession, saveSession, saveSessionSync } = useSession();
const {
  repoPath,
  status,
  branches,
  log,
  historyScope,
  historyQuery,
  hasMoreHistoryCommits,
  historyPaginationMode,
  selectedHistoryCommitHash,
  commitDetail,
  selectedPath,
  selectedDiffMode,
  selectedCommit,
  selectedCommitDiffPath,
  historyPreviewCommitHash,
  historyPreviewDiffPath,
  diff,
  commitDiff,
  historyPreviewDiff,
  isLoading,
  isLoadingLog,
  isUpdatingCommitMessage,
  isLoadingCommitDetail,
  isLoadingCommitDiff,
  isLoadingHistoryPreviewDiff,
  isLoadingMoreHistoryCommits,
  error,
  errorDetail,
  commitDetailError,
  commitDiffError,
  historyPreviewDiffError,
  refresh: refreshRepoStatus,
  loadLog,
  loadMoreLog,
  loadAllLog,
  selectHistoryCommit,
  updateCommitMessage,
  setRepoPath,
  ensureFullStatus,
  selectFile,
  openCommitDiff,
  previewHistoryCommitDiff,
  clearHistoryPreviewDiffState,
  stageFiles,
  unstageFiles,
  discardFile,
  discardHunk,
  commitChanges,
  checkoutBranch,
  createBranch,
  initRepository: initCurrentRepository,
  deleteBranch,
  mergeWorktreeIntoPrimaryBranch,
  removeWorktree,
  removeWorktreeAndDeleteBranch,
  pullBranch,
  pushBranch,
  dispose,
} = useGit();

type PanelId = 'sidebar' | 'diff' | 'terminal';
type ResizeTarget = 'sidebar' | 'content' | null;
type BackgroundShellSubscription = {
  workspaceId: string;
  tabId: string;
  dispose: () => void;
};

const activeResize = ref<ResizeTarget>(null);
const INACTIVE_WORKSPACE_GIT_SUMMARY_POLL_MS = 15_000;
const INACTIVE_WORKSPACE_GIT_SUMMARY_STAGGER_MS = 350;
const INITIAL_INACTIVE_WORKSPACE_GIT_SUMMARY_DELAY_MS = 1200;
const BACKGROUND_SHELL_ACTIVITY_TIMEOUT_MS = 1600;
let persistTimer: number | null = null;
let projectTitleSaveToastTimer: number | null = null;
let inactiveWorkspaceGitSummaryTimer: number | null = null;
let initialInactiveWorkspaceGitSummaryTimer: number | null = null;
let worktreeDetectionTimer: number | null = null;
let removeCloseRequestedListener: (() => void) | null = null;
let inactiveWorkspaceGitSummaryRefreshInFlight = false;
const backgroundShellSubscriptions = new Map<string, BackgroundShellSubscription>();
const backgroundShellActivityTimers = new Map<string, number>();
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
      label: 'Tabs',
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
const currentRepoIsGitRepository = computed(() => {
  if (!repoPath.value) {
    return false;
  }

  return gitRepositoryValidityByPath.value[repoPath.value] ?? false;
});

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
    hasPanelActivity: tabs.some((tab) => Boolean(recentActivity[tab.id] || attention[tab.id])),
    hasPanelAttention: tabs.some((tab) => Boolean(attention[tab.id])),
  };
}

function buildWorkspaceTabRuntimeKey(workspaceId: string, tabId: string) {
  return `${workspaceId}:${tabId}`;
}

function updateWorkspaceIndicatorMap(
  source: typeof workspaceRecentActivityByWorkspaceId | typeof workspaceAttentionByWorkspaceId,
  workspaceId: string,
  tabId: string,
  isActive: boolean,
) {
  const currentWorkspaceIndicators = source.value[workspaceId] ?? {};
  const currentValue = Boolean(currentWorkspaceIndicators[tabId]);

  if (currentValue === isActive) {
    return currentWorkspaceIndicators;
  }

  const nextWorkspaceIndicators = { ...currentWorkspaceIndicators };

  if (isActive) {
    nextWorkspaceIndicators[tabId] = true;
  } else {
    delete nextWorkspaceIndicators[tabId];
  }

  source.value = {
    ...source.value,
    [workspaceId]: nextWorkspaceIndicators,
  };

  return nextWorkspaceIndicators;
}

function setWorkspaceRecentActivityIndicator(workspaceId: string, tabId: string, isActive: boolean) {
  const nextWorkspaceIndicators = updateWorkspaceIndicatorMap(
    workspaceRecentActivityByWorkspaceId,
    workspaceId,
    tabId,
    isActive,
  );

  if (workspaceId === getCurrentWorkspaceId()) {
    workspaceRecentActivityByTabId.value = { ...nextWorkspaceIndicators };
  }
}

function setWorkspaceAttentionIndicator(workspaceId: string, tabId: string, isActive: boolean) {
  updateWorkspaceIndicatorMap(workspaceAttentionByWorkspaceId, workspaceId, tabId, isActive);
}

function clearBackgroundShellActivityTimer(runtimeKey: string) {
  const timerId = backgroundShellActivityTimers.get(runtimeKey);

  if (timerId !== undefined) {
    window.clearTimeout(timerId);
    backgroundShellActivityTimers.delete(runtimeKey);
  }
}

function clearBackgroundShellIndicators(workspaceId: string, tabId: string) {
  setWorkspaceRecentActivityIndicator(workspaceId, tabId, false);
  setWorkspaceAttentionIndicator(workspaceId, tabId, false);
}

function handleBackgroundShellActivity(workspaceId: string, tabId: string) {
  if (workspaceId === getCurrentWorkspaceId()) {
    return;
  }

  const runtimeKey = buildWorkspaceTabRuntimeKey(workspaceId, tabId);
  clearBackgroundShellActivityTimer(runtimeKey);
  setWorkspaceAttentionIndicator(workspaceId, tabId, false);
  setWorkspaceRecentActivityIndicator(workspaceId, tabId, true);

  backgroundShellActivityTimers.set(runtimeKey, window.setTimeout(() => {
    backgroundShellActivityTimers.delete(runtimeKey);

    if (workspaceId === getCurrentWorkspaceId()) {
      return;
    }

    setWorkspaceRecentActivityIndicator(workspaceId, tabId, false);
    setWorkspaceAttentionIndicator(workspaceId, tabId, true);
  }, BACKGROUND_SHELL_ACTIVITY_TIMEOUT_MS));
}

function handleBackgroundShellExit(workspaceId: string, tabId: string) {
  const runtimeKey = buildWorkspaceTabRuntimeKey(workspaceId, tabId);
  clearBackgroundShellActivityTimer(runtimeKey);

  if (workspaceId === getCurrentWorkspaceId()) {
    return;
  }

  setWorkspaceRecentActivityIndicator(workspaceId, tabId, false);
  setWorkspaceAttentionIndicator(workspaceId, tabId, true);
}

function getBackgroundShellTabEntries() {
  const currentWorkspaceId = getCurrentWorkspaceId();
  const nextEntries = workspaceTabs.value
    .filter((tab) => tab.type === 'shell')
    .map((tab) => ({
      workspaceId: currentWorkspaceId,
      tabId: tab.id,
      runtimeKey: buildWorkspaceTabRuntimeKey(currentWorkspaceId, tab.id),
    }));

  Object.entries(workspaceSessions.value).forEach(([workspaceId, workspaceSession]) => {
    if (workspaceId === currentWorkspaceId) {
      return;
    }

    workspaceSession.tabs.forEach((tab) => {
      if (tab.type !== 'shell') {
        return;
      }

      nextEntries.push({
        workspaceId,
        tabId: tab.id,
        runtimeKey: buildWorkspaceTabRuntimeKey(workspaceId, tab.id),
      });
    });
  });

  return nextEntries;
}

function syncBackgroundShellSubscriptions() {
  const nextEntries = getBackgroundShellTabEntries();
  const nextEntriesByRuntimeKey = new Map(
    nextEntries.map((entry) => [entry.runtimeKey, entry] as const),
  );

  backgroundShellSubscriptions.forEach((subscription, runtimeKey) => {
    if (nextEntriesByRuntimeKey.has(runtimeKey)) {
      return;
    }

    subscription.dispose();
    backgroundShellSubscriptions.delete(runtimeKey);
    clearBackgroundShellActivityTimer(runtimeKey);
    clearBackgroundShellIndicators(subscription.workspaceId, subscription.tabId);
  });

  nextEntries.forEach((entry) => {
    if (backgroundShellSubscriptions.has(entry.runtimeKey)) {
      return;
    }

    const terminalRuntime = useTerminal(entry.runtimeKey);
    terminalRuntime.attach({
      onData: () => {
        handleBackgroundShellActivity(entry.workspaceId, entry.tabId);
      },
      onExit: () => {
        handleBackgroundShellExit(entry.workspaceId, entry.tabId);
      },
    });

    backgroundShellSubscriptions.set(entry.runtimeKey, {
      workspaceId: entry.workspaceId,
      tabId: entry.tabId,
      dispose: terminalRuntime.dispose,
    });
  });
}

function buildWorkspaceGitSummary(nextStatus: GitStatusSummary, nextBranch: string | null) {
  return {
    branch: nextStatus.currentBranch ?? nextBranch ?? null,
    changedCount: nextStatus.staged.length + nextStatus.unstaged.length + nextStatus.conflicted.length,
    untrackedCount: nextStatus.untracked.length,
    conflictedCount: nextStatus.conflicted.length,
    worktreeRole: null,
  };
}

function resolveWorkspaceWorktreeRole(
  nextRepoPath: string,
  worktrees: GitWorktreeSummary[],
): 'primary' | 'linked' | null {
  const primaryWorktree = worktrees.find((worktree) => !worktree.bare) ?? null;

  if (!primaryWorktree) {
    return null;
  }

  return areRepoPathsEquivalent(primaryWorktree.path, nextRepoPath) ? 'primary' : 'linked';
}

async function isGitRepositoryPath(
  nextRepoPath: string | null,
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (!nextRepoPath || !window.bridgegit?.git) {
    return false;
  }

  const cachedValidity = gitRepositoryValidityByPath.value[nextRepoPath];

  if (!options.force && cachedValidity !== undefined) {
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
        worktreeRole: null,
      },
    };
    return;
  }

  try {
    const [nextStatus, nextBranches, nextWorktrees] = await Promise.all([
      window.bridgegit.git.status(nextRepoPath),
      window.bridgegit.git.branches(nextRepoPath),
      window.bridgegit.git.worktrees(nextRepoPath),
    ]);
    const nextSummary = buildWorkspaceGitSummary(nextStatus, nextBranches.current);

    workspaceGitSummaryById.value = {
      ...workspaceGitSummaryById.value,
      [nextWorkspaceId]: {
        ...nextSummary,
        worktreeRole: resolveWorkspaceWorktreeRole(nextRepoPath, nextWorktrees),
      },
    };
  } catch {
    // Keep the last known summary if refresh fails.
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function loadInactiveWorkspaceGitSummaries(options: { staggerMs?: number } = {}) {
  if (inactiveWorkspaceGitSummaryRefreshInFlight) {
    return;
  }

  inactiveWorkspaceGitSummaryRefreshInFlight = true;
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

  const staggerMs = Math.max(0, options.staggerMs ?? 0);

  try {
    for (const [index, workspaceEntry] of workspaceEntries.entries()) {
      await loadWorkspaceGitSummary(workspaceEntry.workspaceId, workspaceEntry.repoPath);

      if (staggerMs > 0 && index < workspaceEntries.length - 1) {
        await sleep(staggerMs);
      }
    }
  } finally {
    inactiveWorkspaceGitSummaryRefreshInFlight = false;
  }
}

function scheduleInitialInactiveWorkspaceGitSummaryLoad() {
  if (initialInactiveWorkspaceGitSummaryTimer !== null) {
    window.clearTimeout(initialInactiveWorkspaceGitSummaryTimer);
  }

  initialInactiveWorkspaceGitSummaryTimer = window.setTimeout(() => {
    initialInactiveWorkspaceGitSummaryTimer = null;

    if (!sessionReady.value || isSwitchingWorkspaceContext.value || document.visibilityState !== 'visible') {
      return;
    }

    void loadInactiveWorkspaceGitSummaries({
      staggerMs: INACTIVE_WORKSPACE_GIT_SUMMARY_STAGGER_MS,
    });
  }, INITIAL_INACTIVE_WORKSPACE_GIT_SUMMARY_DELAY_MS);
}

function startInactiveWorkspaceGitSummaryPolling() {
  if (inactiveWorkspaceGitSummaryTimer) {
    window.clearInterval(inactiveWorkspaceGitSummaryTimer);
  }

  inactiveWorkspaceGitSummaryTimer = window.setInterval(() => {
    if (!sessionReady.value || isSwitchingWorkspaceContext.value || document.visibilityState !== 'visible') {
      return;
    }

    void loadInactiveWorkspaceGitSummaries({
      staggerMs: INACTIVE_WORKSPACE_GIT_SUMMARY_STAGGER_MS,
    });
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

function handleWorkspaceTabsUpdate(nextTabs: WorkspaceTabState[]) {
  workspaceTabs.value = nextTabs;
  if (canPersistSession()) {
    captureWorkspaceSession(getCurrentWorkspaceId());
    scheduleSessionSave();
  }
}

function handleWorkspaceEditorPaneLayoutUpdate(nextEditorPaneLayout: WorkspaceEditorPaneLayout) {
  workspaceEditorPaneLayout.value = nextEditorPaneLayout;
  if (canPersistSession()) {
    captureWorkspaceSession(getCurrentWorkspaceId());
    scheduleSessionSave();
  }
}

function handleWorkspaceMultiDisplayTabIdsUpdate(nextMultiDisplayTabIds: string[]) {
  workspaceMultiDisplayTabIds.value = nextMultiDisplayTabIds;
  if (canPersistSession()) {
    captureWorkspaceSession(getCurrentWorkspaceId());
    scheduleSessionSave();
  }
}

function handleActiveWorkspaceTabIdUpdate(nextActiveTabId: string | null) {
  activeWorkspaceTabId.value = nextActiveTabId;
  if (canPersistSession()) {
    captureWorkspaceSession(getCurrentWorkspaceId());
    scheduleSessionSave();
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
      worktreeRole: cachedSummary?.worktreeRole ?? null,
      hasPanelActivity: panelIndicators.hasPanelActivity,
      hasPanelAttention: panelIndicators.hasPanelAttention,
      isCurrent: workspaceId === getCurrentWorkspaceId(),
    }];
  });
});
const activeDetectedWorktree = computed(() => detectedWorktrees.value[0] ?? null);
const hasUnreadInfoNote = computed(() => !seenInfoNoteRevisions.value.includes(CURRENT_INFO_NOTE_REVISION));
const isDiffSplitHorizontal = computed(() => diffPlacement.value === 'left' || diffPlacement.value === 'right');
const isDiffFirst = computed(() => diffPlacement.value === 'left' || diffPlacement.value === 'top');
const shellColumns = computed(() => {
  if (sidebarCollapsed.value) {
    return 'minmax(0, 1fr)';
  }

  if (sidebarSide.value === 'right') {
    return showShellDivider.value
      ? 'minmax(0, 1fr) 8px minmax(280px, var(--sidebar-width))'
      : 'minmax(0, 1fr) minmax(280px, var(--sidebar-width))';
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
const shellAreas = computed(() => {
  if (sidebarCollapsed.value) {
    return '"content"';
  }

  if (sidebarSide.value === 'right') {
    return showShellDivider.value
      ? '"content shell-divider sidebar"'
      : '"content sidebar"';
  }

  return showShellDivider.value
    ? '"sidebar shell-divider content"'
    : '"sidebar content"';
});
const shellAreasMobile = computed(() => {
  if (sidebarCollapsed.value) {
    return '"content"';
  }

  return showShellDivider.value
    ? '"sidebar" "shell-divider" "content"'
    : '"sidebar" "content"';
});
const contentColumns = computed(() => {
  if (!showContentDivider.value) {
    return 'minmax(0, 1fr)';
  }

  return isDiffSplitHorizontal.value
    ? 'minmax(0, 1fr) 8px minmax(280px, var(--terminal-width))'
    : 'minmax(0, 1fr)';
});
const contentRows = computed(() => {
  if (!showContentDivider.value) {
    return 'minmax(0, 1fr)';
  }

  return !isDiffSplitHorizontal.value
    ? 'minmax(0, 1fr) 8px minmax(180px, var(--terminal-height))'
    : 'minmax(0, 1fr)';
});
const contentAreas = computed(() => {
  if (!showContentDivider.value) {
    if (!diffCollapsed.value) {
      return '"diff"';
    }

    if (!terminalCollapsed.value) {
      return '"terminal"';
    }

    return '"empty"';
  }

  if (isDiffSplitHorizontal.value) {
    return isDiffFirst.value
      ? '"diff content-divider terminal"'
      : '"terminal content-divider diff"';
  }

  return isDiffFirst.value
    ? '"diff" "content-divider" "terminal"'
    : '"terminal" "content-divider" "diff"';
});
const appStyle = computed(() => ({
  '--sidebar-width': `${sidebarWidth.value}px`,
  '--terminal-height': `${terminalHeight.value}px`,
  '--terminal-width': `${terminalWidth.value}px`,
  '--shell-columns': shellColumns.value,
  '--shell-rows': 'minmax(0, 1fr)',
  '--shell-areas': shellAreas.value,
  '--shell-columns-mobile': '1fr',
  '--shell-rows-mobile': shellRowsMobile.value,
  '--shell-areas-mobile': shellAreasMobile.value,
  '--content-columns': contentColumns.value,
  '--content-rows': contentRows.value,
  '--content-areas': contentAreas.value,
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
    ? selectedCommitDiffPath.value ?? selectedCommit.value?.message ?? 'Commit diff'
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

function resolveWorkspaceDefaultTerminalCwd(
  nextWorkspaceId: string | null | undefined = activeWorkspaceId.value,
  fallbackRepoPath: string | null = repoPath.value,
) {
  const workspaceDescriptor = getWorkspaceDescriptorById(nextWorkspaceId ?? GLOBAL_WORKSPACE_ID);

  if (workspaceDescriptor?.kind === 'project' && workspaceDescriptor.repoPath) {
    return workspaceDescriptor.repoPath;
  }

  return session.value.terminalCwd
    ?? fallbackRepoPath
    ?? (runtimeInfo.platform === 'win32' ? 'C:\\' : '/');
}

const terminalCwd = computed(() => resolveWorkspaceDefaultTerminalCwd());
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
    editorPaneLayout: cloneWorkspaceEditorPaneLayout(workspaceEditorPaneLayout.value),
    multiDisplayTabIds: [...workspaceMultiDisplayTabIds.value],
  });
}

function buildPersistedWorkspaceSessions(): WorkspaceSessionsById {
  const nextWorkspaceSessions = cloneWorkspaceSessions(workspaceSessions.value);
  nextWorkspaceSessions[getCurrentWorkspaceId()] = buildWorkspaceSessionState();
  workspaceSessions.value = cloneWorkspaceSessions(nextWorkspaceSessions);
  return cloneWorkspaceSessions(nextWorkspaceSessions);
}

function applyWorkspaceSession(nextWorkspaceId: string | null) {
  const workspaceSession = workspaceSessions.value[nextWorkspaceId ?? GLOBAL_WORKSPACE_ID];
  const nextWorkspaceSession = workspaceSession
    ? cloneWorkspaceSessionState(workspaceSession)
    : {
        tabs: [],
        activeTabId: null,
        editorPaneLayout: {
          panes: [],
          activePaneId: null,
        },
        multiDisplayTabIds: [],
      };

  workspaceTabs.value = nextWorkspaceSession.tabs;
  activeWorkspaceTabId.value = nextWorkspaceSession.activeTabId;
  workspaceEditorPaneLayout.value = nextWorkspaceSession.editorPaneLayout;
  workspaceMultiDisplayTabIds.value = [...nextWorkspaceSession.multiDisplayTabIds];
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
    fontSize: repoPanelFontSize.value,
    historyOpen: false,
    workspaceDetailExpanded: true,
    workspaceFamilyFocus: false,
    files: {
      expanded: true,
      viewMode: 'list',
      showAll: false,
      collapsedSections: buildDefaultRepoPanelSectionState(),
      expandedDirectories: [],
    },
  };
}

function currentWorkspaceRepoPanelStateValue(): WorkspaceRepoPanelState {
  const nextState = cloneWorkspaceRepoPanelState(
    workspaceRepoPanelStates.value[getCurrentWorkspaceId()]
    ?? buildDefaultWorkspaceRepoPanelState(),
  );

  nextState.fontSize = repoPanelFontSize.value;
  return nextState;
}

const currentWorkspaceRepoPanelState = computed(() => currentWorkspaceRepoPanelStateValue());

function getWorkspaceRepoPanelStateValue(nextWorkspaceId: string | null | undefined): WorkspaceRepoPanelState {
  const nextState = cloneWorkspaceRepoPanelState(
    workspaceRepoPanelStates.value[nextWorkspaceId ?? GLOBAL_WORKSPACE_ID]
    ?? buildDefaultWorkspaceRepoPanelState(),
  );

  nextState.fontSize = repoPanelFontSize.value;
  return nextState;
}

function buildCurrentPanelLayout(): PanelLayout {
  return {
    sidebarWidth: sidebarWidth.value,
    terminalHeight: terminalHeight.value,
    terminalWidth: terminalWidth.value,
    sidebarSide: sidebarSide.value,
    diffPlacement: diffPlacement.value,
    sidebarCollapsed: sidebarCollapsed.value,
    diffCollapsed: diffCollapsed.value,
    terminalCollapsed: terminalCollapsed.value,
  };
}

function applyPanelLayout(nextPanelLayout: PanelLayout) {
  sidebarWidth.value = nextPanelLayout.sidebarWidth;
  terminalHeight.value = nextPanelLayout.terminalHeight;
  terminalWidth.value = nextPanelLayout.terminalWidth;
  sidebarSide.value = nextPanelLayout.sidebarSide;
  diffPlacement.value = nextPanelLayout.diffPlacement;
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
    const comparableRepoPath = normalizeRepoPathForComparison(recentRepo.path);

    if (comparableRepoPath) {
      knownProjectRepoPaths.add(comparableRepoPath);
    }
  });

  Object.values(workspaceDescriptors.value).forEach((workspaceDescriptor) => {
    if (workspaceDescriptor.kind === 'project' && workspaceDescriptor.repoPath) {
      const comparableRepoPath = normalizeRepoPathForComparison(workspaceDescriptor.repoPath);

      if (comparableRepoPath) {
        knownProjectRepoPaths.add(comparableRepoPath);
      }
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
  const currentRepoComparisonPath = normalizeRepoPathForComparison(repoPath.value);
  const dismissedWorktreeComparisonPaths = dismissedWorktreePaths.value
    .map((path) => normalizeRepoPathForComparison(path))
    .filter(Boolean);
  const seenWorktreePaths = new Set<string>();

  return worktrees.filter((worktree) => {
    const comparableWorktreePath = normalizeRepoPathForComparison(worktree.path);

    if (
      !worktree.path
      || !comparableWorktreePath
      || worktree.current
      || comparableWorktreePath === currentRepoComparisonPath
    ) {
      return false;
    }

    if (seenWorktreePaths.has(comparableWorktreePath)) {
      return false;
    }

    if (knownProjectRepoPaths.has(comparableWorktreePath)) {
      return false;
    }

    if (
      !includeDismissed
      && (
        dismissedWorktreeComparisonPaths.includes(comparableWorktreePath)
        || dismissedWorktreePaths.value.some((dismissedPath) => areRepoPathsEquivalent(dismissedPath, worktree.path))
      )
    ) {
      return false;
    }

    seenWorktreePaths.add(comparableWorktreePath);
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
  const resolvedLastRepoPath = resolvePersistedLastRepoPath(
    hasExplicitLastRepoPath ? options.lastRepoPath ?? null : repoPath.value,
  );
  const resolvedActiveWorkspaceId = options.activeWorkspaceId ?? activeWorkspaceId.value;

  return {
    lastRepoPath: resolvedLastRepoPath,
    activeWorkspaceId: resolvedActiveWorkspaceId,
    recentRepos: recentRepos.value,
    workspaceDescriptors: workspaceDescriptors.value,
    workspaceOrder: workspaceOrder.value,
    repoPanelFontSize: repoPanelFontSize.value,
    terminalCwd: resolveWorkspaceDefaultTerminalCwd(resolvedActiveWorkspaceId, resolvedLastRepoPath),
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
    seenInfoNoteRevisions: seenInfoNoteRevisions.value,
    clipboardHistory: getClipboardHistoryEntries(),
    terminalCommandPresets: terminalCommandPresets.value,
    dockerDialogState: cloneDockerDialogState(dockerDialogState.value),
    workspaceSessions: buildPersistedWorkspaceSessions(),
    panelLayout: buildCurrentPanelLayout(),
    panelLayoutsByWorkspace: buildPersistedPanelLayoutsByWorkspace(),
    workspaceRepoPanelStates: buildPersistedWorkspaceRepoPanelStates(),
  };
}

function buildIncrementalSessionSavePayload(
  options: {
    activeWorkspaceId?: string | null;
    lastRepoPath?: string | null;
  } = {},
) {
  const hasExplicitLastRepoPath = Object.prototype.hasOwnProperty.call(options, 'lastRepoPath');
  const resolvedLastRepoPath = resolvePersistedLastRepoPath(
    hasExplicitLastRepoPath ? options.lastRepoPath ?? null : repoPath.value,
  );
  const resolvedActiveWorkspaceId = options.activeWorkspaceId ?? activeWorkspaceId.value ?? GLOBAL_WORKSPACE_ID;
  const currentWorkspaceId = getCurrentWorkspaceId();

  return {
    lastRepoPath: resolvedLastRepoPath,
    activeWorkspaceId: resolvedActiveWorkspaceId,
    terminalCwd: resolveWorkspaceDefaultTerminalCwd(resolvedActiveWorkspaceId, resolvedLastRepoPath),
    workspaceSessions: {
      [currentWorkspaceId]: buildWorkspaceSessionState(),
    },
    panelLayout: buildCurrentPanelLayout(),
    panelLayoutsByWorkspace: {
      [currentWorkspaceId]: buildCurrentPanelLayout(),
    },
    workspaceRepoPanelStates: {
      [currentWorkspaceId]: currentWorkspaceRepoPanelStateValue(),
    },
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

function syncGlobalLayoutPreferences(
  nextSidebarSide: PanelLayout['sidebarSide'],
  nextDiffPlacement: PanelLayout['diffPlacement'],
) {
  panelLayoutsByWorkspace.value = Object.fromEntries(
    Object.entries(buildPersistedPanelLayoutsByWorkspace()).map(([workspaceId, panelLayout]) => [
      workspaceId,
      {
        ...panelLayout,
        sidebarSide: nextSidebarSide,
        diffPlacement: nextDiffPlacement,
      },
    ]),
  );
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

async function restoreCommitHistoryState(
  repoPanelState: WorkspaceRepoPanelState,
  options: { isGitRepository: boolean },
) {
  if (!repoPanelState.historyOpen) {
    return;
  }

  if (!repoPath.value || !options.isGitRepository) {
    isCommitHistoryOpen.value = false;
    await updateCurrentWorkspaceRepoPanelState({
      ...repoPanelState,
      historyOpen: false,
    });
    return;
  }

  await ensureFullStatus();
  await loadLog();
}

async function updateCurrentWorkspaceRepoPanelState(nextRepoPanelState: WorkspaceRepoPanelState) {
  repoPanelFontSize.value = normalizeNoteFontSize(nextRepoPanelState.fontSize);
  const currentWorkspaceId = getCurrentWorkspaceId();
  const nextWorkspaceRepoPanelState = cloneWorkspaceRepoPanelState({
    ...nextRepoPanelState,
    fontSize: repoPanelFontSize.value,
  });
  const currentWorkspaceRepoPanelState = workspaceRepoPanelStates.value[currentWorkspaceId]
    ?? buildDefaultWorkspaceRepoPanelState();
  const focusModeChanged = currentWorkspaceRepoPanelState.workspaceFamilyFocus !== nextWorkspaceRepoPanelState.workspaceFamilyFocus;

  if (focusModeChanged) {
    const nextWorkspaceRepoPanelStates = cloneWorkspaceRepoPanelStates(workspaceRepoPanelStates.value);

    Object.keys(nextWorkspaceRepoPanelStates).forEach((workspaceId) => {
      nextWorkspaceRepoPanelStates[workspaceId] = cloneWorkspaceRepoPanelState({
        ...nextWorkspaceRepoPanelStates[workspaceId],
        workspaceFamilyFocus: nextWorkspaceRepoPanelState.workspaceFamilyFocus,
      });
    });

    nextWorkspaceRepoPanelStates[currentWorkspaceId] = nextWorkspaceRepoPanelState;
    workspaceRepoPanelStates.value = nextWorkspaceRepoPanelStates;
  } else {
    workspaceRepoPanelStates.value = {
      ...workspaceRepoPanelStates.value,
      [currentWorkspaceId]: nextWorkspaceRepoPanelState,
    };
  }

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

function getSelectedTextFromTarget(target: HTMLInputElement | HTMLTextAreaElement) {
  const selectionStart = target.selectionStart ?? 0;
  const selectionEnd = target.selectionEnd ?? 0;

  if (selectionEnd <= selectionStart) {
    return '';
  }

  return target.value.slice(selectionStart, selectionEnd).replace(/\r\n/g, '\n');
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

function insertTextIntoTarget(target: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const selectionStart = target.selectionStart ?? target.value.length;
  const selectionEnd = target.selectionEnd ?? target.value.length;
  const nextValue = `${target.value.slice(0, selectionStart)}${text}${target.value.slice(selectionEnd)}`;
  const nextCursorPosition = selectionStart + text.length;

  updateTextFieldValue(target, nextValue);
  target.focus();

  try {
    target.setSelectionRange(nextCursorPosition, nextCursorPosition);
  } catch {
    // Some input types do not support programmatic selection ranges.
  }
}

async function insertClipboardTextIntoTarget(
  target: HTMLInputElement | HTMLTextAreaElement,
  options: {
    eventText?: string | null;
  } = {},
) {
  const clipboardText = await readSharedClipboardText({
    eventText: options.eventText,
    preferPreviousDistinctOf: getSelectedTextFromTarget(target),
  });

  if (!clipboardText) {
    return;
  }

  insertTextIntoTarget(target, clipboardText);
}

let clipboardHistoryTextTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
const clipboardHistoryDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

const filteredClipboardHistoryItems = computed(() => {
  const normalizedQuery = clipboardHistoryQuery.value.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return clipboardHistoryItems.value;
  }

  return clipboardHistoryItems.value.filter((item) => item.text.toLocaleLowerCase().includes(normalizedQuery));
});

const selectedClipboardHistoryItem = computed(() => (
  filteredClipboardHistoryItems.value[clipboardHistorySelectedIndex.value] ?? null
));

async function refreshClipboardHistoryItems() {
  clipboardHistoryItems.value = await listClipboardHistory();
  clipboardHistorySelectedIndex.value = 0;
}

function captureClipboardHistoryTarget() {
  const activeElement = document.activeElement;
  clipboardHistoryTextTarget = (
    isTextPasteTarget(activeElement)
    && !activeElement.disabled
    && !activeElement.readOnly
  )
    ? activeElement
    : null;

  window.dispatchEvent(new Event(CLIPBOARD_HISTORY_CAPTURE_TARGET_EVENT));
}

function clearClipboardHistoryTarget() {
  clipboardHistoryTextTarget = null;
  window.dispatchEvent(new Event(CLIPBOARD_HISTORY_CLEAR_TARGET_EVENT));
}

function formatClipboardHistoryCapturedAt(capturedAt: string) {
  const parsedDate = new Date(capturedAt);

  if (Number.isNaN(parsedDate.getTime())) {
    return '';
  }

  return clipboardHistoryDateTimeFormatter.format(parsedDate);
}

async function openClipboardHistoryDialog() {
  captureClipboardHistoryTarget();
  clipboardHistoryQuery.value = '';
  await refreshClipboardHistoryItems();
  isClipboardHistoryOpen.value = true;
  await nextTick();
  clipboardHistorySearchInputRef.value?.focus({ preventScroll: true });
}

function closeClipboardHistoryDialog() {
  isClipboardHistoryOpen.value = false;
  clipboardHistoryQuery.value = '';
  clipboardHistorySelectedIndex.value = 0;
  clearClipboardHistoryTarget();
}

async function insertClipboardHistoryItem(text: string) {
  const normalizedText = text.replace(/\r\n/g, '\n');

  if (!normalizedText) {
    closeClipboardHistoryDialog();
    return;
  }

  let handled = false;

  if (
    clipboardHistoryTextTarget
    && document.contains(clipboardHistoryTextTarget)
    && !clipboardHistoryTextTarget.disabled
    && !clipboardHistoryTextTarget.readOnly
  ) {
    insertTextIntoTarget(clipboardHistoryTextTarget, normalizedText);
    handled = true;
  } else {
    const detail = {
      handled: false,
      text: normalizedText,
    };

    window.dispatchEvent(new CustomEvent(CLIPBOARD_HISTORY_INSERT_EVENT, { detail }));
    handled = detail.handled;
  }

  closeClipboardHistoryDialog();

  if (!handled) {
    return;
  }
}

function moveClipboardHistorySelection(direction: -1 | 1) {
  const itemCount = filteredClipboardHistoryItems.value.length;

  if (itemCount < 1) {
    clipboardHistorySelectedIndex.value = 0;
    return;
  }

  clipboardHistorySelectedIndex.value = (
    clipboardHistorySelectedIndex.value + direction + itemCount
  ) % itemCount;
}

function handleClipboardHistoryKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeClipboardHistoryDialog();
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveClipboardHistorySelection(1);
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveClipboardHistorySelection(-1);
    return;
  }

  if (event.key !== 'Enter') {
    return;
  }

  const selectedItem = selectedClipboardHistoryItem.value;

  if (!selectedItem) {
    return;
  }

  event.preventDefault();
  void insertClipboardHistoryItem(selectedItem.text);
}

function handleClipboardHistoryUpdated(event: Event) {
  const customEvent = event as CustomEvent<ClipboardHistoryUpdatedDetail>;
  clipboardHistoryItems.value = cloneClipboardHistoryEntries(customEvent.detail.entries);

  if (sessionReady.value) {
    scheduleSessionSave();
  }
}

function handleWindowFocus() {
  void syncClipboardHistoryFromSystem().catch(() => {
    // Ignore clipboard read failures triggered by the OS or temporary focus transitions.
  });
}

function flushPendingEditorState() {
  window.dispatchEvent(new CustomEvent('bridgegit:flush-editor-state'));
}

function clearPendingSessionSaveTimer() {
  if (!persistTimer) {
    return;
  }

  window.clearTimeout(persistTimer);
  persistTimer = null;
}

function canPersistSession() {
  return sessionReady.value && sessionPersistenceEnabled.value && !isSwitchingWorkspaceContext.value;
}

function persistCurrentSessionSync() {
  if (!canPersistSession()) {
    return session.value;
  }

  flushPendingEditorState();
  clearPendingSessionSaveTimer();
  return saveSessionSync(buildIncrementalSessionSavePayload());
}

async function persistCurrentSession() {
  if (!canPersistSession()) {
    return session.value;
  }

  clearPendingSessionSaveTimer();
  return saveSession(buildIncrementalSessionSavePayload());
}

function handleWindowBeforeUnload() {
  if (!sessionReady.value) {
    return;
  }

  persistCurrentSessionSync();
}

function handleMainCloseRequested() {
  if (sessionReady.value) {
    persistCurrentSessionSync();
  }

  window.bridgegit?.session?.notifyCloseReady();
}

async function handleGlobalEditableContextMenu(event: MouseEvent) {
  const target = event.target;

  if (!isTextPasteTarget(target) || target.disabled || target.readOnly) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  await insertClipboardTextIntoTarget(target);
}

async function handleGlobalEditablePaste(event: ClipboardEvent) {
  const target = event.target;

  if (!isTextPasteTarget(target) || target.disabled || target.readOnly) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  await insertClipboardTextIntoTarget(target, {
    eventText: event.clipboardData?.getData('text/plain') ?? '',
  });
}

function getSidebarResizeBounds() {
  const shellElement = shellRef.value;

  if (!shellElement) {
    return null;
  }

  const bounds = shellElement.getBoundingClientRect();
  return {
    bounds,
    maxSidebarWidth: Math.max(250, bounds.width * 0.46),
  };
}

function clampSidebarWidthValue(nextWidth: number): number {
  const resizeBounds = getSidebarResizeBounds();

  if (!resizeBounds) {
    return Math.round(Math.max(250, nextWidth));
  }

  return Math.round(clamp(nextWidth, 250, resizeBounds.maxSidebarWidth));
}

function getContentResizeBounds() {
  const contentElement = contentRef.value;

  if (!contentElement) {
    return null;
  }

  const bounds = contentElement.getBoundingClientRect();
  return {
    bounds,
    maxSecondaryWidth: Math.max(280, bounds.width * 0.62),
  };
}

function clampSecondaryPaneWidthValue(nextWidth: number): number {
  const resizeBounds = getContentResizeBounds();

  if (!resizeBounds) {
    return Math.round(Math.max(280, nextWidth));
  }

  return Math.round(clamp(nextWidth, 280, resizeBounds.maxSecondaryWidth));
}

function handlePointerMove(event: PointerEvent) {
  if (activeResize.value === 'sidebar') {
    const resizeBounds = getSidebarResizeBounds();

    if (!resizeBounds) {
      return;
    }

    const { bounds } = resizeBounds;
    const rawSidebarWidth = sidebarSide.value === 'right'
      ? bounds.right - event.clientX
      : event.clientX - bounds.left;
    sidebarWidth.value = clampSidebarWidthValue(rawSidebarWidth);
    return;
  }

  const resizeBounds = getContentResizeBounds();

  if (!resizeBounds) {
    return;
  }

  const { bounds, maxSecondaryWidth } = resizeBounds;

  if (!isDiffSplitHorizontal.value) {
    const maxTerminalHeight = Math.max(180, bounds.height - 220);
    terminalHeight.value = Math.round(clamp(bounds.bottom - event.clientY, 180, maxTerminalHeight));
    return;
  }

  terminalWidth.value = Math.round(clamp(bounds.right - event.clientX, 280, maxSecondaryWidth));
}

function stopResize() {
  activeResize.value = null;
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', stopResize);
  window.removeEventListener('pointercancel', stopResize);
}

function scheduleSessionSave() {
  if (!canPersistSession()) {
    return;
  }

  if (persistTimer) {
    window.clearTimeout(persistTimer);
  }

  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void persistCurrentSession();
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
  repoToolbarBusyAction.value = 'refresh';
  repoOperationStatus.value = 'Refreshing repository state…';

  try {
    const currentRepoPath = repoPath.value;
    let currentRepoIsGit = currentRepoIsGitRepository.value;

    if (currentRepoPath) {
      currentRepoIsGit = await isGitRepositoryPath(currentRepoPath, { force: true });

      const currentWorkspaceId = getCurrentWorkspaceId();
      if (currentWorkspaceId) {
        void loadWorkspaceGitSummary(currentWorkspaceId, currentRepoPath);
      }

      if (!currentRepoIsGit) {
        detectedWorktrees.value = [];
        await setRepoPath(currentRepoPath, { loadMode: 'none' });
        return;
      }
    }

    await refreshRepoStatus();
    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
    repoToolbarBusyAction.value = null;
  }
}

async function handlePullRepo() {
  repoToolbarBusyAction.value = 'pull';
  repoOperationStatus.value = 'Pulling current branch…';

  try {
    await pullBranch();
    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
    repoToolbarBusyAction.value = null;
  }
}

async function handlePushRepo() {
  repoToolbarBusyAction.value = 'push';
  repoOperationStatus.value = 'Pushing current branch…';

  try {
    await pushBranch();
    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
    repoToolbarBusyAction.value = null;
  }
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

function cycleDiffPlacement() {
  const order: PanelLayout['diffPlacement'][] = ['top', 'right', 'bottom', 'left'];
  const currentIndex = order.indexOf(diffPlacement.value);
  diffPlacement.value = order[(currentIndex + 1) % order.length] ?? 'top';
  syncGlobalLayoutPreferences(sidebarSide.value, diffPlacement.value);
  scheduleSessionSave();
}

function handleOpenWelcomeNote() {
  isSettingsOpen.value = false;
  workspaceTabs.value = upsertWelcomeNoteTab(workspaceTabs.value, workspaceTabDefaults.value);
  activeWorkspaceTabId.value = WELCOME_NOTE_TAB_ID;

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

  if (seenInfoNoteRevisions.value.includes(CURRENT_INFO_NOTE_REVISION)) {
    return;
  }

  seenInfoNoteRevisions.value = [...seenInfoNoteRevisions.value, CURRENT_INFO_NOTE_REVISION];
}

async function handleSaveSettings(nextSettings: ProjectSettingsFormData) {
  const trimmedTitle = nextSettings.projectTitle.trim();
  const nextProjectTitlesByContext = repoPath.value
    ? {
        ...projectTitlesByContext.value,
        [getWorkspaceContextKey(getCurrentWorkspaceId(), repoPath.value)]: trimmedTitle || getRepoName(repoPath.value),
      }
    : projectTitlesByContext.value;
  const shouldSwapSideWidths = (
    nextSettings.sidebarSide !== sidebarSide.value
    && (nextSettings.diffPlacement === 'left' || nextSettings.diffPlacement === 'right')
  );

  projectTitlesByContext.value = nextProjectTitlesByContext;
  if (shouldSwapSideWidths) {
    const currentSidebarWidth = sidebarWidth.value;
    sidebarWidth.value = clampSidebarWidthValue(terminalWidth.value);
    terminalWidth.value = clampSecondaryPaneWidthValue(currentSidebarWidth);
  }
  sidebarSide.value = nextSettings.sidebarSide;
  diffPlacement.value = nextSettings.diffPlacement;
  syncGlobalLayoutPreferences(nextSettings.sidebarSide, nextSettings.diffPlacement);
  appAppearance.value = normalizeAppAppearance(nextSettings.appAppearance);
  editorTheme.value = normalizeEditorTheme(nextSettings.editorTheme);
  applyAppTheme(appAppearance.value);
  repoPanelFontSize.value = normalizeNoteFontSize(nextSettings.workspacePanelFontSize);
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
    seenInfoNoteRevisions: seenInfoNoteRevisions.value,
    terminalCommandPresets: nextSettings.terminalCommandPresets,
    workspaceSessions: buildPersistedWorkspaceSessions(),
    workspaceDescriptors: workspaceDescriptors.value,
    workspaceOrder: workspaceOrder.value,
    panelLayout: buildCurrentPanelLayout(),
    panelLayoutsByWorkspace: buildPersistedPanelLayoutsByWorkspace(),
    workspaceRepoPanelStates: buildPersistedWorkspaceRepoPanelStates(),
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
  repoPanelFontSize.value = normalizeNoteFontSize(savedSession.repoPanelFontSize);
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
  const nextRepoPath = requestedRepoPath;
  const nextRepoIsGitRepository = await isGitRepositoryPath(requestedRepoPath);
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
      loadMode: nextRepoIsGitRepository ? 'branches' : 'none',
    });
    if (nextRepoIsGitRepository) {
      await detectWorktrees();
    } else {
      detectedWorktrees.value = [];
    }

    if (nextWorkspaceDescriptor?.id && requestedRepoPath) {
      void loadWorkspaceGitSummary(nextWorkspaceDescriptor.id, requestedRepoPath);
    }

    if (nextRepoPath && nextRepoIsGitRepository && shouldLoadDetailedGitStatus(nextRepoPanelStateForActivation)) {
      void ensureFullStatus();
    }

    await restoreCommitHistoryState(nextRepoPanelStateForActivation, {
      isGitRepository: nextRepoIsGitRepository,
    });
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
  const nextRepoIsGitRepository = nextRepoPath ? await isGitRepositoryPath(nextRepoPath) : false;

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
      loadMode: nextRepoIsGitRepository ? 'branches' : 'none',
    });

    await restoreCommitHistoryState(getWorkspaceRepoPanelStateValue(nextActiveWorkspaceId), {
      isGitRepository: nextRepoIsGitRepository,
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
    worktreeRole: null,
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

async function handleMergeWorkspaceWorktree(workspaceId: string) {
  const workspaceDescriptor = getWorkspaceDescriptorById(workspaceId);
  const targetRepoPath = workspaceDescriptor?.kind === 'project' ? workspaceDescriptor.repoPath : null;

  if (!targetRepoPath) {
    return;
  }

  repoOperationStatus.value = 'Merging into primary branch…';

  try {
    const result = await mergeWorktreeIntoPrimaryBranch(targetRepoPath);

    if (!result) {
      return;
    }

    const primaryWorkspace = ensureProjectWorkspace(result.primaryRepoPath);
    gitRepositoryValidityByPath.value = {
      ...gitRepositoryValidityByPath.value,
      [result.primaryRepoPath]: true,
    };
    void loadWorkspaceGitSummary(workspaceId, targetRepoPath);
    void loadWorkspaceGitSummary(primaryWorkspace.id, result.primaryRepoPath);
    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
  }
}

async function handleRemoveWorkspaceWorktree(workspaceId: string) {
  const workspaceDescriptor = getWorkspaceDescriptorById(workspaceId);
  const targetRepoPath = workspaceDescriptor?.kind === 'project' ? workspaceDescriptor.repoPath : null;

  if (!targetRepoPath || !window.bridgegit?.git) {
    return;
  }

  const removingCurrentWorkspace = workspaceId === getCurrentWorkspaceId();

  if (removingCurrentWorkspace) {
    const worktrees = await window.bridgegit.git.worktrees(targetRepoPath);
    const primaryRepoPath = worktrees.find((worktree) => !worktree.bare)?.path ?? null;

    if (primaryRepoPath && !areRepoPathsEquivalent(primaryRepoPath, targetRepoPath)) {
      const primaryWorkspace = ensureProjectWorkspace(primaryRepoPath);
      await activateWorkspace(primaryWorkspace.id);
    }
  }

  repoOperationStatus.value = 'Removing worktree…';

  try {
    const result = await removeWorktree(targetRepoPath);

    if (!result) {
      return;
    }

    await handleRemoveWorkspace(workspaceId);

    const primaryWorkspace = ensureProjectWorkspace(result.primaryRepoPath);
    gitRepositoryValidityByPath.value = {
      ...gitRepositoryValidityByPath.value,
      [result.primaryRepoPath]: true,
    };
    void loadWorkspaceGitSummary(primaryWorkspace.id, result.primaryRepoPath);
    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
  }
}

async function handleRemoveWorkspaceWorktreeAndDeleteBranch(workspaceId: string) {
  const workspaceDescriptor = getWorkspaceDescriptorById(workspaceId);
  const targetRepoPath = workspaceDescriptor?.kind === 'project' ? workspaceDescriptor.repoPath : null;

  if (!targetRepoPath || !window.bridgegit?.git) {
    return;
  }

  const removingCurrentWorkspace = workspaceId === getCurrentWorkspaceId();

  if (removingCurrentWorkspace) {
    const worktrees = await window.bridgegit.git.worktrees(targetRepoPath);
    const primaryRepoPath = worktrees.find((worktree) => !worktree.bare)?.path ?? null;

    if (primaryRepoPath && !areRepoPathsEquivalent(primaryRepoPath, targetRepoPath)) {
      const primaryWorkspace = ensureProjectWorkspace(primaryRepoPath);
      await activateWorkspace(primaryWorkspace.id);
    }
  }

  repoOperationStatus.value = 'Removing worktree and branch…';

  try {
    const result = await removeWorktreeAndDeleteBranch(targetRepoPath);

    if (!result) {
      return;
    }

    await handleRemoveWorkspace(workspaceId);

    const primaryWorkspace = ensureProjectWorkspace(result.primaryRepoPath);
    gitRepositoryValidityByPath.value = {
      ...gitRepositoryValidityByPath.value,
      [result.primaryRepoPath]: true,
    };
    void loadWorkspaceGitSummary(primaryWorkspace.id, result.primaryRepoPath);
    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
  }
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

function openDockerDialog() {
  isDockerDialogOpen.value = true;
}

function closeDockerDialog() {
  isDockerDialogOpen.value = false;
}

function updateDockerDialogExpandedGroupIds(groupIds: string[]) {
  dockerDialogState.value = {
    ...dockerDialogState.value,
    expandedGroupIds: groupIds,
  };
}

function updateDockerDialogActiveView(activeView: 'containers' | 'images') {
  dockerDialogState.value = {
    ...dockerDialogState.value,
    activeView,
  };
}

async function handleOpenDockerLogs(containerId: string, containerName: string) {
  if (terminalCollapsed.value) {
    terminalCollapsed.value = false;
    scheduleSessionSave();
  }

  await terminalPanelRef.value?.openDockerLogs(containerId, containerName);
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

async function handlePreviewCommitFileDiff(payload: { commit: GitLogEntry; filePath: string }) {
  await previewHistoryCommitDiff(payload.commit, payload.filePath);
}

async function handleOpenHistoryPreviewDiff(payload: { commit: GitLogEntry; filePath: string }) {
  isCommitHistoryOpen.value = false;
  void updateCurrentWorkspaceRepoPanelState({
    ...currentWorkspaceRepoPanelStateValue(),
    historyOpen: false,
  });

  if (diffCollapsed.value) {
    diffCollapsed.value = false;
    scheduleSessionSave();
  }

  await openCommitDiff(payload.commit, payload.filePath);
}

async function handleSelectHistoryCommit(commitHash: string) {
  await selectHistoryCommit(commitHash);
}

async function handleSelectHistoryScope(scope: GitLogScope) {
  await loadLog({ scope });
}

async function handleHistorySearchQueryChange(query: string) {
  await loadLog({ query });
}

async function handleLoadMoreHistoryCommits() {
  await loadMoreLog();
}

async function handleLoadAllHistoryCommits() {
  await loadAllLog();
}

async function handleUpdateHistoryCommitMessage(payload: { commitHash: string; message: string }) {
  await updateCommitMessage(payload.commitHash, payload.message);
}

function handleGlobalKeydown(event: KeyboardEvent) {
  const isReplaceInFilesShortcut = matchesShortcut(event, SHORTCUTS.workspaceReplaceInFiles);
  const isClipboardHistoryShortcut = matchesShortcut(event, SHORTCUTS.clipboardHistoryOpen);

  if (isReplaceInFilesShortcut || isClipboardHistoryShortcut) {
    event.preventDefault();
  }

  if (event.key === 'Escape') {
    if (isClipboardHistoryOpen.value) {
      event.preventDefault();
      closeClipboardHistoryDialog();
      return;
    }

    if (isCommitHistoryOpen.value) {
      event.preventDefault();
      isCommitHistoryOpen.value = false;
      void updateCurrentWorkspaceRepoPanelState({
        ...currentWorkspaceRepoPanelStateValue(),
        historyOpen: false,
      });
      return;
    }

    if (isDockerDialogOpen.value) {
      event.preventDefault();
      closeDockerDialog();
      return;
    }

    if (isSettingsOpen.value) {
      event.preventDefault();
      isSettingsOpen.value = false;
      return;
    }
  }

  if (isDockerDialogOpen.value) {
    return;
  }

  if (isClipboardHistoryOpen.value) {
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.historyOpen) && repoPath.value && !isCommitHistoryOpen.value) {
    event.preventDefault();
    void handleOpenCommitHistory();
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.historySearch) && repoPath.value && isCommitHistoryOpen.value) {
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
    matchesShortcut(event, SHORTCUTS.settingsOpen)
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();
    isSettingsOpen.value = true;
    return;
  }

  if (
    matchesShortcut(event, SHORTCUTS.dockerDialogOpen)
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();
    openDockerDialog();
    return;
  }

  if (
    matchesShortcut(event, SHORTCUTS.workspaceAllTabs)
    && sessionReady.value
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();
    terminalPanelRef.value?.openAllTabsDialog();
    return;
  }

  if (
    matchesShortcut(event, SHORTCUTS.workspaceQuickOpen)
    && sessionReady.value
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();
    terminalPanelRef.value?.openQuickOpenDialog();
    return;
  }

  if (
    matchesShortcut(event, SHORTCUTS.workspaceFindInFiles)
    && sessionReady.value
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();

    if (terminalCollapsed.value) {
      terminalCollapsed.value = false;
      scheduleSessionSave();
    }

    terminalPanelRef.value?.openFindInFilesDialog();
    return;
  }

  if (
    isReplaceInFilesShortcut
    && sessionReady.value
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();

    if (terminalCollapsed.value) {
      terminalCollapsed.value = false;
      scheduleSessionSave();
    }

    terminalPanelRef.value?.openFindInFilesDialogInMode('replace');
    return;
  }

  if (
    isClipboardHistoryShortcut
    && sessionReady.value
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    event.preventDefault();
    void openClipboardHistoryDialog();
    return;
  }

  if (
    matchesShortcut(event, SHORTCUTS.workspaceRevealInAllFiles)
    && sessionReady.value
    && !isSettingsOpen.value
    && !isCommitHistoryOpen.value
  ) {
    const handled = terminalPanelRef.value?.revealActiveFileInAllFiles();

    if (handled) {
      event.preventDefault();
      return;
    }
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

  if (sessionReady.value) {
    const editorPaneSplitShortcuts: Array<{ shortcut: typeof SHORTCUTS.editorPaneSplitLeft; direction: 'left' | 'right' | 'up' | 'down' }> = [
      { shortcut: SHORTCUTS.editorPaneSplitLeft, direction: 'left' },
      { shortcut: SHORTCUTS.editorPaneSplitRight, direction: 'right' },
      { shortcut: SHORTCUTS.editorPaneSplitUp, direction: 'up' },
      { shortcut: SHORTCUTS.editorPaneSplitDown, direction: 'down' },
    ];

    for (const entry of editorPaneSplitShortcuts) {
      if (!matchesShortcut(event, entry.shortcut)) {
        continue;
      }

      const handled = terminalPanelRef.value?.splitEditorPane(entry.direction);

      if (handled) {
        event.preventDefault();
        return;
      }
    }

    const editorPaneCloseShortcuts: Array<{ shortcut: typeof SHORTCUTS.editorPaneCloseLeft; direction: 'left' | 'right' | 'up' | 'down' }> = [
      { shortcut: SHORTCUTS.editorPaneCloseLeft, direction: 'left' },
      { shortcut: SHORTCUTS.editorPaneCloseRight, direction: 'right' },
      { shortcut: SHORTCUTS.editorPaneCloseUp, direction: 'up' },
      { shortcut: SHORTCUTS.editorPaneCloseDown, direction: 'down' },
    ];

    for (const entry of editorPaneCloseShortcuts) {
      if (!matchesShortcut(event, entry.shortcut)) {
        continue;
      }

      const handled = terminalPanelRef.value?.closeEditorPane(entry.direction);

      if (handled) {
        event.preventDefault();
        return;
      }
    }
  }

  if (matchesShortcut(event, SHORTCUTS.terminalCloseTab) && sessionReady.value) {
    event.preventDefault();
    terminalPanelRef.value?.closeActiveTab();
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

function normalizeComparableFilePath(pathValue: string) {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '');
}

function resolveRelativeRepoFilePath(filePath: string) {
  if (!repoPath.value) {
    return null;
  }

  const normalizedRepoRoot = normalizeComparableFilePath(repoPath.value);
  const normalizedFilePath = normalizeComparableFilePath(filePath);
  const repoPrefix = `${normalizedRepoRoot}/`;

  if (!normalizedFilePath.startsWith(repoPrefix)) {
    return null;
  }

  return normalizedFilePath.slice(repoPrefix.length);
}

function requestRevealInAllFiles(filePath: string) {
  const relativePath = resolveRelativeRepoFilePath(filePath);

  if (!relativePath) {
    return false;
  }

  revealInAllFilesPath.value = relativePath;
  revealInAllFilesToken.value += 1;

  if (sidebarCollapsed.value) {
    sidebarCollapsed.value = false;
    scheduleSessionSave();
  }

  return true;
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

function handleRevealInAllFiles(filePath: string) {
  requestRevealInAllFiles(filePath);
}

watch(
  () => repoPath.value,
  () => {
    revealInAllFilesPath.value = null;
  },
);

async function handleOpenCurrentDiffInWorkspace(targetLine?: number) {
  const notesApi = window.bridgegit?.notes;

  if (!selectedPath.value || !repoPath.value || !sessionReady.value || !notesApi) {
    return;
  }

  if (terminalCollapsed.value) {
    terminalCollapsed.value = false;
    scheduleSessionSave();
  }

  const filePath = resolveRepoFilePath(repoPath.value, selectedPath.value);
  const inspectedFile = await notesApi.inspectFile(filePath);

  if (!inspectedFile) {
    showProjectTitleSavedToast(`File not found in current workspace: ${selectedPath.value}`);
    return;
  }

  if (targetLine) {
    await terminalPanelRef.value?.openNavigationTarget({
      filePath: inspectedFile.path,
      line: targetLine,
    });
    return;
  }

  await terminalPanelRef.value?.openWorkspaceFilePath(inspectedFile.path);
}

async function openDiffTargetInWorkspace(target: { filePath: string; line?: number }) {
  const notesApi = window.bridgegit?.notes;

  if (!repoPath.value || !sessionReady.value || !notesApi) {
    return;
  }

  if (terminalCollapsed.value) {
    terminalCollapsed.value = false;
    scheduleSessionSave();
  }

  const isAbsolutePath = /^[A-Za-z]:[\\/]/.test(target.filePath) || target.filePath.startsWith('/');
  const filePath = isAbsolutePath
    ? target.filePath
    : resolveRepoFilePath(repoPath.value, target.filePath);
  const inspectedFile = await notesApi.inspectFile(filePath);

  if (!inspectedFile) {
    showProjectTitleSavedToast(`File not found in current workspace: ${target.filePath}`);
    return;
  }

  if (target.line) {
    await terminalPanelRef.value?.openNavigationTarget({
      filePath: inspectedFile.path,
      line: target.line,
    });
    return;
  }

  await terminalPanelRef.value?.openWorkspaceFilePath(inspectedFile.path);
}

async function handleOpenDiffTargetInWorkspace(target: { filePath: string; line?: number }) {
  await openDiffTargetInWorkspace(target);
}

async function handleOpenHistoryPreviewTarget(target: { filePath: string; line?: number }) {
  isCommitHistoryOpen.value = false;
  void updateCurrentWorkspaceRepoPanelState({
    ...currentWorkspaceRepoPanelStateValue(),
    historyOpen: false,
  });

  await openDiffTargetInWorkspace(target);
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

async function handleCreateBranch(
  branchName: string,
  placement: 'current-repo' | 'new-repo' = 'current-repo',
) {
  if (!branchName.trim()) {
    return;
  }

  const result = await createBranch(branchName, { placement });

  if (!result?.repoPath) {
    return;
  }

  if (placement === 'current-repo' || areRepoPathsEquivalent(result.repoPath, repoPath.value)) {
    return;
  }

  dismissedWorktreePaths.value = dismissedWorktreePaths.value.filter((path) => (
    !areRepoPathsEquivalent(path, result.repoPath)
  ));
  gitRepositoryValidityByPath.value = {
    ...gitRepositoryValidityByPath.value,
    [result.repoPath]: true,
  };
  await handleSelectRepo(result.repoPath);
}

async function handleInitRepository() {
  if (!repoPath.value) {
    return;
  }

  repoOperationStatus.value = 'Initializing Git repository…';

  try {
    const initialized = await initCurrentRepository();

    if (!initialized) {
      return;
    }

    gitRepositoryValidityByPath.value = {
      ...gitRepositoryValidityByPath.value,
      [repoPath.value]: true,
    };

    const currentWorkspaceId = getCurrentWorkspaceId();

    if (currentWorkspaceId) {
      void loadWorkspaceGitSummary(currentWorkspaceId, repoPath.value);
    }

    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
  }
}

async function handleDeleteBranch(branchName: string) {
  if (!branchName.trim()) {
    return;
  }

  repoOperationStatus.value = `Deleting branch "${branchName}"…`;

  try {
    await deleteBranch(branchName);
    await detectWorktrees({ includeDismissed: true });
  } finally {
    repoOperationStatus.value = null;
  }
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

watch([sidebarWidth, terminalHeight, terminalWidth, sidebarSide, diffPlacement, sidebarCollapsed, diffCollapsed, terminalCollapsed], () => {
  scheduleSessionSave();
});

watch(repoPath, () => {
  if (!repoPath.value) {
    detectedWorktrees.value = [];
  }

  scheduleSessionSave();
});

watch([recentRepos, workspaceOrder, appAppearance, editorTheme, workspaceIndicatorVisibility, workspaceTabDefaults, soundNotificationsEnabled, terminalCommandPresets, dockerDialogState, workspaceTabs, workspaceEditorPaneLayout, workspaceMultiDisplayTabIds, activeWorkspaceTabId, workspaceRepoPanelStates], () => {
  if (canPersistSession()) {
    captureWorkspaceSession(getCurrentWorkspaceId());
  }

  scheduleSessionSave();
}, { deep: true });

watch([workspaceTabs, workspaceSessions, activeWorkspaceId], () => {
  if (!sessionReady.value) {
    return;
  }

  syncBackgroundShellSubscriptions();
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
        worktreeRole: workspaceGitSummaryById.value[getCurrentWorkspaceId()]?.worktreeRole ?? null,
      },
    };
  },
);

watch(seenInfoNoteRevisions, () => {
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

watch(filteredClipboardHistoryItems, (items) => {
  if (items.length < 1) {
    clipboardHistorySelectedIndex.value = 0;
    return;
  }

  if (clipboardHistorySelectedIndex.value >= items.length) {
    clipboardHistorySelectedIndex.value = items.length - 1;
  }
});

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, true);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('paste', handleGlobalEditablePaste, true);
  window.addEventListener('contextmenu', handleGlobalEditableContextMenu, true);
  window.addEventListener(CLIPBOARD_HISTORY_UPDATED_EVENT, handleClipboardHistoryUpdated as EventListener);
  window.addEventListener('beforeunload', handleWindowBeforeUnload);
  removeCloseRequestedListener = window.bridgegit?.session?.onCloseRequested(handleMainCloseRequested) ?? null;
  applyAppTheme(appAppearance.value);

  let initialSession = await loadSession();
  setClipboardHistoryEntries(initialSession.clipboardHistory, { emit: false });
  clipboardHistoryItems.value = cloneClipboardHistoryEntries(getClipboardHistoryEntries());

  if (!hasWorkspaceTabs(initialSession.workspaceSessions)) {
    const onboardingCwd = initialSession.lastRepoPath
      ?? initialSession.terminalCwd
      ?? (runtimeInfo.platform === 'win32' ? 'C:\\' : '/');

    initialSession = await saveSession({
      terminalCwd: initialSession.terminalCwd ?? onboardingCwd,
      seenInfoNoteRevisions: initialSession.seenInfoNoteRevisions,
      workspaceSessions: buildOnboardingWorkspaceSessions(
        initialSession.lastRepoPath,
        onboardingCwd,
        initialSession.workspaceTabDefaults,
      ),
    });
  }

  initialSession = {
    ...initialSession,
    workspaceSessions: refreshWelcomeNoteTabs(
      initialSession.workspaceSessions,
      initialSession.workspaceTabDefaults,
    ),
  };

  soundNotificationsEnabled.value = initialSession.soundNotificationsEnabled;
  projectTitlesByContext.value = cloneProjectTitlesByContext(initialSession.projectTitlesByContext);
  appAppearance.value = initialSession.appAppearance;
  editorTheme.value = initialSession.editorTheme;
  applyAppTheme(initialSession.appAppearance);
  workspaceIndicatorVisibility.value = cloneWorkspaceIndicatorVisibilitySettings(initialSession.workspaceIndicatorVisibility);
  workspaceTabDefaults.value = cloneWorkspaceTabDefaults(initialSession.workspaceTabDefaults);
  worktreeDetectionIntervalMs.value = initialSession.worktreeDetectionIntervalMs;
  dismissedWorktreePaths.value = cloneDismissedWorktreePaths(initialSession.dismissedWorktreePaths);
  repoPanelFontSize.value = normalizeNoteFontSize(initialSession.repoPanelFontSize);
  recentRepos.value = initialSession.recentRepos;
  activeWorkspaceId.value = initialSession.activeWorkspaceId;
  workspaceDescriptors.value = cloneWorkspaceDescriptors(initialSession.workspaceDescriptors);
  workspaceOrder.value = [...initialSession.workspaceOrder];
  panelLayoutsByWorkspace.value = clonePanelLayoutsByWorkspace(initialSession.panelLayoutsByWorkspace);
  workspaceRepoPanelStates.value = cloneWorkspaceRepoPanelStates(initialSession.workspaceRepoPanelStates);
  terminalCommandPresets.value = initialSession.terminalCommandPresets;
  dockerDialogState.value = cloneDockerDialogState(initialSession.dockerDialogState);
  workspaceSessions.value = cloneWorkspaceSessions(initialSession.workspaceSessions);
  seenInfoNoteRevisions.value = cloneSeenInfoNoteRevisions(initialSession.seenInfoNoteRevisions);
  clipboardHistoryItems.value = cloneClipboardHistoryEntries(getClipboardHistoryEntries());
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
  const initialRepoPath = requestedInitialRepoPath;
  const initialRepoIsGitRepository = await isGitRepositoryPath(requestedInitialRepoPath);
  const initialRepoPanelState = getWorkspaceRepoPanelStateValue(initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID);

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
      loadMode: initialRepoIsGitRepository ? 'branches' : 'none',
    });
    if (initialRepoIsGitRepository) {
      await detectWorktrees();
    } else {
      detectedWorktrees.value = [];
    }

    if (initialWorkspaceDescriptor?.id) {
      void loadWorkspaceGitSummary(initialWorkspaceDescriptor.id, initialRepoPath);
    }

    if (initialRepoIsGitRepository && shouldLoadDetailedGitStatus(initialRepoPanelState)) {
      void ensureFullStatus();
    }

    await restoreCommitHistoryState(initialRepoPanelState, {
      isGitRepository: initialRepoIsGitRepository,
    });
  } else {
    await setRepoPath(null);
    await restoreCommitHistoryState(initialRepoPanelState, {
      isGitRepository: false,
    });
  }

  markInfoNoteAsSeenWhenActive();

  sessionReady.value = true;
  syncBackgroundShellSubscriptions();
  startInactiveWorkspaceGitSummaryPolling();
  scheduleInitialInactiveWorkspaceGitSummaryLoad();
  startWorktreeDetectionPolling();
  await nextTick();
  flushPendingEditorState();
  await nextTick();
  captureWorkspaceSession(initialSession.activeWorkspaceId ?? GLOBAL_WORKSPACE_ID);
  sessionPersistenceEnabled.value = true;
});

onBeforeUnmount(() => {
  stopResize();
  dispose();
  clearClipboardHistoryTarget();
  window.removeEventListener('keydown', handleGlobalKeydown, true);
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener('paste', handleGlobalEditablePaste, true);
  window.removeEventListener('contextmenu', handleGlobalEditableContextMenu, true);
  window.removeEventListener(CLIPBOARD_HISTORY_UPDATED_EVENT, handleClipboardHistoryUpdated as EventListener);
  window.removeEventListener('beforeunload', handleWindowBeforeUnload);
  removeCloseRequestedListener?.();
  removeCloseRequestedListener = null;

  clearPendingSessionSaveTimer();

  if (projectTitleSaveToastTimer) {
    window.clearTimeout(projectTitleSaveToastTimer);
  }

  if (inactiveWorkspaceGitSummaryTimer) {
    window.clearInterval(inactiveWorkspaceGitSummaryTimer);
  }

  if (initialInactiveWorkspaceGitSummaryTimer) {
    window.clearTimeout(initialInactiveWorkspaceGitSummaryTimer);
  }

  if (worktreeDetectionTimer) {
    window.clearInterval(worktreeDetectionTimer);
  }

  backgroundShellSubscriptions.forEach((subscription, runtimeKey) => {
    subscription.dispose();
    clearBackgroundShellActivityTimer(runtimeKey);
  });
  backgroundShellSubscriptions.clear();
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
          :is-git-repository="currentRepoIsGitRepository"
          :log="log"
          :is-history-open="isCommitHistoryOpen"
          :selected-path="selectedPath"
          :revealed-path="revealInAllFilesPath"
          :reveal-path-token="revealInAllFilesToken"
          :is-loading="isLoading"
          :toolbar-busy-action="repoToolbarBusyAction"
          :error="error"
          :error-detail="errorDetail"
          :operation-status="repoOperationStatus"
          :commit-message="commitMessage"
          :has-unread-info="hasUnreadInfoNote"
          :can-collapse="canCollapseSidebar"
          :collapse-shortcut-display="SHORTCUTS.panelRepoToggle.display"
          @open-info="handleOpenWelcomeNote"
          @open-settings="isSettingsOpen = true"
          @open-docker="openDockerDialog"
          @open-repo="handleOpenRepo"
          @select-repo="handleSelectRepo"
          @select-workspace="handleSelectWorkspace"
          @rename-workspace="handleRenameWorkspace"
          @remove-workspace="handleRemoveWorkspace"
          @change-workspace-repo="handleChangeWorkspaceRepo"
          @merge-worktree="handleMergeWorkspaceWorktree"
          @remove-worktree="handleRemoveWorkspaceWorktree"
          @remove-worktree-and-delete-branch="handleRemoveWorkspaceWorktreeAndDeleteBranch"
          @reorder-workspaces="handleReorderWorkspaces"
          @update:repo-panel-state="updateCurrentWorkspaceRepoPanelState($event)"
          @pull="handlePullRepo"
          @push="handlePushRepo"
          @refresh="handleRefreshRepo"
          @toggle-history="handleToggleCommitHistory"
          @toggle-collapse="togglePanel('sidebar')"
          @select-file="handleSelectFile"
          @open-workspace-file="handleOpenWorkspaceFile"
          @stage="stageFiles"
          @unstage="unstageFiles"
          @discard-file="handleDiscardFile"
          @checkout="handleCheckout"
          @create-branch="handleCreateBranch"
          @init-git="handleInitRepository"
          @delete-branch="handleDeleteBranch"
          @add-detected-worktree="handleAddDetectedWorktree"
          @dismiss-detected-worktree="handleDismissDetectedWorktree"
          @update:commit-message="commitMessage = $event"
          @commit="handleCommit"
        />
      </aside>

      <button
        v-if="showShellDivider"
        class="app__divider app__divider--shell app__divider--vertical"
        type="button"
        aria-label="Resize git sidebar"
        @pointerdown="startResize('sidebar', $event)"
      />

      <section
        ref="contentRef"
        class="app__content"
      >
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
            @open-diff-target="handleOpenDiffTargetInWorkspace"
            @discard-hunk="handleDiscardHunk"
            @toggle-collapse="togglePanel('diff')"
          />
        </div>

        <button
          v-if="showContentDivider"
          class="app__divider app__divider--content"
          :class="isDiffSplitHorizontal ? 'app__divider--content-vertical' : 'app__divider--horizontal'"
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
            :editor-pane-layout="workspaceEditorPaneLayout"
            :multi-display-tab-ids="workspaceMultiDisplayTabIds"
            :active-tab-id="activeWorkspaceTabId"
            :recent-activity="workspaceRecentActivityByWorkspaceId[getCurrentWorkspaceId()] ?? {}"
            :attention="workspaceAttentionByWorkspaceId[getCurrentWorkspaceId()] ?? {}"
            :can-collapse="canCollapseTerminal"
            :collapse-shortcut-display="SHORTCUTS.panelTerminalToggle.display"
            :collapsed="terminalCollapsed"
            @update:tabs="handleWorkspaceTabsUpdate"
            @update:editor-pane-layout="handleWorkspaceEditorPaneLayoutUpdate"
            @update:multi-display-tab-ids="handleWorkspaceMultiDisplayTabIdsUpdate"
            @update:active-tab-id="handleActiveWorkspaceTabIdUpdate"
            @update:recent-activity="handleWorkspaceRecentActivityUpdate($event.workspaceId, $event.recentActivity)"
          @update:attention="handleWorkspaceAttentionUpdate($event.workspaceId, $event.attention)"
          @reveal-in-all-files="handleRevealInAllFiles"
          @open-docker="openDockerDialog"
          @toggle-collapse="togglePanel('terminal')"
        />
      </div>

        <div v-if="!hasVisibleRightPanels" class="app__surface app__surface--empty">
          <div class="app__empty-state">
            <span class="app__empty-eyebrow">Panels</span>
            <h2 class="app__empty-title">Diff and tabs are collapsed</h2>
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
      :diff-placement="diffPlacement"
      :collapsed-panels="collapsedPanels"
      :terminal-tab-indicators="terminalTabIndicators"
      :repo-dock-summary="repoDockSummary"
      @cycle-diff-placement="cycleDiffPlacement"
      @toggle-panel="togglePanel"
    />

    <ProjectSettingsDialog
      v-model="isSettingsOpen"
      :project-title="currentProjectTitle"
      :app-version="CURRENT_APP_VERSION"
      :info-note-revision="CURRENT_INFO_NOTE_REVISION"
      :has-unread-info-note="hasUnreadInfoNote"
      :sidebar-side="sidebarSide"
      :diff-placement="diffPlacement"
      :app-appearance="appAppearance"
      :editor-theme="editorTheme"
      :workspace-panel-font-size="repoPanelFontSize"
      :workspace-indicator-visibility="workspaceIndicatorVisibility"
      :workspace-tab-defaults="workspaceTabDefaults"
      :worktree-detection-interval-ms="worktreeDetectionIntervalMs"
      :sound-notifications-enabled="soundNotificationsEnabled"
      :terminal-command-presets="terminalCommandPresets"
      @open-info="handleOpenWelcomeNote"
      @save="handleSaveSettings"
    />

    <DockerDialog
      v-model="isDockerDialogOpen"
      :active-view="dockerDialogState.activeView"
      :expanded-group-ids="dockerDialogState.expandedGroupIds"
      :project-root="repoPath"
      @update:active-view="updateDockerDialogActiveView"
      @update:expanded-group-ids="updateDockerDialogExpandedGroupIds"
      @open-logs="handleOpenDockerLogs"
    />

    <CommitHistoryDialog
      v-model="isCommitHistoryOpen"
      :sidebar-side="sidebarSide"
      :sidebar-width="sidebarWidth"
      :workspace-panel-font-size="repoPanelFontSize"
      :branches="branches"
      :commits="log?.items ?? []"
      :selected-commit-hash="selectedHistoryCommitHash"
      :history-scope="historyScope"
      :history-query="historyQuery"
      :current-branch="branch"
      :repo-path="repoPath"
      :is-loading="isLoadingLog"
      :available-commit-count="log?.availableTotal ?? null"
      :has-more-commits="hasMoreHistoryCommits"
      :is-loading-more-commits="isLoadingMoreHistoryCommits"
      :pagination-mode="historyPaginationMode"
      :commit-detail="commitDetail"
      :is-updating-commit-message="isUpdatingCommitMessage"
      :is-loading-commit-detail="isLoadingCommitDetail"
      :commit-detail-error="commitDetailError"
      :preview-commit-hash="historyPreviewCommitHash"
      :preview-diff-path="historyPreviewDiffPath"
      :preview-diff="historyPreviewDiff"
      :is-loading-preview-diff="isLoadingHistoryPreviewDiff"
      :preview-diff-error="historyPreviewDiffError"
      :focus-search-token="commitHistorySearchToken"
      @select-commit="handleSelectHistoryCommit"
      @select-scope="handleSelectHistoryScope"
      @search-query-change="handleHistorySearchQueryChange"
      @load-more-commits="handleLoadMoreHistoryCommits"
      @load-all-commits="handleLoadAllHistoryCommits"
      @update-commit-message="handleUpdateHistoryCommitMessage"
      @open-diff="handleOpenCommitDiff"
      @preview-diff-file="handlePreviewCommitFileDiff"
      @open-diff-file="handleOpenHistoryPreviewDiff"
      @open-preview-target="handleOpenHistoryPreviewTarget"
      @close-preview-diff="clearHistoryPreviewDiffState"
    />

    <div
      v-if="isClipboardHistoryOpen"
      class="app__dialog-backdrop"
      role="presentation"
      @click.self="closeClipboardHistoryDialog"
    >
      <section
        class="app__clipboard-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clipboard-history-title"
      >
        <header class="app__clipboard-history-header">
          <div class="app__clipboard-history-heading">
            <p class="app__clipboard-history-eyebrow">Clipboard</p>
            <h2 id="clipboard-history-title" class="app__clipboard-history-title">Clipboard History</h2>
            <p class="app__clipboard-history-meta">Recent unique entries from copy and selection.</p>
          </div>

          <button
            class="app__clipboard-history-close"
            type="button"
            aria-label="Close clipboard history"
            @click="closeClipboardHistoryDialog"
          >
            ×
          </button>
        </header>

        <div class="app__clipboard-history-toolbar">
          <label class="app__clipboard-history-search">
            <span class="app__clipboard-history-search-label">
              Search
              <span class="app__clipboard-history-shortcut">{{ SHORTCUTS.clipboardHistoryOpen.display }}</span>
            </span>
            <input
              ref="clipboardHistorySearchInputRef"
              v-model="clipboardHistoryQuery"
              class="app__clipboard-history-search-input"
              type="search"
              placeholder="Filter clipboard history"
              @keydown="handleClipboardHistoryKeydown"
            >
          </label>
        </div>

        <div class="app__clipboard-history-body">
          <ul v-if="filteredClipboardHistoryItems.length" class="app__clipboard-history-list">
            <li
              v-for="(item, index) in filteredClipboardHistoryItems"
              :key="`${index}-${item.text.slice(0, 32)}-${item.capturedAt}`"
              class="app__clipboard-history-item"
              :class="{ 'app__clipboard-history-item--selected': index === clipboardHistorySelectedIndex }"
            >
              <button
                class="app__clipboard-history-item-button"
                type="button"
                @mouseenter="clipboardHistorySelectedIndex = index"
                @click="insertClipboardHistoryItem(item.text)"
              >
                <span class="app__clipboard-history-item-header">
                  <span class="app__clipboard-history-item-labels">
                    <span class="app__clipboard-history-item-index">#{{ index + 1 }}</span>
                    <span v-if="index === 0" class="app__clipboard-history-item-badge">latest</span>
                  </span>
                  <span class="app__clipboard-history-item-time">{{ formatClipboardHistoryCapturedAt(item.capturedAt) }}</span>
                </span>
                <span class="app__clipboard-history-item-copy">{{ item.text }}</span>
              </button>
            </li>
          </ul>

          <div v-else class="app__clipboard-history-empty">
            <p class="app__clipboard-history-empty-title">Clipboard history is empty</p>
            <p class="app__clipboard-history-empty-copy">Copy or select some text first.</p>
          </div>
        </div>
      </section>
    </div>

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
  grid-template-areas: var(--shell-areas);
  min-height: 0;
  gap: 3px;
}

.app__sidebar {
  grid-area: sidebar;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.app__content {
  grid-area: content;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--content-columns);
  grid-template-rows: var(--content-rows);
  grid-template-areas: var(--content-areas);
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
  grid-area: empty;
  display: grid;
  place-items: center;
}

.app__surface--diff {
  grid-area: diff;
}

.app__surface--terminal {
  grid-area: terminal;
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

.app__divider--shell {
  grid-area: shell-divider;
}

.app__divider--content {
  grid-area: content-divider;
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

.app__dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(5, 8, 12, 0.56);
  backdrop-filter: blur(10px);
}

.app__clipboard-history {
  width: min(860px, calc(100vw - 48px));
  height: min(760px, calc(100vh - 48px));
  max-height: min(760px, calc(100vh - 48px));
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background: var(--panel-bg);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}

.app__clipboard-history-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 22px 14px;
  border-bottom: 1px solid var(--border-subtle);
}

.app__clipboard-history-heading {
  display: grid;
  gap: 6px;
}

.app__clipboard-history-eyebrow {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.app__clipboard-history-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.1rem;
}

.app__clipboard-history-meta {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.88rem;
  line-height: 1.45;
}

.app__clipboard-history-close {
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--button-secondary-bg);
  color: var(--text-primary);
  font-size: 1.2rem;
  line-height: 1;
  width: 34px;
  height: 34px;
}

.app__clipboard-history-toolbar {
  padding: 14px 22px 18px;
  border-bottom: 1px solid var(--border-subtle);
}

.app__clipboard-history-search {
  display: grid;
  gap: 8px;
}

.app__clipboard-history-search-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-muted);
  font-size: 0.82rem;
}

.app__clipboard-history-shortcut {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--button-secondary-bg);
  color: var(--text-dim);
  font-size: 0.75rem;
}

.app__clipboard-history-search-input {
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--input-bg);
  color: var(--text-primary);
  padding: 11px 13px;
  font: inherit;
}

.app__clipboard-history-body {
  min-height: 0;
  overflow: auto;
}

.app__clipboard-history-list {
  list-style: none;
  margin: 0;
  padding: 10px;
  display: grid;
  gap: 8px;
}

.app__clipboard-history-item {
  margin: 0;
}

.app__clipboard-history-item-button {
  width: 100%;
  display: grid;
  gap: 10px;
  text-align: left;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: transparent;
  color: inherit;
  padding: 12px 14px;
}

.app__clipboard-history-item--selected .app__clipboard-history-item-button,
.app__clipboard-history-item-button:hover,
.app__clipboard-history-item-button:focus-visible {
  border-color: rgba(105, 178, 255, 0.42);
  background: rgba(105, 178, 255, 0.1);
}

.app__clipboard-history-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.app__clipboard-history-item-labels {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.app__clipboard-history-item-index {
  color: var(--text-dim);
  font-size: 0.76rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.app__clipboard-history-item-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(105, 178, 255, 0.18);
  color: var(--text-primary);
  font-size: 0.72rem;
}

.app__clipboard-history-item-time {
  color: var(--text-dim);
  font-size: 0.75rem;
  white-space: nowrap;
}

.app__clipboard-history-item-copy {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.84rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.app__clipboard-history-empty {
  display: grid;
  gap: 8px;
  justify-items: center;
  padding: 36px 24px;
  text-align: center;
}

.app__clipboard-history-empty-title,
.app__clipboard-history-empty-copy {
  margin: 0;
}

.app__clipboard-history-empty-copy {
  color: var(--text-muted);
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
    grid-template-areas: var(--shell-areas-mobile);
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
