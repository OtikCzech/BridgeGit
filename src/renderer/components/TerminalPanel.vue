<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import type {
  AppAppearance,
  CodeNavigationRequest,
  CodeNavigationTarget,
  NoteFileHandle,
  NoteFileStat,
  ResolvedEditorTheme,
  TerminalCommandPreset,
  ThemeVariant,
  WorkspaceCodeTabState,
  WorkspaceEditorPaneLayout,
  WorkspaceEditorPaneState,
  WorkspaceExternalFileChangeState,
  WorkspaceNoteTabState,
  WorkspaceShellTabState,
  WorkspaceTabDefaults,
  WorkspaceTabState,
} from '../../shared/bridgegit';
import {
  cloneWorkspaceEditorPaneLayout,
  resolveWorkspaceFileTabType,
} from '../../shared/bridgegit';
import { SHORTCUTS, formatCommandSlotShortcut } from '../shortcuts';
import { playNotificationBeep } from '../utils/notification-audio';
import NoteTabView from './NoteTabView.vue';
import TerminalSessionView from './TerminalSessionView.vue';

const CodeTabView = defineAsyncComponent(() => import('./CodeTabView.vue'));

interface TerminalSessionViewExpose {
  reconnect: () => Promise<void>;
  runPreset: (preset: TerminalCommandPreset) => Promise<boolean>;
}

interface Props {
  workspaceId: string;
  cwd: string;
  projectRoot: string | null;
  appearanceTheme: AppAppearance;
  appearanceThemeVariant: ThemeVariant;
  editorThemeVariant: ThemeVariant;
  editorTheme: ResolvedEditorTheme;
  presets: TerminalCommandPreset[];
  soundNotificationsEnabled: boolean;
  workspaceTabDefaults: WorkspaceTabDefaults;
  tabs: WorkspaceTabState[];
  editorPaneLayout: WorkspaceEditorPaneLayout;
  activeTabId: string | null;
  recentActivity: Record<string, boolean>;
  attention: Record<string, boolean>;
  canCollapse: boolean;
  collapseShortcutDisplay: string;
  collapsed: boolean;
}

const props = defineProps<Props>();
const CREATION_MENU_ACTION_ORDER = ['shell', 'note', 'open-file'] as const;
type CreationMenuActionId = (typeof CREATION_MENU_ACTION_ORDER)[number];
const ALL_TABS_TYPE_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'shell', label: 'Shell' },
  { value: 'note', label: 'Notes' },
  { value: 'code', label: 'Code' },
] as const;
type AllTabsTypeFilterValue = (typeof ALL_TABS_TYPE_FILTER_OPTIONS)[number]['value'];

const emit = defineEmits<{
  'update:tabs': [tabs: WorkspaceTabState[]];
  'update:editor-pane-layout': [editorPaneLayout: WorkspaceEditorPaneLayout];
  'update:active-tab-id': [activeTabId: string | null];
  'update:recent-activity': [payload: { workspaceId: string; recentActivity: Record<string, boolean> }];
  'update:attention': [payload: { workspaceId: string; attention: Record<string, boolean> }];
  'toggle-collapse': [];
  activity: [];
}>();

const tabs = ref<WorkspaceTabState[]>([]);
const editorPaneLayout = ref<WorkspaceEditorPaneLayout>({
  panes: [],
  activePaneId: null,
});
const activeTabId = ref<string | null>(null);
const editingTabId = ref<string | null>(null);
const draftTitle = ref('');
const editingInput = ref<HTMLInputElement | null>(null);
const allTabsSearchInput = ref<HTMLInputElement | null>(null);
const reconnectTokens = ref<Record<string, number>>({});
const tabMenu = ref<{ tabId: string; x: number; y: number } | null>(null);
const creationMenu = ref<{ x: number; y: number } | null>(null);
const commandMenuOpen = ref(false);
const allTabsDialogOpen = ref(false);
const allTabsSearchQuery = ref('');
const allTabsSelectedTabId = ref<string | null>(null);
const allTabsTypeFilter = ref<AllTabsTypeFilterValue>('all');
const allTabsFilterMenuOpen = ref(false);
const noteBusyByTabId = ref<Record<string, boolean>>({});
const codeNavigationRequestByPaneId = ref<Record<string, CodeNavigationRequest>>({});
const externalFileChangeByTabId = ref<Record<string, WorkspaceExternalFileChangeState>>({});
const trackedFileSignatureByTabId = ref<Record<string, string>>({});
const initializedFileTrackingByTabId = ref<Record<string, boolean>>({});
const tabRecentActivity = ref<Record<string, boolean>>({});
const tabAttention = ref<Record<string, boolean>>({});
const tabLastInputAt = ref<Record<string, number>>({});
const tabLastTypingAt = ref<Record<string, number>>({});
const tabLastSubmitAt = ref<Record<string, number>>({});
const interactedShellTabs = ref<Record<string, boolean>>({});
const startedShellTabs = ref<Record<string, boolean>>({});
const draggedTabId = ref<string | null>(null);
const dropTargetTabId = ref<string | null>(null);
const pendingCloseDialog = ref<{
  kind: 'note' | 'code' | 'shell';
  tabId: string;
  title: string;
  hasSavedFile: boolean;
  hasActivity: boolean;
  hasAttention: boolean;
} | null>(null);
const creationButtonRef = ref<HTMLElement | null>(null);
const allTabsFilterButtonRef = ref<HTMLElement | null>(null);
const creationMenuActiveActionId = ref<CreationMenuActionId>('shell');
const TAB_ACTIVITY_TIMEOUT_MS = 1600;
const ACTIVE_SHELL_IDLE_THRESHOLD_MS = 1200;
const ACTIVE_SHELL_TYPING_WINDOW_MS = 500;
const EXTERNAL_FILE_POLL_INTERVAL_MS = 2500;
const MISSING_FILE_SIGNATURE = '__missing__';
const tabActivityTimers = new Map<string, number>();
const sessionViewRefs = new Map<string, TerminalSessionViewExpose>();
const tabRefs = new Map<string, HTMLElement>();
const creationMenuItemRefs = new Map<CreationMenuActionId, HTMLButtonElement>();
const allTabsItemRefs = new Map<string, HTMLButtonElement>();
let externalFilePollTimer: number | null = null;
let externalFilePollInFlight = false;
let nextCodeNavigationToken = 1;
let isRestoringWorkspaceIndicators = false;

const sortedTabCount = computed(() => tabs.value.length);
const menuTab = computed(() => (
  tabs.value.find((tab) => tab.id === tabMenu.value?.tabId) ?? null
));
const sortedPresets = computed(() => (
  [...props.presets].sort((left, right) => {
    const leftSlot = left.shortcutSlot ?? Number.MAX_SAFE_INTEGER;
    const rightSlot = right.shortcutSlot ?? Number.MAX_SAFE_INTEGER;

    if (leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }

    return left.name.localeCompare(right.name);
  })
));
const activeWorkspaceTab = computed(() => (
  activeTabId.value ? getTabById(activeTabId.value) : null
));
const usesEditorPaneLayout = computed(() => Boolean(activeWorkspaceTab.value && isCodeTab(activeWorkspaceTab.value)));
const visibleEditorPanes = computed(() => {
  if (!usesEditorPaneLayout.value) {
    return [];
  }

  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTabId.value);

  return sortEditorPanes(normalizedLayout.panes)
    .map((pane) => {
      const tab = pane.tabId ? getTabById(pane.tabId) : null;
      return tab && isCodeTab(tab)
        ? { pane, tab }
        : null;
    })
    .filter((entry): entry is { pane: WorkspaceEditorPaneState; tab: WorkspaceCodeTabState } => Boolean(entry));
});
const editorPaneGridStyle = computed(() => {
  const hasSecondColumn = visibleEditorPanes.value.some((entry) => entry.pane.col === 1);
  const hasSecondRow = visibleEditorPanes.value.some((entry) => entry.pane.row === 1);

  return {
    gridTemplateColumns: hasSecondColumn ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
    gridTemplateRows: hasSecondRow ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
  };
});
const collapseButtonTitle = computed(() => (
  props.canCollapse
    ? `Collapse tabs panel ${props.collapseShortcutDisplay}`
    : 'Tabs panel cannot be collapsed while it is the last visible panel'
));
const creationMenuActions = computed(() => ([
  {
    id: 'shell' as const,
    label: 'New shell tab',
    shortcutDisplay: SHORTCUTS.terminalNewTab.display,
    key: 's',
  },
  {
    id: 'note' as const,
    label: 'New notes tab',
    shortcutDisplay: SHORTCUTS.workspaceNoteTab.display,
    key: 'n',
  },
  {
    id: 'open-file' as const,
    label: 'Open file',
    shortcutDisplay: SHORTCUTS.workspaceOpenFile.display,
    key: 'o',
  },
]));
const allTabsResults = computed(() => {
  const normalizedQuery = allTabsSearchQuery.value.trim().toLocaleLowerCase();
  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTabId.value);

  return tabs.value
    .map((tab) => {
      const secondaryMeta = getTabSecondaryMeta(tab);
      const paneCount = isCodeTab(tab)
        ? normalizedLayout.panes.filter((pane) => pane.tabId === tab.id).length
        : 0;
      const searchText = [
        tab.title,
        tab.type,
        secondaryMeta,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();

      return {
        tab,
        paneCount,
        secondaryMeta,
        typeLabel: getTabTypeLabel(tab),
        searchText,
      };
    })
    .filter((entry) => allTabsTypeFilter.value === 'all' || entry.tab.type === allTabsTypeFilter.value)
    .filter((entry) => !normalizedQuery || entry.searchText.includes(normalizedQuery));
});
const activeAllTabsTypeFilterLabel = computed(() => (
  ALL_TABS_TYPE_FILTER_OPTIONS.find((option) => option.value === allTabsTypeFilter.value)?.label ?? 'All'
));

function isShellTab(tab: WorkspaceTabState): tab is WorkspaceShellTabState {
  return tab.type === 'shell';
}

function isNoteTab(tab: WorkspaceTabState): tab is WorkspaceNoteTabState {
  return tab.type === 'note';
}

function isCodeTab(tab: WorkspaceTabState): tab is WorkspaceCodeTabState {
  return tab.type === 'code';
}

function isEditableTab(tab: WorkspaceTabState): tab is WorkspaceNoteTabState | WorkspaceCodeTabState {
  return isNoteTab(tab) || isCodeTab(tab);
}

function cloneTabs(source: WorkspaceTabState[]): WorkspaceTabState[] {
  return source.map((tab) => ({ ...tab }));
}

function buildWorkspaceTabRuntimeKey(workspaceId: string, tabId: string) {
  return `${workspaceId}:${tabId}`;
}

function getPathLeafName(pathValue: string) {
  const parts = pathValue.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? pathValue;
}

