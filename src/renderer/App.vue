<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  DEFAULT_PANEL_LAYOUT,
  GLOBAL_WORKSPACE_SESSION_KEY,
  cloneWorkspaceSessionState,
  cloneWorkspaceSessions,
  type GitLogEntry,
  type ProjectTitleMode,
  type ProjectSettingsFormData,
  type GitStatusSummary,
  type RecentRepoEntry,
  type TerminalCommandPreset,
  type WorkspaceSessionState,
  type WorkspaceSessionsByContext,
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
  openNoteFile: () => Promise<unknown>;
  openNoteFilePath: (filePath: string) => Promise<unknown>;
} | null>(null);
const sidebarWidth = ref(DEFAULT_PANEL_LAYOUT.sidebarWidth);
const terminalHeight = ref(DEFAULT_PANEL_LAYOUT.terminalHeight);
const terminalWidth = ref(DEFAULT_PANEL_LAYOUT.terminalWidth);
const contentLayout = ref(DEFAULT_PANEL_LAYOUT.contentLayout);
const sidebarCollapsed = ref(DEFAULT_PANEL_LAYOUT.sidebarCollapsed);
const diffCollapsed = ref(DEFAULT_PANEL_LAYOUT.diffCollapsed);
const terminalCollapsed = ref(DEFAULT_PANEL_LAYOUT.terminalCollapsed);
const projectTitle = ref('BridgeGit');
const projectTitleMode = ref<ProjectTitleMode>('auto');
const soundNotificationsEnabled = ref(true);
const projectTitleSaveToast = ref<string | null>(null);
const isSettingsOpen = ref(false);
const isCommitHistoryOpen = ref(false);
const commitHistorySearchToken = ref(0);
const commitMessage = ref('');
const recentRepos = ref<RecentRepoEntry[]>([]);
const terminalCommandPresets = ref<TerminalCommandPreset[]>([]);
const workspaceSessions = ref<WorkspaceSessionsByContext>({});
const workspaceTabs = ref<WorkspaceTabState[]>([]);
const workspaceRecentActivityByTabId = ref<Record<string, boolean>>({});
const activeWorkspaceTabId = ref<string | null>(null);
const infoNoteLastSeenRevision = ref<string | null>(null);
const sessionReady = ref(false);
const isSwitchingWorkspaceContext = ref(false);

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
  selectedCommit,
  diff,
  commitDiff,
  isLoading,
  isLoadingLog,
  isLoadingCommitDiff,
  error,
  commitDiffError,
  refresh,
  loadLog,
  setRepoPath,
  selectFile,
  openCommitDiff,
  stageFiles,
  unstageFiles,
  commitChanges,
  checkoutBranch,
  dispose,
} = useGit();

type PanelId = 'sidebar' | 'diff' | 'terminal';
type ResizeTarget = 'sidebar' | 'content' | null;

