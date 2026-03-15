<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  BranchSummary,
  GitChange,
  GitLogResult,
  GitStatusSummary,
  RecentRepoEntry,
} from '../../shared/bridgegit';
import { SHORTCUTS } from '../shortcuts';
import RepoPicker from './RepoPicker.vue';

interface Props {
  projectTitle: string;
  repoPath: string | null;
  recentRepos: RecentRepoEntry[];
  status: GitStatusSummary | null;
  branches: BranchSummary | null;
  log: GitLogResult | null;
  isHistoryOpen: boolean;
  selectedPath: string | null;
  isLoading: boolean;
  error: string | null;
  commitMessage: string;
  hasUnreadInfo: boolean;
  canCollapse: boolean;
  collapseShortcutDisplay: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (event: 'open-info'): void;
  (event: 'open-settings'): void;
  (event: 'open-repo'): void;
  (event: 'select-repo', path: string): void;
  (event: 'refresh'): void;
  (event: 'toggle-history'): void;
  (event: 'toggle-collapse'): void;
  (event: 'select-file', path: string): void;
  (event: 'open-file-in-notes', path: string): void;
  (event: 'stage', files: string[]): void;
  (event: 'unstage', files: string[]): void;
  (event: 'checkout', branch: string): void;
  (event: 'update:commit-message', value: string): void;
  (event: 'commit'): void;
}>();

type GroupAction = 'stage' | 'unstage' | null;
type SectionId = 'staged' | 'changed' | 'untracked' | 'conflicts';
type SectionState = Record<SectionId, boolean>;
type FileListMode = 'list' | 'tree';

interface TreeRow {
  type: 'directory' | 'file';
  name: string;
  path: string;
  depth: number;
  item?: GitChange;
}

const branchPickerRef = ref<HTMLElement | null>(null);
const fileMenu = ref<{ path: string; x: number; y: number } | null>(null);
const isBranchMenuOpen = ref(false);
const branchFilter = ref('');
const fileListMode = ref<FileListMode>('list');
const collapsedSections = ref<SectionState>({
  staged: false,
  changed: false,
  untracked: false,
  conflicts: false,
});
const historyCount = computed(() => props.log?.items.length ?? 0);
const collapseButtonTitle = computed(() => (
  props.canCollapse
    ? `Collapse repository panel ${props.collapseShortcutDisplay}`
    : 'Repository panel cannot be collapsed while it is the last visible panel'
));

const sections = computed(() => {
  const source = props.status;

  return [
    {
      id: 'staged' as SectionId,
      title: 'Staged',
      accent: 'success',
      action: 'unstage' as GroupAction,
      items: source?.staged ?? [],
    },
    {
      id: 'changed' as SectionId,
      title: 'Changed',
      accent: 'warning',
      action: 'stage' as GroupAction,
      items: source?.unstaged ?? [],
    },
    {
      id: 'untracked' as SectionId,
      title: 'Untracked',
      accent: 'muted',
      action: 'stage' as GroupAction,
      items: source?.untracked ?? [],
    },
    {
      id: 'conflicts' as SectionId,
      title: 'Conflicts',
      accent: 'danger',
      action: null,
      items: source?.conflicted ?? [],
    },
  ].filter((section) => section.items.length > 0);
});

const currentBranchLabel = computed(() => (
  props.status?.currentBranch ?? props.branches?.current ?? 'Detached HEAD'
));

const filteredBranches = computed(() => {
  const searchTerm = branchFilter.value.trim().toLowerCase();
  const branchItems = props.branches?.all ?? [];

  if (!searchTerm) {
    return branchItems;
  }

  return branchItems.filter((branch) => branch.name.toLowerCase().includes(searchTerm));
});
const treeRowsBySection = computed<Record<SectionId, TreeRow[]>>(() => {
  const nextRows: Record<SectionId, TreeRow[]> = {
    staged: [],
    changed: [],
    untracked: [],
    conflicts: [],
  };

  sections.value.forEach((section) => {
    nextRows[section.id] = buildTreeRows(section.items);
  });

  return nextRows;
});
const sortedItemsBySection = computed<Record<SectionId, GitChange[]>>(() => {
  const nextItems: Record<SectionId, GitChange[]> = {
    staged: [],
    changed: [],
    untracked: [],
    conflicts: [],
  };

  sections.value.forEach((section) => {
    nextItems[section.id] = [...section.items].sort((left, right) => compareText(left.path, right.path));
  });

  return nextItems;
});
const canCommit = computed(() => (
  !props.isLoading
  && Boolean(props.status?.staged.length)
  && Boolean(props.commitMessage.trim())
));
const SUPPORTED_NOTE_FILE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);