function normalizeFileLookup(pathValue: string) {
  const normalizedPath = pathValue.replace(/\\/g, '/');
  return window.bridgegit?.platform === 'win32'
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function buildTrackedFileSignature(fileStat: Pick<NoteFileStat, 'lastModifiedMs' | 'size'> | null) {
  if (!fileStat) {
    return MISSING_FILE_SIGNATURE;
  }

  return `${Math.round(fileStat.lastModifiedMs)}:${fileStat.size}`;
}

function getEditableTabFilePath(tab: WorkspaceTabState) {
  if (isNoteTab(tab)) {
    return tab.filePath;
  }

  if (isCodeTab(tab)) {
    return tab.filePath;
  }

  return null;
}

function sanitizeNoteFileName(title: string) {
  const sanitizedTitle = title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitizedTitle || 'notes';
}

function sleep(delayMs: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function cloneEditorPaneLayoutState(source: WorkspaceEditorPaneLayout) {
  return cloneWorkspaceEditorPaneLayout(source);
}

function buildEmptyEditorPaneLayout(): WorkspaceEditorPaneLayout {
  return {
    panes: [],
    activePaneId: null,
  };
}

function createEditorPaneId() {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function syncState(
  nextTabs: WorkspaceTabState[],
  nextActiveTabId: string | null,
  nextEditorPaneLayout = editorPaneLayout.value,
) {
  const normalizedEditorPaneLayout = normalizeEditorPaneLayout(
    nextEditorPaneLayout,
    nextTabs,
    nextActiveTabId,
  );
  tabs.value = cloneTabs(nextTabs);
  editorPaneLayout.value = cloneEditorPaneLayoutState(normalizedEditorPaneLayout);
  activeTabId.value = nextActiveTabId;
  emit('update:tabs', cloneTabs(nextTabs));
  emit('update:editor-pane-layout', cloneEditorPaneLayoutState(normalizedEditorPaneLayout));
  emit('update:active-tab-id', nextActiveTabId);
}

function createTabId(type: WorkspaceTabState['type']): string {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getNextTabNumber(type: WorkspaceTabState['type']): number {
  const pattern = type === 'shell' ? /^Shell\s+(\d+)$/ : /^Notes\s+(\d+)$/;

  const highestNumber = tabs.value.reduce((maxValue, tab) => {
    if (tab.type !== type) {
      return maxValue;
    }

    const match = pattern.exec(tab.title);
    return match ? Math.max(maxValue, Number.parseInt(match[1], 10)) : maxValue;
  }, 0);

  return highestNumber + 1;
}

function buildShellTab(cwd = props.cwd): WorkspaceShellTabState {
  return {
    id: createTabId('shell'),
    type: 'shell',
    title: `Shell ${getNextTabNumber('shell')}`,
    cwd,
    fontSize: props.workspaceTabDefaults.shellFontSize,
    launcherProfileId: null,
  };
}

function buildNoteTab(): WorkspaceNoteTabState {
  const content = '';

  return {
    id: createTabId('note'),
    type: 'note',
    title: `Notes ${getNextTabNumber('note')}`,
    filePath: null,
    content,
    savedContent: content,
    viewMode: 'split',
    fontSize: props.workspaceTabDefaults.noteFontSize,
  };
}

function ensureTab() {
  if (!tabs.value.length) {
    const nextTab = buildShellTab(props.cwd);
    syncState([nextTab], nextTab.id);
    markShellTabAsStarted(nextTab.id);
  }
}

function setSessionViewRef(
  tabId: string,
  instance: Element | ComponentPublicInstance | null,
) {
  const sessionView = instance as TerminalSessionViewExpose | null;

  if (!sessionView) {
    sessionViewRefs.delete(tabId);
    return;
  }

  sessionViewRefs.set(tabId, sessionView);
}

function setTabRef(
  tabId: string,
  element: Element | ComponentPublicInstance | null,
) {
  const tabElement = element as HTMLElement | null;

  if (!tabElement) {
    tabRefs.delete(tabId);
    return;
  }

  tabRefs.set(tabId, tabElement);
}

function setActiveTab(tabId: string) {
  const targetTab = getTabById(tabId);

  if (targetTab && isCodeTab(targetTab)) {
    assignTabToActiveEditorPane(tabId);
    clearTabActivity(tabId);
    clearTabAttention(tabId);
    tabMenu.value = null;
    creationMenu.value = null;
    commandMenuOpen.value = false;
    return;
  }

  activeTabId.value = tabId;
  emit('update:active-tab-id', tabId);
  clearTabActivity(tabId);
  clearTabAttention(tabId);
  tabMenu.value = null;
  creationMenu.value = null;
  commandMenuOpen.value = false;
  closeAllTabsDialog();
}

function markShellTabAsInteracted(tabId: string) {
  const tab = getTabById(tabId);

  if (!tab || !isShellTab(tab) || interactedShellTabs.value[tabId]) {
    return;
  }

  interactedShellTabs.value = {
    ...interactedShellTabs.value,
    [tabId]: true,
  };
}

function markShellTabAsStarted(tabId: string) {
  const tab = getTabById(tabId);

  if (!tab || !isShellTab(tab) || startedShellTabs.value[tabId]) {
    return;
  }

  startedShellTabs.value = {
    ...startedShellTabs.value,
    [tabId]: true,
  };
}

function handleTabClick(tabId: string) {
  if (editingTabId.value === tabId) {
    return;
  }

  markShellTabAsStarted(tabId);
  setActiveTab(tabId);
}

function handleTerminalViewActivate(tabId: string) {
  markShellTabAsStarted(tabId);
  markShellTabAsInteracted(tabId);
}

function clearTabDragState() {
  draggedTabId.value = null;
  dropTargetTabId.value = null;
}

function reorderTabs(sourceTabId: string, targetTabId: string) {
  if (sourceTabId === targetTabId) {
    return;
  }

  const sourceIndex = tabs.value.findIndex((tab) => tab.id === sourceTabId);
  const targetIndex = tabs.value.findIndex((tab) => tab.id === targetTabId);

  if (sourceIndex < 0 || targetIndex < 0) {
    return;
  }

  const nextTabs = cloneTabs(tabs.value);
  const [movedTab] = nextTabs.splice(sourceIndex, 1);

  if (!movedTab) {
    return;
  }

  const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  nextTabs.splice(insertionIndex, 0, movedTab);
  syncState(nextTabs, activeTabId.value ?? movedTab.id);
}

function handleTabDragStart(event: DragEvent, tabId: string) {
  if (editingTabId.value === tabId || tabs.value.length < 2) {
    event.preventDefault();
    return;
  }

  draggedTabId.value = tabId;
  dropTargetTabId.value = tabId;

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabId);
  }
}

function handleTabDragOver(event: DragEvent, tabId: string) {
  if (!draggedTabId.value || draggedTabId.value === tabId) {
    return;
  }

  event.preventDefault();

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }

  dropTargetTabId.value = tabId;
}

function handleTabDrop(tabId: string) {
  if (!draggedTabId.value || draggedTabId.value === tabId) {
    clearTabDragState();
    return;
  }

  reorderTabs(draggedTabId.value, tabId);
  clearTabDragState();
}

function clearTabActivityTimer(tabId: string) {
  const timerId = tabActivityTimers.get(tabId);

  if (timerId) {
    window.clearTimeout(timerId);
    tabActivityTimers.delete(tabId);
  }
}

function clearTabActivity(tabId: string) {
  clearTabActivityTimer(tabId);

  if (!(tabId in tabRecentActivity.value)) {
    return;
  }

  const { [tabId]: _removedActivity, ...nextActivity } = tabRecentActivity.value;
  tabRecentActivity.value = nextActivity;
}

function clearTabAttention(tabId: string) {
  if (!(tabId in tabAttention.value)) {
    return;
  }

  const { [tabId]: _removedAttention, ...nextAttention } = tabAttention.value;
  tabAttention.value = nextAttention;
}

function setTabLastInput(tabId: string) {
  tabLastInputAt.value = {
    ...tabLastInputAt.value,
    [tabId]: Date.now(),
  };
}

function clearTabLastInput(tabId: string) {
  if (!(tabId in tabLastInputAt.value)) {
    return;
  }

  const { [tabId]: _removedTimestamp, ...nextTimestamps } = tabLastInputAt.value;
  tabLastInputAt.value = nextTimestamps;
}

function setTabLastTyping(tabId: string) {
  tabLastTypingAt.value = {
    ...tabLastTypingAt.value,
    [tabId]: Date.now(),
  };
}

function clearTabLastTyping(tabId: string) {
  if (!(tabId in tabLastTypingAt.value)) {
    return;
  }

  const { [tabId]: _removedTypingAt, ...nextTyping } = tabLastTypingAt.value;
  tabLastTypingAt.value = nextTyping;
}

function setTabLastSubmit(tabId: string) {
  tabLastSubmitAt.value = {
    ...tabLastSubmitAt.value,
    [tabId]: Date.now(),
  };
}

function clearTabLastSubmit(tabId: string) {
  if (!(tabId in tabLastSubmitAt.value)) {
    return;
  }

  const { [tabId]: _removedSubmitAt, ...nextSubmits } = tabLastSubmitAt.value;
  tabLastSubmitAt.value = nextSubmits;
}

function pruneTabActivityState(nextTabs: WorkspaceTabState[]) {
  const nextTabIds = new Set(nextTabs.map((tab) => tab.id));

  tabActivityTimers.forEach((_timerId, tabId) => {
    if (!nextTabIds.has(tabId)) {
      clearTabActivityTimer(tabId);
    }
  });

  const nextActivityEntries = Object.entries(tabRecentActivity.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextActivityEntries.length !== Object.keys(tabRecentActivity.value).length) {
    tabRecentActivity.value = Object.fromEntries(nextActivityEntries);
  }

  const nextAttentionEntries = Object.entries(tabAttention.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextAttentionEntries.length !== Object.keys(tabAttention.value).length) {
    tabAttention.value = Object.fromEntries(nextAttentionEntries);
  }

  const nextInputEntries = Object.entries(tabLastInputAt.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextInputEntries.length !== Object.keys(tabLastInputAt.value).length) {
    tabLastInputAt.value = Object.fromEntries(nextInputEntries);
  }

  const nextTypingEntries = Object.entries(tabLastTypingAt.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextTypingEntries.length !== Object.keys(tabLastTypingAt.value).length) {
    tabLastTypingAt.value = Object.fromEntries(nextTypingEntries);
  }

  const nextSubmitEntries = Object.entries(tabLastSubmitAt.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextSubmitEntries.length !== Object.keys(tabLastSubmitAt.value).length) {
    tabLastSubmitAt.value = Object.fromEntries(nextSubmitEntries);
  }

  const nextBusyEntries = Object.entries(noteBusyByTabId.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextBusyEntries.length !== Object.keys(noteBusyByTabId.value).length) {
    noteBusyByTabId.value = Object.fromEntries(nextBusyEntries);
  }

  const nextInteractedEntries = Object.entries(interactedShellTabs.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextInteractedEntries.length !== Object.keys(interactedShellTabs.value).length) {
    interactedShellTabs.value = Object.fromEntries(nextInteractedEntries);
  }

  const nextStartedEntries = Object.entries(startedShellTabs.value)
    .filter(([tabId]) => nextTabIds.has(tabId));

  if (nextStartedEntries.length !== Object.keys(startedShellTabs.value).length) {
    startedShellTabs.value = Object.fromEntries(nextStartedEntries);
  }
}

function resetTransientTabState() {
  tabActivityTimers.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  tabActivityTimers.clear();
  tabRecentActivity.value = {};
  tabAttention.value = {};
  tabLastInputAt.value = {};
  tabLastTypingAt.value = {};
  tabLastSubmitAt.value = {};
  interactedShellTabs.value = {};
  startedShellTabs.value = {};
  noteBusyByTabId.value = {};
  codeNavigationRequestByPaneId.value = {};
  externalFileChangeByTabId.value = {};
  trackedFileSignatureByTabId.value = {};
  initializedFileTrackingByTabId.value = {};
}

function filterIndicatorStateByTabs(
  source: Record<string, boolean>,
  nextTabs: WorkspaceTabState[] = tabs.value,
) {
  const nextTabIds = new Set(nextTabs.map((tab) => tab.id));

  return Object.fromEntries(
    Object.entries(source).filter(([tabId, isActive]) => nextTabIds.has(tabId) && Boolean(isActive)),
  ) as Record<string, boolean>;
}

function emitWorkspaceIndicators() {
  emit('update:recent-activity', {
    workspaceId: props.workspaceId,
    recentActivity: buildVisualRecentActivity(),
  });
  emit('update:attention', {
    workspaceId: props.workspaceId,
    attention: buildVisualAttention(),
  });
}

function restoreWorkspaceIndicatorState() {
  const restoredRecentActivity = filterIndicatorStateByTabs(props.recentActivity);
  const restoredAttention = filterIndicatorStateByTabs(props.attention);
  const restoredShellIds = new Set([
    ...Object.keys(restoredRecentActivity),
    ...Object.keys(restoredAttention),
  ]);

  tabRecentActivity.value = restoredRecentActivity;
  tabAttention.value = restoredAttention;

  if (restoredShellIds.size > 0) {
    interactedShellTabs.value = {
      ...interactedShellTabs.value,
      ...Object.fromEntries([...restoredShellIds].map((tabId) => [tabId, true])),
    };

    tabLastInputAt.value = {
      ...tabLastInputAt.value,
      ...Object.fromEntries(
        Object.keys(restoredAttention).map((tabId) => [tabId, tabLastInputAt.value[tabId] ?? Date.now()]),
      ),
    };
  }
}

function shouldPlayActivityCompletionSound(tabId: string) {
  if (!props.soundNotificationsEnabled) {
    return false;
  }

  return props.collapsed || tabId !== activeTabId.value;
}

function getTabById(tabId: string) {
  return tabs.value.find((tab) => tab.id === tabId) ?? null;
}

function isEditableTabDirty(tab: WorkspaceTabState) {
  return isEditableTab(tab) && tab.content !== tab.savedContent;
}

function hasAttention(tabId: string) {
  return Boolean(tabAttention.value[tabId])
    && Boolean(tabLastInputAt.value[tabId])
    && Boolean(interactedShellTabs.value[tabId]);
}

function shellNeedsCloseConfirmation(tabId: string) {
  return isTabActive(tabId) || hasAttention(tabId);
}

function showsShellTabIndicator(tab: WorkspaceTabState) {
  if (!isShellTab(tab)) {
    return true;
  }

  return Boolean(interactedShellTabs.value[tab.id]);
}

function hasTabActiveChrome(tab: WorkspaceTabState) {
  if (tab.id !== activeTabId.value) {
    return false;
  }

  if (!isShellTab(tab)) {
    return true;
  }

  return showsShellTabIndicator(tab);
}

function shouldMountShellTab(tab: WorkspaceTabState) {
  if (!isShellTab(tab)) {
    return false;
  }

  return Boolean(startedShellTabs.value[tab.id]);
}

function editableTabHasSavedFile(tab: WorkspaceTabState) {
  return isEditableTab(tab) && Boolean(tab.filePath);
}

function tabDisplayTitle(tab: WorkspaceTabState) {
  return tab.title;
}

function tabTitleTooltip(tab: WorkspaceTabState) {
  if (!isEditableTab(tab) || !tab.filePath) {
    return tabDisplayTitle(tab);
  }

  return isEditableTabDirty(tab)
    ? `${tab.filePath}\nUnsaved changes`
    : tab.filePath;
}

function getTabTypeLabel(tab: WorkspaceTabState) {
  if (isShellTab(tab)) {
    return 'Shell';
  }

  if (isNoteTab(tab)) {
    return 'Notes';
  }

  return 'Code';
}

function getTabSecondaryMeta(tab: WorkspaceTabState) {
  if (isShellTab(tab)) {
    return tab.cwd;
  }

  return tab.filePath;
}

function splitShortcutDisplay(display: string) {
  return display
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getDefaultCreationMenuActionId(): CreationMenuActionId {
  const activeTab = activeTabId.value ? getTabById(activeTabId.value) : null;
  return activeTab && isNoteTab(activeTab) ? 'note' : 'shell';
}

function setNoteBusy(tabId: string, busy: boolean) {
  if (busy) {
    noteBusyByTabId.value = {
      ...noteBusyByTabId.value,
      [tabId]: true,
    };
    return;
  }

  if (!(tabId in noteBusyByTabId.value)) {
    return;
  }

  const { [tabId]: _removedBusy, ...nextBusy } = noteBusyByTabId.value;
  noteBusyByTabId.value = nextBusy;
}

function setCodeNavigationRequest(paneId: string, target: CodeNavigationTarget) {
  codeNavigationRequestByPaneId.value = {
    ...codeNavigationRequestByPaneId.value,
    [paneId]: {
      ...target,
      token: nextCodeNavigationToken,
    },
  };
  nextCodeNavigationToken += 1;
}

function clearCodeNavigationRequest(paneId: string) {
  if (!(paneId in codeNavigationRequestByPaneId.value)) {
    return;
  }

  const { [paneId]: _removedRequest, ...nextRequests } = codeNavigationRequestByPaneId.value;
  codeNavigationRequestByPaneId.value = nextRequests;
}

function setTrackedFileSignature(tabId: string, signature: string) {
  trackedFileSignatureByTabId.value = {
    ...trackedFileSignatureByTabId.value,
    [tabId]: signature,
  };
}

function markFileTrackingInitialized(tabId: string) {
  if (initializedFileTrackingByTabId.value[tabId]) {
    return;
  }

  initializedFileTrackingByTabId.value = {
    ...initializedFileTrackingByTabId.value,
    [tabId]: true,
  };
}

function clearTrackedFileState(tabId: string) {
  if (tabId in trackedFileSignatureByTabId.value) {
    const { [tabId]: _removedSignature, ...nextSignatures } = trackedFileSignatureByTabId.value;
    trackedFileSignatureByTabId.value = nextSignatures;
  }

  if (tabId in initializedFileTrackingByTabId.value) {
    const { [tabId]: _removedInitialized, ...nextInitialized } = initializedFileTrackingByTabId.value;
    initializedFileTrackingByTabId.value = nextInitialized;
  }

  if (tabId in externalFileChangeByTabId.value) {
    const { [tabId]: _removedChange, ...nextChanges } = externalFileChangeByTabId.value;
    externalFileChangeByTabId.value = nextChanges;
  }
}

function clearExternalFileChange(tabId: string) {
  if (!(tabId in externalFileChangeByTabId.value)) {
    return;
  }

  const { [tabId]: _removedChange, ...nextChanges } = externalFileChangeByTabId.value;
  externalFileChangeByTabId.value = nextChanges;
}

function setExternalFileChange(tabId: string, kind: WorkspaceExternalFileChangeState) {
  if (externalFileChangeByTabId.value[tabId] === kind) {
    return;
  }

  externalFileChangeByTabId.value = {
    ...externalFileChangeByTabId.value,
    [tabId]: kind,
  };
}

function seedTrackedFileState(tabId: string, fileHandle: Pick<NoteFileHandle, 'lastModifiedMs' | 'size'>) {
  setTrackedFileSignature(tabId, buildTrackedFileSignature(fileHandle));
  markFileTrackingInitialized(tabId);
  clearExternalFileChange(tabId);
}

function pruneExternalFileRuntimeState(nextTabs: WorkspaceTabState[]) {
  const nextTrackedTabIds = new Set(nextTabs
    .filter((tab) => isEditableTab(tab) && Boolean(getEditableTabFilePath(tab)))
    .map((tab) => tab.id));

  Object.keys(trackedFileSignatureByTabId.value).forEach((tabId) => {
    if (!nextTrackedTabIds.has(tabId)) {
      clearTrackedFileState(tabId);
    }
  });
}

function pruneCodeNavigationRequests(nextEditorPaneLayout: WorkspaceEditorPaneLayout) {
  const nextPaneIds = new Set(nextEditorPaneLayout.panes.map((pane) => pane.id));

  Object.keys(codeNavigationRequestByPaneId.value).forEach((paneId) => {
    if (!nextPaneIds.has(paneId)) {
      clearCodeNavigationRequest(paneId);
    }
  });
}

function updateNoteTabState(tabId: string, patch: Partial<WorkspaceNoteTabState>) {
  const nextTabs = tabs.value.map((tab) => (
    isNoteTab(tab) && tab.id === tabId
      ? {
          ...tab,
          ...patch,
        }
      : tab
  ));

  syncState(nextTabs, activeTabId.value);
}

function updateCodeTabState(tabId: string, patch: Partial<WorkspaceCodeTabState>) {
  const nextTabs = tabs.value.map((tab) => (
    isCodeTab(tab) && tab.id === tabId
      ? {
          ...tab,
          ...patch,
        }
      : tab
  ));

  syncState(nextTabs, activeTabId.value);
}

function updateShellTabState(tabId: string, patch: Partial<WorkspaceShellTabState>) {
  const nextTabs = tabs.value.map((tab) => (
    isShellTab(tab) && tab.id === tabId
      ? {
          ...tab,
          ...patch,
        }
      : tab
  ));

  syncState(nextTabs, activeTabId.value);
}

function findNoteTabByFilePath(filePath: string, excludeTabId?: string | null) {
  const lookupPath = normalizeFileLookup(filePath);

  return tabs.value.find((tab) => (
    isNoteTab(tab)
    && tab.id !== excludeTabId
    && tab.filePath
    && normalizeFileLookup(tab.filePath) === lookupPath
  )) ?? null;
}

function findCodeTabByFilePath(filePath: string, excludeTabId?: string | null) {
  const lookupPath = normalizeFileLookup(filePath);

  return tabs.value.find((tab) => (
    isCodeTab(tab)
    && tab.id !== excludeTabId
    && normalizeFileLookup(tab.filePath) === lookupPath
  )) ?? null;
}

function buildFileBackedNoteTab(filePath: string, content: string): WorkspaceNoteTabState {
  return {
    id: createTabId('note'),
    type: 'note',
    title: getPathLeafName(filePath),
    filePath,
    content,
    savedContent: content,
    viewMode: 'split',
    fontSize: props.workspaceTabDefaults.noteFontSize,
  };
}

function buildFileBackedCodeTab(filePath: string, content: string): WorkspaceCodeTabState {
  return {
    id: createTabId('code'),
    type: 'code',
    title: getPathLeafName(filePath),
    filePath,
    content,
    savedContent: content,
    fontSize: props.workspaceTabDefaults.noteFontSize,
  };
}

function getCodeTabs(sourceTabs = tabs.value) {
  return sourceTabs.filter((tab): tab is WorkspaceCodeTabState => isCodeTab(tab));
}

function sortEditorPanes(panes: WorkspaceEditorPaneState[]) {
  return [...panes].sort((left, right) => {
    if (left.row !== right.row) {
      return left.row - right.row;
    }

    return left.col - right.col;
  });
}

function normalizeEditorPaneLayout(
  sourceLayout: WorkspaceEditorPaneLayout,
  nextTabs = tabs.value,
  nextActiveTabId = activeTabId.value,
): WorkspaceEditorPaneLayout {
  const codeTabs = getCodeTabs(nextTabs);
  const fallbackTabId = (
    (nextActiveTabId && codeTabs.some((tab) => tab.id === nextActiveTabId) ? nextActiveTabId : null)
    ?? codeTabs[0]?.id
    ?? null
  );

  if (!fallbackTabId) {
    return buildEmptyEditorPaneLayout();
  }

  const codeTabIds = new Set(codeTabs.map((tab) => tab.id));
  const normalizedPanes = sortEditorPanes(sourceLayout.panes)
    .filter((pane, index, panes) => (
      panes.findIndex((candidate) => candidate.row === pane.row && candidate.col === pane.col) === index
    ))
    .map((pane) => ({
      ...pane,
      tabId: pane.tabId && codeTabIds.has(pane.tabId) ? pane.tabId : fallbackTabId,
    }));

  const panes = normalizedPanes.length > 0
    ? normalizedPanes
    : [{
        id: 'pane-primary',
        row: 0 as const,
        col: 0 as const,
        tabId: fallbackTabId,
      }];

  const activePaneId = panes.find((pane) => pane.id === sourceLayout.activePaneId)?.id
    ?? panes.find((pane) => pane.tabId === fallbackTabId)?.id
    ?? panes[0]?.id
    ?? null;

  return {
    panes,
    activePaneId,
  };
}

function getEditorPaneById(paneId: string | null | undefined, sourceLayout = editorPaneLayout.value) {
  if (!paneId) {
    return null;
  }

  return sourceLayout.panes.find((pane) => pane.id === paneId) ?? null;
}

function getActiveEditorPane(sourceLayout = editorPaneLayout.value) {
  return getEditorPaneById(sourceLayout.activePaneId, sourceLayout)
    ?? sourceLayout.panes[0]
    ?? null;
}

function setActiveEditorPane(paneId: string) {
  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value);
  const targetPane = getEditorPaneById(paneId, normalizedLayout);

  if (!targetPane || !targetPane.tabId) {
    return false;
  }

  syncState(
    tabs.value,
    targetPane.tabId,
    {
      ...normalizedLayout,
      activePaneId: targetPane.id,
    },
  );
  return true;
}

function assignTabToActiveEditorPane(tabId: string) {
  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, tabId);
  const activePane = getActiveEditorPane(normalizedLayout);

  if (!activePane) {
    syncState(
      tabs.value,
      tabId,
      normalizeEditorPaneLayout(buildEmptyEditorPaneLayout(), tabs.value, tabId),
    );
    return;
  }

  const nextLayout: WorkspaceEditorPaneLayout = {
    panes: normalizedLayout.panes.map((pane) => (
      pane.id === activePane.id
        ? {
            ...pane,
            tabId,
          }
        : pane
    )),
    activePaneId: activePane.id,
  };

  syncState(tabs.value, tabId, nextLayout);
}

