<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  BranchInfo,
  BranchSummary,
  GitChange,
  GitCommitDetail,
  GitLogEntry,
  GitLogScope,
} from '../../shared/bridgegit';
import { SHORTCUTS, matchesShortcut, shortcutBindingsRevision } from '../shortcuts';
import AppConfirmDialog from './AppConfirmDialog.vue';
import DiffViewer from './DiffViewer.vue';
import GitHistoryGraph from './GitHistoryGraph.vue';

interface Props {
  modelValue: boolean;
  sidebarSide: 'left' | 'right';
  sidebarWidth: number;
  workspacePanelFontSize: number;
  branches: BranchSummary | null;
  commits: GitLogEntry[];
  selectedCommitHash: string | null;
  historyScope: GitLogScope;
  historyQuery: string;
  currentBranch: string;
  repoPath: string | null;
  isLoading: boolean;
  availableCommitCount: number | null;
  hasMoreCommits: boolean;
  isLoadingMoreCommits: boolean;
  paginationMode: 'more' | 'all' | null;
  commitDetail: GitCommitDetail | null;
  isUpdatingCommitMessage: boolean;
  isLoadingCommitDetail: boolean;
  commitDetailError: string | null;
  previewCommitHash: string | null;
  previewDiffPath: string | null;
  previewDiff: string;
  isLoadingPreviewDiff: boolean;
  previewDiffError: string | null;
  focusSearchToken?: number;
}

const props = defineProps<Props>();
const shortcutBindingsVersion = shortcutBindingsRevision;

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'select-commit': [commitHash: string];
  'select-scope': [scope: GitLogScope];
  'search-query-change': [query: string];
  'load-more-commits': [];
  'load-all-commits': [];
  'update-commit-message': [payload: { commitHash: string; message: string }];
  'open-diff': [commit: GitLogEntry];
  'preview-diff-file': [payload: { commit: GitLogEntry; filePath: string }];
  'open-diff-file': [payload: { commit: GitLogEntry; filePath: string }];
  'open-preview-target': [payload: { filePath: string; line?: number }];
  'close-preview-diff': [];
}>();

type ChangedFileViewMode = 'list' | 'tree';
const LARGE_HISTORY_CONFIRM_THRESHOLD = 1000;

interface ChangedFileTreeRow {
  type: 'directory' | 'file';
  path: string;
  name: string;
  depth: number;
  change?: GitChange;
}

const searchQuery = ref(props.historyQuery);
const searchInput = ref<HTMLInputElement | null>(null);
const messageTextarea = ref<HTMLTextAreaElement | null>(null);
const scopeMenuRef = ref<HTMLElement | null>(null);
const isScopeMenuOpen = ref(false);
const isEditingMessage = ref(false);
const messageDraft = ref('');
const changedFileViewMode = ref<ChangedFileViewMode>('list');
const sidebarPaneWidth = ref(320);
const isResizingSidebarPane = ref(false);
const previewHeight = ref(320);
const isResizingPreviewPane = ref(false);
const previewViewMode = ref<'side-by-side' | 'line-by-line'>('side-by-side');
const showLoadAllWarning = ref(false);
let sidebarResizePointerId: number | null = null;
let sidebarResizeStartX = 0;
let sidebarResizeStartWidth = 320;
let previewResizePointerId: number | null = null;
let previewResizeStartY = 0;
let previewResizeStartHeight = 320;
let searchDebounceTimer: number | null = null;

const detailDateFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function closeDialog() {
  showLoadAllWarning.value = false;
  emit('update:modelValue', false);
}

function closeLoadAllWarning() {
  showLoadAllWarning.value = false;
}

function toggleScopeMenu() {
  isScopeMenuOpen.value = !isScopeMenuOpen.value;
}

function closeScopeMenu() {
  isScopeMenuOpen.value = false;
}

function clampSidebarPaneWidth(width: number): number {
  return Math.min(640, Math.max(340, width));
}

function clampPreviewHeight(height: number): number {
  const maxHeight = Math.max(220, Math.floor(window.innerHeight * 0.6));
  return Math.min(maxHeight, Math.max(220, height));
}

function startSidebarResize(event: PointerEvent) {
  sidebarResizePointerId = event.pointerId;
  isResizingSidebarPane.value = true;
  sidebarResizeStartX = event.clientX;
  sidebarResizeStartWidth = sidebarPaneWidth.value;
  window.addEventListener('pointermove', handleSidebarResizeMove);
  window.addEventListener('pointerup', handleSidebarResizeEnd);
  window.addEventListener('pointercancel', handleSidebarResizeEnd);
}

function handleSidebarResizeMove(event: PointerEvent) {
  if (sidebarResizePointerId === null || event.pointerId !== sidebarResizePointerId) {
    return;
  }

  const deltaX = event.clientX - sidebarResizeStartX;
  const nextWidth = props.sidebarSide === 'right'
    ? sidebarResizeStartWidth - deltaX
    : sidebarResizeStartWidth + deltaX;

  sidebarPaneWidth.value = clampSidebarPaneWidth(nextWidth);
}

function handleSidebarResizeEnd(event: PointerEvent) {
  if (sidebarResizePointerId === null || event.pointerId !== sidebarResizePointerId) {
    return;
  }

  sidebarResizePointerId = null;
  isResizingSidebarPane.value = false;
  window.removeEventListener('pointermove', handleSidebarResizeMove);
  window.removeEventListener('pointerup', handleSidebarResizeEnd);
  window.removeEventListener('pointercancel', handleSidebarResizeEnd);
}

function startPreviewResize(event: PointerEvent) {
  previewResizePointerId = event.pointerId;
  isResizingPreviewPane.value = true;
  previewResizeStartY = event.clientY;
  previewResizeStartHeight = previewHeight.value;
  window.addEventListener('pointermove', handlePreviewResizeMove);
  window.addEventListener('pointerup', handlePreviewResizeEnd);
  window.addEventListener('pointercancel', handlePreviewResizeEnd);
}

function handlePreviewResizeMove(event: PointerEvent) {
  if (previewResizePointerId === null || event.pointerId !== previewResizePointerId) {
    return;
  }

  const deltaY = previewResizeStartY - event.clientY;
  previewHeight.value = clampPreviewHeight(previewResizeStartHeight + deltaY);
}

function handlePreviewResizeEnd(event: PointerEvent) {
  if (previewResizePointerId === null || event.pointerId !== previewResizePointerId) {
    return;
  }

  previewResizePointerId = null;
  isResizingPreviewPane.value = false;
  window.removeEventListener('pointermove', handlePreviewResizeMove);
  window.removeEventListener('pointerup', handlePreviewResizeEnd);
  window.removeEventListener('pointercancel', handlePreviewResizeEnd);
}