function normalizePathSeparators(path: string) {
  return path.replace(/\\/g, '/');
}

function splitPath(path: string) {
  return normalizePathSeparators(path).split('/').filter(Boolean);
}

function fileName(path: string) {
  const parts = splitPath(path);
  return parts.at(-1) ?? path;
}

function fileDirectory(path: string) {
  const parts = splitPath(path);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function supportsNotesOpen(path: string) {
  const normalizedPath = normalizePathSeparators(path);
  const fileExtension = normalizedPath.split('.').at(-1)?.toLowerCase() ?? '';
  return SUPPORTED_NOTE_FILE_EXTENSIONS.has(fileExtension);
}

function buildTreeRows(items: GitChange[]): TreeRow[] {
  interface MutableTreeNode {
    name: string;
    path: string;
    directories: Map<string, MutableTreeNode>;
    files: GitChange[];
  }

  const root: MutableTreeNode = {
    name: '',
    path: '',
    directories: new Map(),
    files: [],
  };

  items.forEach((item) => {
    const normalizedPath = normalizePathSeparators(item.path);
    const parts = splitPath(normalizedPath);

    if (!parts.length) {
      return;
    }

    let cursor = root;

    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const nextPath = cursor.path ? `${cursor.path}/${part}` : part;
      let nextNode = cursor.directories.get(part);

      if (!nextNode) {
        nextNode = {
          name: part,
          path: nextPath,
          directories: new Map(),
          files: [],
        };
        cursor.directories.set(part, nextNode);
      }

      cursor = nextNode;
    }

    cursor.files.push({
      ...item,
      path: normalizedPath,
    });
  });

  const rows: TreeRow[] = [];

  function visit(node: MutableTreeNode, depth: number) {
    const sortedDirectories = [...node.directories.values()].sort((left, right) => compareText(left.name, right.name));
    const sortedFiles = [...node.files].sort((left, right) => compareText(fileName(left.path), fileName(right.path)));

    sortedFiles.forEach((item) => {
      rows.push({
        type: 'file',
        name: fileName(item.path),
        path: item.path,
        depth,
        item,
      });
    });

    sortedDirectories.forEach((directory) => {
      rows.push({
        type: 'directory',
        name: directory.name,
        path: directory.path,
        depth,
      });
      visit(directory, depth + 1);
    });
  }

  visit(root, 0);

  return rows;
}

function statusDotClass(change: GitChange) {
  switch (change.type) {
    case 'added':
    case 'untracked':
      return 'repo-panel__status-dot--new';
    case 'deleted':
      return 'repo-panel__status-dot--deleted';
    case 'conflicted':
      return 'repo-panel__status-dot--conflict';
    default:
      return 'repo-panel__status-dot--changed';
  }
}

function activateFile(path: string, action: GroupAction) {
  if (props.isLoading) {
    return;
  }

  if (!action) {
    return;
  }

  triggerAction(action, [path]);
}

function selectAndActivateFile(path: string, action: GroupAction) {
  emit('select-file', path);
  activateFile(path, action);
}

function treeRowStyle(depth: number) {
  return {
    paddingInlineStart: `${10 + (depth * 14)}px`,
  };
}

function shouldCollapseByDefault(sectionId: SectionId, itemCount: number): boolean {
  if (sectionId === 'staged' || sectionId === 'conflicts') {
    return false;
  }

  return itemCount > 40;
}

function createCollapsedState(status: GitStatusSummary | null): SectionState {
  return {
    staged: shouldCollapseByDefault('staged', status?.staged.length ?? 0),
    changed: shouldCollapseByDefault('changed', status?.unstaged.length ?? 0),
    untracked: shouldCollapseByDefault('untracked', status?.untracked.length ?? 0),
    conflicts: shouldCollapseByDefault('conflicts', status?.conflicted.length ?? 0),
  };
}