function getAdjacentEditorPaneFor(
  pane: WorkspaceEditorPaneState,
  direction: 'left' | 'right' | 'up' | 'down',
  sourceLayout = editorPaneLayout.value,
) {
  const targetRow = direction === 'up'
    ? pane.row - 1
    : direction === 'down'
      ? pane.row + 1
      : pane.row;
  const targetCol = direction === 'left'
    ? pane.col - 1
    : direction === 'right'
      ? pane.col + 1
      : pane.col;

  if (targetRow < 0 || targetRow > 1 || targetCol < 0 || targetCol > 1) {
    return null;
  }

  return sourceLayout.panes.find((pane) => pane.row === targetRow && pane.col === targetCol) ?? null;
}

function getAdjacentEditorPane(
  direction: 'left' | 'right' | 'up' | 'down',
  sourceLayout = editorPaneLayout.value,
) {
  const activePane = getActiveEditorPane(sourceLayout);

  if (!activePane) {
    return null;
  }

  return getAdjacentEditorPaneFor(activePane, direction, sourceLayout);
}

function compactEditorPaneLayout(sourceLayout: WorkspaceEditorPaneLayout): WorkspaceEditorPaneLayout {
  const sortedPanes = sortEditorPanes(sourceLayout.panes);
  const rowValues = [...new Set(sortedPanes.map((pane) => pane.row))].sort();
  const colValues = [...new Set(sortedPanes.map((pane) => pane.col))].sort();

  return {
    panes: sortedPanes.map((pane) => ({
      ...pane,
      row: (rowValues.indexOf(pane.row) === 1 ? 1 : 0),
      col: (colValues.indexOf(pane.col) === 1 ? 1 : 0),
    })),
    activePaneId: sourceLayout.activePaneId,
  };
}

function splitEditorPane(direction: 'left' | 'right' | 'up' | 'down') {
  const activeTab = activeTabId.value ? getTabById(activeTabId.value) : null;

  if (!activeTab || !isCodeTab(activeTab)) {
    return false;
  }

  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTab.id);
  const activePane = getActiveEditorPane(normalizedLayout);

  if (!activePane || !activePane.tabId) {
    return false;
  }

  const adjacentPane = getAdjacentEditorPaneFor(activePane, direction, normalizedLayout);

  if (adjacentPane) {
    return setActiveEditorPane(adjacentPane.id);
  }

  if (normalizedLayout.panes.length >= 4) {
    return false;
  }

  const targetRow = direction === 'up'
    ? activePane.row - 1
    : direction === 'down'
      ? activePane.row + 1
      : activePane.row;
  const targetCol = direction === 'left'
    ? activePane.col - 1
    : direction === 'right'
      ? activePane.col + 1
      : activePane.col;

  if (targetRow < 0 || targetRow > 1 || targetCol < 0 || targetCol > 1) {
    return false;
  }

  const nextPane: WorkspaceEditorPaneState = {
    id: createEditorPaneId(),
    row: targetRow === 1 ? 1 : 0,
    col: targetCol === 1 ? 1 : 0,
    tabId: activePane.tabId,
  };
  const nextLayout = compactEditorPaneLayout({
    panes: [...normalizedLayout.panes, nextPane],
    activePaneId: nextPane.id,
  });
  syncState(tabs.value, activePane.tabId, nextLayout);
  return true;
}

function closeEditorPane(direction: 'left' | 'right' | 'up' | 'down') {
  const activeTab = activeTabId.value ? getTabById(activeTabId.value) : null;

  if (!activeTab || !isCodeTab(activeTab)) {
    return false;
  }

  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTab.id);
  const activePane = getActiveEditorPane(normalizedLayout);

  if (!activePane || normalizedLayout.panes.length <= 1) {
    return false;
  }

  const adjacentPane = getAdjacentEditorPaneFor(activePane, direction, normalizedLayout);

  if (!adjacentPane || !adjacentPane.tabId) {
    return false;
  }

  const nextLayout = compactEditorPaneLayout({
    panes: normalizedLayout.panes.filter((pane) => pane.id !== activePane.id),
    activePaneId: adjacentPane.id,
  });
  syncState(tabs.value, adjacentPane.tabId, nextLayout);
  return true;
}

function splitSpecificEditorPane(paneId: string, direction: 'left' | 'right' | 'up' | 'down') {
  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTabId.value);
  const pane = getEditorPaneById(paneId, normalizedLayout);

  if (!pane || !pane.tabId) {
    return false;
  }

  const currentTab = getTabById(pane.tabId);

  if (!currentTab || !isCodeTab(currentTab)) {
    return false;
  }

  const adjacentPane = getAdjacentEditorPaneFor(pane, direction, normalizedLayout);

  if (adjacentPane) {
    return setActiveEditorPane(adjacentPane.id);
  }

  if (normalizedLayout.panes.length >= 4) {
    return false;
  }

  const targetRow = direction === 'up'
    ? pane.row - 1
    : direction === 'down'
      ? pane.row + 1
      : pane.row;
  const targetCol = direction === 'left'
    ? pane.col - 1
    : direction === 'right'
      ? pane.col + 1
      : pane.col;

  if (targetRow < 0 || targetRow > 1 || targetCol < 0 || targetCol > 1) {
    return false;
  }

  const nextPane: WorkspaceEditorPaneState = {
    id: createEditorPaneId(),
    row: targetRow === 1 ? 1 : 0,
    col: targetCol === 1 ? 1 : 0,
    tabId: pane.tabId,
  };
  const nextLayout = compactEditorPaneLayout({
    panes: [...normalizedLayout.panes, nextPane],
    activePaneId: nextPane.id,
  });
  syncState(tabs.value, pane.tabId, nextLayout);
  return true;
}

function resolveEditorPaneCloseDirection(paneId: string) {
  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTabId.value);
  const pane = getEditorPaneById(paneId, normalizedLayout);

  if (!pane) {
    return null;
  }

  const directions: Array<'left' | 'right' | 'up' | 'down'> = ['left', 'right', 'up', 'down'];
  return directions.find((direction) => Boolean(getAdjacentEditorPaneFor(pane, direction, normalizedLayout))) ?? null;
}

function findClosestRemainingEditorPane(
  pane: WorkspaceEditorPaneState,
  panes: WorkspaceEditorPaneState[],
) {
  if (!panes.length) {
    return null;
  }

  return [...panes]
    .sort((left, right) => {
      const leftDistance = Math.abs(left.row - pane.row) + Math.abs(left.col - pane.col);
      const rightDistance = Math.abs(right.row - pane.row) + Math.abs(right.col - pane.col);

      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      if (left.row !== right.row) {
        return left.row - right.row;
      }

      return left.col - right.col;
    })[0] ?? null;
}

function closeSpecificEditorPane(paneId: string) {
  const normalizedLayout = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTabId.value);
  const pane = getEditorPaneById(paneId, normalizedLayout);

  if (!pane || normalizedLayout.panes.length <= 1) {
    return false;
  }

  const remainingPanes = normalizedLayout.panes.filter((entry) => entry.id !== paneId);
  const targetPane = findClosestRemainingEditorPane(pane, remainingPanes);

  if (!targetPane?.tabId) {
    return false;
  }

  const nextLayout = compactEditorPaneLayout({
    panes: remainingPanes,
    activePaneId: targetPane.id,
  });
  syncState(tabs.value, targetPane.tabId, nextLayout);
  return true;
}

function suggestNoteFileName(tab: WorkspaceNoteTabState) {
  if (tab.filePath) {
    return tab.filePath;
  }

  return `${sanitizeNoteFileName(tab.title)}.md`;
}

function isUserIdleInTab(tabId: string) {
  const lastInputAt = tabLastInputAt.value[tabId];

  if (!lastInputAt) {
    return true;
  }

  return Date.now() - lastInputAt >= ACTIVE_SHELL_IDLE_THRESHOLD_MS;
}

function isUserTypingInTab(tabId: string) {
  const lastTypingAt = tabLastTypingAt.value[tabId];

  if (!lastTypingAt) {
    return false;
  }

  return Date.now() - lastTypingAt < ACTIVE_SHELL_TYPING_WINDOW_MS;
}

function handleTabInput(tabId: string, input: string) {
  markShellTabAsInteracted(tabId);
  setTabLastInput(tabId);
  clearTabAttention(tabId);
  clearTabActivity(tabId);

  if (input.includes('\r')) {
    clearTabLastTyping(tabId);
    setTabLastSubmit(tabId);
    return;
  }

  setTabLastTyping(tabId);
}

function handleTabActivity(tabId: string) {
  const hasUserInputInCurrentSession = Boolean(tabLastInputAt.value[tabId]);

  if (!hasUserInputInCurrentSession) {
    return;
  }

  const isActiveVisibleTab = tabId === activeTabId.value && !props.collapsed;

  if (isActiveVisibleTab) {
    tabRecentActivity.value = {
      ...tabRecentActivity.value,
      [tabId]: true,
    };
    clearTabAttention(tabId);
    clearTabActivityTimer(tabId);

    tabActivityTimers.set(tabId, window.setTimeout(() => {
      clearTabActivity(tabId);

      const tab = getTabById(tabId);
      if (!tab || !isShellTab(tab)) {
        return;
      }

      const lastSubmitAt = tabLastSubmitAt.value[tabId] ?? 0;
      const lastInputAt = tabLastInputAt.value[tabId] ?? 0;
      if (!lastSubmitAt || lastInputAt > lastSubmitAt) {
        return;
      }

      if (!isUserIdleInTab(tabId)) {
        return;
      }

      tabAttention.value = {
        ...tabAttention.value,
        [tabId]: true,
      };
      clearTabLastSubmit(tabId);
    }, TAB_ACTIVITY_TIMEOUT_MS));

    emit('activity');
    return;
  }

  clearTabAttention(tabId);
  tabRecentActivity.value = {
    ...tabRecentActivity.value,
    [tabId]: true,
  };
  clearTabActivityTimer(tabId);

  tabActivityTimers.set(tabId, window.setTimeout(() => {
    const shouldNotify = shouldPlayActivityCompletionSound(tabId);
    clearTabActivity(tabId);

    const tab = getTabById(tabId);
    if (tab && isShellTab(tab) && tabId !== activeTabId.value) {
      tabAttention.value = {
        ...tabAttention.value,
        [tabId]: true,
      };
    }

    if (shouldNotify) {
      void playNotificationBeep();
    }
  }, TAB_ACTIVITY_TIMEOUT_MS));

  emit('activity');
}

function isTabActive(tabId: string) {
  if (!interactedShellTabs.value[tabId]) {
    return false;
  }

  if (!tabRecentActivity.value[tabId]) {
    return false;
  }

  const isActiveVisibleTab = tabId === activeTabId.value && !props.collapsed;

  if (isActiveVisibleTab && isUserTypingInTab(tabId)) {
    return false;
  }

  return true;
}

function buildVisualRecentActivity() {
  return Object.fromEntries(
    tabs.value
      .filter((tab) => isTabActive(tab.id) && Boolean(interactedShellTabs.value[tab.id]))
      .map((tab) => [tab.id, true]),
  ) as Record<string, boolean>;
}