function normalizeFilePath(path: string) {
  return path.replace(/\\/g, '/').trim();
}

function splitPath(path: string) {
  return normalizeFilePath(path).split('/').filter(Boolean);
}

function fileName(path: string) {
  const parts = splitPath(path);
  return parts.at(-1) ?? path;
}

function fileDirectory(path: string) {
  const parts = splitPath(path);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function treeRowIndentStyle(depth: number) {
  return {
    '--commit-history-tree-depth': String(depth),
  };
}

function buildChangedFileTreeRows(changes: GitChange[]): ChangedFileTreeRow[] {
  interface MutableTreeNode {
    path: string;
    name: string;
    directories: Map<string, MutableTreeNode>;
    files: GitChange[];
  }

  const root: MutableTreeNode = {
    path: '',
    name: '',
    directories: new Map(),
    files: [],
  };

  for (const change of changes) {
    const normalizedPath = normalizeFilePath(change.path);
    const parts = splitPath(normalizedPath);

    if (!parts.length) {
      continue;
    }

    let cursor = root;

    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const nextPath = cursor.path ? `${cursor.path}/${part}` : part;
      let directory = cursor.directories.get(part);

      if (!directory) {
        directory = {
          path: nextPath,
          name: part,
          directories: new Map(),
          files: [],
        };
        cursor.directories.set(part, directory);
      }

      cursor = directory;
    }

    cursor.files.push({
      ...change,
      path: normalizedPath,
    });
  }

  const rows: ChangedFileTreeRow[] = [];

  function visit(node: MutableTreeNode, depth: number) {
    const directories = [...node.directories.values()].sort((left, right) => compareText(left.name, right.name));
    const files = [...node.files].sort((left, right) => compareText(fileName(left.path), fileName(right.path)));

    directories.forEach((directory) => {
      rows.push({
        type: 'directory',
        path: directory.path,
        name: directory.name,
        depth,
      });
      visit(directory, depth + 1);
    });

    files.forEach((change) => {
      rows.push({
        type: 'file',
        path: change.path,
        name: fileName(change.path),
        depth,
        change,
      });
    });
  }

  visit(root, 0);
  return rows;
}

function isScopeActive(scope: GitLogScope): boolean {
  if (scope.kind !== props.historyScope.kind) {
    return false;
  }

  if (scope.kind !== 'branch') {
    return true;
  }

  return (scope.branchName ?? '') === (props.historyScope.branchName ?? '');
}

function selectScope(scope: GitLogScope) {
  if (isScopeActive(scope)) {
    closeScopeMenu();
    return;
  }

  closeScopeMenu();
  emit('select-scope', scope);
}

function formatScopeTitle(scope: GitLogScope): string {
  if (scope.kind === 'all') {
    return 'All Branches';
  }

  if (scope.kind === 'head') {
    return props.currentBranch && props.currentBranch !== 'no repo'
      ? `Current Branch · ${props.currentBranch}`
      : 'Current Branch';
  }

  return scope.branchName?.trim() || 'Selected Branch';
}

function formatDetailDate(value: string): string {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return value;
  }

  return detailDateFormatter.format(new Date(parsed));
}

function changeDotClass(change: GitChange): string {
  switch (change.type) {
    case 'added':
    case 'copied':
      return 'commit-history-dialog__status-dot--added';
    case 'deleted':
      return 'commit-history-dialog__status-dot--deleted';
    case 'modified':
    case 'renamed':
    case 'typechanged':
      return 'commit-history-dialog__status-dot--changed';
    default:
      return 'commit-history-dialog__status-dot--changed';
  }
}

function buildBranchScope(branch: BranchInfo): GitLogScope {
  return {
    kind: 'branch',
    branchName: branch.name,
  };
}
const selectedCommit = computed(() => (
  props.commits.find((commit) => commit.hash === props.selectedCommitHash) ?? null
));
const selectedPreviewCommit = computed(() => (
  props.commits.find((commit) => commit.hash === props.previewCommitHash) ?? selectedCommit.value
));
const historyTitle = computed(() => formatScopeTitle(props.historyScope));
const currentBranchInfo = computed(() => props.branches?.local.find((branch) => branch.current) ?? null);
const localBranches = computed(() => props.branches?.local.filter((branch) => !branch.current) ?? []);
const remoteBranches = computed(() => props.branches?.remote ?? []);
const canEditSelectedCommitMessage = computed(() => props.commitDetail?.isHead ?? false);
const changedFiles = computed(() => props.commitDetail?.files ?? []);
const sortedChangedFiles = computed(() => (
  [...changedFiles.value]
    .map((change) => ({ ...change, path: normalizeFilePath(change.path) }))
    .sort((left, right) => compareText(left.path, right.path))
));
const changedFileTreeRows = computed(() => buildChangedFileTreeRows(sortedChangedFiles.value));
const hasPreviewPanel = computed(() => (
  props.isLoadingPreviewDiff || Boolean(props.previewDiffError) || Boolean(props.previewDiffPath)
));
const previewFileIndex = computed(() => {
  const normalizedPreviewPath = props.previewDiffPath?.trim() ?? '';

  if (!normalizedPreviewPath) {
    return -1;
  }

  return sortedChangedFiles.value.findIndex((change) => change.path === normalizedPreviewPath);
});
const canSelectPreviousPreviewFile = computed(() => previewFileIndex.value > 0);
const canSelectNextPreviewFile = computed(() => (
  previewFileIndex.value >= 0 && previewFileIndex.value < sortedChangedFiles.value.length - 1
));
const commitCountLabel = computed(() => (
  props.historyQuery.trim()
    ? `${props.commits.length.toLocaleString()} / ${(props.availableCommitCount ?? props.commits.length).toLocaleString()} shown`
    : props.availableCommitCount !== null
      ? `${props.commits.length.toLocaleString()} / ${props.availableCommitCount.toLocaleString()} commits`
      : `${props.commits.length.toLocaleString()} commits`
));
const historyFooterLabel = computed(() => (
  props.availableCommitCount !== null
    ? `${props.commits.length.toLocaleString()} of ${props.availableCommitCount.toLocaleString()} commits loaded`
    : `${props.commits.length.toLocaleString()} commits loaded`
));
const historyFooterStatusLabel = computed(() => {
  if (!props.isLoadingMoreCommits) {
    return historyFooterLabel.value;
  }

  if (props.availableCommitCount !== null) {
    const action = props.paginationMode === 'all' ? 'Loading all commits' : 'Loading more commits';
    return `${action}... ${props.commits.length.toLocaleString()} / ${props.availableCommitCount.toLocaleString()}`;
  }

  return props.paginationMode === 'all' ? 'Loading all commits...' : 'Loading more commits...';
});
const loadMoreLabel = computed(() => {
  if (props.isLoadingMoreCommits && props.paginationMode === 'more') {
    return 'Loading...';
  }

  return props.availableCommitCount !== null
    ? `Load Next ${Math.min(100, Math.max(props.availableCommitCount - props.commits.length, 0)).toLocaleString()}`
    : 'Load More';
});
const loadAllLabel = computed(() => {
  if (props.isLoadingMoreCommits && props.paginationMode === 'all') {
    return 'Loading all...';
  }

  if (props.availableCommitCount !== null) {
    const remainingCount = Math.max(props.availableCommitCount - props.commits.length, 0);
    return remainingCount > 0 ? `Load All ${remainingCount.toLocaleString()} Remaining` : 'Load All';
  }

  return 'Load All';
});
const remainingCommitCount = computed(() => (
  props.availableCommitCount !== null
    ? Math.max(props.availableCommitCount - props.commits.length, 0)
    : 0
));
const loadAllWarningCopy = computed(() => (
  `This will load the remaining ${remainingCommitCount.value.toLocaleString()} commits into the history view. `
  + 'In very large repositories this may take a while and make the dialog heavier to render.'
));
const loadAllWarningActions = computed(() => ([
  {
    id: 'confirm',
    label: `Load ${remainingCommitCount.value.toLocaleString()} commits`,
    tone: 'danger' as const,
  },
  {
    id: 'cancel',
    label: 'Cancel',
  },
]));
const panelStyle = computed(() => ({
  '--commit-history-sidebar-width': `${sidebarPaneWidth.value}px`,
  '--commit-history-font-size-px': String(props.workspacePanelFontSize),
  '--commit-history-preview-height': `${previewHeight.value}px`,
}));