function findSectionIdByPath(path: string): SectionId | null {
  if (!props.status) {
    return null;
  }

  if (props.status.staged.some((item) => item.path === path)) {
    return 'staged';
  }

  if (props.status.unstaged.some((item) => item.path === path)) {
    return 'changed';
  }

  if (props.status.untracked.some((item) => item.path === path)) {
    return 'untracked';
  }

  if (props.status.conflicted.some((item) => item.path === path)) {
    return 'conflicts';
  }

  return null;
}

function isSectionCollapsed(sectionId: SectionId): boolean {
  return collapsedSections.value[sectionId];
}

function toggleSection(sectionId: SectionId) {
  collapsedSections.value = {
    ...collapsedSections.value,
    [sectionId]: !collapsedSections.value[sectionId],
  };
}

function handleCommitMessageUpdate(event: Event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  emit('update:commit-message', target?.value ?? '');
}

function handleCommitSubmit() {
  if (!canCommit.value) {
    return;
  }

  emit('commit');
}

function toggleBranchMenu() {
  isBranchMenuOpen.value = !isBranchMenuOpen.value;

  if (!isBranchMenuOpen.value) {
    branchFilter.value = '';
  }
}

function closeBranchMenu() {
  isBranchMenuOpen.value = false;
  branchFilter.value = '';
}

function openFileMenu(event: MouseEvent, path: string) {
  if (!supportsNotesOpen(path)) {
    return;
  }

  event.preventDefault();
  emit('select-file', path);
  closeBranchMenu();
  fileMenu.value = {
    path,
    x: event.clientX,
    y: event.clientY,
  };
}

function closeFileMenu() {
  fileMenu.value = null;
}

function handleOpenFileInNotes() {
  if (!fileMenu.value) {
    return;
  }

  emit('open-file-in-notes', fileMenu.value.path);
  closeFileMenu();
}

function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target as Element | null;

  if (!branchPickerRef.value?.contains(event.target as Node | null)) {
    closeBranchMenu();
  }

  if (!target?.closest('.repo-panel__file-menu')) {
    closeFileMenu();
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeBranchMenu();
    closeFileMenu();
  }
}

function handleBranchSelect(branchName: string) {
  emit('checkout', branchName);
  closeBranchMenu();
}

function triggerAction(action: GroupAction, files: string[]) {
  if (action === 'stage') {
    emit('stage', files);
    return;
  }

  if (action === 'unstage') {
    emit('unstage', files);
  }
}

watch(
  () => props.repoPath,
  () => {
    collapsedSections.value = createCollapsedState(props.status);
  },
  { immediate: true },
);

watch(
  () => [
    props.status?.staged.length ?? 0,
    props.status?.unstaged.length ?? 0,
    props.status?.untracked.length ?? 0,
    props.status?.conflicted.length ?? 0,
  ],
  (nextCounts, previousCounts) => {
    if (!previousCounts) {
      collapsedSections.value = createCollapsedState(props.status);
      return;
    }

    const nextState = { ...collapsedSections.value };
    const defaults = createCollapsedState(props.status);
    const sectionIds: SectionId[] = ['staged', 'changed', 'untracked', 'conflicts'];

    sectionIds.forEach((sectionId, index) => {
      const previousCount = previousCounts[index] ?? 0;
      const nextCount = nextCounts[index] ?? 0;

      if (nextCount === 0) {
        nextState[sectionId] = defaults[sectionId];
        return;
      }

      if (previousCount === 0) {
        nextState[sectionId] = defaults[sectionId];
      }
    });

    collapsedSections.value = nextState;
  },
  { immediate: true },
);

watch(
  () => props.selectedPath,
  (nextSelectedPath) => {
    if (!nextSelectedPath) {
      return;
    }

    const matchingSectionId = findSectionIdByPath(nextSelectedPath);

    if (!matchingSectionId || !collapsedSections.value[matchingSectionId]) {
      return;
    }

    collapsedSections.value = {
      ...collapsedSections.value,
      [matchingSectionId]: false,
    };
  },
);

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
});
</script>