function buildVisualAttention() {
  return Object.fromEntries(
    tabs.value
      .filter((tab) => (
        Boolean(tabAttention.value[tab.id])
        && Boolean(tabLastInputAt.value[tab.id])
        && Boolean(interactedShellTabs.value[tab.id])
      ))
      .map((tab) => [tab.id, true]),
  ) as Record<string, boolean>;
}

function selectAdjacentTab(direction: -1 | 1) {
  if (tabs.value.length < 2) {
    return;
  }

  const currentIndex = tabs.value.findIndex((tab) => tab.id === activeTabId.value);
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeCurrentIndex + direction + tabs.value.length) % tabs.value.length;
  const nextTabId = tabs.value[nextIndex]?.id ?? null;

  if (nextTabId) {
    setActiveTab(nextTabId);
  }
}

function addShellTab() {
  const nextTab = buildShellTab(props.cwd);
  syncState([...tabs.value, nextTab], nextTab.id);
  creationMenu.value = null;
  return nextTab;
}

function addNoteTab() {
  const nextTab = buildNoteTab();
  syncState([...tabs.value, nextTab], nextTab.id);
  creationMenu.value = null;
  return nextTab;
}

async function openWorkspaceFile(targetTabId?: string | null) {
  creationMenu.value = null;

  if (!window.bridgegit?.notes) {
    return null;
  }

  const activeTab = activeTabId.value ? getTabById(activeTabId.value) : null;
  const resolvedTargetTabId = targetTabId ?? (
    activeTab && isEditableTab(activeTab) ? activeTab.id : null
  );

  if (resolvedTargetTabId) {
    setNoteBusy(resolvedTargetTabId, true);
  }

  try {
    const openedFile = await window.bridgegit.notes.openFile();

    if (!openedFile) {
      return null;
    }

    return openResolvedWorkspaceFile(openedFile, resolvedTargetTabId);
  } catch (error) {
    console.error('Failed to open workspace file.', error);
    return null;
  } finally {
    if (resolvedTargetTabId) {
      setNoteBusy(resolvedTargetTabId, false);
    }
  }
}

function openResolvedWorkspaceFile(
  openedFile: NoteFileHandle,
  targetTabId?: string | null,
  preferredType?: 'note' | 'code',
) {
  const tabType = preferredType ?? resolveWorkspaceFileTabType(openedFile.path);

  if (tabType === 'unsupported') {
    return null;
  }

  const targetTab = targetTabId ? getTabById(targetTabId) : null;

  if (tabType === 'note') {
    const existingNoteTab = findNoteTabByFilePath(openedFile.path, targetTabId);

    if (existingNoteTab) {
      setActiveTab(existingNoteTab.id);
      return existingNoteTab;
    }

    if (targetTab && isNoteTab(targetTab) && !targetTab.filePath && !targetTab.content.trim()) {
      updateNoteTabState(targetTab.id, {
        title: getPathLeafName(openedFile.path),
        filePath: openedFile.path,
        content: openedFile.content,
        savedContent: openedFile.content,
      });
      seedTrackedFileState(targetTab.id, openedFile);
      setActiveTab(targetTab.id);
      return targetTab;
    }

    const nextNoteTab = buildFileBackedNoteTab(openedFile.path, openedFile.content);
    syncState([...tabs.value, nextNoteTab], nextNoteTab.id);
    seedTrackedFileState(nextNoteTab.id, openedFile);
    return nextNoteTab;
  }

  const existingCodeTab = findCodeTabByFilePath(openedFile.path, targetTabId);

  if (existingCodeTab) {
    setActiveTab(existingCodeTab.id);
    return existingCodeTab;
  }

  const nextCodeTab = buildFileBackedCodeTab(openedFile.path, openedFile.content);
  syncState([...tabs.value, nextCodeTab], nextCodeTab.id);
  seedTrackedFileState(nextCodeTab.id, openedFile);
  return nextCodeTab;
}

async function openNoteFilePath(filePath: string, targetTabId?: string | null) {
  creationMenu.value = null;

  if (!window.bridgegit?.notes) {
    return null;
  }

  const activeTab = activeTabId.value ? getTabById(activeTabId.value) : null;
  const resolvedTargetTabId = targetTabId ?? (activeTab && isNoteTab(activeTab) ? activeTab.id : null);

  if (resolvedTargetTabId) {
    setNoteBusy(resolvedTargetTabId, true);
  }

  try {
    const openedFile = await window.bridgegit.notes.readFile(filePath);
    return openResolvedWorkspaceFile(openedFile, resolvedTargetTabId, 'note');
  } catch (error) {
    console.error('Failed to open note file path.', error);
    return null;
  } finally {
    if (resolvedTargetTabId) {
      setNoteBusy(resolvedTargetTabId, false);
    }
  }
}

async function openWorkspaceFilePath(filePath: string, targetTabId?: string | null) {
  creationMenu.value = null;

  if (!window.bridgegit?.notes) {
    return null;
  }

  const activeTab = activeTabId.value ? getTabById(activeTabId.value) : null;
  const targetType = resolveWorkspaceFileTabType(filePath);

  if (targetType === 'unsupported') {
    return null;
  }

  const resolvedTargetTabId = targetTabId ?? (
    activeTab
    && ((targetType === 'note' && isNoteTab(activeTab)) || (targetType === 'code' && isCodeTab(activeTab)))
      ? activeTab.id
      : null
  );

  if (resolvedTargetTabId) {
    setNoteBusy(resolvedTargetTabId, true);
  }

  try {
    const openedFile = await window.bridgegit.notes.readFile(filePath);
    return openResolvedWorkspaceFile(openedFile, resolvedTargetTabId, targetType);
  } catch (error) {
    console.error('Failed to open workspace file path.', error);
    return null;
  } finally {
    if (resolvedTargetTabId) {
      setNoteBusy(resolvedTargetTabId, false);
    }
  }
}

async function openCodeNavigationTarget(target: CodeNavigationTarget) {
  const openedTab = await openWorkspaceFilePath(target.filePath);

  if (!openedTab) {
    return null;
  }

  if (isCodeTab(openedTab) && (target.line || target.column)) {
    const activePane = getActiveEditorPane(normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, openedTab.id));

    if (activePane) {
      setCodeNavigationRequest(activePane.id, target);
    }
  }

  return openedTab;
}

async function reloadEditableTabFromDisk(tabId: string) {
  const tab = getTabById(tabId);
  const filePath = tab ? getEditableTabFilePath(tab) : null;

  if (!tab || !isEditableTab(tab) || !filePath || !window.bridgegit?.notes) {
    return null;
  }

  setNoteBusy(tabId, true);

  try {
    const openedFile = await window.bridgegit.notes.readFile(filePath);

    if (isNoteTab(tab)) {
      updateNoteTabState(tabId, {
        title: getPathLeafName(openedFile.path),
        filePath: openedFile.path,
        content: openedFile.content,
        savedContent: openedFile.content,
      });
    } else {
      updateCodeTabState(tabId, {
        title: getPathLeafName(openedFile.path),
        filePath: openedFile.path,
        content: openedFile.content,
        savedContent: openedFile.content,
      });
    }

    seedTrackedFileState(tabId, openedFile);
    return openedFile.path;
  } catch (error) {
    console.error('Failed to reload file from disk.', error);
    return null;
  } finally {
    setNoteBusy(tabId, false);
  }
}

async function dismissExternalFileChange(tabId: string) {
  const tab = getTabById(tabId);
  const filePath = tab ? getEditableTabFilePath(tab) : null;

  if (!tab || !isEditableTab(tab) || !filePath || !window.bridgegit?.notes) {
    clearExternalFileChange(tabId);
    return;
  }

  const fileStat = await window.bridgegit.notes.statFile(filePath);
  setTrackedFileSignature(tabId, buildTrackedFileSignature(fileStat));
  markFileTrackingInitialized(tabId);
  clearExternalFileChange(tabId);
}

async function pollExternalFileChanges() {
  if (externalFilePollInFlight || !window.bridgegit?.notes) {
    return;
  }

  externalFilePollInFlight = true;

  try {
    const fileBackedTabs = tabs.value.filter((tab): tab is WorkspaceNoteTabState | WorkspaceCodeTabState => (
      isEditableTab(tab) && Boolean(getEditableTabFilePath(tab))
    ));

    for (const tab of fileBackedTabs) {
      const filePath = getEditableTabFilePath(tab);

      if (!filePath || noteBusyByTabId.value[tab.id]) {
        continue;
      }

      const isInitialized = Boolean(initializedFileTrackingByTabId.value[tab.id]);

      if (!isInitialized) {
        const inspectedFile = await window.bridgegit.notes.inspectFile(filePath);

        markFileTrackingInitialized(tab.id);

        if (!inspectedFile) {
          setTrackedFileSignature(tab.id, MISSING_FILE_SIGNATURE);
          setExternalFileChange(tab.id, 'unavailable');
          continue;
        }

        if (inspectedFile.content !== tab.savedContent) {
          setTrackedFileSignature(tab.id, buildTrackedFileSignature(inspectedFile));
          setExternalFileChange(tab.id, 'changed');
          continue;
        }

        if (tab.content !== tab.savedContent) {
          seedTrackedFileState(tab.id, inspectedFile);
          setExternalFileChange(tab.id, 'session-dirty');
          continue;
        }

        seedTrackedFileState(tab.id, inspectedFile);
        continue;
      }

      const fileStat = await window.bridgegit.notes.statFile(filePath);
      const nextSignature = buildTrackedFileSignature(fileStat);
      const previousSignature = trackedFileSignatureByTabId.value[tab.id] ?? MISSING_FILE_SIGNATURE;

      if (nextSignature === previousSignature) {
        continue;
      }

      if (!fileStat) {
        setTrackedFileSignature(tab.id, nextSignature);
        setExternalFileChange(tab.id, 'unavailable');
        continue;
      }

      const inspectedFile = await window.bridgegit.notes.inspectFile(filePath);

      if (!inspectedFile) {
        setTrackedFileSignature(tab.id, MISSING_FILE_SIGNATURE);
        setExternalFileChange(tab.id, 'unavailable');
        continue;
      }

      setTrackedFileSignature(tab.id, buildTrackedFileSignature(inspectedFile));

      if (inspectedFile.content === tab.savedContent) {
        clearExternalFileChange(tab.id);
        continue;
      }

      setExternalFileChange(tab.id, 'changed');
    }
  } finally {
    externalFilePollInFlight = false;
  }
}

function startExternalFilePolling() {
  if (externalFilePollTimer) {
    return;
  }

  externalFilePollTimer = window.setInterval(() => {
    void pollExternalFileChanges();
  }, EXTERNAL_FILE_POLL_INTERVAL_MS);
}

function stopExternalFilePolling() {
  if (!externalFilePollTimer) {
    return;
  }

  window.clearInterval(externalFilePollTimer);
  externalFilePollTimer = null;
}

function closeActiveTab() {
  if (!activeTabId.value || tabs.value.length < 2) {
    return;
  }

  void requestCloseTab(activeTabId.value);
}

function reconnectTab(tabId: string) {
  reconnectTokens.value = {
    ...reconnectTokens.value,
    [tabId]: (reconnectTokens.value[tabId] ?? 0) + 1,
  };
  tabMenu.value = null;
}

function setEditingInput(element: Element | ComponentPublicInstance | null) {
  editingInput.value = element as HTMLInputElement | null;
}

function setAllTabsSearchInput(element: Element | ComponentPublicInstance | null) {
  allTabsSearchInput.value = element as HTMLInputElement | null;
}

function setAllTabsFilterButtonRef(element: Element | ComponentPublicInstance | null) {
  allTabsFilterButtonRef.value = element as HTMLElement | null;
}

function setCreationButtonRef(element: Element | ComponentPublicInstance | null) {
  creationButtonRef.value = element as HTMLElement | null;
}

function setCreationMenuItemRef(
  actionId: CreationMenuActionId,
  element: Element | ComponentPublicInstance | null,
) {
  const button = element as HTMLButtonElement | null;

  if (!button) {
    creationMenuItemRefs.delete(actionId);
    return;
  }

  creationMenuItemRefs.set(actionId, button);
}

function setAllTabsItemRef(
  tabId: string,
  element: Element | ComponentPublicInstance | null,
) {
  const button = element as HTMLButtonElement | null;

  if (!button) {
    allTabsItemRefs.delete(tabId);
    return;
  }

  allTabsItemRefs.set(tabId, button);
}

function focusCreationMenuAction(actionId: CreationMenuActionId) {
  void nextTick(() => {
    creationMenuItemRefs.get(actionId)?.focus({ preventScroll: true });
  });
}

function scrollTabIntoView(tabId: string | null) {
  if (!tabId) {
    return;
  }

  tabRefs.get(tabId)?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
  });
}

function focusAllTabsSearch() {
  void nextTick(() => {
    allTabsSearchInput.value?.focus();
    allTabsSearchInput.value?.select();
  });
}

function scrollSelectedAllTabsItemIntoView() {
  if (!allTabsSelectedTabId.value) {
    return;
  }

  void nextTick(() => {
    allTabsItemRefs.get(allTabsSelectedTabId.value ?? '')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  });
}

function openAllTabsDialog() {
  tabMenu.value = null;
  creationMenu.value = null;
  commandMenuOpen.value = false;
  allTabsDialogOpen.value = true;
  allTabsSearchQuery.value = '';
  allTabsTypeFilter.value = 'all';
  allTabsFilterMenuOpen.value = false;
  allTabsSelectedTabId.value = activeTabId.value ?? tabs.value[0]?.id ?? null;
  focusAllTabsSearch();
  scrollSelectedAllTabsItemIntoView();
}

function closeAllTabsDialog() {
  allTabsDialogOpen.value = false;
  allTabsSearchQuery.value = '';
  allTabsTypeFilter.value = 'all';
  allTabsFilterMenuOpen.value = false;
  allTabsSelectedTabId.value = null;
}

function toggleAllTabsFilterMenu() {
  allTabsFilterMenuOpen.value = !allTabsFilterMenuOpen.value;
}

function closeAllTabsFilterMenu() {
  allTabsFilterMenuOpen.value = false;
}

function setAllTabsTypeFilter(filter: AllTabsTypeFilterValue) {
  allTabsTypeFilter.value = filter;
  closeAllTabsFilterMenu();
}

function selectAllTabsItem(tabId: string | null) {
  allTabsSelectedTabId.value = tabId;
  scrollSelectedAllTabsItemIntoView();
}

function moveAllTabsSelection(direction: -1 | 1) {
  if (!allTabsResults.value.length) {
    return;
  }

  const currentIndex = allTabsResults.value.findIndex((entry) => entry.tab.id === allTabsSelectedTabId.value);
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeCurrentIndex + direction + allTabsResults.value.length) % allTabsResults.value.length;
  const nextTabId = allTabsResults.value[nextIndex]?.tab.id ?? null;

  if (nextTabId) {
    selectAllTabsItem(nextTabId);
  }
}

function activateSelectedAllTabsItem() {
  const targetTabId = allTabsSelectedTabId.value ?? allTabsResults.value[0]?.tab.id ?? null;

  if (!targetTabId) {
    return false;
  }

  activateAllTabsItem(targetTabId);
  return true;
}

function activateAllTabsItem(tabId: string) {
  setActiveTab(tabId);
  closeAllTabsDialog();
}

function setActiveCreationMenuAction(actionId: CreationMenuActionId, focus = true) {
  creationMenuActiveActionId.value = actionId;

  if (focus && creationMenu.value) {
    focusCreationMenuAction(actionId);
  }
}

function moveCreationMenuSelection(direction: -1 | 1) {
  const currentIndex = CREATION_MENU_ACTION_ORDER.indexOf(creationMenuActiveActionId.value);
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeCurrentIndex + direction + CREATION_MENU_ACTION_ORDER.length)
    % CREATION_MENU_ACTION_ORDER.length;

  setActiveCreationMenuAction(CREATION_MENU_ACTION_ORDER[nextIndex] ?? 'shell');
}