function focusSearch() {
  searchInput.value?.focus();
  searchInput.value?.select();
}

function openSelectedCommitDiff() {
  if (!selectedCommit.value) {
    return;
  }

  emit('open-diff', selectedCommit.value);
}

function handleLoadAllCommits() {
  if (props.isLoadingMoreCommits) {
    return;
  }

  if (remainingCommitCount.value > LARGE_HISTORY_CONFIRM_THRESHOLD) {
    showLoadAllWarning.value = true;
    return;
  }

  emit('load-all-commits');
}

function confirmLoadAllCommits() {
  showLoadAllWarning.value = false;
  emit('load-all-commits');
}

function handleLoadAllWarningAction(actionId: string) {
  if (actionId === 'confirm') {
    confirmLoadAllCommits();
    return;
  }

  closeLoadAllWarning();
}

function handleOpenCommitHash(commitHash: string) {
  emit('select-commit', commitHash);
  const commit = props.commits.find((item) => item.hash === commitHash);

  if (commit) {
    emit('open-diff', commit);
  }
}

function openSelectedCommitFileDiff(filePath: string) {
  const normalizedFilePath = filePath.trim();

  if (!normalizedFilePath || !selectedCommit.value) {
    return;
  }

  emit('preview-diff-file', {
    commit: selectedCommit.value,
    filePath: normalizedFilePath,
  });
}

function openPreviewInMainDiff() {
  const normalizedFilePath = props.previewDiffPath?.trim();

  if (!normalizedFilePath || !selectedPreviewCommit.value) {
    return;
  }

  emit('open-diff-file', {
    commit: selectedPreviewCommit.value,
    filePath: normalizedFilePath,
  });
}

function openPreviewInWorkspace(targetLine?: number) {
  const normalizedFilePath = props.previewDiffPath?.trim();

  if (!normalizedFilePath) {
    return;
  }

  emit('open-preview-target', {
    filePath: normalizedFilePath,
    line: targetLine,
  });
}

function selectAdjacentPreviewFile(direction: -1 | 1) {
  const nextIndex = previewFileIndex.value + direction;
  const nextPath = sortedChangedFiles.value[nextIndex]?.path ?? null;

  if (!nextPath) {
    return;
  }

  openSelectedCommitFileDiff(nextPath);
}

function closePreviewDiff() {
  emit('close-preview-diff');
}

function emitSearchQueryChange() {
  if (searchQuery.value === props.historyQuery) {
    return;
  }

  emit('search-query-change', searchQuery.value);
}

function scheduleSearchQueryChange() {
  if (searchDebounceTimer !== null) {
    window.clearTimeout(searchDebounceTimer);
  }

  searchDebounceTimer = window.setTimeout(() => {
    searchDebounceTimer = null;
    emitSearchQueryChange();
  }, 220);
}

async function startEditingMessage() {
  if (!props.commitDetail || !canEditSelectedCommitMessage.value) {
    return;
  }

  messageDraft.value = props.commitDetail.message;
  isEditingMessage.value = true;
  await nextTick();
  messageTextarea.value?.focus();
  messageTextarea.value?.select();
}

function cancelEditingMessage() {
  messageDraft.value = props.commitDetail?.message ?? '';
  isEditingMessage.value = false;
}

function saveEditedMessage() {
  if (!props.commitDetail) {
    return;
  }

  const trimmedDraft = messageDraft.value.trim();

  if (!trimmedDraft) {
    return;
  }

  if (trimmedDraft === props.commitDetail.message.trim()) {
    cancelEditingMessage();
    return;
  }

  emit('update-commit-message', {
    commitHash: props.commitDetail.hash,
    message: messageDraft.value,
  });
}

function handleMessageKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    saveEditedMessage();
  }
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (matchesShortcut(event, SHORTCUTS.commitOpenDiff)) {
    event.preventDefault();
    openSelectedCommitDiff();
  }
}

async function handleGlobalKeydown(event: KeyboardEvent) {
  if (!props.modelValue) {
    return;
  }

  if (event.key === 'Escape' && showLoadAllWarning.value) {
    event.preventDefault();
    closeLoadAllWarning();
    return;
  }

  if (event.key === 'Escape' && isScopeMenuOpen.value) {
    event.preventDefault();
    closeScopeMenu();
    return;
  }

  if (event.key === 'Escape' && hasPreviewPanel.value) {
    event.preventDefault();
    closePreviewDiff();
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog();
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.commitOpenDiff)) {
    event.preventDefault();
    openSelectedCommitDiff();
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.historySearch)) {
    event.preventDefault();
    focusSearch();
  }
}