<template>
  <section class="git-panel">
    <section class="repo-panel__project">
      <div class="repo-panel__project-header">
        <div class="repo-panel__project-branding">
          <h2 class="repo-panel__project-title">{{ projectTitle }}</h2>
        </div>

        <div class="repo-panel__project-actions">
          <button
            class="repo-panel__project-settings"
            :class="props.hasUnreadInfo ? 'repo-panel__project-settings--info-unread' : 'repo-panel__project-settings--info-read'"
            type="button"
            aria-label="Open message center"
            title="Message Center"
            @click="emit('open-info')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.75 4.75A2.75 2.75 0 0 0 4 7.5v9A2.75 2.75 0 0 0 6.75 19.25h10.5A2.75 2.75 0 0 0 20 16.5v-9a2.75 2.75 0 0 0-2.75-2.75H6.75Zm0 1.5h10.5c.69 0 1.25.56 1.25 1.25v.41l-6.08 4.64a.75.75 0 0 1-.91 0L5.5 7.91V7.5c0-.69.56-1.25 1.25-1.25Zm11.75 3.55v6.7c0 .69-.56 1.25-1.25 1.25H6.75c-.69 0-1.25-.56-1.25-1.25V9.8l5.1 3.89a2.25 2.25 0 0 0 2.73 0l5.17-3.89Z" />
            </svg>
          </button>

          <button
            class="repo-panel__project-settings"
            type="button"
            aria-label="Open project settings"
            title="Project settings"
            @click="emit('open-settings')"
          >
            <span aria-hidden="true">⚙</span>
          </button>

          <button
            class="repo-panel__project-settings"
            type="button"
            :disabled="!canCollapse"
            :title="collapseButtonTitle"
            aria-label="Collapse repository panel"
            @click="emit('toggle-collapse')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.75 11.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H6.75Z" />
            </svg>
          </button>
        </div>
      </div>

      <RepoPicker
        :repo-path="repoPath"
        :recent-repos="recentRepos"
        :is-busy="isLoading"
        @open="emit('open-repo')"
        @select="emit('select-repo', $event)"
      />
    </section>

    <template v-if="repoPath">
      <section class="repo-panel__summary">
        <div class="repo-panel__summary-row repo-panel__summary-row--branch">
          <div ref="branchPickerRef" class="repo-panel__summary-branch">
            <button
              class="repo-panel__branch-button"
              type="button"
              :disabled="isLoading"
              :aria-expanded="isBranchMenuOpen"
              aria-haspopup="dialog"
              @click="toggleBranchMenu"
            >
              <span class="repo-panel__branch-label">
                {{ currentBranchLabel }}
              </span>
              <span class="repo-panel__branch-chevron" aria-hidden="true">▾</span>
            </button>

            <div class="repo-panel__summary-actions">
              <button
                class="repo-panel__action"
                :class="{ 'repo-panel__action--active': isHistoryOpen }"
                type="button"
                :disabled="isLoading"
                :title="historyCount
                  ? `Commit history (${historyCount.toLocaleString()}) ${SHORTCUTS.historyOpen.display}`
                  : `Commit history ${SHORTCUTS.historyOpen.display}`"
                aria-label="Toggle commit history"
                @click="emit('toggle-history')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M7.25 6.5a2.75 2.75 0 1 1 2.53 2.74v3.03h4.44a2.75 2.75 0 1 1 0 1.5H8.28V9.24A2.75 2.75 0 0 1 7.25 6.5Zm0 0a1.25 1.25 0 1 0 1.25-1.25A1.25 1.25 0 0 0 7.25 6.5Zm9.5 6.5a1.25 1.25 0 1 0 1.25-1.25A1.25 1.25 0 0 0 16.75 13Zm-9.5 4.5a2.75 2.75 0 1 1 2.53 2.74v-3.74h1.5v3.74A2.75 2.75 0 1 1 7.25 17.5Zm1.25 1.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"
                  />
                </svg>
              </button>

              <button
                class="repo-panel__action"
                type="button"
                :disabled="isLoading"
                title="Refresh repository status"
                aria-label="Refresh repository status"
                @click="emit('refresh')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 4.5a7.5 7.5 0 0 1 6.43 3.64V5.25a.75.75 0 0 1 1.5 0v5.25a.75.75 0 0 1-.75.75h-5.25a.75.75 0 0 1 0-1.5h3.5A6 6 0 1 0 18 13.5a.75.75 0 0 1 1.5 0A7.5 7.5 0 1 1 12 4.5Z"
                  />
                </svg>
              </button>
            </div>

            <section
              v-if="isBranchMenuOpen"
              class="repo-panel__branch-menu"
              role="dialog"
              aria-label="Branches"
            >
              <input
                v-model="branchFilter"
                class="repo-panel__branch-search"
                type="search"
                placeholder="Filter branches"
                autocomplete="off"
              />

              <div v-if="filteredBranches.length" class="repo-panel__branch-list">
                <button
                  v-for="branch in filteredBranches"
                  :key="branch.name"
                  class="repo-panel__branch-item"
                  :class="{ 'repo-panel__branch-item--active': branch.current }"
                  type="button"
                  @click="handleBranchSelect(branch.name)"
                >
                  {{ branch.name }}
                </button>
              </div>

              <div v-else class="repo-panel__branch-empty">
                No branches match the current filter.
              </div>
            </section>
          </div>
        </div>

        <div class="repo-panel__summary-row">
          <span class="repo-panel__summary-label">Ahead / behind</span>
          <span class="repo-panel__summary-value">
            +{{ status?.ahead ?? 0 }} / -{{ status?.behind ?? 0 }}
          </span>
        </div>

        <div class="repo-panel__summary-row">
          <span class="repo-panel__summary-label">Tracking</span>
          <span class="repo-panel__summary-value">
            {{ status?.trackingBranch ?? 'No upstream' }}
          </span>
        </div>
      </section>

      <div v-if="error" class="repo-panel__error">
        {{ error }}
      </div>

      <div class="repo-panel__files-toolbar">
        <span class="repo-panel__label">Files</span>
        <div class="repo-panel__view-toggle" role="group" aria-label="File list view mode">
          <button
            class="repo-panel__view-button"
            :class="{ 'repo-panel__view-button--active': fileListMode === 'list' }"
            type="button"
            @click="fileListMode = 'list'"
          >
            List
          </button>
          <button
            class="repo-panel__view-button"
            :class="{ 'repo-panel__view-button--active': fileListMode === 'tree' }"
            type="button"
            @click="fileListMode = 'tree'"
          >
            Tree
          </button>
        </div>
      </div>

      <div class="repo-panel__groups">
        <template v-if="sections.length > 0">
          <section
            v-for="section in sections"
            :key="section.id"
            class="repo-panel__group"
          >
            <header class="repo-panel__group-header">
              <button
                class="repo-panel__group-toggle"
                type="button"
                :aria-expanded="!isSectionCollapsed(section.id)"
                @click="toggleSection(section.id)"
              >
                <span class="repo-panel__group-title">
                  <span
                    class="repo-panel__group-dot"
                    :class="`repo-panel__group-dot--${section.accent}`"
                  />
                  {{ section.title }}
                </span>
                <span class="repo-panel__group-chevron" aria-hidden="true">
                  {{ isSectionCollapsed(section.id) ? '▸' : '▾' }}
                </span>
              </button>

              <div class="repo-panel__group-actions">
                <span class="repo-panel__group-count">{{ section.items.length.toLocaleString() }}</span>
                <button
                  v-if="section.action && !(section.id === 'untracked' && isSectionCollapsed(section.id))"
                  class="repo-panel__mini-action"
                  type="button"
                  :disabled="isLoading"
                  @click="triggerAction(section.action, sortedItemsBySection[section.id].map((item) => item.path))"
                >
                  {{ section.action === 'stage' ? 'Stage all' : 'Unstage all' }}
                </button>
              </div>
            </header>

            <p v-if="isSectionCollapsed(section.id)" class="repo-panel__group-collapsed-copy">
              {{ section.items.length.toLocaleString() }} hidden {{ section.items.length === 1 ? 'file' : 'files' }}
            </p>

            <ul v-else-if="fileListMode === 'list'" class="repo-panel__files">
              <li
                v-for="item in sortedItemsBySection[section.id]"
                :key="`${item.type}:${item.path}`"
                class="repo-panel__file"
              >
                <button
                  class="repo-panel__file-main"
                  :class="{ 'repo-panel__file-main--selected': selectedPath === item.path }"
                  type="button"
                  @click="emit('select-file', item.path)"
                  @contextmenu="openFileMenu($event, item.path)"
                  @dblclick="selectAndActivateFile(item.path, section.action)"
                  @keydown.enter.prevent="activateFile(item.path, section.action)"
                >
                  <span class="repo-panel__file-meta">
                    <span class="repo-panel__file-name">{{ fileName(item.path) }}</span>
                    <span class="repo-panel__file-directory">{{ fileDirectory(item.path) }}</span>
                  </span>
                  <span class="repo-panel__status-dot" :class="statusDotClass(item)" aria-hidden="true" />
                </button>
              </li>
            </ul>

            <ul v-else class="repo-panel__tree">
              <li
                v-for="row in treeRowsBySection[section.id]"
                :key="`${row.type}:${row.path}`"
                class="repo-panel__tree-row"
              >
                <div
                  v-if="row.type === 'directory'"
                  class="repo-panel__tree-directory"
                  :style="treeRowStyle(row.depth)"
                >
                  <span class="repo-panel__tree-caret" aria-hidden="true">▾</span>
                  <span class="repo-panel__tree-label">{{ row.name }}</span>
                </div>

                <button
                  v-else
                  class="repo-panel__tree-file"
                  :class="{ 'repo-panel__tree-file--selected': selectedPath === row.path }"
                  type="button"
                  :style="treeRowStyle(row.depth)"
                  @click="emit('select-file', row.path)"
                  @contextmenu="openFileMenu($event, row.path)"
                  @dblclick="selectAndActivateFile(row.path, section.action)"
                  @keydown.enter.prevent="activateFile(row.path, section.action)"
                >
                  <span class="repo-panel__tree-label">{{ row.name }}</span>
                  <span
                    v-if="row.item"
                    class="repo-panel__status-dot"
                    :class="statusDotClass(row.item)"
                    aria-hidden="true"
                  />
                </button>
              </li>
            </ul>
          </section>
        </template>

        <div v-else class="repo-panel__clean">
          Working tree is clean.
        </div>
      </div>

      <footer class="repo-panel__footer">
        <div class="repo-panel__commit-row">
          <input
            id="commit-message"
            class="repo-panel__commit-input"
            type="text"
            :disabled="isLoading || !status?.staged.length"
            :value="commitMessage"
            placeholder="feat(scope): short commit message"
            @input="handleCommitMessageUpdate"
            @keydown.enter.prevent="handleCommitSubmit"
          />

          <button
            class="repo-panel__commit repo-panel__commit--icon"
            type="button"
            :disabled="!canCommit"
            title="Commit staged changes"
            aria-label="Commit staged changes"
            @click="handleCommitSubmit"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M19.25 12a.75.75 0 0 1-.75.75H8.56l3.72 3.72a.75.75 0 1 1-1.06 1.06l-5-5a.75.75 0 0 1 0-1.06l5-5a.75.75 0 1 1 1.06 1.06L8.56 11.25h9.94a.75.75 0 0 1 .75.75ZM4 5.75A1.75 1.75 0 0 1 5.75 4h8.5a.75.75 0 0 1 0 1.5h-8.5a.25.25 0 0 0-.25.25v12.5c0 .14.11.25.25.25h8.5a.75.75 0 0 1 0 1.5h-8.5A1.75 1.75 0 0 1 4 18.25V5.75Z"
              />
            </svg>
          </button>
        </div>
      </footer>

      <div
        v-if="fileMenu"
        class="repo-panel__file-menu"
        :style="{ left: `${fileMenu.x}px`, top: `${fileMenu.y}px` }"
        role="menu"
        aria-label="File actions"
      >
        <button
          class="repo-panel__file-menu-item"
          type="button"
          role="menuitem"
          @click="handleOpenFileInNotes"
        >
          Open in Notes
        </button>
      </div>
    </template>

    <div v-else class="repo-panel__empty">
      <span class="repo-panel__eyebrow">Source Control</span>
      <h2 class="repo-panel__title">Choose a repository</h2>
      <p class="repo-panel__empty-copy">
        Open any local Git repository to populate branches, changed files, and commit actions.
      </p>
      <button class="repo-panel__commit" type="button" @click="emit('open-repo')">
        Open Repo
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.git-panel {
  display: grid;
  grid-template-rows: auto auto auto 1fr auto;
  gap: 10px;
  height: 100%;
  padding: 12px 12px 10px;
}