async function activateCreationMenuAction(actionId: CreationMenuActionId) {
  if (actionId === 'shell') {
    addShellTab();
    return;
  }

  if (actionId === 'note') {
    addNoteTab();
    return;
  }

  await openWorkspaceFile();
}

function handleCreationMenuKeydown(event: KeyboardEvent) {
  if (!creationMenu.value) {
    return false;
  }

  if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
    event.preventDefault();
    moveCreationMenuSelection(1);
    return true;
  }

  if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
    event.preventDefault();
    moveCreationMenuSelection(-1);
    return true;
  }

  if (event.key === 'Home') {
    event.preventDefault();
    setActiveCreationMenuAction(CREATION_MENU_ACTION_ORDER[0] ?? 'shell');
    return true;
  }

  if (event.key === 'End') {
    event.preventDefault();
    setActiveCreationMenuAction(CREATION_MENU_ACTION_ORDER.at(-1) ?? 'open-file');
    return true;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void activateCreationMenuAction(creationMenuActiveActionId.value);
    return true;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }

  const normalizedKey = event.key.toLocaleLowerCase();
  const matchedAction = creationMenuActions.value.find((action) => action.key === normalizedKey);

  if (!matchedAction) {
    return false;
  }

  event.preventDefault();
  setActiveCreationMenuAction(matchedAction.id, false);
  void activateCreationMenuAction(matchedAction.id);
  return true;
}

function handleAllTabsDialogKeydown(event: KeyboardEvent) {
  if (!allTabsDialogOpen.value) {
    return false;
  }

  if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
    event.preventDefault();
    moveAllTabsSelection(1);
    return true;
  }

  if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
    event.preventDefault();
    moveAllTabsSelection(-1);
    return true;
  }

  if (event.key === 'Home') {
    event.preventDefault();
    selectAllTabsItem(allTabsResults.value[0]?.tab.id ?? null);
    return true;
  }

  if (event.key === 'End') {
    event.preventDefault();
    selectAllTabsItem(allTabsResults.value.at(-1)?.tab.id ?? null);
    return true;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    return activateSelectedAllTabsItem();
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
    event.preventDefault();
    focusAllTabsSearch();
    return true;
  }

  return false;
}

function performCloseTab(tabId: string) {
  const currentIndex = tabs.value.findIndex((tab) => tab.id === tabId);

  if (currentIndex === -1) {
    return;
  }

  const wasActive = activeTabId.value === tabId;
  const nextTabs = tabs.value.filter((tab) => tab.id !== tabId);

  editingTabId.value = editingTabId.value === tabId ? null : editingTabId.value;
  tabMenu.value = tabMenu.value?.tabId === tabId ? null : tabMenu.value;

  if (tabId in reconnectTokens.value) {
    const { [tabId]: _removedToken, ...nextTokens } = reconnectTokens.value;
    reconnectTokens.value = nextTokens;
  }

  clearTabActivity(tabId);
  clearTabAttention(tabId);
  clearTabLastInput(tabId);
  clearTabLastTyping(tabId);
  clearTabLastSubmit(tabId);
  setNoteBusy(tabId, false);

  if (!nextTabs.length) {
    const fallbackTab = buildShellTab(props.cwd);
    syncState([fallbackTab], fallbackTab.id);
    return;
  }

  if (wasActive) {
    const fallbackIndex = Math.min(currentIndex, nextTabs.length - 1);
    syncState(nextTabs, nextTabs[fallbackIndex]?.id ?? nextTabs[0]?.id ?? null);
    return;
  }

  syncState(nextTabs, activeTabId.value);
}

function closePendingCloseDialog() {
  pendingCloseDialog.value = null;
}

async function requestCloseTab(tabId: string) {
  const tab = getTabById(tabId);

  if (!tab) {
    return;
  }

  if (isEditableTab(tab) && isEditableTabDirty(tab)) {
    pendingCloseDialog.value = {
      kind: tab.type,
      tabId,
      title: tab.title,
      hasSavedFile: Boolean(tab.filePath),
      hasActivity: false,
      hasAttention: false,
    };
    tabMenu.value = null;
    creationMenu.value = null;
    commandMenuOpen.value = false;
    return;
  }

  if (isShellTab(tab) && shellNeedsCloseConfirmation(tabId)) {
    pendingCloseDialog.value = {
      kind: 'shell',
      tabId,
      title: tab.title,
      hasSavedFile: false,
      hasActivity: isTabActive(tabId),
      hasAttention: hasAttention(tabId),
    };
    tabMenu.value = null;
    creationMenu.value = null;
    commandMenuOpen.value = false;
    return;
  }

  performCloseTab(tabId);
}

function updateNoteContent(tabId: string, content: string) {
  updateNoteTabState(tabId, { content });
}

function updateCodeContent(tabId: string, content: string) {
  updateCodeTabState(tabId, { content });
}

function updateNoteViewMode(tabId: string, viewMode: WorkspaceNoteTabState['viewMode']) {
  updateNoteTabState(tabId, { viewMode });
}

function updateNoteFontSize(tabId: string, fontSize: number) {
  updateNoteTabState(tabId, { fontSize });
}

function updateCodeFontSize(tabId: string, fontSize: number) {
  updateCodeTabState(tabId, { fontSize });
}

function updateShellFontSize(tabId: string, fontSize: number) {
  updateShellTabState(tabId, { fontSize });
}

async function saveNoteFile(tabId: string) {
  const tab = getTabById(tabId);

  if (!tab || !isNoteTab(tab) || !window.bridgegit?.notes) {
    return null;
  }

  if (!tab.filePath) {
    return saveNoteFileAs(tabId);
  }

  setNoteBusy(tabId, true);

  try {
    const savedPath = await window.bridgegit.notes.saveFile(tab.filePath, tab.content);
    const savedFileStat = await window.bridgegit.notes.statFile(savedPath);
    updateNoteTabState(tabId, {
      filePath: savedPath,
      title: getPathLeafName(savedPath),
      savedContent: tab.content,
    });
    setTrackedFileSignature(tabId, buildTrackedFileSignature(savedFileStat));
    markFileTrackingInitialized(tabId);
    clearExternalFileChange(tabId);
    return savedPath;
  } catch (error) {
    console.error('Failed to save note file.', error);
    return null;
  } finally {
    setNoteBusy(tabId, false);
  }
}

async function saveCodeFile(tabId: string) {
  const tab = getTabById(tabId);

  if (!tab || !isCodeTab(tab) || !window.bridgegit?.notes) {
    return null;
  }

  setNoteBusy(tabId, true);

  try {
    const savedPath = await window.bridgegit.notes.saveFile(tab.filePath, tab.content);
    const savedFileStat = await window.bridgegit.notes.statFile(savedPath);
    updateCodeTabState(tabId, {
      filePath: savedPath,
      title: getPathLeafName(savedPath),
      savedContent: tab.content,
    });
    setTrackedFileSignature(tabId, buildTrackedFileSignature(savedFileStat));
    markFileTrackingInitialized(tabId);
    clearExternalFileChange(tabId);
    return savedPath;
  } catch (error) {
    console.error('Failed to save code file.', error);
    return null;
  } finally {
    setNoteBusy(tabId, false);
  }
}

async function saveNoteFileAs(tabId: string) {
  const tab = getTabById(tabId);

  if (!tab || !isNoteTab(tab) || !window.bridgegit?.notes) {
    return null;
  }

  setNoteBusy(tabId, true);

  try {
    const savedPath = await window.bridgegit.notes.saveFileAs(tab.content, suggestNoteFileName(tab));

    if (!savedPath) {
      return null;
    }

    const savedFileStat = await window.bridgegit.notes.statFile(savedPath);
    updateNoteTabState(tabId, {
      filePath: savedPath,
      title: getPathLeafName(savedPath),
      savedContent: tab.content,
    });
    setTrackedFileSignature(tabId, buildTrackedFileSignature(savedFileStat));
    markFileTrackingInitialized(tabId);
    clearExternalFileChange(tabId);
    return savedPath;
  } catch (error) {
    console.error('Failed to save note file as.', error);
    return null;
  } finally {
    setNoteBusy(tabId, false);
  }
}

async function saveCodeFileAs(tabId: string) {
  const tab = getTabById(tabId);

  if (!tab || !isCodeTab(tab) || !window.bridgegit?.notes) {
    return null;
  }

  setNoteBusy(tabId, true);

  try {
    const savedPath = await window.bridgegit.notes.saveFileAs(tab.content, tab.filePath);

    if (!savedPath) {
      return null;
    }

    const savedFileStat = await window.bridgegit.notes.statFile(savedPath);
    updateCodeTabState(tabId, {
      filePath: savedPath,
      title: getPathLeafName(savedPath),
      savedContent: tab.content,
    });
    setTrackedFileSignature(tabId, buildTrackedFileSignature(savedFileStat));
    markFileTrackingInitialized(tabId);
    clearExternalFileChange(tabId);
    return savedPath;
  } catch (error) {
    console.error('Failed to save code file as.', error);
    return null;
  } finally {
    setNoteBusy(tabId, false);
  }
}

async function handlePendingCloseSave() {
  if (!pendingCloseDialog.value || pendingCloseDialog.value.kind === 'shell') {
    return;
  }

  const { kind, tabId } = pendingCloseDialog.value;
  const savedPath = kind === 'code' ? await saveCodeFile(tabId) : await saveNoteFile(tabId);

  if (!savedPath) {
    return;
  }

  closePendingCloseDialog();
  performCloseTab(tabId);
}

async function handlePendingCloseSaveAs() {
  if (!pendingCloseDialog.value || pendingCloseDialog.value.kind === 'shell') {
    return;
  }

  const { kind, tabId } = pendingCloseDialog.value;
  const savedPath = kind === 'code' ? await saveCodeFileAs(tabId) : await saveNoteFileAs(tabId);

  if (!savedPath) {
    return;
  }

  closePendingCloseDialog();
  performCloseTab(tabId);
}

function handlePendingCloseDiscard() {
  if (!pendingCloseDialog.value) {
    return;
  }

  const { tabId } = pendingCloseDialog.value;
  closePendingCloseDialog();
  performCloseTab(tabId);
}

async function startEditing(tab: WorkspaceTabState) {
  tabMenu.value = null;
  editingTabId.value = tab.id;
  draftTitle.value = tab.title;

  await nextTick();
  editingInput.value?.focus();
  editingInput.value?.select();
}

function cancelEditing() {
  editingTabId.value = null;
  draftTitle.value = '';
}

function openTabMenu(event: MouseEvent, tab: WorkspaceTabState) {
  event.preventDefault();
  creationMenu.value = null;
  closeAllTabsDialog();
  tabMenu.value = {
    tabId: tab.id,
    x: event.clientX,
    y: event.clientY,
  };
}

function openCreationMenu(event?: MouseEvent) {
  event?.preventDefault();
  tabMenu.value = null;
  commandMenuOpen.value = false;
  closeAllTabsDialog();

  const fallbackRect = creationButtonRef.value?.getBoundingClientRect();
  const fallbackX = fallbackRect ? Math.round(fallbackRect.left + fallbackRect.width / 2) : 24;
  const fallbackY = fallbackRect ? Math.round(fallbackRect.bottom + 8) : 72;

  creationMenu.value = {
    x: event?.clientX ?? fallbackX,
    y: event?.clientY ?? fallbackY,
  };
  setActiveCreationMenuAction(getDefaultCreationMenuActionId());
}

function closeTabMenu() {
  tabMenu.value = null;
}

function closeCreationMenu() {
  creationMenu.value = null;
}

function toggleCommandMenu() {
  commandMenuOpen.value = !commandMenuOpen.value;
  tabMenu.value = null;
  creationMenu.value = null;
  closeAllTabsDialog();
}

function closeCommandMenu() {
  commandMenuOpen.value = false;
}

function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target;

  if (!(target instanceof Element)) {
    closeTabMenu();
    closeCreationMenu();
    closeCommandMenu();
    return;
  }

  if (!target.closest('.terminal-panel__menu')) {
    closeTabMenu();
    closeCreationMenu();
  }

  if (!target.closest('.terminal-panel__commands')) {
    closeCommandMenu();
  }

  if (!target.closest('.terminal-panel__switcher-filter')) {
    closeAllTabsFilterMenu();
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (handleAllTabsDialogKeydown(event)) {
    return;
  }

  if (handleCreationMenuKeydown(event)) {
    return;
  }

  if (event.key === 'Escape') {
    closeAllTabsDialog();
    closePendingCloseDialog();
    closeTabMenu();
    closeCreationMenu();
    closeCommandMenu();
  }
}

function saveEditing(tabId: string) {
  if (editingTabId.value !== tabId) {
    return;
  }

  const activeTab = tabs.value.find((tab) => tab.id === tabId);
  const fallbackTitle = activeTab
    ? (
      isEditableTab(activeTab)
        ? getPathLeafName(activeTab.filePath ?? '') || (activeTab.type === 'note' ? 'Notes' : 'Code')
        : 'Shell'
    )
    : 'Shell';
  const nextTitle = draftTitle.value.trim() || fallbackTitle;
  const nextTabs = tabs.value.map((tab) => (
    tab.id === tabId
      ? {
          ...tab,
          title: nextTitle,
        }
      : tab
  ));

  cancelEditing();
  syncState(nextTabs, activeTabId.value);
}

async function waitForSessionView(tabId: string) {
  const timeoutStartedAt = Date.now();

  while (!sessionViewRefs.has(tabId)) {
    if (Date.now() - timeoutStartedAt >= 10_000) {
      return null;
    }

    await nextTick();
    await sleep(40);
  }

  return sessionViewRefs.get(tabId) ?? null;
}

async function runPreset(preset: TerminalCommandPreset) {
  closeCommandMenu();
  tabMenu.value = null;
  creationMenu.value = null;

  const activeTab = tabs.value.find((tab) => tab.id === activeTabId.value) ?? null;
  let targetTabId = activeTab && isShellTab(activeTab) ? activeTab.id : null;

  if (preset.target === 'new-tab' || !targetTabId) {
    const nextTab = addShellTab();
    targetTabId = nextTab.id;
  } else {
    setActiveTab(targetTabId);
  }

  if (!targetTabId) {
    return false;
  }

  const sessionView = await waitForSessionView(targetTabId);

  if (!sessionView) {
    return false;
  }

  return sessionView.runPreset(preset);
}

async function executePresetBySlot(slot: number) {
  const preset = props.presets.find((item) => item.shortcutSlot === slot);

  if (!preset) {
    return false;
  }

  return runPreset(preset);
}

watch(
  [activeTabId, () => tabs.value.map((tab) => tab.id).join('|')],
  async () => {
    await nextTick();
    scrollTabIntoView(activeTabId.value);
  },
  { immediate: true },
);

watch(
  allTabsResults,
  (nextResults) => {
    if (!allTabsDialogOpen.value) {
      return;
    }

    const hasSelectedTab = nextResults.some((entry) => entry.tab.id === allTabsSelectedTabId.value);

    if (hasSelectedTab) {
      scrollSelectedAllTabsItemIntoView();
      return;
    }

    allTabsSelectedTabId.value = nextResults.find((entry) => entry.tab.id === activeTabId.value)?.tab.id
      ?? nextResults[0]?.tab.id
      ?? null;
    scrollSelectedAllTabsItemIntoView();
  },
  { deep: true },
);

watch(
  () => props.tabs,
  (nextTabs) => {
    tabs.value = cloneTabs(nextTabs);
    pruneTabActivityState(nextTabs);
    pruneExternalFileRuntimeState(nextTabs);
    editorPaneLayout.value = normalizeEditorPaneLayout(editorPaneLayout.value, nextTabs, activeTabId.value);
    pruneCodeNavigationRequests(editorPaneLayout.value);
    void pollExternalFileChanges();
  },
  { deep: true },
);

watch(
  () => props.editorPaneLayout,
  (nextEditorPaneLayout) => {
    editorPaneLayout.value = normalizeEditorPaneLayout(nextEditorPaneLayout, tabs.value, activeTabId.value);
    pruneCodeNavigationRequests(editorPaneLayout.value);
  },
  { deep: true },
);