function handleGlobalPointerDown(event: PointerEvent) {
  if (!isScopeMenuOpen.value) {
    return;
  }

  const target = event.target;

  if (!(target instanceof Node)) {
    closeScopeMenu();
    return;
  }

  if (scopeMenuRef.value?.contains(target)) {
    return;
  }

  closeScopeMenu();
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown, true);
  window.addEventListener('pointerdown', handleGlobalPointerDown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown, true);
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true);
  window.removeEventListener('pointermove', handleSidebarResizeMove);
  window.removeEventListener('pointerup', handleSidebarResizeEnd);
  window.removeEventListener('pointercancel', handleSidebarResizeEnd);
  window.removeEventListener('pointermove', handlePreviewResizeMove);
  window.removeEventListener('pointerup', handlePreviewResizeEnd);
  window.removeEventListener('pointercancel', handlePreviewResizeEnd);
  if (searchDebounceTimer !== null) {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
});

watch(
  () => props.modelValue,
  async (isOpen) => {
    if (!isOpen) {
      closeScopeMenu();
      closeLoadAllWarning();
      isEditingMessage.value = false;

      if (hasPreviewPanel.value) {
        closePreviewDiff();
      }

      return;
    }

    sidebarPaneWidth.value = clampSidebarPaneWidth(props.sidebarWidth);
    previewHeight.value = clampPreviewHeight(Math.floor(window.innerHeight * 0.33));
    await nextTick();
    focusSearch();
  },
);

watch(
  () => props.sidebarWidth,
  (nextWidth) => {
    if (props.modelValue && isResizingSidebarPane.value) {
      return;
    }

    sidebarPaneWidth.value = clampSidebarPaneWidth(nextWidth);
  },
  { immediate: true },
);

watch(
  () => props.historyQuery,
  (nextQuery) => {
    if (nextQuery === searchQuery.value) {
      return;
    }

    searchQuery.value = nextQuery;
  },
);

watch(searchQuery, () => {
  if (!props.modelValue) {
    return;
  }

  scheduleSearchQueryChange();
});

watch(
  () => props.focusSearchToken,
  async (nextToken, previousToken) => {
    if (!props.modelValue || !nextToken || nextToken === previousToken) {
      return;
    }

    await nextTick();
    focusSearch();
  },
);

watch(
  () => [props.commitDetail?.hash ?? null, props.commitDetail?.message ?? '', props.isUpdatingCommitMessage] as const,
  ([nextHash, nextMessage, isUpdating]) => {
    if (!nextHash) {
      isEditingMessage.value = false;
      messageDraft.value = '';
      return;
    }

    if (!isUpdating) {
      isEditingMessage.value = false;
      messageDraft.value = nextMessage;
    }
  },
  { immediate: true },
);
</script>