.repo-panel__group-header,
.repo-panel__group-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.repo-panel__group-header {
  justify-content: space-between;
}

.repo-panel__project {
  display: grid;
  gap: 12px;
  padding: 0 0 10px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.14);
}

.repo-panel__project-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.repo-panel__project-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.repo-panel__project-branding {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.repo-panel__project-title {
  overflow: hidden;
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.06rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__project-settings {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(16, 23, 31, 0.94);
  color: var(--text-primary);
  flex: 0 0 auto;
}

.repo-panel__project-settings svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.repo-panel__project-settings--info-read {
  color: var(--text-dim);
}

.repo-panel__project-settings--info-unread {
  color: #ffb066;
}

.repo-panel__eyebrow,
.repo-panel__summary-label,
.repo-panel__label {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.repo-panel__action,
.repo-panel__mini-action,
.repo-panel__commit {
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(25, 34, 45, 0.92), rgba(18, 24, 32, 0.92));
  color: var(--text-primary);
  font-weight: 600;
  opacity: 0.72;
}

.repo-panel__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
}

.repo-panel__action svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.repo-panel__action--active {
  border-color: rgba(110, 197, 255, 0.34);
  background: rgba(25, 34, 45, 0.96);
  color: rgba(123, 208, 255, 0.94);
  opacity: 1;
}

.repo-panel__summary {
  display: grid;
  gap: 8px;
  padding: 0 0 10px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.14);
}