watch(
  [tabRecentActivity, activeTabId, tabLastTypingAt, () => props.collapsed, tabs, interactedShellTabs],
  () => {
    if (isRestoringWorkspaceIndicators) {
      return;
    }

    emit('update:recent-activity', {
      workspaceId: props.workspaceId,
      recentActivity: buildVisualRecentActivity(),
    });
  },
  { deep: true, immediate: true },
);

watch(
  [tabAttention, tabLastInputAt, tabs, interactedShellTabs],
  () => {
    if (isRestoringWorkspaceIndicators) {
      return;
    }

    emit('update:attention', {
      workspaceId: props.workspaceId,
      attention: buildVisualAttention(),
    });
  },
  { deep: true, immediate: true },
);

watch(
  () => props.activeTabId,
  (nextActiveTabId) => {
    activeTabId.value = nextActiveTabId ?? props.tabs[0]?.id ?? null;
    editorPaneLayout.value = normalizeEditorPaneLayout(editorPaneLayout.value, tabs.value, activeTabId.value);

    if (activeTabId.value) {
      markShellTabAsStarted(activeTabId.value);
    }
  },
);

watch(
  () => props.cwd,
  (nextCwd) => {
    if (!tabs.value.length) {
      const nextTab = buildShellTab(nextCwd);
      syncState([nextTab], nextTab.id);
    }
  },
);

watch(
  () => props.workspaceId,
  async (nextWorkspaceId, previousWorkspaceId) => {
    if (!nextWorkspaceId || nextWorkspaceId === previousWorkspaceId) {
      return;
    }

    isRestoringWorkspaceIndicators = true;
    resetTransientTabState();
    await nextTick();
    restoreWorkspaceIndicatorState();
    isRestoringWorkspaceIndicators = false;
    emitWorkspaceIndicators();
  },
);

onMounted(async () => {
  tabs.value = cloneTabs(props.tabs);
  editorPaneLayout.value = normalizeEditorPaneLayout(props.editorPaneLayout, props.tabs, props.activeTabId ?? props.tabs[0]?.id ?? null);
  activeTabId.value = props.activeTabId ?? props.tabs[0]?.id ?? null;
  if (activeTabId.value) {
    markShellTabAsStarted(activeTabId.value);
  }
  restoreWorkspaceIndicatorState();
  ensureTab();
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
  startExternalFilePolling();
  void pollExternalFileChanges();

  await nextTick();
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
  stopExternalFilePolling();
  clearTabDragState();
  emit('update:recent-activity', {
    workspaceId: props.workspaceId,
    recentActivity: {},
  });
  emit('update:attention', {
    workspaceId: props.workspaceId,
    attention: {},
  });
  tabs.value.forEach((tab) => {
    clearTabActivity(tab.id);
    clearTabAttention(tab.id);
    clearTabLastInput(tab.id);
    clearTabLastTyping(tab.id);
    clearTabLastSubmit(tab.id);
  });
});

defineExpose({
  addShellTab,
  addNoteTab,
  closeActiveTab,
  closeEditorPane: (direction: 'left' | 'right' | 'up' | 'down') => closeEditorPane(direction),
  focusPreviousTab: () => selectAdjacentTab(-1),
  focusNextTab: () => selectAdjacentTab(1),
  executePresetBySlot,
  openAllTabsDialog,
  openCreationMenu: () => openCreationMenu(),
  openFile: () => openWorkspaceFile(),
  openNoteFilePath: (filePath: string) => openNoteFilePath(filePath),
  openWorkspaceFilePath: (filePath: string) => openWorkspaceFilePath(filePath),
  openNavigationTarget: (target: CodeNavigationTarget) => openCodeNavigationTarget(target),
  splitEditorPane: (direction: 'left' | 'right' | 'up' | 'down') => splitEditorPane(direction),
});
</script>

<template>
  <section class="terminal-panel" :data-appearance-theme="props.appearanceTheme">
    <header class="terminal-panel__tabs-header">
      <div class="terminal-panel__tabs" role="tablist" aria-label="Tabs panel">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          :ref="(element) => setTabRef(tab.id, element)"
          class="terminal-panel__tab"
          :class="{
            'terminal-panel__tab--active': hasTabActiveChrome(tab),
            'terminal-panel__tab--editing': editingTabId === tab.id,
            'terminal-panel__tab--dragging': tab.id === draggedTabId,
            'terminal-panel__tab--drop-target': tab.id === dropTargetTabId && tab.id !== draggedTabId,
          }"
          :draggable="sortedTabCount > 1 && editingTabId !== tab.id"
          @click="handleTabClick(tab.id)"
          @contextmenu="openTabMenu($event, tab)"
          @dragstart="handleTabDragStart($event, tab.id)"
          @dragover="handleTabDragOver($event, tab.id)"
          @drop.prevent="handleTabDrop(tab.id)"
          @dragend="clearTabDragState"
        >
            <span
              class="terminal-panel__tab-dot"
              :class="{
                'terminal-panel__tab-dot--note-file': editableTabHasSavedFile(tab) && !isEditableTabDirty(tab),
                'terminal-panel__tab-dot--note-dirty': isEditableTabDirty(tab),
                'terminal-panel__tab-dot--attention': hasAttention(tab.id),
                'terminal-panel__tab-dot--current': tab.id === activeTabId && showsShellTabIndicator(tab),
                'terminal-panel__tab-dot--active': isTabActive(tab.id),
            }"
            aria-hidden="true"
          />

          <input
            v-if="editingTabId === tab.id"
            v-model="draftTitle"
            :ref="setEditingInput"
            class="terminal-panel__tab-input"
            type="text"
            maxlength="32"
            @blur="saveEditing(tab.id)"
            @keydown.enter.prevent="saveEditing(tab.id)"
            @keydown.esc.prevent="cancelEditing"
          />
          <button
            v-else
            class="terminal-panel__tab-button"
            type="button"
            role="tab"
            :aria-selected="tab.id === activeTabId"
            :title="tabTitleTooltip(tab)"
            @dblclick="startEditing(tab)"
          >
            <span class="terminal-panel__tab-label">
              {{ tabDisplayTitle(tab) }}
            </span>
          </button>

          <button
            v-if="sortedTabCount > 1"
            class="terminal-panel__tab-close"
            type="button"
            :title="`Close ${tabDisplayTitle(tab)}`"
            :aria-label="`Close ${tabDisplayTitle(tab)}`"
            @click.stop="requestCloseTab(tab.id)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8" />
              <path d="M12 4 4 12" />
            </svg>
          </button>
        </div>

        <button
          :ref="setCreationButtonRef"
          class="terminal-panel__add terminal-panel__add--inline"
          type="button"
          title="Create workspace tab"
          aria-label="Create workspace tab"
          @click="openCreationMenu"
          @contextmenu="openCreationMenu"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M11.25 5.25a.75.75 0 0 1 1.5 0v6h6a.75.75 0 0 1 0 1.5h-6v6a.75.75 0 0 1-1.5 0v-6h-6a.75.75 0 0 1 0-1.5h6v-6Z" />
          </svg>
        </button>
      </div>

      <div class="terminal-panel__controls">
        <button
          class="terminal-panel__all-tabs"
          type="button"
          :title="`Show all tabs ${SHORTCUTS.workspaceAllTabs.display} (${sortedTabCount})`"
          aria-label="Show all tabs"
          @click="openAllTabsDialog"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5.25 7.25h13.5" />
            <path d="M5.25 12h13.5" />
            <path d="M5.25 16.75h13.5" />
          </svg>
          <span class="terminal-panel__all-tabs-copy">Tabs</span>
          <span class="terminal-panel__all-tabs-count">{{ sortedTabCount }}</span>
        </button>

        <div class="terminal-panel__commands">
          <button
            class="terminal-panel__commands-button"
            type="button"
            :disabled="!sortedPresets.length"
            :title="sortedPresets.length ? 'Run command preset' : 'No command presets configured'"
            aria-label="Run command preset"
            @click="toggleCommandMenu"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4.75 6A2.75 2.75 0 0 1 7.5 3.25h9A2.75 2.75 0 0 1 19.25 6v12A2.75 2.75 0 0 1 16.5 20.75h-9A2.75 2.75 0 0 1 4.75 18V6Zm2.75-1.25C6.81 4.75 6.25 5.31 6.25 6v12c0 .69.56 1.25 1.25 1.25h9c.69 0 1.25-.56 1.25-1.25V6c0-.69-.56-1.25-1.25-1.25h-9Zm1.25 3.5a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1-.75-.75Zm0 3.5a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1-.75-.75Zm0 3.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Z"
              />
            </svg>
          </button>

          <div
            v-if="commandMenuOpen && sortedPresets.length"
            class="terminal-panel__menu terminal-panel__commands-menu"
            @pointerdown.stop
          >
            <button
              v-for="preset in sortedPresets"
              :key="preset.id"
              class="terminal-panel__menu-item terminal-panel__menu-item--command"
              type="button"
              @click="runPreset(preset)"
            >
              <span class="terminal-panel__menu-copy">
                <span class="terminal-panel__menu-label">{{ preset.name }}</span>
                <span class="terminal-panel__menu-meta">
                  {{ preset.target === 'new-tab' ? 'New shell tab' : 'Active shell tab' }}
                </span>
              </span>
              <code v-if="preset.shortcutSlot" class="terminal-panel__menu-shortcut">
                {{ formatCommandSlotShortcut(preset.shortcutSlot) }}
              </code>
            </button>
          </div>
        </div>

        <button
          class="terminal-panel__collapse"
          type="button"
          :disabled="!canCollapse"
          :title="collapseButtonTitle"
          aria-label="Collapse tabs panel"
          @click="emit('toggle-collapse')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.75 11.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H6.75Z" />
          </svg>
        </button>
      </div>
    </header>

    <div class="terminal-panel__views">
      <template v-for="tab in tabs" :key="tab.id">
        <TerminalSessionView
          v-if="tab.type === 'shell' && shouldMountShellTab(tab)"
          :key="buildWorkspaceTabRuntimeKey(props.workspaceId, tab.id)"
          :ref="(instance) => setSessionViewRef(tab.id, instance)"
          class="terminal-panel__view"
          :class="{ 'terminal-panel__view--active': tab.id === activeTabId }"
          :session-key="buildWorkspaceTabRuntimeKey(props.workspaceId, tab.id)"
          :cwd="tab.cwd"
          :font-size="tab.fontSize"
          :appearance-theme="props.appearanceTheme"
          :appearance-theme-variant="props.appearanceThemeVariant"
          :active="tab.id === activeTabId && !collapsed"
          :reconnect-token="reconnectTokens[tab.id] ?? 0"
          @activate="handleTerminalViewActivate(tab.id)"
          @activity="handleTabActivity(tab.id)"
          @input="handleTabInput(tab.id, $event)"
          @update:font-size="updateShellFontSize(tab.id, $event)"
        />

        <NoteTabView
          v-else-if="tab.type === 'note'"
          :key="buildWorkspaceTabRuntimeKey(props.workspaceId, tab.id)"
          class="terminal-panel__view"
          :class="{ 'terminal-panel__view--active': tab.id === activeTabId }"
          :active="tab.id === activeTabId && !collapsed"
          :busy="Boolean(noteBusyByTabId[tab.id])"
          :content="tab.content"
          :file-path="tab.filePath"
          :project-root="props.projectRoot"
          :appearance-theme="props.appearanceTheme"
          :appearance-theme-variant="props.appearanceThemeVariant"
          :is-dirty="tab.content !== tab.savedContent"
          :external-change="externalFileChangeByTabId[tab.id] ?? null"
          :view-mode="tab.viewMode"
          :font-size="tab.fontSize"
          @focus-previous-tab="selectAdjacentTab(-1)"
          @focus-next-tab="selectAdjacentTab(1)"
          @open-file="openWorkspaceFile(tab.id)"
          @open-note-link="openNoteFilePath($event, tab.id)"
          @reload-from-disk="reloadEditableTabFromDisk(tab.id)"
          @save-file="saveNoteFile(tab.id)"
          @save-file-as="saveNoteFileAs(tab.id)"
          @dismiss-external-change="dismissExternalFileChange(tab.id)"
          @update:content="updateNoteContent(tab.id, $event)"
          @update:font-size="updateNoteFontSize(tab.id, $event)"
          @update:view-mode="updateNoteViewMode(tab.id, $event)"
        />

        <CodeTabView
          v-else-if="tab.type === 'code' && !usesEditorPaneLayout"
          :key="buildWorkspaceTabRuntimeKey(props.workspaceId, tab.id)"
          class="terminal-panel__view"
          :class="{ 'terminal-panel__view--active': tab.id === activeTabId }"
          :active="tab.id === activeTabId && !collapsed"
          :busy="Boolean(noteBusyByTabId[tab.id])"
          :content="tab.content"
          :file-path="tab.filePath"
          :project-root="props.projectRoot"
          :editor-theme="props.editorTheme"
          :theme-variant="props.editorThemeVariant"
          :navigation-request="null"
          :is-dirty="tab.content !== tab.savedContent"
          :external-change="externalFileChangeByTabId[tab.id] ?? null"
          :font-size="tab.fontSize"
          @focus-previous-tab="selectAdjacentTab(-1)"
          @focus-next-tab="selectAdjacentTab(1)"
          @open-file="openWorkspaceFile(tab.id)"
          @open-navigation-target="openCodeNavigationTarget($event)"
          @reload-from-disk="reloadEditableTabFromDisk(tab.id)"
          @save-file="saveCodeFile(tab.id)"
          @save-file-as="saveCodeFileAs(tab.id)"
          @dismiss-external-change="dismissExternalFileChange(tab.id)"
          @update:content="updateCodeContent(tab.id, $event)"
          @update:font-size="updateCodeFontSize(tab.id, $event)"
        />
      </template>

      <div
        v-if="usesEditorPaneLayout && visibleEditorPanes.length"
        class="terminal-panel__editor-panes"
        :style="editorPaneGridStyle"
      >
        <section
          v-for="entry in visibleEditorPanes"
          :key="`${entry.pane.id}:${entry.tab.id}`"
          class="terminal-panel__editor-pane"
          :class="{ 'terminal-panel__editor-pane--active': entry.pane.id === editorPaneLayout.activePaneId }"
          :style="{
            gridColumn: String(entry.pane.col + 1),
            gridRow: String(entry.pane.row + 1),
          }"
          @pointerdown="setActiveEditorPane(entry.pane.id)"
        >
          <header class="terminal-panel__editor-pane-header">
            <button
              class="terminal-panel__editor-pane-title"
              type="button"
              :title="entry.tab.filePath"
              @click="setActiveEditorPane(entry.pane.id)"
            >
              {{ entry.tab.title }}
            </button>

            <div class="terminal-panel__editor-pane-actions">
              <button
                class="terminal-panel__editor-pane-action"
                type="button"
                :title="`Split right ${SHORTCUTS.editorPaneSplitRight.display}`"
                :aria-label="`Split ${entry.tab.title} to the right`"
                @click.stop="splitSpecificEditorPane(entry.pane.id, 'right')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4.75 6A1.25 1.25 0 0 1 6 4.75h12A1.25 1.25 0 0 1 19.25 6v12A1.25 1.25 0 0 1 18 19.25H6A1.25 1.25 0 0 1 4.75 18V6Z" />
                  <path d="M12 4.75v14.5" />
                  <path d="M15.75 12h4.5" />
                </svg>
              </button>

              <button
                class="terminal-panel__editor-pane-action"
                type="button"
                :title="`Split down ${SHORTCUTS.editorPaneSplitDown.display}`"
                :aria-label="`Split ${entry.tab.title} down`"
                @click.stop="splitSpecificEditorPane(entry.pane.id, 'down')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4.75 6A1.25 1.25 0 0 1 6 4.75h12A1.25 1.25 0 0 1 19.25 6v12A1.25 1.25 0 0 1 18 19.25H6A1.25 1.25 0 0 1 4.75 18V6Z" />
                  <path d="M4.75 12h14.5" />
                  <path d="M12 15.75v4.5" />
                </svg>
              </button>

              <button
                class="terminal-panel__editor-pane-action"
                type="button"
                :disabled="visibleEditorPanes.length <= 1"
                title="Close pane"
                :aria-label="`Close pane for ${entry.tab.title}`"
                @click.stop="closeSpecificEditorPane(entry.pane.id)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 7l10 10" />
                  <path d="M17 7 7 17" />
                </svg>
              </button>
            </div>
          </header>

          <CodeTabView
            :key="buildWorkspaceTabRuntimeKey(props.workspaceId, `${entry.pane.id}:${entry.tab.id}`)"
            class="terminal-panel__editor-pane-view"
            :active="entry.pane.id === editorPaneLayout.activePaneId && !collapsed"
            :busy="Boolean(noteBusyByTabId[entry.tab.id])"
            :content="entry.tab.content"
            :file-path="entry.tab.filePath"
            :project-root="props.projectRoot"
            :editor-theme="props.editorTheme"
            :theme-variant="props.editorThemeVariant"
            :navigation-request="codeNavigationRequestByPaneId[entry.pane.id] ?? null"
            :is-dirty="entry.tab.content !== entry.tab.savedContent"
            :external-change="externalFileChangeByTabId[entry.tab.id] ?? null"
            :font-size="entry.tab.fontSize"
            @focus-previous-tab="selectAdjacentTab(-1)"
            @focus-next-tab="selectAdjacentTab(1)"
            @open-file="openWorkspaceFile(entry.tab.id)"
            @open-navigation-target="openCodeNavigationTarget($event)"
            @reload-from-disk="reloadEditableTabFromDisk(entry.tab.id)"
            @save-file="saveCodeFile(entry.tab.id)"
            @save-file-as="saveCodeFileAs(entry.tab.id)"
            @dismiss-external-change="dismissExternalFileChange(entry.tab.id)"
            @update:content="updateCodeContent(entry.tab.id, $event)"
            @update:font-size="updateCodeFontSize(entry.tab.id, $event)"
          />
        </section>
      </div>
    </div>

    <div
      v-if="allTabsDialogOpen"
      class="terminal-panel__switcher-backdrop"
      @click.self="closeAllTabsDialog"
    >
      <section
        class="terminal-panel__switcher"
        role="dialog"
        aria-modal="true"
        aria-label="All tabs"
        @click.stop
      >
        <header class="terminal-panel__switcher-header">
          <div class="terminal-panel__switcher-heading">
            <span class="terminal-panel__switcher-eyebrow">Workspace</span>
            <h3 class="terminal-panel__switcher-title">All Tabs</h3>
            <p class="terminal-panel__switcher-meta">
              {{ sortedTabCount.toLocaleString() }} open
              <span v-if="activeWorkspaceTab">current: {{ activeWorkspaceTab.title }}</span>
            </p>
          </div>

          <button
            class="terminal-panel__switcher-close"
            type="button"
            aria-label="Close all tabs list"
            @click="closeAllTabsDialog"
          >
            ×
          </button>
        </header>

        <div class="terminal-panel__switcher-toolbar">
          <label class="terminal-panel__switcher-search">
            <span class="terminal-panel__switcher-search-label">Search tabs</span>
            <input
              :ref="setAllTabsSearchInput"
              v-model="allTabsSearchQuery"
              class="terminal-panel__switcher-search-input"
              type="text"
              placeholder="title, file path, shell cwd"
              @keydown="handleAllTabsDialogKeydown"
            >
          </label>

          <div class="terminal-panel__switcher-filter">
            <span class="terminal-panel__switcher-search-label">Type</span>
            <button
              :ref="setAllTabsFilterButtonRef"
              class="terminal-panel__switcher-filter-button"
              type="button"
              :aria-expanded="allTabsFilterMenuOpen"
              aria-haspopup="menu"
              aria-label="Filter tabs by type"
              @click="toggleAllTabsFilterMenu"
            >
              <span>{{ activeAllTabsTypeFilterLabel }}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.5 6.25 8 9.75l3.5-3.5" />
              </svg>
            </button>

            <div
              v-if="allTabsFilterMenuOpen"
              class="terminal-panel__switcher-filter-menu terminal-panel__menu"
              role="menu"
              @pointerdown.stop
            >
              <button
                v-for="option in ALL_TABS_TYPE_FILTER_OPTIONS"
                :key="option.value"
                class="terminal-panel__menu-item"
                :class="{ 'terminal-panel__menu-item--selected': allTabsTypeFilter === option.value }"
                type="button"
                role="menuitemradio"
                :aria-checked="allTabsTypeFilter === option.value"
                @click="setAllTabsTypeFilter(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </div>

        <div class="terminal-panel__switcher-body">
          <div
            v-if="allTabsResults.length"
            class="terminal-panel__switcher-list"
            role="listbox"
            aria-label="Open workspace tabs"
          >
            <button
              v-for="entry in allTabsResults"
              :key="entry.tab.id"
              :ref="(element) => setAllTabsItemRef(entry.tab.id, element)"
              class="terminal-panel__switcher-item"
              :class="{
                'terminal-panel__switcher-item--selected': entry.tab.id === allTabsSelectedTabId,
                'terminal-panel__switcher-item--active': entry.tab.id === activeTabId,
              }"
              type="button"
              role="option"
              :aria-selected="entry.tab.id === allTabsSelectedTabId"
              @mouseenter="selectAllTabsItem(entry.tab.id)"
              @click="activateAllTabsItem(entry.tab.id)"
            >
              <span
                class="terminal-panel__switcher-dot"
                :class="{
                  'terminal-panel__switcher-dot--dirty': isEditableTabDirty(entry.tab),
                  'terminal-panel__switcher-dot--attention': hasAttention(entry.tab.id),
                  'terminal-panel__switcher-dot--active': entry.tab.id === activeTabId,
                }"
                aria-hidden="true"
              />

              <span class="terminal-panel__switcher-copy">
                <span class="terminal-panel__switcher-row">
                  <span class="terminal-panel__switcher-name">{{ entry.tab.title }}</span>
                  <span class="terminal-panel__switcher-badges">
                    <span class="terminal-panel__switcher-badge terminal-panel__switcher-badge--type">
                      {{ entry.typeLabel }}
                    </span>
                    <span v-if="entry.paneCount > 1" class="terminal-panel__switcher-badge">
                      {{ entry.paneCount }} panes
                    </span>
                    <span
                      v-if="isEditableTabDirty(entry.tab)"
                      class="terminal-panel__switcher-badge terminal-panel__switcher-badge--dirty"
                    >
                      Dirty
                    </span>
                  </span>
                </span>
                <span v-if="entry.secondaryMeta" class="terminal-panel__switcher-path">{{ entry.secondaryMeta }}</span>
              </span>
            </button>
          </div>

          <div v-else class="terminal-panel__switcher-empty">
            No tabs match the current search.
          </div>
        </div>
      </section>
    </div>

    <div
      v-if="tabMenu && menuTab"
      class="terminal-panel__menu"
      :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
      @pointerdown.stop
    >
      <button
        class="terminal-panel__menu-item"
        type="button"
        @click="startEditing(menuTab)"
      >
        Rename
      </button>

      <button
        v-if="menuTab.type === 'shell'"
        class="terminal-panel__menu-item"
        type="button"
        @click="reconnectTab(menuTab.id)"
      >
        Reconnect shell
      </button>

      <button
        v-if="sortedTabCount > 1"
        class="terminal-panel__menu-item terminal-panel__menu-item--danger"
        type="button"
        @click="requestCloseTab(menuTab.id)"
      >
        Close tab
      </button>
    </div>

    <div
      v-if="pendingCloseDialog"
      class="terminal-panel__dialog-backdrop"
      @click="closePendingCloseDialog"
    >
      <section
        class="terminal-panel__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm tab close"
        @click.stop
      >
        <span class="terminal-panel__dialog-eyebrow">
          {{ pendingCloseDialog.kind === 'shell'
            ? 'Shell activity'
            : (pendingCloseDialog.kind === 'code' ? 'Unsaved file' : 'Unsaved note') }}
        </span>
        <h3 class="terminal-panel__dialog-title">
          Close {{ pendingCloseDialog.title }}?
        </h3>
        <p class="terminal-panel__dialog-copy">
          {{ pendingCloseDialog.kind === 'note'
            ? (pendingCloseDialog.hasSavedFile
              ? 'This note has unsaved changes. Save it before closing, save a copy under a new file name, or discard the changes.'
              : 'This scratch note has unsaved changes. Save it before closing or discard the changes.')
            : pendingCloseDialog.kind === 'code'
              ? 'This file has unsaved changes. Save it before closing, save a copy under a new file name, or discard the changes.'
              : (pendingCloseDialog.hasAttention
                ? 'This shell tab still needs attention. Close it anyway?'
                : 'This shell tab still shows recent activity. Close it anyway?') }}
        </p>

        <div class="terminal-panel__dialog-actions">
          <template v-if="pendingCloseDialog.kind !== 'shell'">
            <button
              class="terminal-panel__dialog-button terminal-panel__dialog-button--primary"
              type="button"
              @click="handlePendingCloseSave"
            >
              Save
            </button>
            <button
              v-if="pendingCloseDialog.hasSavedFile"
              class="terminal-panel__dialog-button"
              type="button"
              @click="handlePendingCloseSaveAs"
            >
              Save As
            </button>
          </template>

          <button
            class="terminal-panel__dialog-button terminal-panel__dialog-button--danger"
            type="button"
            @click="handlePendingCloseDiscard"
          >
            {{ pendingCloseDialog.kind === 'shell' ? 'Close anyway' : 'Discard' }}
          </button>
          <button
            class="terminal-panel__dialog-button"
            type="button"
            @click="closePendingCloseDialog"
          >
            Cancel
          </button>
        </div>
      </section>
    </div>

    <div
      v-if="creationMenu"
      class="terminal-panel__menu"
      :style="{ left: `${creationMenu.x}px`, top: `${creationMenu.y}px` }"
      @pointerdown.stop
    >
      <button
        v-for="action in creationMenuActions"
        :key="action.id"
        :ref="(element) => setCreationMenuItemRef(action.id, element)"
        class="terminal-panel__menu-item"
        :class="{
          'terminal-panel__menu-item--selected': action.id === creationMenuActiveActionId,
        }"
        type="button"
        @focus="setActiveCreationMenuAction(action.id, false)"
        @mouseenter="setActiveCreationMenuAction(action.id, false)"
        @click="activateCreationMenuAction(action.id)"
      >
        {{ action.label }}
        <span class="terminal-panel__menu-shortcuts">
          <code
            v-for="shortcutPart in splitShortcutDisplay(action.shortcutDisplay)"
            :key="`${action.id}-${shortcutPart}`"
            class="terminal-panel__menu-shortcut"
          >
            [{{ shortcutPart }}]
          </code>
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.terminal-panel {
  --terminal-panel-tab-bg: rgba(13, 18, 24, 0.84);
  --terminal-panel-tab-active-bg: rgba(21, 29, 39, 0.96);
  --terminal-panel-tab-hover-bg: rgba(18, 25, 33, 0.92);
  --terminal-panel-close-hover-bg: rgba(255, 255, 255, 0.08);
  --terminal-panel-close-hover-color: #f6fbff;
  --terminal-panel-close-focus-bg: rgba(110, 197, 255, 0.16);
  --terminal-panel-control-bg: rgba(14, 20, 27, 0.88);
  --terminal-panel-menu-bg: rgba(10, 14, 19, 0.98);
  --terminal-panel-menu-hover-bg: rgba(24, 33, 43, 0.92);
  --terminal-panel-menu-shortcut-bg: rgba(8, 12, 17, 0.42);
  --terminal-panel-dialog-backdrop: rgba(2, 5, 8, 0.5);
  --terminal-panel-dialog-bg:
    linear-gradient(160deg, rgba(69, 151, 250, 0.08), transparent 34%),
    rgba(10, 14, 19, 0.98);
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  min-height: 0;
}