<template>
  <teleport to="body">
    <div
      v-if="modelValue"
      class="commit-history-dialog"
      :data-shortcut-bindings-version="shortcutBindingsVersion"
      role="presentation"
    >
      <section
        class="commit-history-dialog__panel"
        :class="{ 'commit-history-dialog__panel--sidebar-right': sidebarSide === 'right' }"
        :style="panelStyle"
        role="dialog"
        aria-modal="true"
        aria-label="Commit history"
      >
        <header class="commit-history-dialog__header">
          <div class="commit-history-dialog__heading">
            <p class="commit-history-dialog__eyebrow">Repository History</p>
            <h2 class="commit-history-dialog__title">{{ historyTitle }}</h2>
            <p class="commit-history-dialog__meta">
              <span>{{ commitCountLabel }}</span>
              <span v-if="currentBranch && currentBranch !== 'no repo'">current: {{ currentBranch }}</span>
              <span v-if="repoPath">{{ repoPath }}</span>
            </p>
          </div>

          <button
            class="commit-history-dialog__close"
            type="button"
            aria-label="Close commit history"
            @click="closeDialog"
          >
            ×
          </button>
        </header>

        <div class="commit-history-dialog__toolbar">
          <label class="commit-history-dialog__search-field">
            <span class="commit-history-dialog__search-label">
              Search
              <span class="commit-history-dialog__search-shortcut">{{ SHORTCUTS.historySearch.display }}</span>
            </span>
            <input
              ref="searchInput"
              v-model="searchQuery"
              class="commit-history-dialog__search-input"
              type="text"
              placeholder="message, hash, author, branch"
              @keydown="handleSearchKeydown"
            >
          </label>

          <div class="commit-history-dialog__toolbar-actions">
            <div ref="scopeMenuRef" class="commit-history-dialog__scope-menu">
              <button
                class="commit-history-dialog__toolbar-button"
                type="button"
                @click="toggleScopeMenu"
              >
                <span>Scope: {{ historyTitle }}</span>
                <span class="commit-history-dialog__toolbar-caret">{{ isScopeMenuOpen ? '▴' : '▾' }}</span>
              </button>

              <div v-if="isScopeMenuOpen" class="commit-history-dialog__scope-popover">
                <div class="commit-history-dialog__scope-section">
                  <p class="commit-history-dialog__section-label">Scope</p>

                  <button
                    class="commit-history-dialog__scope-button"
                    :class="{ 'commit-history-dialog__scope-button--active': isScopeActive({ kind: 'all' }) }"
                    type="button"
                    @click="selectScope({ kind: 'all' })"
                  >
                    All branches
                  </button>

                  <button
                    v-if="currentBranch && currentBranch !== 'no repo'"
                    class="commit-history-dialog__scope-button"
                    :class="{ 'commit-history-dialog__scope-button--active': isScopeActive({ kind: 'head' }) }"
                    type="button"
                    @click="selectScope({ kind: 'head' })"
                  >
                    <span>Current branch</span>
                    <span class="commit-history-dialog__scope-meta">{{ currentBranch }}</span>
                  </button>
                </div>

                <div v-if="currentBranchInfo" class="commit-history-dialog__scope-section">
                  <p class="commit-history-dialog__section-label">Checked Out</p>
                  <button
                    class="commit-history-dialog__branch-button"
                    :class="{ 'commit-history-dialog__branch-button--active': isScopeActive(buildBranchScope(currentBranchInfo)) }"
                    type="button"
                    @click="selectScope(buildBranchScope(currentBranchInfo))"
                  >
                    <span class="commit-history-dialog__branch-name">{{ currentBranchInfo.shortName }}</span>
                    <span class="commit-history-dialog__branch-pill">current</span>
                  </button>
                </div>

                <div v-if="localBranches.length" class="commit-history-dialog__scope-section">
                  <p class="commit-history-dialog__section-label">Local</p>
                  <button
                    v-for="branchItem in localBranches"
                    :key="branchItem.name"
                    class="commit-history-dialog__branch-button"
                    :class="{ 'commit-history-dialog__branch-button--active': isScopeActive(buildBranchScope(branchItem)) }"
                    type="button"
                    @click="selectScope(buildBranchScope(branchItem))"
                  >
                    <span class="commit-history-dialog__branch-name">{{ branchItem.shortName }}</span>
                  </button>
                </div>

                <div v-if="remoteBranches.length" class="commit-history-dialog__scope-section">
                  <p class="commit-history-dialog__section-label">Remote</p>
                  <button
                    v-for="branchItem in remoteBranches"
                    :key="branchItem.name"
                    class="commit-history-dialog__branch-button"
                    :class="{ 'commit-history-dialog__branch-button--active': isScopeActive(buildBranchScope(branchItem)) }"
                    type="button"
                    @click="selectScope(buildBranchScope(branchItem))"
                  >
                    <span class="commit-history-dialog__branch-name">{{ branchItem.shortName }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          class="commit-history-dialog__body"
          :class="{ 'commit-history-dialog__body--resizing': isResizingSidebarPane }"
        >
          <aside class="commit-history-dialog__sidebar">
            <header class="commit-history-dialog__sidebar-header">
              <div class="commit-history-dialog__workspace-heading">
                <p class="commit-history-dialog__section-label">Commit Detail</p>
                <p v-if="selectedCommit" class="commit-history-dialog__workspace-meta">
                  {{ selectedCommit.shortHash }} · {{ selectedCommit.authorName }} · {{ formatDetailDate(selectedCommit.date) }}
                </p>
              </div>

              <div v-if="selectedCommit" class="commit-history-dialog__workspace-actions">
                <button
                  v-if="commitDetail"
                  class="commit-history-dialog__action-button"
                  type="button"
                  :disabled="!canEditSelectedCommitMessage || isUpdatingCommitMessage"
                  :title="canEditSelectedCommitMessage ? 'Edit HEAD commit message' : 'Only the current HEAD commit message can be edited'"
                  @click="startEditingMessage"
                >
                  Edit Message
                </button>

                <button
                  class="commit-history-dialog__action-button"
                  type="button"
                  @click="openSelectedCommitDiff"
                >
                  Open Diff
                </button>
              </div>
            </header>

            <div
              v-if="isLoadingCommitDetail && !commitDetail"
              class="commit-history-dialog__sidebar-state"
            >
              Loading commit detail...
            </div>

            <div
              v-else-if="commitDetail"
              class="commit-history-dialog__detail-scroll"
            >
              <div
                v-if="commitDetailError"
                class="commit-history-dialog__banner commit-history-dialog__banner--error"
              >
                {{ commitDetailError }}
              </div>

              <section class="commit-history-dialog__section">
                <p class="commit-history-dialog__detail-kicker">Message</p>

                <div v-if="isEditingMessage" class="commit-history-dialog__message-editor">
                  <textarea
                    ref="messageTextarea"
                    v-model="messageDraft"
                    class="commit-history-dialog__message-textarea"
                    rows="6"
                    :disabled="isUpdatingCommitMessage"
                    @keydown="handleMessageKeydown"
                  />

                  <div class="commit-history-dialog__message-actions">
                    <button
                      class="commit-history-dialog__action-button"
                      type="button"
                      :disabled="isUpdatingCommitMessage || !messageDraft.trim()"
                      @click="saveEditedMessage"
                    >
                      Save
                    </button>

                    <button
                      class="commit-history-dialog__action-button"
                      type="button"
                      :disabled="isUpdatingCommitMessage"
                      @click="cancelEditingMessage"
                    >
                      Cancel
                    </button>
                  </div>
                </div>

                <pre v-else class="commit-history-dialog__message">{{ commitDetail.message }}</pre>
              </section>

              <section class="commit-history-dialog__section">
                <div class="commit-history-dialog__section-header">
                  <div>
                    <p class="commit-history-dialog__detail-kicker">Changed Files</p>
                    <p class="commit-history-dialog__section-meta">
                      {{ sortedChangedFiles.length }} files
                    </p>
                  </div>

                  <div class="commit-history-dialog__view-toggle">
                    <button
                      class="commit-history-dialog__view-button"
                      :class="{ 'commit-history-dialog__view-button--active': changedFileViewMode === 'list' }"
                      type="button"
                      @click="changedFileViewMode = 'list'"
                    >
                      List
                    </button>

                    <button
                      class="commit-history-dialog__view-button"
                      :class="{ 'commit-history-dialog__view-button--active': changedFileViewMode === 'tree' }"
                      type="button"
                      @click="changedFileViewMode = 'tree'"
                    >
                      Tree
                    </button>
                  </div>
                </div>

                <div v-if="!sortedChangedFiles.length" class="commit-history-dialog__section-empty">
                  No changed files recorded for this commit.
                </div>

                <ul
                  v-else-if="changedFileViewMode === 'list'"
                  class="commit-history-dialog__files-list"
                >
                  <li
                    v-for="change in sortedChangedFiles"
                    :key="change.path"
                    class="commit-history-dialog__files-item"
                  >
                    <button
                      class="commit-history-dialog__file-button"
                      :class="{ 'commit-history-dialog__file-button--active': previewDiffPath === change.path }"
                      type="button"
                      :title="change.path"
                      @click="openSelectedCommitFileDiff(change.path)"
                    >
                      <span class="commit-history-dialog__file-copy">
                        <span class="commit-history-dialog__file-name">{{ fileName(change.path) }}</span>
                        <span class="commit-history-dialog__file-directory">
                          {{ fileDirectory(change.path) ?? 'repo root' }}
                        </span>
                      </span>
                      <span
                        class="commit-history-dialog__status-dot"
                        :class="changeDotClass(change)"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                </ul>

                <ul v-else class="commit-history-dialog__tree">
                  <li
                    v-for="row in changedFileTreeRows"
                    :key="`${row.type}:${row.path}`"
                    class="commit-history-dialog__tree-row"
                    :style="treeRowIndentStyle(row.depth)"
                  >
                    <div
                      v-if="row.type === 'directory'"
                      class="commit-history-dialog__tree-directory"
                      :title="row.path"
                    >
                      <span class="commit-history-dialog__tree-caret">▾</span>
                      <span class="commit-history-dialog__tree-name">{{ row.name }}</span>
                    </div>

                    <button
                      v-else-if="row.change"
                      class="commit-history-dialog__tree-file"
                      :class="{ 'commit-history-dialog__tree-file--active': previewDiffPath === row.change.path }"
                      type="button"
                      :title="row.change.path"
                      @click="openSelectedCommitFileDiff(row.change.path)"
                    >
                      <span class="commit-history-dialog__tree-name">{{ row.name }}</span>
                      <span
                        class="commit-history-dialog__status-dot"
                        :class="changeDotClass(row.change)"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                </ul>
              </section>
            </div>

            <div v-else-if="commitDetailError" class="commit-history-dialog__sidebar-state">
              {{ commitDetailError }}
            </div>

            <div v-else class="commit-history-dialog__sidebar-state">
              Select a commit to inspect its message and changed files.
            </div>
          </aside>

          <div
            class="commit-history-dialog__splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize history sidebar"
            @pointerdown.prevent="startSidebarResize"
          />

          <section class="commit-history-dialog__workspace">
            <div
              v-if="isLoading && !commits.length"
              class="commit-history-dialog__workspace-state"
            >
              Loading commits...
            </div>

            <div
              v-else
              class="commit-history-dialog__workspace-body"
              :class="{
                'commit-history-dialog__workspace-body--with-preview': hasPreviewPanel,
                'commit-history-dialog__workspace-body--resizing-preview': isResizingPreviewPane,
              }"
            >
              <section class="commit-history-dialog__workspace-history">
                <GitHistoryGraph
                  :commits="commits"
                  :selected-hash="selectedCommitHash"
                  :simplify-graph="Boolean(historyQuery.trim())"
                  fill
                  @select="emit('select-commit', $event)"
                  @open-diff="handleOpenCommitHash"
                />

                <div v-if="hasMoreCommits || isLoadingMoreCommits" class="commit-history-dialog__history-footer">
                  <span class="commit-history-dialog__history-footer-count">
                    <span
                      v-if="isLoadingMoreCommits"
                      class="commit-history-dialog__history-spinner"
                      aria-hidden="true"
                    />
                    {{ historyFooterStatusLabel }}
                  </span>
                  <button
                    class="commit-history-dialog__action-button"
                    type="button"
                    :disabled="isLoadingMoreCommits"
                    @click="emit('load-more-commits')"
                  >
                    {{ loadMoreLabel }}
                  </button>
                  <button
                    class="commit-history-dialog__action-button"
                    type="button"
                    :disabled="isLoadingMoreCommits"
                    @click="handleLoadAllCommits"
                  >
                    {{ loadAllLabel }}
                  </button>
                </div>
              </section>

              <div
                v-if="hasPreviewPanel"
                class="commit-history-dialog__preview-splitter"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize file diff preview"
                @pointerdown.prevent="startPreviewResize"
              />

              <section v-if="hasPreviewPanel" class="commit-history-dialog__preview">
                <div class="commit-history-dialog__preview-viewer">
                  <DiffViewer
                    :repo-path="repoPath"
                    viewer-mode="commit"
                    :view-mode="previewViewMode"
                    eyebrow-text="Commit Diff"
                    title=""
                    :title-meta="null"
                    :has-target="Boolean(previewDiffPath)"
                    :diff="previewDiff"
                    git-diff-mode="working-tree"
                    :is-loading="isLoadingPreviewDiff"
                    :error="previewDiffError"
                    :change-position="previewFileIndex >= 0 ? previewFileIndex + 1 : 0"
                    :change-count="sortedChangedFiles.length"
                    :can-select-previous="canSelectPreviousPreviewFile"
                    :can-select-next="canSelectNextPreviewFile"
                    :can-stage-current="false"
                    :can-discard-current="false"
                    :can-open-current-file="Boolean(previewDiffPath)"
                    stage-action-label="Stage current"
                    :can-collapse="false"
                    collapse-shortcut-display=""
                    @update:view-mode="previewViewMode = $event"
                    @select-previous="selectAdjacentPreviewFile(-1)"
                    @select-next="selectAdjacentPreviewFile(1)"
                    @open-current-file="openPreviewInWorkspace"
                    @open-diff-target="emit('open-preview-target', $event)"
                  >
                    <template #toolbar-prefix>
                      <button
                        v-if="previewDiffPath"
                        class="commit-history-dialog__action-button"
                        type="button"
                        @click="openPreviewInMainDiff"
                      >
                        Open Diff
                      </button>
                    </template>

                    <template #toolbar-suffix>
                      <button
                        class="commit-history-dialog__icon-button"
                        type="button"
                        aria-label="Close preview"
                        @click="closePreviewDiff"
                      >
                        ×
                      </button>
                    </template>
                  </DiffViewer>
                </div>
              </section>
            </div>
          </section>
        </div>
      </section>

      <AppConfirmDialog
        :model-value="showLoadAllWarning"
        dialog-label="Confirm loading all commits"
        eyebrow="Large History"
        title="Load all remaining commits?"
        :copy="loadAllWarningCopy"
        :actions="loadAllWarningActions"
        @update:model-value="closeLoadAllWarning"
        @action="handleLoadAllWarningAction"
      />
    </div>
  </teleport>