const activeResize = ref<ResizeTarget>(null);
let persistTimer: number | null = null;
let projectTitleSaveToastTimer: number | null = null;
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
const collapsedPanels = computed(() => {
  const panels: Array<{ id: PanelId; label: string; shortcut: string }> = [];

  if (sidebarCollapsed.value) {
    panels.push({ id: 'sidebar', label: 'Repo', shortcut: SHORTCUTS.panelRepoToggle.display });
  }

  if (diffCollapsed.value) {
    panels.push({ id: 'diff', label: 'Diff', shortcut: SHORTCUTS.panelDiffToggle.display });
  }

  if (terminalCollapsed.value) {
    panels.push({ id: 'terminal', label: 'Workspace', shortcut: SHORTCUTS.panelTerminalToggle.display });
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
    status.value.untracked.length +
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
const branch = computed(() => status.value?.currentBranch ?? branches.value?.current ?? 'no repo');
const displayProjectTitle = computed(() => projectTitle.value.trim() || 'BridgeGit');
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
const stageActionLabel = computed(() => (
  canSelectNextDiff.value ? 'Stage & next' : 'Stage current'
));

function getRepoName(nextRepoPath: string): string {
  const parts = nextRepoPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? nextRepoPath;
}

function getWorkspaceContextKey(nextRepoPath: string | null): string {
  return nextRepoPath ?? GLOBAL_WORKSPACE_SESSION_KEY;
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

function buildPersistedWorkspaceSessions(): WorkspaceSessionsByContext {
  const nextWorkspaceSessions = cloneWorkspaceSessions(workspaceSessions.value);
  nextWorkspaceSessions[getWorkspaceContextKey(repoPath.value)] = buildWorkspaceSessionState();
  return nextWorkspaceSessions;
}

function applyWorkspaceSession(nextRepoPath: string | null) {
  const workspaceSession = workspaceSessions.value[getWorkspaceContextKey(nextRepoPath)];
  const nextWorkspaceSession = workspaceSession
    ? cloneWorkspaceSessionState(workspaceSession)
    : {
        tabs: [],
        activeTabId: null,
      };

  workspaceTabs.value = nextWorkspaceSession.tabs;
  activeWorkspaceTabId.value = nextWorkspaceSession.activeTabId;
}

function captureWorkspaceSession(nextRepoPath: string | null) {
  workspaceSessions.value = {
    ...workspaceSessions.value,
    [getWorkspaceContextKey(nextRepoPath)]: buildWorkspaceSessionState(),
  };
}

function resolveAutoProjectTitle(nextRepoPath: string | null): string {
  return nextRepoPath ? getRepoName(nextRepoPath) : 'BridgeGit';
}

function resolveInitialProjectTitle(
  savedTitle: string,
  lastRepoPath: string | null,
  mode: ProjectTitleMode,
): string {
  if (mode === 'auto') {
    return resolveAutoProjectTitle(lastRepoPath);
  }

  const trimmedTitle = savedTitle.trim();

  if (!trimmedTitle) {
    return resolveAutoProjectTitle(lastRepoPath);
  }

  return trimmedTitle;
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
    void saveSession({
      lastRepoPath: repoPath.value,
      recentRepos: recentRepos.value,
      terminalCwd: terminalCwd.value,
      projectTitle: projectTitle.value,
      projectTitleMode: projectTitleMode.value,
      soundNotificationsEnabled: soundNotificationsEnabled.value,
      infoNoteLastSeenRevision: infoNoteLastSeenRevision.value,
      terminalCommandPresets: terminalCommandPresets.value,
      workspaceSessions: buildPersistedWorkspaceSessions(),
      panelLayout: {
        sidebarWidth: sidebarWidth.value,
        terminalHeight: terminalHeight.value,
        terminalWidth: terminalWidth.value,
        contentLayout: contentLayout.value,
        sidebarCollapsed: sidebarCollapsed.value,
        diffCollapsed: diffCollapsed.value,
        terminalCollapsed: terminalCollapsed.value,
      },
    });
  }, 180);
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
  workspaceTabs.value = upsertWelcomeNoteTab(workspaceTabs.value);
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
  const nextMode: ProjectTitleMode = trimmedTitle ? 'custom' : 'auto';
  const nextProjectTitle = nextMode === 'custom'
    ? trimmedTitle
    : resolveAutoProjectTitle(repoPath.value);

  projectTitle.value = nextProjectTitle;
  projectTitleMode.value = nextMode;
  contentLayout.value = nextSettings.contentLayout;
  soundNotificationsEnabled.value = nextSettings.soundNotificationsEnabled;
  terminalCommandPresets.value = nextSettings.terminalCommandPresets;

  const savedSession = await saveSession({
    projectTitle: nextProjectTitle,
    projectTitleMode: nextMode,
    soundNotificationsEnabled: nextSettings.soundNotificationsEnabled,
    infoNoteLastSeenRevision: infoNoteLastSeenRevision.value,
    terminalCommandPresets: nextSettings.terminalCommandPresets,
    workspaceSessions: buildPersistedWorkspaceSessions(),
    panelLayout: {
      contentLayout: nextSettings.contentLayout,
    },
  });

  projectTitle.value = resolveInitialProjectTitle(
    savedSession.projectTitle,
    savedSession.lastRepoPath,
    savedSession.projectTitleMode,
  );
  projectTitleMode.value = savedSession.projectTitleMode;
  soundNotificationsEnabled.value = savedSession.soundNotificationsEnabled;
  contentLayout.value = savedSession.panelLayout.contentLayout;
  terminalCommandPresets.value = savedSession.terminalCommandPresets;
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

async function handleSelectRepo(nextRepoPath: string) {
  const nextRepoName = getRepoName(nextRepoPath);
  const previousRepoPath = repoPath.value;

  isCommitHistoryOpen.value = false;
  commitMessage.value = '';
  isSwitchingWorkspaceContext.value = true;

  try {
    captureWorkspaceSession(previousRepoPath);
    await setRepoPath(nextRepoPath);
    applyWorkspaceSession(nextRepoPath);
    recentRepos.value = buildRecentRepos(nextRepoPath);

    if (projectTitleMode.value === 'auto') {
      projectTitle.value = nextRepoName;
    }

    const savedSession = await saveSession({
      lastRepoPath: nextRepoPath,
      recentRepos: recentRepos.value,
      terminalCwd: nextRepoPath,
      projectTitle: projectTitle.value,
      projectTitleMode: projectTitleMode.value,
      soundNotificationsEnabled: soundNotificationsEnabled.value,
      infoNoteLastSeenRevision: infoNoteLastSeenRevision.value,
      terminalCommandPresets: terminalCommandPresets.value,
      workspaceSessions: buildPersistedWorkspaceSessions(),
      panelLayout: {
        sidebarWidth: sidebarWidth.value,
        terminalHeight: terminalHeight.value,
        terminalWidth: terminalWidth.value,
        contentLayout: contentLayout.value,
        sidebarCollapsed: sidebarCollapsed.value,
        diffCollapsed: diffCollapsed.value,
        terminalCollapsed: terminalCollapsed.value,
      },
    });
    workspaceSessions.value = cloneWorkspaceSessions(savedSession.workspaceSessions);
  } finally {
    isSwitchingWorkspaceContext.value = false;
  }
}

async function handleOpenRepo() {
  const nextRepoPath = await window.bridgegit?.dialog.openRepo();

  if (nextRepoPath) {
    await handleSelectRepo(nextRepoPath);
  }
}

async function handleToggleCommitHistory() {
  if (!repoPath.value) {
    return;
  }

  const nextState = !isCommitHistoryOpen.value;
  isCommitHistoryOpen.value = nextState;

  if (nextState) {
    await loadLog();
  }
}

async function handleOpenCommitHistory() {
  if (!repoPath.value || isCommitHistoryOpen.value) {
    return;
  }

  isCommitHistoryOpen.value = true;
  await loadLog();
}

async function focusCommitHistorySearch() {
  if (!repoPath.value) {
    return;
  }

  const shouldLoadLog = !isCommitHistoryOpen.value;

  if (!isCommitHistoryOpen.value) {
    isCommitHistoryOpen.value = true;
  }

  commitHistorySearchToken.value += 1;

  if (shouldLoadLog) {
    await loadLog();
  }
}

async function handleSelectFile(filePath: string) {
  if (diffCollapsed.value) {
    diffCollapsed.value = false;
    scheduleSessionSave();
  }

  await selectFile(filePath);
}

async function handleOpenCommitDiff(commit: GitLogEntry) {
  isCommitHistoryOpen.value = false;

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

async function handleOpenRepoFileInNotes(relativePath: string) {
  if (!repoPath.value || !sessionReady.value) {
    return;
  }

  if (terminalCollapsed.value) {
    terminalCollapsed.value = false;
    scheduleSessionSave();
  }

  const filePath = resolveRepoFilePath(repoPath.value, relativePath);
  await terminalPanelRef.value?.openNoteFilePath(filePath);
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
  scheduleSessionSave();
});

watch([recentRepos, soundNotificationsEnabled, terminalCommandPresets, workspaceTabs, activeWorkspaceTabId], () => {
  scheduleSessionSave();
}, { deep: true });

watch(infoNoteLastSeenRevision, () => {
  scheduleSessionSave();
});

watch([workspaceTabs, activeWorkspaceTabId], () => {
  markInfoNoteAsSeenWhenActive();
}, { deep: true });

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, true);
  window.addEventListener('contextmenu', handleGlobalEditableContextMenu, true);

  let initialSession = await loadSession();

  if (!hasWorkspaceTabs(initialSession.workspaceSessions)) {
    const onboardingCwd = initialSession.lastRepoPath
      ?? initialSession.terminalCwd
      ?? (runtimeInfo.platform === 'win32' ? 'C:\\' : '/');

    initialSession = await saveSession({
      terminalCwd: initialSession.terminalCwd ?? onboardingCwd,
      infoNoteLastSeenRevision: initialSession.infoNoteLastSeenRevision,
      workspaceSessions: buildOnboardingWorkspaceSessions(initialSession.lastRepoPath, onboardingCwd),
    });
  }

  sidebarWidth.value = initialSession.panelLayout.sidebarWidth;
  terminalHeight.value = initialSession.panelLayout.terminalHeight;
  terminalWidth.value = initialSession.panelLayout.terminalWidth;
  contentLayout.value = initialSession.panelLayout.contentLayout;
  sidebarCollapsed.value = initialSession.panelLayout.sidebarCollapsed;
  diffCollapsed.value = initialSession.panelLayout.diffCollapsed;
  terminalCollapsed.value = initialSession.panelLayout.terminalCollapsed;
  projectTitleMode.value = initialSession.projectTitleMode;
  soundNotificationsEnabled.value = initialSession.soundNotificationsEnabled;
  projectTitle.value = resolveInitialProjectTitle(
    initialSession.projectTitle,
    initialSession.lastRepoPath,
    initialSession.projectTitleMode,
  );
  recentRepos.value = initialSession.recentRepos;
  terminalCommandPresets.value = initialSession.terminalCommandPresets;
  workspaceSessions.value = cloneWorkspaceSessions(initialSession.workspaceSessions);
  infoNoteLastSeenRevision.value = initialSession.infoNoteLastSeenRevision;
  applyWorkspaceSession(null);

  if (initialSession.lastRepoPath) {
    await setRepoPath(initialSession.lastRepoPath);
    applyWorkspaceSession(initialSession.lastRepoPath);
  }

  markInfoNoteAsSeenWhenActive();

  sessionReady.value = true;
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
});
</script>