.terminal-panel[data-appearance-theme='bridgegit-light'] {
  --terminal-panel-tab-bg: rgba(236, 242, 249, 0.96);
  --terminal-panel-tab-active-bg: rgba(224, 234, 244, 0.98);
  --terminal-panel-tab-hover-bg: rgba(230, 238, 247, 0.98);
  --terminal-panel-close-hover-bg: rgba(45, 124, 216, 0.1);
  --terminal-panel-close-hover-color: #1d3b5d;
  --terminal-panel-close-focus-bg: rgba(45, 124, 216, 0.14);
  --terminal-panel-control-bg: rgba(236, 242, 249, 0.98);
  --terminal-panel-menu-bg: rgba(255, 255, 255, 0.98);
  --terminal-panel-menu-hover-bg: rgba(230, 238, 247, 0.98);
  --terminal-panel-menu-shortcut-bg: rgba(236, 242, 249, 0.98);
  --terminal-panel-dialog-backdrop: rgba(214, 224, 237, 0.58);
  --terminal-panel-dialog-bg:
    linear-gradient(160deg, rgba(88, 154, 225, 0.08), transparent 34%),
    rgba(248, 251, 255, 0.98);
}

.terminal-panel[data-appearance-theme='github-dark'] {
  --terminal-panel-tab-bg: #161b22;
  --terminal-panel-tab-active-bg: #21262d;
  --terminal-panel-tab-hover-bg: #30363d;
  --terminal-panel-close-hover-bg: rgba(88, 166, 255, 0.12);
  --terminal-panel-close-hover-color: #c9d1d9;
  --terminal-panel-close-focus-bg: rgba(88, 166, 255, 0.16);
  --terminal-panel-control-bg: #21262d;
  --terminal-panel-menu-bg: #161b22;
  --terminal-panel-menu-hover-bg: #21262d;
  --terminal-panel-menu-shortcut-bg: rgba(13, 17, 23, 0.42);
  --terminal-panel-dialog-backdrop: rgba(1, 4, 9, 0.58);
  --terminal-panel-dialog-bg:
    linear-gradient(160deg, rgba(56, 139, 253, 0.08), transparent 34%),
    #0d1117;
}

.terminal-panel[data-appearance-theme='github-light'] {
  --terminal-panel-tab-bg: #f6f8fa;
  --terminal-panel-tab-active-bg: #eef2f6;
  --terminal-panel-tab-hover-bg: #f0f3f6;
  --terminal-panel-close-hover-bg: rgba(9, 105, 218, 0.12);
  --terminal-panel-close-hover-color: #1f3f63;
  --terminal-panel-close-focus-bg: rgba(9, 105, 218, 0.16);
  --terminal-panel-control-bg: #f6f8fa;
  --terminal-panel-menu-bg: #ffffff;
  --terminal-panel-menu-hover-bg: #eef2f6;
  --terminal-panel-menu-shortcut-bg: rgba(246, 248, 250, 0.98);
  --terminal-panel-dialog-backdrop: rgba(208, 215, 222, 0.46);
  --terminal-panel-dialog-bg:
    linear-gradient(160deg, rgba(9, 105, 218, 0.06), transparent 34%),
    #ffffff;
}

.terminal-panel[data-appearance-theme='nord'] {
  --terminal-panel-tab-bg: rgba(59, 66, 82, 0.94);
  --terminal-panel-tab-active-bg: rgba(67, 76, 94, 0.98);
  --terminal-panel-tab-hover-bg: rgba(76, 86, 106, 0.98);
  --terminal-panel-close-hover-bg: rgba(136, 192, 208, 0.14);
  --terminal-panel-close-hover-color: #e5e9f0;
  --terminal-panel-close-focus-bg: rgba(136, 192, 208, 0.18);
  --terminal-panel-control-bg: rgba(67, 76, 94, 0.96);
  --terminal-panel-menu-bg: rgba(46, 52, 64, 0.98);
  --terminal-panel-menu-hover-bg: rgba(59, 66, 82, 0.96);
  --terminal-panel-menu-shortcut-bg: rgba(46, 52, 64, 0.5);
  --terminal-panel-dialog-backdrop: rgba(36, 41, 51, 0.58);
  --terminal-panel-dialog-bg:
    linear-gradient(160deg, rgba(136, 192, 208, 0.08), transparent 34%),
    rgba(46, 52, 64, 0.98);
}