</template>

<style scoped lang="scss">
.commit-history-dialog {
  position: fixed;
  inset: 0;
  z-index: 80;
  background:
    radial-gradient(circle at top, rgba(31, 48, 67, 0.18), transparent 48%),
    rgba(5, 8, 12, 0.94);
  backdrop-filter: blur(12px);
}

.commit-history-dialog__panel {
  --commit-history-scale: calc(var(--commit-history-font-size-px, 14) / 14);
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  height: 100%;
  min-height: 100vh;
  background: linear-gradient(180deg, rgba(10, 15, 21, 0.98), rgba(6, 9, 13, 0.98));
  color: var(--text-primary);
}

.commit-history-dialog__header,
.commit-history-dialog__toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-inline: 12px;
}

.commit-history-dialog__header {
  padding-top: 10px;
}

.commit-history-dialog__toolbar {
  align-items: end;
  padding-top: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(92, 108, 130, 0.16);
}

.commit-history-dialog__heading {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.commit-history-dialog__eyebrow,
.commit-history-dialog__search-label,
.commit-history-dialog__detail-kicker,
.commit-history-dialog__section-label {
  margin: 0;
  color: var(--text-dim);
  font-size: calc(0.68rem * var(--commit-history-scale));
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.commit-history-dialog__title {
  margin: 0;
  font-size: calc(1.28rem * var(--commit-history-scale));
  line-height: 1.1;
}

.commit-history-dialog__meta,
.commit-history-dialog__workspace-meta,
.commit-history-dialog__section-meta,
.commit-history-dialog__preview-directory,
.commit-history-dialog__file-directory {
  margin: 0;
  color: var(--text-muted);
  font-size: calc(0.72rem * var(--commit-history-scale));
}

.commit-history-dialog__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.commit-history-dialog__close,
.commit-history-dialog__toolbar-button,
.commit-history-dialog__nav-button,
.commit-history-dialog__action-button,
.commit-history-dialog__icon-button,
.commit-history-dialog__view-button,
.commit-history-dialog__scope-button,
.commit-history-dialog__branch-button,
.commit-history-dialog__file-button,
.commit-history-dialog__tree-file {
  font: inherit;
}

.commit-history-dialog__close,
.commit-history-dialog__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(100, 114, 136, 0.22);
  border-radius: 9px;
  background: rgba(14, 20, 27, 0.82);
  color: var(--text-primary);
  font-size: calc(0.94rem * var(--commit-history-scale));
}

.commit-history-dialog__icon-button svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.commit-history-dialog__icon-button--accent {
  color: rgba(123, 208, 255, 0.92);
}

.commit-history-dialog__search-field {
  min-width: 0;
  flex: 1 1 auto;
  display: grid;
  gap: 6px;
}

.commit-history-dialog__search-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.commit-history-dialog__search-shortcut {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: calc(0.66rem * var(--commit-history-scale));
  letter-spacing: 0;
  text-transform: none;
}

.commit-history-dialog__search-input {
  width: 100%;
  min-width: 0;
  padding: 0.62rem 0.78rem;
  border: 1px solid rgba(91, 115, 145, 0.44);
  border-radius: 10px;
  background: rgba(11, 16, 22, 0.92);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.76rem * var(--commit-history-scale));
}