.repo-panel__summary-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.repo-panel__summary-row--branch {
  grid-template-columns: minmax(0, 1fr);
}

.repo-panel__summary-row:not(:last-child) {
  padding-bottom: 6px;
}

.repo-panel__summary-branch {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  position: relative;
}

.repo-panel__summary-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.repo-panel__summary-value {
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--text-muted);
  font-size: 0.76rem;
  font-weight: 500;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.repo-panel__select {
  width: 100%;
  min-width: 0;
}

.repo-panel__branch-button {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: rgba(9, 12, 17, 0.85);
  color: var(--text-primary);
  font-size: 0.82rem;
}

.repo-panel__branch-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__branch-chevron {
  color: var(--text-dim);
  font-size: 0.74rem;
  flex: 0 0 auto;
}

.repo-panel__branch-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 84px;
  z-index: 25;
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background:
    linear-gradient(160deg, rgba(69, 151, 250, 0.08), transparent 34%),
    rgba(10, 14, 19, 0.98);
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.34);
}

.repo-panel__branch-search {
  width: 100%;
  padding: 0.68rem 0.78rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(8, 12, 17, 0.92);
  color: var(--text-primary);
}

.repo-panel__branch-list {
  display: grid;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
}

.repo-panel__branch-item {
  padding: 0.62rem 0.72rem;
  border: 1px solid transparent;
  border-radius: 10px;
  background: rgba(17, 23, 31, 0.9);
  color: var(--text-primary);
  text-align: left;
}