.terminal-panel__tabs-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px 0;
}

.terminal-panel__tabs {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
}

.terminal-panel__controls {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  margin-left: auto;
}

.terminal-panel__commands {
  position: relative;
}

.terminal-panel__tab {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 4px;
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--terminal-panel-tab-bg);
  padding: 3px 6px 3px 10px;
  cursor: pointer;
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    box-shadow 140ms ease;
}

.terminal-panel__tab--active {
  border-color: rgba(110, 197, 255, 0.36);
  background: var(--terminal-panel-tab-active-bg);
  box-shadow: inset 0 0 0 1px rgba(110, 197, 255, 0.08);
}

.terminal-panel__tab:hover {
  border-color: rgba(110, 197, 255, 0.18);
  background: var(--terminal-panel-tab-hover-bg);
}

.terminal-panel__tab--editing {
  cursor: text;
}

.terminal-panel__tab--dragging {
  opacity: 0.56;
}

.terminal-panel__tab--drop-target {
  border-color: rgba(111, 224, 165, 0.48);
  box-shadow: inset 0 0 0 1px rgba(111, 224, 165, 0.18);
}

.terminal-panel__tab-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  margin-right: 2px;
  border-radius: 999px;
  background: rgba(108, 124, 148, 0.48);
}

.terminal-panel__tab-dot--note-file {
  background: rgba(108, 124, 148, 0.68);
  box-shadow: 0 0 0 1px rgba(108, 124, 148, 0.18);
}

.terminal-panel__tab-dot--note-dirty {
  background: rgba(255, 176, 102, 0.82);
  box-shadow: 0 0 0 1px rgba(255, 176, 102, 0.24);
}

.terminal-panel__tab-dot--current {
  background: rgba(111, 224, 165, 0.72);
  box-shadow: 0 0 0 1px rgba(111, 224, 165, 0.28);
}

.terminal-panel__tab-dot--note-dirty.terminal-panel__tab-dot--current {
  background: rgba(255, 176, 102, 0.82);
  box-shadow: 0 0 0 1px rgba(255, 176, 102, 0.24);
}

.terminal-panel__tab-dot--active {
  background: #6cb0ff;
  box-shadow: 0 0 12px rgba(108, 176, 255, 0.42);
  animation: terminal-panel-tab-pulse 1.4s ease-in-out infinite;
}

.terminal-panel__tab-dot--attention {
  background: rgba(255, 176, 102, 0.72);
  box-shadow: 0 0 0 1px rgba(255, 176, 102, 0.22);
}

.terminal-panel__tab-button,
.terminal-panel__tab-input,
.terminal-panel__tab-close,
.terminal-panel__add,
.terminal-panel__commands-button,
.terminal-panel__collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-primary);
}

.terminal-panel__tab-button {
  min-width: 0;
  max-width: 176px;
  padding: 0.55rem 0 0.55rem 0;
  overflow: hidden;
  font-weight: 600;
  color: var(--text-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-panel__tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.terminal-panel__tab-input {
  width: 132px;
  min-width: 0;
  padding: 0.48rem 0 0.48rem 0;
  border: 0;
  background: transparent;
  color: rgba(216, 224, 236, 0.92);
}

.terminal-panel__tab--active .terminal-panel__tab-button {
  color: var(--text-muted);
}

.terminal-panel__add,
.terminal-panel__commands-button,
.terminal-panel__collapse {
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 9px;
}

.terminal-panel__tab-close {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  margin-right: 2px;
  border-radius: 6px;
  color: rgba(178, 190, 204, 0.78);
  opacity: 0.84;
  transition:
    color 140ms ease,
    background-color 140ms ease,
    opacity 140ms ease;
}

.terminal-panel__tab:hover .terminal-panel__tab-close,
.terminal-panel__tab--active .terminal-panel__tab-close {
  color: rgba(224, 232, 241, 0.92);
  opacity: 1;
}

.terminal-panel__tab-close:hover,
.terminal-panel__add:hover,
.terminal-panel__commands-button:hover,
.terminal-panel__collapse:hover {
  border-color: rgba(110, 197, 255, 0.2);
  background: var(--terminal-panel-menu-hover-bg);
}

.terminal-panel__tab-close:hover {
  color: var(--terminal-panel-close-hover-color);
  background: var(--terminal-panel-close-hover-bg);
}

.terminal-panel__tab-close:focus-visible {
  outline: none;
  background: var(--terminal-panel-close-focus-bg);
  color: var(--terminal-panel-close-hover-color);
  opacity: 1;
}

.terminal-panel__tab-close svg,
.terminal-panel__all-tabs svg,
.terminal-panel__add svg,
.terminal-panel__commands-button svg,
.terminal-panel__collapse svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}

.terminal-panel__tab-close svg {
  width: 14px;
  height: 14px;
  stroke-width: 2.35;
}

.terminal-panel__add {
  border: 1px solid var(--border-subtle);
  background: var(--terminal-panel-control-bg);
  color: var(--text-primary);
}

.terminal-panel__all-tabs {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--terminal-panel-control-bg);
  color: var(--text-primary);
  white-space: nowrap;
}

.terminal-panel__all-tabs:hover {
  border-color: rgba(110, 197, 255, 0.2);
  background: var(--terminal-panel-menu-hover-bg);
}

.terminal-panel__all-tabs-copy {
  font-size: 0.76rem;
  font-weight: 600;
}

.terminal-panel__all-tabs-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(110, 197, 255, 0.14);
  color: var(--text-muted);
  font-size: 0.72rem;
  font-weight: 700;
}

.terminal-panel__collapse {
  border: 1px solid var(--border-subtle);
  background: var(--terminal-panel-control-bg);
  color: var(--text-primary);
}

.terminal-panel__commands-button {
  border: 1px solid var(--border-subtle);
  background: var(--terminal-panel-control-bg);
  color: var(--text-primary);
}

.terminal-panel__commands-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@keyframes terminal-panel-tab-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }

  50% {
    transform: scale(1.14);
    opacity: 0.82;
  }
}

.terminal-panel__views {
  position: relative;
  min-height: 0;
}

.terminal-panel__editor-panes {
  display: grid;
  gap: 12px;
  min-height: 0;
  height: 100%;
}

.terminal-panel__editor-pane {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  overflow: hidden;
  background: rgba(10, 14, 19, 0.82);
}

.terminal-panel__editor-pane--active {
  border-color: rgba(110, 197, 255, 0.34);
  box-shadow: inset 0 0 0 1px rgba(110, 197, 255, 0.12);
}

.terminal-panel__editor-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.12);
  background: rgba(15, 20, 27, 0.92);
}

.terminal-panel__editor-pane-title {
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.terminal-panel__editor-pane--active .terminal-panel__editor-pane-title {
  color: var(--text-primary);
}

.terminal-panel__editor-pane-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.terminal-panel__editor-pane-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(108, 124, 148, 0.18);
  border-radius: 8px;
  background: rgba(10, 14, 19, 0.32);
  color: var(--text-muted);
}

.terminal-panel__editor-pane-action:hover:not(:disabled) {
  border-color: rgba(110, 197, 255, 0.24);
  background: rgba(24, 33, 43, 0.86);
  color: var(--text-primary);
}

.terminal-panel__editor-pane-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.terminal-panel__editor-pane-action svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.terminal-panel__editor-pane-view {
  min-width: 0;
  min-height: 0;
}

.terminal-panel__menu {
  position: fixed;
  z-index: 12;
  display: grid;
  gap: 2px;
  min-width: 150px;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--terminal-panel-menu-bg);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.36);
}

.terminal-panel__commands-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  left: auto;
  min-width: 280px;
}

.terminal-panel__menu-shortcuts {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.terminal-panel__menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
  padding: 0.52rem 0.68rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  text-align: left;
}

.terminal-panel__menu-item--command {
  justify-content: space-between;
  gap: 12px;
}

.terminal-panel__menu-item:hover {
  background: var(--terminal-panel-menu-hover-bg);
}

.terminal-panel__menu-item--selected {
  background: var(--terminal-panel-menu-hover-bg);
}

.terminal-panel__menu-item:focus-visible {
  outline: none;
  box-shadow: none;
}

.terminal-panel__menu-item--danger {
  color: #ffb3ad;
}

.terminal-panel__menu-copy {
  display: grid;
  gap: 3px;
}

.terminal-panel__menu-label {
  color: var(--text-primary);
  font-weight: 600;
}

.terminal-panel__menu-meta {
  color: var(--text-dim);
  font-size: 0.72rem;
}

.terminal-panel__menu-shortcut {
  padding: 0.14rem 0.42rem;
  border: 1px solid rgba(108, 124, 148, 0.12);
  border-radius: 8px;
  background: var(--terminal-panel-menu-shortcut-bg);
  color: rgba(173, 184, 197, 0.78);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  white-space: nowrap;
}

.terminal-panel__dialog-backdrop {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--terminal-panel-dialog-backdrop);
  backdrop-filter: blur(3px);
}

.terminal-panel__dialog {
  display: grid;
  gap: 12px;
  width: min(460px, 100%);
  padding: 18px;
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background: var(--terminal-panel-dialog-bg);
  box-shadow: 0 22px 48px rgba(0, 0, 0, 0.38);
}

.terminal-panel__dialog-eyebrow {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.terminal-panel__dialog-title {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 1.08rem;
}

.terminal-panel__dialog-copy {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.82rem;
  line-height: 1.5;
}

.terminal-panel__dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.terminal-panel__dialog-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 0.82rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(17, 23, 31, 0.9);
  color: var(--text-primary);
  font-size: 0.78rem;
  font-weight: 600;
}

.terminal-panel__dialog-button--primary {
  border-color: rgba(110, 197, 255, 0.28);
  background: rgba(69, 151, 250, 0.16);
  color: #b9dcff;
}

.terminal-panel__dialog-button--danger {
  border-color: rgba(188, 87, 87, 0.24);
  background: rgba(188, 87, 87, 0.14);
  color: #ffb3ad;
}

.terminal-panel__switcher-backdrop {
  position: absolute;
  inset: 0;
  z-index: 18;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(4, 8, 12, 0.38);
  backdrop-filter: blur(2px);
}

.terminal-panel__switcher {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 14px;
  width: min(720px, 100%);
  max-height: min(620px, 100%);
  min-height: 0;
  padding: 18px;
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background:
    linear-gradient(160deg, rgba(69, 151, 250, 0.08), transparent 32%),
    var(--terminal-panel-menu-bg);
  color-scheme: dark;
  box-shadow: 0 24px 54px rgba(0, 0, 0, 0.42);
}

.terminal-panel[data-appearance-theme='bridgegit-light'] .terminal-panel__switcher,
.terminal-panel[data-appearance-theme='github-light'] .terminal-panel__switcher {
  color-scheme: light;
}

.terminal-panel__switcher-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.terminal-panel__switcher-heading {
  display: grid;
  gap: 4px;
}

.terminal-panel__switcher-eyebrow {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.terminal-panel__switcher-title {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 1.06rem;
}

.terminal-panel__switcher-meta {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.78rem;
}

.terminal-panel__switcher-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(17, 23, 31, 0.9);
  color: var(--text-primary);
  font-size: 1.12rem;
  line-height: 1;
}

.terminal-panel__switcher-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.terminal-panel__switcher-search,
.terminal-panel__switcher-filter {
  display: grid;
  gap: 6px;
}

.terminal-panel__switcher-search-label {
  color: var(--text-dim);
  font-size: 0.74rem;
  font-weight: 600;
}

.terminal-panel__switcher-search-input,
.terminal-panel__switcher-filter-button {
  width: 100%;
  padding: 0.72rem 0.86rem;
  border: 1px solid rgba(108, 124, 148, 0.18);
  border-radius: 12px;
  background: rgba(8, 12, 17, 0.42);
  color: var(--text-primary);
  font: inherit;
  font-size: 0.82rem;
  line-height: 1.2;
}

.terminal-panel__switcher-filter {
  position: relative;
  width: 156px;
  flex: 0 0 auto;
}

.terminal-panel__switcher-filter-button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
}

.terminal-panel__switcher-filter-button svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}

.terminal-panel__switcher-search-input:focus,
.terminal-panel__switcher-filter-button:focus,
.terminal-panel__switcher-filter-button[aria-expanded='true'] {
  outline: none;
  border-color: rgba(110, 197, 255, 0.34);
  box-shadow: 0 0 0 3px rgba(110, 197, 255, 0.08);
}

.terminal-panel__switcher-filter-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  left: auto;
  min-width: 156px;
  z-index: 1;
}

.terminal-panel__switcher-body {
  min-height: 0;
}

.terminal-panel__switcher-list {
  display: grid;
  gap: 8px;
  max-height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.terminal-panel__switcher-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  width: 100%;
  padding: 0.8rem 0.92rem;
  border: 1px solid rgba(108, 124, 148, 0.14);
  border-radius: 14px;
  background: rgba(17, 23, 31, 0.72);
  color: var(--text-primary);
  text-align: left;
}

.terminal-panel__switcher-item:hover,
.terminal-panel__switcher-item--selected {
  border-color: rgba(110, 197, 255, 0.28);
  background: rgba(24, 33, 43, 0.92);
}

.terminal-panel__switcher-item--active {
  box-shadow: inset 0 0 0 1px rgba(110, 197, 255, 0.12);
}

.terminal-panel__switcher-dot {
  width: 8px;
  height: 8px;
  margin-top: 0.42rem;
  border-radius: 999px;
  background: rgba(108, 124, 148, 0.52);
}

.terminal-panel__switcher-dot--dirty {
  background: rgba(255, 176, 102, 0.82);
}

.terminal-panel__switcher-dot--attention {
  background: rgba(255, 176, 102, 0.82);
  box-shadow: 0 0 0 1px rgba(255, 176, 102, 0.24);
}

.terminal-panel__switcher-dot--active {
  background: #6cb0ff;
  box-shadow: 0 0 10px rgba(108, 176, 255, 0.36);
}

.terminal-panel__switcher-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.terminal-panel__switcher-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.terminal-panel__switcher-name {
  min-width: 0;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.terminal-panel__switcher-badges {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex: 0 0 auto;
  margin-left: auto;
  flex-wrap: wrap;
}

.terminal-panel__switcher-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.42rem;
  border: 1px solid rgba(108, 124, 148, 0.16);
  border-radius: 999px;
  background: rgba(8, 12, 17, 0.42);
  color: var(--text-dim);
  font-size: 0.68rem;
  white-space: nowrap;
}

.terminal-panel__switcher-badge--type {
  border-color: rgba(110, 197, 255, 0.3);
  background: rgba(69, 151, 250, 0.16);
  color: #c6e2ff;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.terminal-panel__switcher-badge--dirty {
  border-color: rgba(255, 176, 102, 0.24);
  color: #ffcd93;
}

.terminal-panel__switcher-path {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.73rem;
  line-height: 1.45;
  word-break: break-word;
}

.terminal-panel__switcher-empty {
  display: grid;
  place-items: center;
  min-height: 180px;
  padding: 18px;
  border: 1px dashed rgba(108, 124, 148, 0.16);
  border-radius: 16px;
  color: var(--text-dim);
  text-align: center;
}

.terminal-panel__view {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
}

.terminal-panel__view--active {
  z-index: 1;
  opacity: 1;
  pointer-events: auto;
}

@media (max-width: 860px) {
  .terminal-panel__tabs-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .terminal-panel__controls {
    align-self: flex-end;
  }

  .terminal-panel__switcher {
    width: 100%;
    max-height: 100%;
  }

  .terminal-panel__switcher-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }
}
</style>