.commit-history-dialog__toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.commit-history-dialog__toolbar-button,
.commit-history-dialog__nav-button,
.commit-history-dialog__action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0.34rem 0.68rem;
  border: 1px solid rgba(100, 114, 136, 0.22);
  border-radius: 9px;
  background: rgba(14, 20, 27, 0.82);
  color: var(--text-primary);
  font-size: calc(0.72rem * var(--commit-history-scale));
}

.commit-history-dialog__toolbar-button:disabled,
.commit-history-dialog__nav-button:disabled,
.commit-history-dialog__action-button:disabled {
  opacity: 0.44;
}

.commit-history-dialog__toolbar-caret {
  color: var(--text-muted);
}

.commit-history-dialog__search-count {
  min-width: 62px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: calc(0.7rem * var(--commit-history-scale));
  text-align: right;
}

.commit-history-dialog__scope-menu {
  position: relative;
}

.commit-history-dialog__scope-popover {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 2;
  display: grid;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
  max-height: min(72vh, 680px);
  padding: 10px;
  overflow: auto;
  border: 1px solid rgba(102, 118, 140, 0.22);
  border-radius: 12px;
  background: rgba(9, 14, 19, 0.98);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.32);
}

.commit-history-dialog__scope-section {
  display: grid;
  gap: 6px;
}

.commit-history-dialog__scope-button,
.commit-history-dialog__branch-button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 0.5rem 0.62rem;
  border: 1px solid transparent;
  border-radius: 9px;
  background: rgba(17, 24, 31, 0.72);
  color: var(--text-primary);
  text-align: left;
  font-size: calc(0.74rem * var(--commit-history-scale));
}

.commit-history-dialog__scope-button--active,
.commit-history-dialog__branch-button--active {
  border-color: rgba(110, 197, 255, 0.34);
  background: rgba(26, 35, 46, 0.94);
}

.commit-history-dialog__branch-name,
.commit-history-dialog__scope-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-history-dialog__branch-pill {
  flex: 0 0 auto;
  padding: 0.14rem 0.4rem;
  border-radius: 999px;
  background: rgba(110, 197, 255, 0.16);
  color: #d6eeff;
  font-size: calc(0.64rem * var(--commit-history-scale));
  font-weight: 700;
}

.commit-history-dialog__body {
  display: grid;
  grid-template-columns: minmax(340px, var(--commit-history-sidebar-width)) 8px minmax(0, 1fr);
  grid-template-areas: 'sidebar splitter workspace';
  min-height: 0;
}

.commit-history-dialog__panel--sidebar-right .commit-history-dialog__body {
  grid-template-columns: minmax(0, 1fr) 8px minmax(340px, var(--commit-history-sidebar-width));
  grid-template-areas: 'workspace splitter sidebar';
}

.commit-history-dialog__body--resizing {
  cursor: col-resize;
  user-select: none;
}

.commit-history-dialog__sidebar,
.commit-history-dialog__workspace {
  min-width: 0;
  min-height: 0;
}

.commit-history-dialog__sidebar {
  grid-area: sidebar;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  padding: 10px 10px 12px 12px;
  overflow: hidden;
}

.commit-history-dialog__panel--sidebar-right .commit-history-dialog__sidebar {
  padding-inline: 10px 12px;
}

.commit-history-dialog__sidebar-state,
.commit-history-dialog__workspace-state,
.commit-history-dialog__section-empty,
.commit-history-dialog__preview-state {
  display: grid;
  place-items: center;
  min-height: 84px;
  color: var(--text-muted);
  font-size: calc(0.74rem * var(--commit-history-scale));
  text-align: center;
}

.commit-history-dialog__splitter {
  grid-area: splitter;
  position: relative;
  min-width: 8px;
  cursor: col-resize;
}

.commit-history-dialog__splitter::before {
  content: '';
  position: absolute;
  inset: 8px 3px;
  border-radius: 999px;
  background: rgba(94, 112, 136, 0.24);
}

.commit-history-dialog__workspace {
  grid-area: workspace;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  padding: 10px 12px 12px 10px;
}

.commit-history-dialog__panel--sidebar-right .commit-history-dialog__workspace {
  padding-inline: 12px 10px;
}

.commit-history-dialog__section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.commit-history-dialog__sidebar-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.commit-history-dialog__workspace-heading {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.commit-history-dialog__workspace-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 0 0 auto;
}

.commit-history-dialog__sidebar-header .commit-history-dialog__workspace-actions {
  justify-content: flex-start;
}

.commit-history-dialog__workspace-body {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
}

.commit-history-dialog__workspace-body--with-preview {
  grid-template-rows: minmax(0, 1fr) 8px minmax(220px, var(--commit-history-preview-height));
}

.commit-history-dialog__workspace-body--resizing-preview {
  cursor: row-resize;
  user-select: none;
}

.commit-history-dialog__detail-scroll {
  min-height: 0;
  overflow: auto;
  scrollbar-color: rgba(88, 102, 124, 0.44) rgba(8, 12, 17, 0.72);
}

.commit-history-dialog__detail-scroll {
  display: grid;
  align-content: start;
  gap: 10px;
  padding-right: 4px;
}

.commit-history-dialog__section,
.commit-history-dialog__workspace-history,
.commit-history-dialog__preview {
  border: 1px solid rgba(90, 105, 126, 0.18);
  border-radius: 12px;
  background: rgba(12, 18, 24, 0.82);
}

.commit-history-dialog__section,
.commit-history-dialog__workspace-history,
.commit-history-dialog__preview {
  padding: 10px;
}

.commit-history-dialog__workspace-history {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 10px;
  min-height: 0;
  overflow: hidden;
}

.commit-history-dialog__history-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding-top: 2px;
  flex-wrap: wrap;
}