.repo-panel__branch-item--active,
.repo-panel__branch-item:hover {
  border-color: rgba(110, 197, 255, 0.24);
  background: rgba(24, 33, 43, 0.96);
}

.repo-panel__branch-empty {
  color: var(--text-dim);
  font-size: 0.74rem;
}

.repo-panel__file-menu {
  position: fixed;
  z-index: 40;
  display: grid;
  min-width: 168px;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background:
    linear-gradient(160deg, rgba(69, 151, 250, 0.08), transparent 34%),
    rgba(10, 14, 19, 0.98);
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.34);
}

.repo-panel__file-menu-item {
  padding: 0.42rem 0.56rem;
  border: 1px solid transparent;
  border-radius: 9px;
  background: rgba(17, 23, 31, 0.9);
  color: var(--text-primary);
  font-size: 0.74rem;
  line-height: 1.2;
  text-align: left;
}

.repo-panel__file-menu-item:hover {
  border-color: rgba(110, 197, 255, 0.24);
  background: rgba(24, 33, 43, 0.96);
}

.repo-panel__files-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.14);
}

.repo-panel__view-toggle {
  display: inline-flex;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
}

.repo-panel__view-button {
  border: 0;
  border-right: 1px solid var(--border-subtle);
  background: rgba(11, 15, 21, 0.9);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.76rem;
  font-weight: 600;
  padding: 0.42rem 0.72rem;
}

.repo-panel__view-button:last-child {
  border-right: 0;
}

.repo-panel__view-button--active {
  background: rgba(26, 36, 48, 0.96);
  color: var(--text-primary);
}

.repo-panel__groups {
  display: grid;
  align-content: start;
  justify-items: stretch;
  grid-auto-rows: max-content;
  gap: 0;
  min-height: 0;
  overflow: auto;
}

.repo-panel__group {
  display: grid;
  gap: 12px;
  padding: 10px 0;
}

.repo-panel__group:not(:first-child) {
  border-top: 1px solid rgba(108, 124, 148, 0.12);
}