<template>
  <div class="app" :style="appStyle">
    <div ref="shellRef" class="app__shell">
      <aside v-if="!sidebarCollapsed" class="app__sidebar">
        <RepoPanel
          :project-title="displayProjectTitle"
          :repo-path="repoPath"
          :recent-repos="recentRepos"
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
          @refresh="refresh"
          @toggle-history="handleToggleCommitHistory"
          @toggle-collapse="togglePanel('sidebar')"
          @select-file="handleSelectFile"
          @open-file-in-notes="handleOpenRepoFileInNotes"
          @stage="stageFiles"
          @unstage="unstageFiles"
          @checkout="handleCheckout"
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
            :is-loading="activeDiffLoading"
            :error="activeDiffError"
            :change-position="currentDiffPosition"
            :change-count="diffPathQueue.length"
            :can-select-previous="canSelectPreviousDiff"
            :can-select-next="canSelectNextDiff"
            :can-stage-current="canStageCurrentDiff"
            :stage-action-label="stageActionLabel"
            :can-collapse="canCollapseDiff"
            :collapse-shortcut-display="SHORTCUTS.panelDiffToggle.display"
            @select-previous="handleSelectAdjacentDiff(-1)"
            @select-next="handleSelectAdjacentDiff(1)"
            @stage-current="handleStageCurrentAndAdvance"
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
            :cwd="terminalCwd"
            :presets="terminalCommandPresets"
            :sound-notifications-enabled="soundNotificationsEnabled"
            :tabs="workspaceTabs"
            :active-tab-id="activeWorkspaceTabId"
            :can-collapse="canCollapseTerminal"
            :collapse-shortcut-display="SHORTCUTS.panelTerminalToggle.display"
            :collapsed="terminalCollapsed"
            @update:tabs="workspaceTabs = $event"
            @update:active-tab-id="activeWorkspaceTabId = $event"
            @update:recent-activity="workspaceRecentActivityByTabId = $event"
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
      :project-title="displayProjectTitle"
      :content-layout="contentLayout"
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