.commit-history-dialog__history-footer-count {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: calc(0.72rem * var(--commit-history-scale));
}

.commit-history-dialog__history-spinner {
  width: 0.85rem;
  height: 0.85rem;
  border: 2px solid rgba(124, 147, 182, 0.24);
  border-top-color: rgba(124, 147, 182, 0.95);
  border-radius: 999px;
  animation: commit-history-dialog-spin 0.8s linear infinite;
}

@keyframes commit-history-dialog-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

.commit-history-dialog__preview-splitter {
  position: relative;
  min-height: 8px;
  cursor: row-resize;
}

.commit-history-dialog__preview-splitter::before {
  content: '';
  position: absolute;
  inset: 3px 8px;
  border-radius: 999px;
  background: rgba(94, 112, 136, 0.24);
}

.commit-history-dialog__message {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
  font-family: inherit;
  font-size: calc(0.76rem * var(--commit-history-scale));
  line-height: 1.55;
}

.commit-history-dialog__message-editor {
  display: grid;
  gap: 8px;
  margin-top: 6px;
}

.commit-history-dialog__message-textarea {
  width: 100%;
  min-height: 120px;
  padding: 0.68rem 0.78rem;
  border: 1px solid rgba(92, 111, 136, 0.24);
  border-radius: 10px;
  background: rgba(10, 15, 20, 0.9);
  color: var(--text-primary);
  font: inherit;
  font-size: calc(0.76rem * var(--commit-history-scale));
  line-height: 1.5;
  resize: vertical;
}

.commit-history-dialog__message-actions {
  display: flex;
  gap: 6px;
}

.commit-history-dialog__view-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  border: 1px solid rgba(100, 114, 136, 0.22);
  border-radius: 9px;
  overflow: hidden;
}

.commit-history-dialog__view-button {
  padding: 0.32rem 0.62rem;
  border: 0;
  border-right: 1px solid rgba(100, 114, 136, 0.22);
  background: rgba(14, 20, 27, 0.82);
  color: var(--text-muted);
  font-size: calc(0.72rem * var(--commit-history-scale));
}

.commit-history-dialog__view-button:last-child {
  border-right: 0;
}

.commit-history-dialog__view-button--active {
  background: rgba(26, 35, 46, 0.94);
  color: var(--text-primary);
}

.commit-history-dialog__files-list {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.commit-history-dialog__tree {
  display: grid;
  gap: 1px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.commit-history-dialog__file-button,
.commit-history-dialog__tree-file,
.commit-history-dialog__tree-directory {
  width: 100%;
  min-width: 0;
  border-radius: 12px;
}

.commit-history-dialog__file-button,
.commit-history-dialog__tree-file {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 0.38rem 0.52rem;
  border: 1px solid transparent;
  background: rgba(16, 23, 30, 0.72);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.74rem * var(--commit-history-scale));
  text-align: left;
}

.commit-history-dialog__file-button:hover,
.commit-history-dialog__file-button--active,
.commit-history-dialog__tree-file:hover,
.commit-history-dialog__tree-file--active {
  border-color: rgba(110, 197, 255, 0.28);
  background: rgba(26, 35, 46, 0.94);
}

.commit-history-dialog__file-copy {
  min-width: 0;
  flex: 1 1 auto;
  display: grid;
  gap: 2px;
}

.commit-history-dialog__file-name,
.commit-history-dialog__tree-name,
.commit-history-dialog__preview-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-history-dialog__file-name,
.commit-history-dialog__tree-name {
  color: var(--text-primary);
  font-size: calc(0.7rem * var(--commit-history-scale));
}

.commit-history-dialog__file-directory,
.commit-history-dialog__preview-directory {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-history-dialog__file-directory {
  font-size: calc(0.68rem * var(--commit-history-scale));
}

.commit-history-dialog__status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: 0 0 auto;
  margin-left: auto;
  margin-top: 0.2rem;
}

.commit-history-dialog__status-dot--added {
  background: #6ea7ea;
  box-shadow: 0 0 0 1px rgba(110, 167, 234, 0.24);
}

.commit-history-dialog__status-dot--changed {
  background: #d59a56;
  box-shadow: 0 0 0 1px rgba(213, 154, 86, 0.24);
}

.commit-history-dialog__status-dot--deleted {
  background: #ff8e8e;
  box-shadow: 0 0 0 1px rgba(255, 142, 142, 0.3);
}

.commit-history-dialog__tree-row {
  padding-left: calc(var(--commit-history-tree-depth, 0) * 14px);
}

.commit-history-dialog__tree-directory {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0.18rem 0.48rem 0.18rem 0.42rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: calc(0.74rem * var(--commit-history-scale));
}

.commit-history-dialog__tree-caret {
  color: var(--text-dim);
  font-size: calc(0.66rem * var(--commit-history-scale));
}

.commit-history-dialog__tree-name {
  flex: 1 1 auto;
}

.commit-history-dialog__preview {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
}

.commit-history-dialog__preview-viewer {
  min-height: 0;
  overflow: hidden;
}

.commit-history-dialog__banner {
  padding: 0.58rem 0.7rem;
  border-radius: 10px;
  font-size: calc(0.72rem * var(--commit-history-scale));
  line-height: 1.45;
}

.commit-history-dialog__banner--error {
  border: 1px solid rgba(255, 132, 132, 0.24);
  background: rgba(87, 24, 24, 0.34);
  color: #ffd1d1;
}

.commit-history-dialog__preview-viewer :deep(.diff-viewer) {
  gap: 12px;
  height: 100%;
  padding: 0;
}

.commit-history-dialog__preview-viewer :deep(.diff-viewer__header) {
  padding-top: 2px;
}

@media (max-width: 980px) {
  .commit-history-dialog__toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .commit-history-dialog__toolbar-actions {
    justify-content: flex-end;
  }

  .commit-history-dialog__body,
  .commit-history-dialog__panel--sidebar-right .commit-history-dialog__body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(220px, 36vh) 8px minmax(0, 1fr);
    grid-template-areas:
      'sidebar'
      'splitter'
      'workspace';
  }

  .commit-history-dialog__workspace-body--with-preview {
    grid-template-rows: minmax(0, 1fr) 8px minmax(180px, 32vh);
  }

  .commit-history-dialog__splitter {
    min-height: 8px;
    min-width: 0;
    cursor: row-resize;
  }

  .commit-history-dialog__splitter::before {
    inset: 3px 8px;
  }

  .commit-history-dialog__sidebar,
  .commit-history-dialog__panel--sidebar-right .commit-history-dialog__sidebar,
  .commit-history-dialog__workspace,
  .commit-history-dialog__panel--sidebar-right .commit-history-dialog__workspace {
    padding-inline: 12px;
  }
}
</style>