.repo-panel__group-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
}

.repo-panel__group-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 0.72rem;
  min-width: 0;
}

.repo-panel__group-chevron {
  color: var(--text-dim);
  font-size: 0.76rem;
}

.repo-panel__group-collapsed-copy {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.78rem;
}

.repo-panel__group-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.repo-panel__group-dot--warning {
  background: #ffb066;
}

.repo-panel__group-dot--success {
  background: #6fe0a5;
}

.repo-panel__group-dot--muted {
  background: #7f8ea4;
}

.repo-panel__group-count {
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.repo-panel__mini-action {
  padding: 0.45rem 0.7rem;
  font-size: 0.78rem;
}

.repo-panel__files {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.repo-panel__file {
  display: block;
}

.repo-panel__file-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  width: 100%;
  padding: 0.48rem 0.62rem;
  border: 1px solid transparent;
  border-radius: 12px;
  background: rgba(22, 29, 38, 0.82);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.74rem;
  text-align: left;
}

.repo-panel__file-main--selected,
.repo-panel__file-main:hover {
  border-color: rgba(110, 197, 255, 0.34);
  background: rgba(25, 34, 45, 0.92);
}

.repo-panel__file-meta {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.repo-panel__file-name,
.repo-panel__file-directory {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__file-name {
  color: var(--text-primary);
  font-size: 0.7rem;
}

.repo-panel__file-directory {
  color: var(--text-muted);
  font-size: 0.68rem;
}

.repo-panel__status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: 0 0 auto;
  margin-top: 0.2rem;
}

.repo-panel__status-dot--new {
  background: #6fe0a5;
  box-shadow: 0 0 0 1px rgba(111, 224, 165, 0.28);
}

.repo-panel__status-dot--changed {
  background: #6cb0ff;
  box-shadow: 0 0 0 1px rgba(108, 176, 255, 0.26);
}

.repo-panel__status-dot--deleted {
  background: #ff8e8e;
  box-shadow: 0 0 0 1px rgba(255, 142, 142, 0.3);
}

.repo-panel__status-dot--conflict {
  background: #ffb066;
  box-shadow: 0 0 0 1px rgba(255, 176, 102, 0.3);
}

.repo-panel__tree {
  display: grid;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.repo-panel__tree-row {
  min-width: 0;
}

.repo-panel__tree-directory,
.repo-panel__tree-file {
  width: 100%;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.74rem;
  text-align: left;
}

.repo-panel__tree-directory {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-block: 0.18rem;
  color: var(--text-muted);
}

.repo-panel__tree-file {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  background: rgba(18, 25, 34, 0.76);
  padding-block: 0.2rem;
  padding-inline-end: 0.48rem;
}

.repo-panel__tree-file:hover,
.repo-panel__tree-file--selected {
  border-color: rgba(110, 197, 255, 0.3);
  background: rgba(24, 33, 43, 0.94);
}

.repo-panel__tree-caret {
  color: var(--text-dim);
  font-size: 0.72rem;
}

.repo-panel__tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.7rem;
}

.repo-panel__error,
.repo-panel__clean {
  padding: 0.9rem 1rem;
  border: 1px solid rgba(188, 87, 87, 0.28);
  border-radius: 14px;
  background: rgba(188, 87, 87, 0.1);
  color: #ffb3ad;
}

.repo-panel__clean {
  border-color: var(--border-subtle);
  background: rgba(13, 18, 24, 0.72);
  color: var(--text-muted);
}

.repo-panel__footer {
  display: grid;
  gap: 8px;
  padding: 10px 0 0;
  border-top: 1px solid rgba(108, 124, 148, 0.14);
}

.repo-panel__commit-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.repo-panel__commit-input {
  width: 100%;
  min-width: 0;
  padding: 0.55rem 0.72rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(9, 12, 17, 0.85);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.8rem;
}

.repo-panel__commit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 0.72rem;
}

.repo-panel__commit--icon {
  width: 34px;
  height: 34px;
  padding: 0;
}

.repo-panel__commit--icon svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.repo-panel__empty {
  display: grid;
  align-content: center;
  gap: 10px;
  height: 100%;
  text-align: left;
}

.repo-panel__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 0.98rem;
  line-height: 1.2;
}

.repo-panel__empty-copy {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
  line-height: 1.55;
}
</style>
