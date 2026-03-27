<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  BranchInfo,
  BranchSummary,
  GitChange,
  GitChangeKind,
  GitDiffMode,
  GitLogResult,
  GitStatusSummary,
  GitWorktreeSummary,
  RecentRepoEntry,
  RepoDirectoryEntry,
  RepoPanelFileListMode,
  RepoPanelSectionState,
  AppAppearance,
  ThemeVariant,
  WorkspaceIndicatorVisibilitySettings,
  WorkspaceOverviewItem,
  WorkspaceRepoPanelState,
} from '../../shared/bridgegit';
import { areRepoPathsEquivalent, normalizeNoteFontSize, resolveWorkspaceFileTabType } from '../../shared/bridgegit';
import { SHORTCUTS } from '../shortcuts';

interface Props {
  projectTitle: string;
  repoPath: string | null;
  appearanceTheme: AppAppearance;
  appearanceThemeVariant: ThemeVariant;
  recentRepos: RecentRepoEntry[];
  workspaceItems: WorkspaceOverviewItem[];
  workspaceIndicatorVisibility: WorkspaceIndicatorVisibilitySettings;
  repoPanelState: WorkspaceRepoPanelState;
  projectTitlesByContext: Record<string, string>;
  detectedWorktree: GitWorktreeSummary | null;
  status: GitStatusSummary | null;
  branches: BranchSummary | null;
  isGitRepository: boolean;
  log: GitLogResult | null;
  isHistoryOpen: boolean;
  selectedPath: string | null;
  isLoading: boolean;
  toolbarBusyAction: 'pull' | 'push' | 'refresh' | null;
  error: string | null;
  errorDetail: string | null;
  operationStatus: string | null;
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
  (event: 'select-workspace', workspaceId: string | null): void;
  (event: 'rename-workspace', workspaceId: string, title: string): void;
  (event: 'remove-workspace', workspaceId: string): void;
  (event: 'change-workspace-repo', workspaceId: string): void;
  (event: 'merge-worktree', workspaceId: string): void;
  (event: 'remove-worktree', workspaceId: string): void;
  (event: 'remove-worktree-and-delete-branch', workspaceId: string): void;
  (event: 'reorder-workspaces', workspaceIds: string[]): void;
  (event: 'update:repo-panel-state', value: WorkspaceRepoPanelState): void;
  (event: 'pull'): void;
  (event: 'push'): void;
  (event: 'refresh'): void;
  (event: 'toggle-history'): void;
  (event: 'toggle-collapse'): void;
  (event: 'select-file', path: string, diffMode?: GitDiffMode): void;
  (event: 'open-workspace-file', path: string): void;
  (event: 'stage', files: string[]): void;
  (event: 'unstage', files: string[]): void;
  (event: 'discard-file', change: GitChange): void;
  (event: 'checkout', branch: string): void;
  (event: 'create-branch', branch: string, placement?: 'current-repo' | 'new-repo'): void;
  (event: 'init-git'): void;
  (event: 'delete-branch', branch: string): void;
  (event: 'add-detected-worktree', path: string): void;
  (event: 'dismiss-detected-worktree', path: string): void;
  (event: 'update:commit-message', value: string): void;
  (event: 'commit'): void;
}>();

type GroupAction = 'stage' | 'unstage' | null;
type SectionId = 'staged' | 'changed' | 'untracked' | 'conflicts';
type SectionState = RepoPanelSectionState;
type FileListMode = RepoPanelFileListMode;

interface TreeRow {
  type: 'directory' | 'file';
  name: string;
  path: string;
  depth: number;
  item?: GitChange;
}

interface AllFilesTreeRow {
  type: 'directory' | 'file' | 'message';
  name: string;
  path: string;
  depth: number;
  item?: GitChange;
  isExpanded?: boolean;
  isLoading?: boolean;
  message?: string;
}

interface RepoSectionViewModel {
  id: SectionId;
  title: string;
  accent: 'success' | 'warning' | 'muted' | 'danger';
  action: GroupAction;
  items: GitChange[];
  filteredItems: GitChange[];
}

interface FilesStatusIndicator {
  id: 'staged' | 'changed' | 'untracked';
  label: string;
  active: boolean;
  accentClass: string;
}

interface FileMenuState {
  change: GitChange;
  canOpenFile: boolean;
  x: number;
  y: number;
}

interface WorkspaceMenuState {
  workspaceId: string;
  title: string;
  path: string | null;
  branch: string | null;
  worktreeRole: 'primary' | 'linked' | null;
  x: number;
  y: number;
}

interface BranchItemMenuState {
  branch: BranchListItem;
  x: number;
  y: number;
}

interface BranchBadge {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

interface BranchListItem extends BranchInfo {
  helperText: string | null;
  badges: BranchBadge[];
  isWorktreeBranch: boolean;
  hasWorktreeChanges: boolean;
}

interface BranchListSection {
  id: 'local' | 'remote';
  title: string;
  items: BranchListItem[];
}

type FileMenuMode = 'actions' | 'discard-confirm';
type WorkspaceMenuMode = 'actions' | 'rename' | 'remove-confirm' | 'worktree-remove-confirm' | 'worktree-remove-delete-confirm';
type BranchItemMenuMode = 'actions' | 'delete-confirm';

const branchPickerRef = ref<HTMLElement | HTMLElement[] | null>(null);
const branchListRef = ref<HTMLElement | HTMLElement[] | null>(null);
const branchSearchInputRef = ref<HTMLInputElement | null>(null);
const workspaceListRef = ref<HTMLElement | null>(null);
const workspaceRenameInputRef = ref<HTMLInputElement | null>(null);
const commitInputRef = ref<HTMLInputElement | null>(null);
const filesFilterInputRef = ref<HTMLInputElement | null>(null);
const fileMenu = ref<FileMenuState | null>(null);
const workspaceMenu = ref<WorkspaceMenuState | null>(null);
const branchItemMenu = ref<BranchItemMenuState | null>(null);
const isBranchMenuOpen = ref(false);
const isBranchCreateMode = ref(false);
const fileMenuMode = ref<FileMenuMode>('actions');
const workspaceMenuMode = ref<WorkspaceMenuMode>('actions');
const branchItemMenuMode = ref<BranchItemMenuMode>('actions');
const draggedWorkspaceId = ref<string | null>(null);
const dropTargetWorkspaceId = ref<string | null>(null);
const branchFilter = ref('');
const filesFilter = ref('');
const isFilesFilterVisible = ref(false);
const workspaceRenameValue = ref('');
const fileListMode = ref<FileListMode>(props.repoPanelState.files.viewMode);
const isAllFilesExpanded = ref(props.repoPanelState.files.showAll);
const isFilesExpanded = ref(props.repoPanelState.files.expanded);
const isWorkspaceDetailExpanded = ref(props.repoPanelState.workspaceDetailExpanded);
const isWorkspaceFamilyFocus = ref(props.repoPanelState.workspaceFamilyFocus);
const collapsedSections = ref<SectionState>({ ...props.repoPanelState.files.collapsedSections });
const repoPanelFontSize = ref(normalizeNoteFontSize(props.repoPanelState.fontSize));
const pendingCommitFocus = ref(false);
const allFilesEntriesByDirectory = ref<Record<string, RepoDirectoryEntry[]>>({});
const allFilesDirectoryLoading = ref<Record<string, boolean>>({});
const allFilesDirectoryErrors = ref<Record<string, string | null>>({});
const expandedAllFilesDirectories = ref<Record<string, boolean>>({});
const allFilesSearchResults = ref<string[] | null>(null);
const allFilesSearchError = ref<string | null>(null);
const isSearchingAllFiles = ref(false);
const hasRequestedAllFilesLoad = ref(false);
let isApplyingRepoPanelState = false;
let allFilesSearchToken = 0;
let allFilesSearchDebounceTimer: number | null = null;
let branchSearchFocusTimer: number | null = null;
const historyCount = computed(() => props.log?.items.length ?? 0);
const collapseButtonTitle = computed(() => (
  props.canCollapse
    ? `Collapse repository panel ${props.collapseShortcutDisplay}`
    : 'Repository panel cannot be collapsed while it is the last visible panel'
));
const hasWorkspaceItems = computed(() => props.workspaceItems.length > 0);
const currentWorkspaceItem = computed(() => (
  props.workspaceItems.find((workspace) => workspace.isCurrent) ?? props.workspaceItems[0] ?? null
));

function workspaceFamilySourceName(workspace: WorkspaceOverviewItem) {
  if (workspace.path) {
    return workspace.path.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.repoName ?? workspace.title;
  }

  return workspace.repoName || workspace.title;
}

function workspaceFamilyKey(workspace: WorkspaceOverviewItem) {
  return workspaceFamilySourceName(workspace).split('.')[0]?.toLowerCase() ?? workspaceFamilySourceName(workspace).toLowerCase();
}

function workspaceFamilyLabel(workspace: WorkspaceOverviewItem) {
  return workspaceFamilySourceName(workspace).split('.')[0] ?? workspaceFamilySourceName(workspace);
}

const currentWorkspaceFamilyKey = computed(() => (
  currentWorkspaceItem.value ? workspaceFamilyKey(currentWorkspaceItem.value) : null
));
const currentWorkspaceFamilyItems = computed(() => (
  currentWorkspaceFamilyKey.value
    ? props.workspaceItems.filter((workspace) => workspaceFamilyKey(workspace) === currentWorkspaceFamilyKey.value)
    : props.workspaceItems
));
const currentWorkspaceFamilyLabel = computed(() => (
  currentWorkspaceItem.value ? workspaceFamilyLabel(currentWorkspaceItem.value) : 'Current repo'
));
const visibleWorkspaceItems = computed(() => (
  isWorkspaceFamilyFocus.value && currentWorkspaceItem.value
    ? [currentWorkspaceItem.value]
    : props.workspaceItems
));
const shouldShowWorkspaceFamilySwitcher = computed(() => (
  isWorkspaceFamilyFocus.value && currentWorkspaceFamilyItems.value.length > 0
));

const sections = computed<Omit<RepoSectionViewModel, 'filteredItems'>[]>(() => {
  const source = props.status;

  return [
    {
      id: 'staged' as SectionId,
      title: 'Staged',
      accent: 'success' as const,
      action: 'unstage' as GroupAction,
      items: source?.staged ?? [],
    },
    {
      id: 'changed' as SectionId,
      title: 'Changed',
      accent: 'warning' as const,
      action: 'stage' as GroupAction,
      items: source?.unstaged ?? [],
    },
    {
      id: 'untracked' as SectionId,
      title: 'Untracked',
      accent: 'muted' as const,
      action: 'stage' as GroupAction,
      items: source?.untracked ?? [],
    },
    {
      id: 'conflicts' as SectionId,
      title: 'Conflicts',
      accent: 'danger' as const,
      action: null,
      items: source?.conflicted ?? [],
    },
  ].filter((section) => section.items.length > 0);
});

const fileStatusIndicators = computed<FilesStatusIndicator[]>(() => [
  {
    id: 'staged',
    label: 'Staged',
    active: Boolean(props.status?.staged.length),
    accentClass: 'repo-panel__group-dot--success',
  },
  {
    id: 'changed',
    label: 'Changed',
    active: Boolean(props.status?.unstaged.length),
    accentClass: 'repo-panel__group-dot--warning',
  },
  {
    id: 'untracked',
    label: 'Untracked',
    active: Boolean(props.status?.untracked.length),
    accentClass: 'repo-panel__group-dot--muted',
  },
]);

const currentBranchLabel = computed(() => (
  props.status?.currentBranch ?? props.branches?.current ?? 'Detached HEAD'
  ));
const canPull = computed(() => (
  props.isGitRepository
  && Boolean(props.status?.currentBranch ?? props.branches?.current)
  && Boolean(props.status?.trackingBranch)
));
const pullTitle = computed(() => {
  if (!canPull.value) {
    return 'Pull unavailable without upstream branch';
  }

  if (!shouldHighlightPull.value) {
    return 'Already up to date';
  }

  return `Pull ${props.status?.trackingBranch}`;
});
const pushTitle = computed(() => {
  if (!canPush.value) {
    return 'Push unavailable in detached HEAD';
  }

  if (!shouldHighlightPush.value) {
    return 'Nothing to push';
  }

  if (props.status?.trackingBranch) {
    return `Push ${props.status.trackingBranch}`;
  }

  const currentBranch = props.status?.currentBranch ?? props.branches?.current;

  if (currentBranch) {
    return `Push origin/${currentBranch} and set upstream`;
  }

  return 'Push current branch';
});
const aheadBehindLabel = computed(() => (
  `+${props.status?.ahead ?? 0} / -${props.status?.behind ?? 0}`
));
const aheadBehindTitle = computed(() => (
  `Ahead / behind: +${props.status?.ahead ?? 0} / -${props.status?.behind ?? 0}`
));
const shouldHighlightPull = computed(() => (
  (props.status?.behind ?? 0) > 0
));
const shouldHighlightPush = computed(() => (
  (props.status?.ahead ?? 0) > 0
));
const canPush = computed(() => (
  props.isGitRepository && Boolean(props.status?.currentBranch ?? props.branches?.current)
));
const isNonGitRepository = computed(() => (
  !props.isGitRepository
));
const gitActionsEnabled = computed(() => props.isGitRepository && !props.isLoading);
const visibleError = computed(() => (
  shouldDisplayError(props.error) ? props.error : null
));
const visibleErrorTitle = computed(() => (
  shouldDisplayError(props.errorDetail) ? props.errorDetail : visibleError.value
));
const visibleOperationStatus = computed(() => (
  shouldDisplayError(props.operationStatus) ? props.operationStatus : null
));
const filesFilterQuery = computed(() => filesFilter.value.trim());
const normalizedFilesFilterQuery = computed(() => filesFilterQuery.value.toLowerCase());
const hasFilesFilter = computed(() => Boolean(filesFilterQuery.value));
const shouldShowFilesFilterRow = computed(() => (
  isFilesExpanded.value && (isFilesFilterVisible.value || hasFilesFilter.value)
));
const filesFilterToggleTitle = computed(() => {
  if (hasFilesFilter.value) {
    return 'Clear file filter';
  }

  return isFilesFilterVisible.value ? 'Hide file filter' : 'Show file filter';
});
const isAllFilesSearchMode = computed(() => hasFilesFilter.value);
const shouldLoadAllFiles = computed(() => (
  hasRequestedAllFilesLoad.value || Boolean(filesFilterQuery.value)
));
const shouldShowAllFilesSearchHint = computed(() => (
  isAllFilesSearchMode.value && filesFilterQuery.value.length < 2
));
const branchFilterQuery = computed(() => branchFilter.value.trim());
const exactBranchMatch = computed(() => (
  (props.branches?.local ?? []).find((branch) => branch.name === branchFilterQuery.value)
  ?? (props.branches?.remote ?? []).find((branch) => (
    branch.shortName === branchFilterQuery.value || branch.name === branchFilterQuery.value
  ))
  ?? null
));
const canCreateBranch = computed(() => (
  Boolean(branchFilterQuery.value) && !exactBranchMatch.value
));
const branchSearchPlaceholder = computed(() => (
  isBranchCreateMode.value ? 'New branch name' : 'Filter branches'
));
const branchCreateButtonTitle = computed(() => {
  if (!isBranchCreateMode.value) {
    return 'Create a new branch';
  }

  if (!branchFilterQuery.value) {
    return 'Enter a new branch name';
  }

  if (exactBranchMatch.value) {
    return 'Branch already exists';
  }

  return `Choose how to create branch "${branchFilterQuery.value}"`;
});
const branchCreateHint = computed(() => {
  if (!isBranchCreateMode.value) {
    return '';
  }

  if (!branchFilterQuery.value) {
    return 'Type a branch name. Press Enter to create it here, or use New Repo for a separate checkout.';
  }

  if (exactBranchMatch.value) {
    return `Branch "${exactBranchMatch.value.displayName}" already exists.`;
  }

  return `Press Enter to create branch "${branchFilterQuery.value}" here, or choose New Repo below.`;
});

function branchStatusBadge(branch: BranchInfo): BranchBadge | null {
  switch (branch.syncStatus) {
    case 'local-only':
      return { label: 'Local only', tone: 'neutral' };
    case 'remote-untracked':
      return { label: 'Remote, no track', tone: 'warning' };
    case 'tracked-synced':
      return { label: 'Up to date', tone: 'success' };
    case 'tracked-ahead':
      return { label: branch.ahead > 0 ? `Ahead ${branch.ahead}` : 'Ahead', tone: 'warning' };
    case 'tracked-behind':
      return { label: branch.behind > 0 ? `Behind ${branch.behind}` : 'Behind', tone: 'warning' };
    case 'tracked-diverged':
      return {
        label: branch.ahead > 0 || branch.behind > 0
          ? `Diverged ${branch.ahead}/${branch.behind}`
          : 'Diverged',
        tone: 'danger',
      };
    case 'tracked-gone':
      return { label: 'Upstream gone', tone: 'danger' };
    case 'remote-only':
      return { label: branch.remoteName ?? 'Remote', tone: 'neutral' };
    default:
      return null;
  }
}

function branchHelperText(
  branch: BranchInfo,
  worktreeLabel: string | null,
): string | null {
  if (branch.checkedOutElsewhere) {
    return worktreeLabel ? `Checked out in ${worktreeLabel}` : 'Checked out in another repo';
  }

  if (branch.kind === 'remote') {
    return `Create local tracking branch from ${branch.name}.`;
  }

  if (branch.syncStatus === 'tracked-gone' && branch.upstreamName) {
    return `Upstream ${branch.upstreamName} no longer exists.`;
  }

  if (branch.syncStatus === 'remote-untracked') {
    return 'Matching remote branch exists, but this local branch does not track it yet.';
  }

  if (branch.upstreamName && branch.upstreamName !== `origin/${branch.name}`) {
    return `Tracks ${branch.upstreamName}.`;
  }

  return null;
}

function buildBranchListItem(branch: BranchInfo): BranchListItem {
  const matchingWorkspace = branch.worktreePath
    ? props.workspaceItems.find((workspaceItem) => (
      workspaceItem.path && areRepoPathsEquivalent(workspaceItem.path, branch.worktreePath)
    )) ?? null
    : null;
  const hasWorktreeChanges = Boolean(
    (matchingWorkspace?.changedCount ?? 0)
    || (matchingWorkspace?.untrackedCount ?? 0)
    || (matchingWorkspace?.conflictedCount ?? 0),
  );
  const worktreeRepoName = branch.worktreePath
    ? branch.worktreePath.split(/[\\/]/).filter(Boolean).at(-1) ?? branch.worktreePath
    : null;
  const badges: BranchBadge[] = [];

  if (branch.current) {
    badges.push({ label: 'Current', tone: 'success' });
  }

  const statusBadge = branchStatusBadge(branch);

  if (statusBadge) {
    badges.push(statusBadge);
  }

  return {
    ...branch,
    helperText: branchHelperText(branch, matchingWorkspace?.title ?? worktreeRepoName),
    badges,
    isWorktreeBranch: branch.checkedOutElsewhere,
    hasWorktreeChanges,
  };
}

const branchSections = computed<BranchListSection[]>(() => {
  const searchTerm = branchFilterQuery.value.toLowerCase();
  const matchesBranch = (branch: BranchInfo) => {
    if (!searchTerm) {
      return true;
    }

    return [
      branch.displayName,
      branch.name,
      branch.upstreamName ?? '',
      branch.remoteName ?? '',
    ].some((value) => value.toLowerCase().includes(searchTerm));
  };

  const localItems = (props.branches?.local ?? [])
    .filter(matchesBranch)
    .map(buildBranchListItem);
  const remoteItems = (props.branches?.remote ?? [])
    .filter(matchesBranch)
    .map(buildBranchListItem);

  return [
    localItems.length
      ? {
        id: 'local' as const,
        title: 'Local',
        items: localItems,
      }
      : null,
    remoteItems.length
      ? {
        id: 'remote' as const,
        title: 'Remote',
        items: remoteItems,
      }
      : null,
  ].filter((section): section is BranchListSection => Boolean(section));
});
const filteredBranches = computed(() => branchSections.value.flatMap((section) => section.items));
const areFileDetailsLoaded = computed(() => Boolean(props.status));
const shouldPrepareFileDetails = computed(() => (
  isWorkspaceDetailExpanded.value
  && isFilesExpanded.value
  && areFileDetailsLoaded.value
));
const visibleSections = computed<RepoSectionViewModel[]>(() => (
  sections.value
    .map((section) => ({
      ...section,
      filteredItems: section.items.filter((item) => matchesFilesFilter(item.path)),
    }))
    .filter((section) => {
      if (!section.items.length) {
        return false;
      }

      if (!hasFilesFilter.value) {
        return true;
      }

      return section.filteredItems.length > 0;
    })
));
const treeRowsBySection = computed<Record<SectionId, TreeRow[]>>(() => {
  const nextRows: Record<SectionId, TreeRow[]> = {
    staged: [],
    changed: [],
    untracked: [],
    conflicts: [],
  };

  if (!shouldPrepareFileDetails.value || fileListMode.value !== 'tree') {
    return nextRows;
  }

  visibleSections.value.forEach((section) => {
    if (collapsedSections.value[section.id]) {
      return;
    }

    nextRows[section.id] = buildTreeRows(section.filteredItems);
  });

  return nextRows;
});
const allFilesChangeMap = computed(() => buildAllFilesChangeMap(props.status));
const allFilesTreeRows = computed<AllFilesTreeRow[]>(() => {
  if (isAllFilesSearchMode.value || !props.repoPath) {
    return [];
  }

  return buildAllFilesTreeRows();
});
const allFilesRootError = computed(() => {
  const nextError = allFilesDirectoryErrors.value[''] ?? null;
  return shouldDisplayError(nextError) ? nextError : null;
});
const visibleAllFilesSearchError = computed(() => (
  shouldDisplayError(allFilesSearchError.value) ? allFilesSearchError.value : null
));
const allFilesSearchResultsWithChanges = computed(() => (
  (allFilesSearchResults.value ?? []).map((path) => ({
    path,
    item: allFilesChangeMap.value.get(path),
  }))
));
const allFilesCountLabel = computed(() => {
  if (!isAllFilesSearchMode.value || shouldShowAllFilesSearchHint.value) {
    return null;
  }

  if (isSearchingAllFiles.value && allFilesSearchResults.value === null) {
    return null;
  }

  return (allFilesSearchResults.value ?? []).length.toLocaleString();
});
const sortedItemsBySection = computed<Record<SectionId, GitChange[]>>(() => {
  const nextItems: Record<SectionId, GitChange[]> = {
    staged: [],
    changed: [],
    untracked: [],
    conflicts: [],
  };

  if (!shouldPrepareFileDetails.value || fileListMode.value !== 'list') {
    return nextItems;
  }

  visibleSections.value.forEach((section) => {
    if (collapsedSections.value[section.id]) {
      return;
    }

    nextItems[section.id] = [...section.filteredItems].sort((left, right) => compareText(left.path, right.path));
  });

  return nextItems;
});
const hasVisibleSections = computed(() => visibleSections.value.length > 0);
const hasStagedChanges = computed(() => Boolean(props.status?.staged.length));
const canCommit = computed(() => (
  !props.isLoading
  && hasStagedChanges.value
  && Boolean(props.commitMessage.trim())
));
const repoPanelStyle = computed(() => ({
  '--repo-panel-font-size-px': String(repoPanelFontSize.value),
}));
function normalizePathSeparators(path: string) {
  return path.replace(/\\/g, '/');
}

function shouldDisplayError(value: string | null): value is string {
  if (!value) {
    return false;
  }

  return !value.toLowerCase().includes('not a git repository');
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

function matchesFilesFilter(path: string) {
  if (!normalizedFilesFilterQuery.value) {
    return true;
  }

  return normalizePathSeparators(path).toLowerCase().includes(normalizedFilesFilterQuery.value);
}

function supportsWorkspaceFileOpen(path: string) {
  return resolveWorkspaceFileTabType(path) !== 'unsupported';
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

function resetAllFilesState() {
  allFilesEntriesByDirectory.value = {};
  allFilesDirectoryLoading.value = {};
  allFilesDirectoryErrors.value = {};
  expandedAllFilesDirectories.value = {};
  allFilesSearchResults.value = null;
  allFilesSearchError.value = null;
  isSearchingAllFiles.value = false;
  hasRequestedAllFilesLoad.value = false;
  allFilesSearchToken += 1;
}

function isAllFilesDirectoryExpanded(path: string) {
  return Boolean(expandedAllFilesDirectories.value[path]);
}

function hasAllFilesDirectoryLoaded(path: string) {
  return Object.hasOwn(allFilesEntriesByDirectory.value, path);
}

function buildAllFilesTreeRows(relativePath = '', depth = 0): AllFilesTreeRow[] {
  const rows: AllFilesTreeRow[] = [];
  const entries = allFilesEntriesByDirectory.value[relativePath] ?? [];

  entries.forEach((entry) => {
    const change = allFilesChangeMap.value.get(entry.path);

    if (entry.kind === 'directory') {
      const isExpanded = isAllFilesDirectoryExpanded(entry.path);
      const isLoading = Boolean(allFilesDirectoryLoading.value[entry.path]);

      rows.push({
        type: 'directory',
        name: entry.name,
        path: entry.path,
        depth,
        item: change,
        isExpanded,
        isLoading,
      });

      if (!isExpanded) {
        return;
      }

      const directoryError = allFilesDirectoryErrors.value[entry.path];

      if (directoryError) {
        rows.push({
          type: 'message',
          name: '',
          path: `${entry.path}::error`,
          depth: depth + 1,
          message: directoryError,
        });
        return;
      }

      if (!hasAllFilesDirectoryLoaded(entry.path)) {
        return;
      }

      const childRows = buildAllFilesTreeRows(entry.path, depth + 1);

      if (!childRows.length) {
        rows.push({
          type: 'message',
          name: '',
          path: `${entry.path}::empty`,
          depth: depth + 1,
          message: 'Empty directory',
        });
        return;
      }

      rows.push(...childRows);
      return;
    }

    rows.push({
      type: 'file',
      name: entry.name,
      path: entry.path,
      depth,
      item: change,
    });
  });

  return rows;
}

async function ensureDirectoryLoaded(relativePath = '') {
  if (!props.repoPath || !window.bridgegit?.git) {
    return;
  }

  const normalizedPath = normalizePathSeparators(relativePath);

  if (hasAllFilesDirectoryLoaded(normalizedPath) || allFilesDirectoryLoading.value[normalizedPath]) {
    return;
  }

  const expectedRepoPath = props.repoPath;
  allFilesDirectoryLoading.value = {
    ...allFilesDirectoryLoading.value,
    [normalizedPath]: true,
  };

  try {
    const entries = await window.bridgegit.git.listDirectory(expectedRepoPath, normalizedPath);

    if (props.repoPath !== expectedRepoPath) {
      return;
    }

    allFilesEntriesByDirectory.value = {
      ...allFilesEntriesByDirectory.value,
      [normalizedPath]: entries,
    };
    allFilesDirectoryErrors.value = {
      ...allFilesDirectoryErrors.value,
      [normalizedPath]: null,
    };
  } catch (error) {
    if (props.repoPath !== expectedRepoPath) {
      return;
    }

    allFilesDirectoryErrors.value = {
      ...allFilesDirectoryErrors.value,
      [normalizedPath]: error instanceof Error ? error.message : 'Failed to load directory.',
    };
  } finally {
    if (props.repoPath === expectedRepoPath) {
      allFilesDirectoryLoading.value = {
        ...allFilesDirectoryLoading.value,
        [normalizedPath]: false,
      };
    }
  }
}

function toggleAllFilesDirectory(path: string) {
  const nextExpanded = !isAllFilesDirectoryExpanded(path);

  expandedAllFilesDirectories.value = {
    ...expandedAllFilesDirectories.value,
    [path]: nextExpanded,
  };

  if (nextExpanded) {
    void ensureDirectoryLoaded(path);
  }
}

async function runAllFilesSearch(query: string) {
  if (!props.repoPath || !window.bridgegit?.git) {
    allFilesSearchResults.value = null;
    allFilesSearchError.value = null;
    isSearchingAllFiles.value = false;
    return;
  }

  const expectedRepoPath = props.repoPath;
  const requestToken = ++allFilesSearchToken;
  isSearchingAllFiles.value = true;
  allFilesSearchError.value = null;

  try {
    const results = await window.bridgegit.git.searchFiles(expectedRepoPath, query, 200);

    if (props.repoPath !== expectedRepoPath || requestToken !== allFilesSearchToken) {
      return;
    }

    allFilesSearchResults.value = results;
  } catch (error) {
    if (props.repoPath !== expectedRepoPath || requestToken !== allFilesSearchToken) {
      return;
    }

    allFilesSearchResults.value = [];
    allFilesSearchError.value = error instanceof Error ? error.message : 'Failed to search files.';
  } finally {
    if (props.repoPath === expectedRepoPath && requestToken === allFilesSearchToken) {
      isSearchingAllFiles.value = false;
    }
  }
}

function changeTypePriority(changeType: GitChangeKind): number {
  switch (changeType) {
    case 'conflicted':
      return 4;
    case 'deleted':
      return 3;
    case 'added':
    case 'untracked':
      return 2;
    default:
      return 1;
  }
}

function buildAllFilesChangeMap(nextStatus: GitStatusSummary | null): Map<string, GitChange> {
  const changeMap = new Map<string, GitChange>();

  if (!nextStatus) {
    return changeMap;
  }

  [
    ...nextStatus.staged,
    ...nextStatus.unstaged,
    ...nextStatus.untracked,
    ...nextStatus.conflicted,
  ].forEach((change) => {
    const existingChange = changeMap.get(change.path);

    if (!existingChange || changeTypePriority(change.type) >= changeTypePriority(existingChange.type)) {
      changeMap.set(change.path, change);
    }
  });

  return changeMap;
}

function resolveVisualSectionId(path: string): SectionId | null {
  if (props.status?.conflicted.some((item) => item.path === path)) {
    return 'conflicts';
  }

  if (props.status?.untracked.some((item) => item.path === path)) {
    return 'untracked';
  }

  if (props.status?.unstaged.some((item) => item.path === path)) {
    return 'changed';
  }

  if (props.status?.staged.some((item) => item.path === path)) {
    return 'staged';
  }

  return null;
}

function statusDotClass(change: GitChange, sectionId?: SectionId | null) {
  const resolvedSectionId = sectionId ?? resolveVisualSectionId(change.path);

  if (change.type === 'added') {
    return 'repo-panel__status-dot--added';
  }

  switch (resolvedSectionId) {
    case 'staged':
      return 'repo-panel__status-dot--staged';
    case 'changed':
      return 'repo-panel__status-dot--changed';
    case 'untracked':
      return 'repo-panel__status-dot--untracked';
    case 'conflicts':
      return 'repo-panel__status-dot--conflict';
    default:
      switch (change.type) {
        case 'untracked':
          return 'repo-panel__status-dot--untracked';
        case 'deleted':
          return 'repo-panel__status-dot--deleted';
        case 'conflicted':
          return 'repo-panel__status-dot--conflict';
        default:
          return 'repo-panel__status-dot--changed';
      }
  }
}

function workspacePanelDotStateClass(value: boolean) {
  return value ? 'repo-panel__workspace-dot--active' : 'repo-panel__workspace-dot--inactive';
}

function clearWorkspaceDragState() {
  draggedWorkspaceId.value = null;
  dropTargetWorkspaceId.value = null;
}

function reorderWorkspaces(sourceWorkspaceId: string, targetWorkspaceId: string) {
  if (sourceWorkspaceId === targetWorkspaceId) {
    return;
  }

  const orderedWorkspaceIds = props.workspaceItems.map((workspace) => workspace.workspaceId);
  const sourceIndex = orderedWorkspaceIds.indexOf(sourceWorkspaceId);
  const targetIndex = orderedWorkspaceIds.indexOf(targetWorkspaceId);

  if (sourceIndex < 0 || targetIndex < 0) {
    return;
  }

  const nextWorkspaceIds = [...orderedWorkspaceIds];
  const [movedWorkspaceId] = nextWorkspaceIds.splice(sourceIndex, 1);

  if (!movedWorkspaceId) {
    return;
  }

  const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  nextWorkspaceIds.splice(insertionIndex, 0, movedWorkspaceId);
  emit('reorder-workspaces', nextWorkspaceIds);
}

function handleWorkspaceDragStart(event: DragEvent, workspaceId: string) {
  if (props.workspaceItems.length < 2) {
    event.preventDefault();
    return;
  }

  draggedWorkspaceId.value = workspaceId;
  dropTargetWorkspaceId.value = workspaceId;

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', workspaceId);
  }
}

function handleWorkspaceDragOver(event: DragEvent, workspaceId: string) {
  if (!draggedWorkspaceId.value || draggedWorkspaceId.value === workspaceId) {
    return;
  }

  event.preventDefault();

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }

  dropTargetWorkspaceId.value = workspaceId;
}

function handleWorkspaceDrop(workspaceId: string) {
  if (!draggedWorkspaceId.value || draggedWorkspaceId.value === workspaceId) {
    clearWorkspaceDragState();
    return;
  }

  reorderWorkspaces(draggedWorkspaceId.value, workspaceId);
  clearWorkspaceDragState();
}

function workspaceCountsTitle(workspace: WorkspaceOverviewItem) {
  const changedCount = workspace.changedCount ?? 0;
  const untrackedCount = workspace.untrackedCount ?? 0;
  const conflictedCount = workspace.conflictedCount ?? 0;

  if (
    workspace.changedCount === null
    && workspace.untrackedCount === null
    && workspace.conflictedCount === null
  ) {
    return 'Repository state not loaded yet';
  }

  return `Changed ${changedCount}, untracked ${untrackedCount}, conflicted ${conflictedCount}`;
}

function workspacePanelsTitle(workspace: WorkspaceOverviewItem) {
  return [
    props.workspaceIndicatorVisibility.repo
      ? `Repository ${workspaceHasRepoChanges(workspace) ? 'changed' : 'idle'}`
      : null,
    props.workspaceIndicatorVisibility.activity
      ? `Panel activity ${workspace.hasPanelActivity ? 'present' : 'idle'}`
      : null,
    props.workspaceIndicatorVisibility.attention
      ? `Panel attention ${workspace.hasPanelAttention ? 'present' : 'idle'}`
      : null,
  ].filter(Boolean).join(', ');
}

function workspaceHasRepoChanges(workspace: WorkspaceOverviewItem) {
  return (workspace.changedCount ?? 0) > 0
    || (workspace.conflictedCount ?? 0) > 0;
}

function detectedWorktreeLabel(worktree: GitWorktreeSummary | null) {
  if (!worktree) {
    return '';
  }

  return worktree.branch ?? fileName(worktree.path);
}

function handleWorkspaceSelect(workspaceId: string) {
  if (props.workspaceItems.some((workspace) => workspace.workspaceId === workspaceId && workspace.isCurrent)) {
    isWorkspaceDetailExpanded.value = !isWorkspaceDetailExpanded.value;
    return;
  }

  emit('select-workspace', workspaceId);
}

function cloneSectionState(sectionState: SectionState): SectionState {
  return { ...sectionState };
}

function areSectionStatesEqual(left: SectionState, right: SectionState) {
  return left.staged === right.staged
    && left.changed === right.changed
    && left.untracked === right.untracked
    && left.conflicts === right.conflicts;
}

function areRepoPanelStatesEqual(left: WorkspaceRepoPanelState, right: WorkspaceRepoPanelState) {
  return left.fontSize === right.fontSize
    && left.historyOpen === right.historyOpen
    && left.workspaceDetailExpanded === right.workspaceDetailExpanded
    && left.workspaceFamilyFocus === right.workspaceFamilyFocus
    && left.files.expanded === right.files.expanded
    && left.files.viewMode === right.files.viewMode
    && left.files.showAll === right.files.showAll
    && areSectionStatesEqual(left.files.collapsedSections, right.files.collapsedSections);
}

function buildRepoPanelState(): WorkspaceRepoPanelState {
  return {
    fontSize: repoPanelFontSize.value,
    historyOpen: props.isHistoryOpen,
    workspaceDetailExpanded: isWorkspaceDetailExpanded.value,
    workspaceFamilyFocus: isWorkspaceFamilyFocus.value,
    files: {
      expanded: isFilesExpanded.value,
      viewMode: fileListMode.value,
      showAll: isAllFilesExpanded.value,
      collapsedSections: cloneSectionState(collapsedSections.value),
    },
  };
}

function applyRepoPanelState(nextRepoPanelState: WorkspaceRepoPanelState) {
  isApplyingRepoPanelState = true;
  repoPanelFontSize.value = normalizeNoteFontSize(nextRepoPanelState.fontSize);
  fileListMode.value = nextRepoPanelState.files.viewMode;
  isAllFilesExpanded.value = nextRepoPanelState.files.showAll;
  isFilesExpanded.value = nextRepoPanelState.files.expanded;
  isWorkspaceDetailExpanded.value = nextRepoPanelState.workspaceDetailExpanded;
  isWorkspaceFamilyFocus.value = nextRepoPanelState.workspaceFamilyFocus;
  collapsedSections.value = cloneSectionState(nextRepoPanelState.files.collapsedSections);
  isApplyingRepoPanelState = false;
}

function emitRepoPanelState() {
  if (isApplyingRepoPanelState) {
    return;
  }

  const nextRepoPanelState = buildRepoPanelState();

  if (areRepoPanelStatesEqual(nextRepoPanelState, props.repoPanelState)) {
    return;
  }

  emit('update:repo-panel-state', nextRepoPanelState);
}

function handleWheelZoom(event: WheelEvent) {
  if ((!event.ctrlKey && !event.metaKey) || props.isLoading) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const zoomStep = event.deltaY < 0 ? 1 : -1;
  const nextFontSize = normalizeNoteFontSize(repoPanelFontSize.value + zoomStep);

  if (nextFontSize === repoPanelFontSize.value) {
    return;
  }

  repoPanelFontSize.value = nextFontSize;
  emitRepoPanelState();
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
  emit('select-file', path, action === 'unstage' ? 'staged' : 'working-tree');
  activateFile(path, action);
}

function selectAllFilesPath(path: string) {
  if (supportsWorkspaceFileOpen(path)) {
    emit('open-workspace-file', path);
    return;
  }

  const sectionId = findSectionIdByPath(path);
  emit('select-file', path, sectionId ? getSectionDiffMode(sectionId) : undefined);
}

function canInteractWithAllFilesPath(path: string) {
  return supportsWorkspaceFileOpen(path) || Boolean(findSectionIdByPath(path));
}

function getSectionDiffMode(sectionId: SectionId): GitDiffMode {
  return sectionId === 'staged' ? 'staged' : 'working-tree';
}

function toggleFilesSection() {
  isFilesExpanded.value = !isFilesExpanded.value;
}

function toggleAllFilesSection() {
  const nextExpanded = !isAllFilesExpanded.value;
  isAllFilesExpanded.value = nextExpanded;

  if (nextExpanded) {
    requestAllFilesLoad();
  }
}

function requestAllFilesLoad() {
  if (hasRequestedAllFilesLoad.value) {
    return;
  }

  hasRequestedAllFilesLoad.value = true;

  if (!isAllFilesSearchMode.value) {
    void ensureDirectoryLoaded('');
  }
}

function treeRowStyle(depth: number) {
  return {
    paddingInlineStart: `${10 + (depth * 14)}px`,
  };
}

function getSingleElement(value: HTMLElement | HTMLElement[] | null): HTMLElement | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
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

async function focusCommitInput() {
  await nextTick();
  commitInputRef.value?.focus({ preventScroll: true });
}

function requestCommitFocus() {
  pendingCommitFocus.value = true;
  isFilesExpanded.value = true;

  if (collapsedSections.value.staged) {
    collapsedSections.value = {
      ...collapsedSections.value,
      staged: false,
    };
  }

  if (hasStagedChanges.value) {
    pendingCommitFocus.value = false;
    void focusCommitInput();
  }
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
    if (branchSearchFocusTimer !== null) {
      window.clearTimeout(branchSearchFocusTimer);
      branchSearchFocusTimer = null;
    }

    branchFilter.value = '';
    isBranchCreateMode.value = false;
  }
}

async function toggleFilesFilter() {
  if (isFilesFilterVisible.value) {
    if (hasFilesFilter.value) {
      filesFilter.value = '';
    }

    isFilesFilterVisible.value = false;
    return;
  }

  isFilesFilterVisible.value = true;
  await nextTick();
  filesFilterInputRef.value?.focus({ preventScroll: true });
}

async function scrollCurrentBranchIntoView() {
  await nextTick();

  const activeBranch = getSingleElement(branchListRef.value)
    ?.querySelector<HTMLElement>('.repo-panel__branch-item--active');

  activeBranch?.scrollIntoView({
    block: 'nearest',
  });
}

async function focusBranchSearchInput() {
  await nextTick();
  branchSearchInputRef.value?.focus({ preventScroll: true });
}

function scheduleBranchSearchFocus(delay = 1000) {
  if (branchSearchFocusTimer !== null) {
    window.clearTimeout(branchSearchFocusTimer);
  }

  branchSearchFocusTimer = window.setTimeout(() => {
    branchSearchFocusTimer = null;

    if (!isBranchMenuOpen.value) {
      return;
    }

    void focusBranchSearchInput();
  }, delay);
}

function closeBranchMenu() {
  if (branchSearchFocusTimer !== null) {
    window.clearTimeout(branchSearchFocusTimer);
    branchSearchFocusTimer = null;
  }

  isBranchMenuOpen.value = false;
  branchFilter.value = '';
  isBranchCreateMode.value = false;
}

function openFileMenu(event: MouseEvent, change: GitChange) {
  event.preventDefault();
  closeBranchMenu();
  closeWorkspaceMenu();
  fileMenuMode.value = 'actions';
  fileMenu.value = {
    change,
    canOpenFile: supportsWorkspaceFileOpen(change.path),
    x: event.clientX,
    y: event.clientY,
  };
}

function closeFileMenu() {
  fileMenu.value = null;
  fileMenuMode.value = 'actions';
}

function handleOpenWorkspaceFile() {
  if (!fileMenu.value) {
    return;
  }

  emit('open-workspace-file', fileMenu.value.change.path);
  closeFileMenu();
}

function handleShowFileDiff() {
  if (!fileMenu.value) {
    return;
  }

  const sectionId = findSectionIdByPath(fileMenu.value.change.path);
  const diffMode = sectionId ? getSectionDiffMode(sectionId) : undefined;
  emit('select-file', fileMenu.value.change.path, diffMode);
  closeFileMenu();
}

function handleFileDiscardStart() {
  if (!fileMenu.value) {
    return;
  }

  fileMenuMode.value = 'discard-confirm';
}

function handleFileDiscard() {
  if (!fileMenu.value) {
    return;
  }

  emit('discard-file', fileMenu.value.change);
  closeFileMenu();
}

function fileDiscardTitle() {
  if (!fileMenu.value) {
    return 'Discard file changes?';
  }

  return fileMenu.value.change.type === 'untracked'
    ? `Delete untracked file ${fileName(fileMenu.value.change.path)}?`
    : `Discard changes in ${fileName(fileMenu.value.change.path)}?`;
}

function fileDiscardCopy() {
  if (!fileMenu.value) {
    return '';
  }

  switch (fileMenu.value.change.type) {
    case 'untracked':
      return 'This will delete the untracked file from disk.';
    case 'renamed':
      return 'This will restore the rename back to the last committed state and drop staged or unstaged changes for this file.';
    default:
      return 'This will restore the file to the last committed state and drop staged or unstaged changes for this file.';
  }
}

function openWorkspaceMenu(event: MouseEvent, workspace: WorkspaceOverviewItem) {
  event.preventDefault();
  openWorkspaceMenuAtPosition(event.clientX, event.clientY, workspace);
}

function openWorkspaceMenuAtPosition(x: number, y: number, workspace: WorkspaceOverviewItem) {
  closeBranchMenu();
  closeFileMenu();
  closeBranchItemMenu();
  workspaceMenuMode.value = 'actions';
  workspaceRenameValue.value = workspace.title;
  workspaceMenu.value = {
    workspaceId: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
    branch: workspace.branch,
    worktreeRole: workspace.worktreeRole,
    x,
    y,
  };
}

function handleCurrentWorkspaceMenuButtonClick(event: MouseEvent) {
  if (!currentWorkspaceItem.value) {
    return;
  }

  const target = event.currentTarget as HTMLElement | null;
  const bounds = target?.getBoundingClientRect();
  openWorkspaceMenuAtPosition(bounds?.left ?? event.clientX, bounds?.bottom ?? event.clientY, currentWorkspaceItem.value);
}

function handleWorkspaceFamilyFocusToggle() {
  isWorkspaceFamilyFocus.value = !isWorkspaceFamilyFocus.value;
}

function compactWorkspaceLabel(workspace: WorkspaceOverviewItem) {
  const branchLabel = workspace.branch ?? 'branch unknown';
  const normalizedTitle = workspace.title.trim();
  const familyTitle = currentWorkspaceItem.value ? workspaceFamilyLabel(currentWorkspaceItem.value) : '';

  if (!normalizedTitle || normalizedTitle === workspace.repoName || normalizedTitle === familyTitle) {
    return branchLabel;
  }

  return `${branchLabel} - ${normalizedTitle}`;
}

function handleWorkspaceFamilySelect(event: Event) {
  const target = event.target as HTMLSelectElement | null;
  const workspaceId = target?.value ?? '';

  if (!workspaceId) {
    return;
  }

  handleWorkspaceSelect(workspaceId);
}

function closeWorkspaceMenu() {
  workspaceMenu.value = null;
  workspaceMenuMode.value = 'actions';
  workspaceRenameValue.value = '';
}

function canDeleteBranch(branch: BranchListItem): boolean {
  return branch.kind === 'local' && !branch.current && !branch.checkedOutElsewhere;
}

function branchItemTitle(branch: BranchListItem) {
  const branchLabel = branch.kind === 'remote' ? branch.name : branch.displayName;

  return branch.helperText ? `${branchLabel} - ${branch.helperText}` : branchLabel;
}

function openBranchItemMenu(event: MouseEvent, branch: BranchListItem) {
  if (!canDeleteBranch(branch)) {
    return;
  }

  event.preventDefault();
  closeFileMenu();
  closeWorkspaceMenu();
  branchItemMenuMode.value = 'actions';
  branchItemMenu.value = {
    branch,
    x: event.clientX,
    y: event.clientY,
  };
}

function closeBranchItemMenu() {
  branchItemMenu.value = null;
  branchItemMenuMode.value = 'actions';
}

async function handleWorkspaceRenameStart() {
  if (!workspaceMenu.value) {
    return;
  }

  workspaceMenuMode.value = 'rename';
  workspaceRenameValue.value = workspaceMenu.value.title;
  await nextTick();
  workspaceRenameInputRef.value?.focus();
  workspaceRenameInputRef.value?.select();
}

function handleWorkspaceRenameSubmit() {
  if (!workspaceMenu.value) {
    return;
  }

  const trimmedTitle = workspaceRenameValue.value.trim();

  if (!trimmedTitle || trimmedTitle === workspaceMenu.value.title.trim()) {
    closeWorkspaceMenu();
    return;
  }

  emit('rename-workspace', workspaceMenu.value.workspaceId, trimmedTitle);
  closeWorkspaceMenu();
}

function handleWorkspaceRenameKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleWorkspaceRenameSubmit();
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    closeWorkspaceMenu();
  }
}

function handleWorkspaceRemove() {
  if (!workspaceMenu.value) {
    return;
  }

  emit('remove-workspace', workspaceMenu.value.workspaceId);
  closeWorkspaceMenu();
}

function handleWorkspaceRepoChange() {
  if (!workspaceMenu.value) {
    return;
  }

  emit('change-workspace-repo', workspaceMenu.value.workspaceId);
  closeWorkspaceMenu();
}

function handleWorkspaceRemoveStart() {
  if (!workspaceMenu.value) {
    return;
  }

  workspaceMenuMode.value = 'remove-confirm';
}

function handleWorkspaceWorktreeMerge() {
  if (!workspaceMenu.value) {
    return;
  }

  emit('merge-worktree', workspaceMenu.value.workspaceId);
  closeWorkspaceMenu();
}

function handleWorkspaceWorktreeRemove() {
  if (!workspaceMenu.value) {
    return;
  }

  emit('remove-worktree', workspaceMenu.value.workspaceId);
  closeWorkspaceMenu();
}

function handleWorkspaceWorktreeRemoveStart() {
  if (!workspaceMenu.value) {
    return;
  }

  workspaceMenuMode.value = 'worktree-remove-confirm';
}

function handleWorkspaceWorktreeRemoveAndDeleteBranch() {
  if (!workspaceMenu.value) {
    return;
  }

  emit('remove-worktree-and-delete-branch', workspaceMenu.value.workspaceId);
  closeWorkspaceMenu();
}

function handleWorkspaceWorktreeRemoveAndDeleteBranchStart() {
  if (!workspaceMenu.value) {
    return;
  }

  workspaceMenuMode.value = 'worktree-remove-delete-confirm';
}

function handleBranchDeleteStart() {
  if (!branchItemMenu.value) {
    return;
  }

  branchItemMenuMode.value = 'delete-confirm';
}

function handleBranchDelete() {
  if (!branchItemMenu.value) {
    return;
  }

  emit('delete-branch', branchItemMenu.value.branch.name);
  closeBranchItemMenu();
  closeBranchMenu();
}

function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target as Element | null;
  const branchPickerElement = getSingleElement(branchPickerRef.value);

  if (!branchPickerElement?.contains(event.target as Node | null)) {
    closeBranchMenu();
  }

  if (!target?.closest('.repo-panel__file-menu')) {
    closeFileMenu();
  }

  if (!target?.closest('.repo-panel__workspace-menu')) {
    closeWorkspaceMenu();
  }

  if (!target?.closest('.repo-panel__branch-item-menu')) {
    closeBranchItemMenu();
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (
    isBranchMenuOpen.value
    && !isEditableTarget(event.target)
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
  ) {
    if (event.key === 'Backspace' && branchFilter.value) {
      event.preventDefault();
      branchFilter.value = branchFilter.value.slice(0, -1);
      void focusBranchSearchInput();
      return;
    }

    if (event.key.length === 1) {
      event.preventDefault();
      branchFilter.value += event.key;
      void focusBranchSearchInput();
      return;
    }
  }

  if (event.key === 'Escape') {
    closeBranchMenu();
    closeFileMenu();
    closeWorkspaceMenu();
    closeBranchItemMenu();
  }
}

function handleBranchSelect(branch: BranchInfo) {
  if (branch.current) {
    return;
  }

  if (branch.checkedOutElsewhere && branch.worktreePath) {
    emit('select-repo', branch.worktreePath);
    closeBranchMenu();
    return;
  }

  emit('checkout', branch.name);
  closeBranchMenu();
}

function handleCreateBranch(placement: 'current-repo' | 'new-repo' = 'current-repo') {
  if (!canCreateBranch.value) {
    return;
  }

  emit('create-branch', branchFilterQuery.value, placement);
}

async function handleBranchCreateButtonClick() {
  if (isBranchCreateMode.value) {
    await focusBranchSearchInput();
    return;
  }

  isBranchCreateMode.value = true;
  branchFilter.value = '';
  await focusBranchSearchInput();
}

function handleBranchFilterKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isBranchCreateMode.value) {
    event.preventDefault();
    isBranchCreateMode.value = false;
    branchFilter.value = '';
    return;
  }

  if (event.key !== 'Enter') {
    return;
  }

  event.preventDefault();

  if (isBranchCreateMode.value) {
    if (canCreateBranch.value) {
      handleCreateBranch();
    }

    return;
  }

  if (exactBranchMatch.value) {
    handleBranchSelect(exactBranchMatch.value);
  }
}

function triggerAction(action: GroupAction, files: string[]) {
  if (!files.length) {
    return;
  }

  if (action === 'stage') {
    requestCommitFocus();
    emit('stage', files);
    return;
  }

  if (action === 'unstage') {
    emit('unstage', files);
  }
}

function getSectionActionPaths(sectionItems: GitChange[]) {
  return sectionItems.map((item) => item.path);
}

function formatVisibleCountLabel(visibleCount: number, totalCount: number) {
  if (!hasFilesFilter.value) {
    return totalCount.toLocaleString();
  }

  return `${visibleCount.toLocaleString()} / ${totalCount.toLocaleString()}`;
}

function sectionCountLabel(section: RepoSectionViewModel) {
  return formatVisibleCountLabel(section.filteredItems.length, section.items.length);
}

function sectionCollapsedCopy(section: RepoSectionViewModel) {
  const visibleCount = section.filteredItems.length;

  if (hasFilesFilter.value) {
    return `${visibleCount.toLocaleString()} matching ${visibleCount === 1 ? 'file' : 'files'} hidden`;
  }

  return `${section.items.length.toLocaleString()} hidden ${section.items.length === 1 ? 'file' : 'files'}`;
}

function noVisibleChangedFilesCopy() {
  return hasFilesFilter.value
    ? 'No changed files match the current filter.'
    : 'Working tree is clean.';
}

watch(
  () => isBranchMenuOpen.value,
  (isOpen) => {
    if (isOpen) {
      scheduleBranchSearchFocus();
      void scrollCurrentBranchIntoView();
      return;
    }

    if (branchSearchFocusTimer !== null) {
      window.clearTimeout(branchSearchFocusTimer);
      branchSearchFocusTimer = null;
    }
  },
);

watch(
  () => branchFilter.value,
  () => {
    if (isBranchMenuOpen.value) {
      void scrollCurrentBranchIntoView();
    }
  },
);

watch(
  () => props.isLoading,
  (nextLoading, previousLoading) => {
    if (!nextLoading && previousLoading && isBranchCreateMode.value && isBranchMenuOpen.value) {
      closeBranchMenu();
    }
  },
);

watch(
  () => props.repoPath,
  () => {
    resetAllFilesState();
  },
  { immediate: true },
);

watch(
  () => props.repoPanelState,
  (nextRepoPanelState) => {
    applyRepoPanelState(nextRepoPanelState);
  },
  { immediate: true },
);

watch(
  () => collapsedSections.value,
  () => {
    emitRepoPanelState();
  },
  { deep: true },
);

watch(
  () => isAllFilesExpanded.value,
  () => {
    emitRepoPanelState();
  },
);

watch(
  () => fileListMode.value,
  () => {
    emitRepoPanelState();
  },
);

watch(
  () => isFilesExpanded.value,
  (isExpanded) => {
    if (!isExpanded) {
      isFilesFilterVisible.value = false;
    }

    emitRepoPanelState();
  },
);

watch(
  () => isWorkspaceDetailExpanded.value,
  () => {
    emitRepoPanelState();
  },
);

watch(
  () => isWorkspaceFamilyFocus.value,
  () => {
    emitRepoPanelState();
  },
);

watch(
  [
    () => props.repoPath,
    () => isWorkspaceDetailExpanded.value,
    () => isFilesExpanded.value,
    () => isAllFilesExpanded.value,
    () => isNonGitRepository.value,
    () => filesFilterQuery.value,
  ],
  ([nextRepoPath, workspaceDetailExpanded, filesExpanded, allFilesExpanded, nonGitRepository, currentQuery]) => {
    if (
      !nextRepoPath
      || !workspaceDetailExpanded
      || !filesExpanded
      || !allFilesExpanded
      || nonGitRepository
      || currentQuery
      || !shouldLoadAllFiles.value
    ) {
      return;
    }

    void ensureDirectoryLoaded('');
  },
  { immediate: true },
);

watch(
  [
    () => props.repoPath,
    () => isWorkspaceDetailExpanded.value,
    () => isFilesExpanded.value,
    () => isAllFilesExpanded.value,
    () => isNonGitRepository.value,
    () => filesFilterQuery.value,
  ],
  ([nextRepoPath, workspaceDetailExpanded, filesExpanded, allFilesExpanded, nonGitRepository, currentQuery]) => {
    if (allFilesSearchDebounceTimer !== null) {
      window.clearTimeout(allFilesSearchDebounceTimer);
      allFilesSearchDebounceTimer = null;
    }

    allFilesSearchToken += 1;

    if (
      !nextRepoPath
      || !workspaceDetailExpanded
      || !filesExpanded
      || !allFilesExpanded
      || nonGitRepository
      || !currentQuery
      || !shouldLoadAllFiles.value
    ) {
      allFilesSearchResults.value = null;
      allFilesSearchError.value = null;
      isSearchingAllFiles.value = false;
      return;
    }

    if (currentQuery.length < 2) {
      allFilesSearchResults.value = [];
      allFilesSearchError.value = null;
      isSearchingAllFiles.value = false;
      return;
    }

    allFilesSearchResults.value = null;
    allFilesSearchError.value = null;
    isSearchingAllFiles.value = true;

    allFilesSearchDebounceTimer = window.setTimeout(() => {
      void runAllFilesSearch(currentQuery);
    }, 180);
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

watch(
  () => props.status?.staged.length ?? 0,
  (nextCount) => {
    if (!nextCount) {
      pendingCommitFocus.value = false;
      return;
    }

    if (!pendingCommitFocus.value) {
      return;
    }

    pendingCommitFocus.value = false;
    void focusCommitInput();
  },
);

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);

  if (allFilesSearchDebounceTimer !== null) {
    window.clearTimeout(allFilesSearchDebounceTimer);
    allFilesSearchDebounceTimer = null;
  }

  if (branchSearchFocusTimer !== null) {
    window.clearTimeout(branchSearchFocusTimer);
    branchSearchFocusTimer = null;
  }
});
</script>

<template>
  <section
    class="git-panel"
    :data-appearance-theme="props.appearanceTheme"
    :style="repoPanelStyle"
    @wheel.capture="handleWheelZoom"
  >
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

    </section>

    <section v-if="hasWorkspaceItems" class="repo-panel__workspaces">
      <div class="repo-panel__workspaces-header">
        <div class="repo-panel__workspaces-heading">
          <span class="repo-panel__label">Workspaces</span>
          <button
            class="repo-panel__mini-action repo-panel__mini-action--icon"
            type="button"
            aria-label="Open repository"
            title="Open repository"
            @click="emit('open-repo')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.75 6A2.75 2.75 0 0 1 7.5 3.25h3.19c.53 0 1.04.22 1.4.61l1.1 1.14h3.31A2.75 2.75 0 0 1 19.25 7.75v8.75a2.75 2.75 0 0 1-2.75 2.75h-9A2.75 2.75 0 0 1 4.75 16.5V6Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h9c.69 0 1.25-.56 1.25-1.25V7.75c0-.69-.56-1.25-1.25-1.25h-3.63a.75.75 0 0 1-.54-.23L11 5.13a.75.75 0 0 0-.54-.23H7.5Z" />
              <path d="M12 8.25a.75.75 0 0 1 .75.75v2.25H15a.75.75 0 0 1 0 1.5h-2.25V15a.75.75 0 0 1-1.5 0v-2.25H9a.75.75 0 0 1 0-1.5h2.25V9a.75.75 0 0 1 .75-.75Z" />
            </svg>
          </button>
        </div>

        <button
          class="repo-panel__mini-action repo-panel__mini-action--icon"
          :class="{ 'repo-panel__mini-action--active': isWorkspaceFamilyFocus }"
          type="button"
          :aria-label="isWorkspaceFamilyFocus ? 'Show all workspaces' : 'Show only current repo family'"
          :title="isWorkspaceFamilyFocus ? 'Show all workspaces' : 'Show only current repo family'"
          @click="handleWorkspaceFamilyFocusToggle"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4.75 6.75A2.75 2.75 0 0 1 7.5 4h9A2.75 2.75 0 0 1 19.25 6.75v1.14c0 .53-.19 1.03-.53 1.42l-3.97 4.47v3.08a.75.75 0 0 1-.27.58l-2.5 2.03A.75.75 0 0 1 10.75 18.9v-5.12L6.78 9.31a2.13 2.13 0 0 1-.53-1.42V6.75ZM7.5 5.5c-.69 0-1.25.56-1.25 1.25v1.14c0 .15.05.29.15.4l4.16 4.69a.75.75 0 0 1 .19.5v3.85l1-.81v-3.04a.75.75 0 0 1 .19-.5l4.16-4.69c.1-.11.15-.25.15-.4V6.75c0-.69-.56-1.25-1.25-1.25h-9Z" />
          </svg>
        </button>
      </div>

      <div v-if="shouldShowWorkspaceFamilySwitcher" class="repo-panel__workspace-family-switcher">
        <div class="repo-panel__workspace-family-summary">
          <span class="repo-panel__workspace-family-name">{{ currentWorkspaceFamilyLabel }}</span>
          <span class="repo-panel__workspace-family-count">{{ currentWorkspaceFamilyItems.length }} repos</span>
        </div>

        <div class="repo-panel__workspace-family-controls">
          <select
            class="repo-panel__workspace-family-select"
            :value="currentWorkspaceItem?.workspaceId ?? ''"
            @change="handleWorkspaceFamilySelect"
          >
            <option
              v-for="workspace in currentWorkspaceFamilyItems"
              :key="workspace.workspaceId"
              :value="workspace.workspaceId"
            >
              {{ compactWorkspaceLabel(workspace) }}
            </option>
          </select>

          <button
            class="repo-panel__mini-action repo-panel__mini-action--icon"
            type="button"
            aria-label="Open current workspace menu"
            title="Workspace actions"
            @click="handleCurrentWorkspaceMenuButtonClick"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 6.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm0 6.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm0 6.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z" />
            </svg>
          </button>
        </div>
      </div>

      <div ref="workspaceListRef" class="repo-panel__workspace-list">
        <div
          v-for="workspace in visibleWorkspaceItems"
          :key="workspace.workspaceId"
          class="repo-panel__workspace-entry"
          :class="{
            'repo-panel__workspace-entry--dragging': workspace.workspaceId === draggedWorkspaceId,
            'repo-panel__workspace-entry--drop-target':
              workspace.workspaceId === dropTargetWorkspaceId && workspace.workspaceId !== draggedWorkspaceId,
          }"
          :draggable="visibleWorkspaceItems.length > 1"
          @dragstart="handleWorkspaceDragStart($event, workspace.workspaceId)"
          @dragover="handleWorkspaceDragOver($event, workspace.workspaceId)"
          @drop.prevent="handleWorkspaceDrop(workspace.workspaceId)"
          @dragend="clearWorkspaceDragState"
        >
          <button
            class="repo-panel__workspace-item"
            :class="{ 'repo-panel__workspace-item--current': workspace.isCurrent }"
            type="button"
            @click="handleWorkspaceSelect(workspace.workspaceId)"
            @contextmenu="openWorkspaceMenu($event, workspace)"
          >
            <span class="repo-panel__workspace-mainline">
              <span class="repo-panel__workspace-title">{{ workspace.title }}</span>
              <span class="repo-panel__workspace-counts" :title="workspaceCountsTitle(workspace)">
                {{ workspace.changedCount ?? '-' }} / {{ workspace.untrackedCount ?? '-' }} / {{ workspace.conflictedCount ?? '-' }}
              </span>
            </span>
            <span class="repo-panel__workspace-subline">
              <span class="repo-panel__workspace-branch">
                {{ workspace.branch ?? 'branch unknown' }}
              </span>
              <span class="repo-panel__workspace-dots" :title="workspacePanelsTitle(workspace)">
                <span
                  v-if="workspaceIndicatorVisibility.repo"
                  class="repo-panel__workspace-dot repo-panel__workspace-dot--repo"
                  :class="workspacePanelDotStateClass(workspaceHasRepoChanges(workspace))"
                />
                <span
                  v-if="workspaceIndicatorVisibility.activity"
                  class="repo-panel__workspace-dot repo-panel__workspace-dot--activity"
                  :class="workspacePanelDotStateClass(workspace.hasPanelActivity)"
                />
                <span
                  v-if="workspaceIndicatorVisibility.attention"
                  class="repo-panel__workspace-dot repo-panel__workspace-dot--attention"
                  :class="workspacePanelDotStateClass(workspace.hasPanelAttention)"
                />
              </span>
            </span>
          </button>

          <template v-if="workspace.isCurrent && repoPath">
            <div v-if="isWorkspaceDetailExpanded" class="repo-panel__workspace-detail">
              <section
                v-if="detectedWorktree"
                class="repo-panel__commit-box repo-panel__commit-box--ready repo-panel__worktree-callout"
              >
                <div class="repo-panel__worktree-copy">
                  <span class="repo-panel__label">New worktree detected</span>
                  <strong class="repo-panel__worktree-branch">
                    {{ detectedWorktreeLabel(detectedWorktree) }}
                  </strong>
                  <span class="repo-panel__worktree-path" :title="detectedWorktree.path">
                    {{ detectedWorktree.path }}
                  </span>
                </div>

                <div class="repo-panel__worktree-actions">
                  <button
                    class="repo-panel__commit repo-panel__commit--active repo-panel__worktree-add"
                    type="button"
                    @click="emit('add-detected-worktree', detectedWorktree.path)"
                  >
                    Add as repo
                  </button>
                  <button
                    class="repo-panel__worktree-dismiss"
                    type="button"
                    @click="emit('dismiss-detected-worktree', detectedWorktree.path)"
                  >
                    Dismiss
                  </button>
                </div>
              </section>

              <section
                v-if="!props.isGitRepository"
                class="repo-panel__commit-box repo-panel__worktree-callout"
              >
                <div class="repo-panel__worktree-copy">
                  <span class="repo-panel__label">Git not initialized</span>
                  <strong class="repo-panel__worktree-branch">
                    This folder is not a Git repository
                  </strong>
                  <span class="repo-panel__worktree-path">
                    All files works normally. Initialize Git to enable branches, status and commit flow.
                  </span>
                </div>

                <div class="repo-panel__worktree-actions">
                  <button
                    class="repo-panel__commit repo-panel__commit--active repo-panel__worktree-add"
                    type="button"
                    :disabled="props.isLoading"
                    @click="emit('init-git')"
                  >
                    Initialize Git repository
                  </button>
                </div>
              </section>

              <div ref="branchPickerRef" class="repo-panel__branch-block">
                <section class="repo-panel__summary">
                  <div class="repo-panel__summary-row repo-panel__summary-row--branch">
                    <div class="repo-panel__summary-branch">
                    <div class="repo-panel__summary-toolbar">
                      <button
                        class="repo-panel__action"
                        :class="{ 'repo-panel__action--active': isBranchMenuOpen }"
                        type="button"
                        :disabled="!gitActionsEnabled"
                        :title="props.isGitRepository
                          ? `Switch branch (${currentBranchLabel})`
                          : 'Initialize Git repository to enable branches'"
                        aria-label="Switch branch"
                        :aria-expanded="isBranchMenuOpen"
                        aria-haspopup="dialog"
                        @click="toggleBranchMenu"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M6 4.25a2.75 2.75 0 1 1 2.57 2.74H10a3 3 0 0 1 3 3v3.18a2.75 2.75 0 1 1-1.5 0V10a1.5 1.5 0 0 0-1.5-1.5H8.57A2.75 2.75 0 1 1 6 4.25Zm1.25 0a1.25 1.25 0 1 0 1.25-1.25 1.25 1.25 0 0 0-1.25 1.25Zm8.25 11a1.25 1.25 0 1 0 1.25 1.25 1.25 1.25 0 0 0-1.25-1.25ZM7.25 19.5a1.25 1.25 0 1 0 1.25-1.25 1.25 1.25 0 0 0-1.25 1.25Z"
                          />
                        </svg>
                      </button>

                      <span
                        class="repo-panel__summary-value repo-panel__summary-value--ahead-behind repo-panel__summary-value--counts"
                        :title="aheadBehindTitle"
                      >
                        {{ aheadBehindLabel }}
                      </span>

                      <div class="repo-panel__summary-actions">
                        <button
                          class="repo-panel__action"
                          :class="{ 'repo-panel__action--active': shouldHighlightPull }"
                          type="button"
                          :disabled="!gitActionsEnabled || !canPull || !shouldHighlightPull"
                          :title="props.isGitRepository ? pullTitle : 'Initialize Git repository to enable pull'"
                          :aria-label="props.isGitRepository ? pullTitle : 'Pull unavailable until Git is initialized'"
                          @click="emit('pull')"
                        >
                          <span
                            v-if="props.toolbarBusyAction === 'pull'"
                            class="repo-panel__action-loader"
                            aria-hidden="true"
                          />
                          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M12 4.75a.75.75 0 0 1 .75.75v8.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V5.5a.75.75 0 0 1 .75-.75ZM6 18.5a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H6.75A.75.75 0 0 1 6 18.5Z"
                            />
                          </svg>
                        </button>

                        <button
                          class="repo-panel__action"
                          :class="{ 'repo-panel__action--dimmed': !shouldHighlightPush }"
                          type="button"
                          :disabled="!gitActionsEnabled || !canPush || !shouldHighlightPush"
                          :title="pushTitle"
                          :aria-label="pushTitle"
                          @click="emit('push')"
                        >
                          <span
                            v-if="props.toolbarBusyAction === 'push'"
                            class="repo-panel__action-loader"
                            aria-hidden="true"
                          />
                          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M6 18.5a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H6.75A.75.75 0 0 1 6 18.5ZM12 4.75a.75.75 0 0 1 .75.75v8.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V5.5a.75.75 0 0 1 .75-.75Z"
                              transform="rotate(180 12 12)"
                            />
                          </svg>
                        </button>

                        <button
                          class="repo-panel__action"
                          :class="{ 'repo-panel__action--active': isHistoryOpen }"
                          type="button"
                          :disabled="!gitActionsEnabled"
                          :title="historyCount
                            ? `Commit history (${historyCount.toLocaleString()}) ${SHORTCUTS.historyOpen.display}`
                            : (props.isGitRepository
                              ? `Commit history ${SHORTCUTS.historyOpen.display}`
                              : 'Initialize Git repository to enable history')"
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
                          <span
                            v-if="props.toolbarBusyAction === 'refresh'"
                            class="repo-panel__action-loader"
                            aria-hidden="true"
                          />
                          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M12 4.5a7.5 7.5 0 0 1 6.43 3.64V5.25a.75.75 0 0 1 1.5 0v5.25a.75.75 0 0 1-.75.75h-5.25a.75.75 0 0 1 0-1.5h3.5A6 6 0 1 0 18 13.5a.75.75 0 0 1 1.5 0A7.5 7.5 0 1 1 12 4.5Z"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>

                    </div>
                  </div>
                </section>

                <section
                  v-if="props.isGitRepository && isBranchMenuOpen"
                  class="repo-panel__branch-menu"
                  role="dialog"
                  aria-label="Branches"
                >
                  <div class="repo-panel__branch-search-row">
                    <input
                      ref="branchSearchInputRef"
                      v-model="branchFilter"
                      class="repo-panel__branch-search"
                      type="search"
                      :placeholder="branchSearchPlaceholder"
                      autocomplete="off"
                      spellcheck="false"
                      @keydown="handleBranchFilterKeydown"
                    />

                    <button
                      class="repo-panel__action"
                      :class="{ 'repo-panel__action--active': isBranchCreateMode }"
                      type="button"
                      :disabled="isLoading"
                      :title="branchCreateButtonTitle"
                      :aria-label="branchCreateButtonTitle"
                      @click="handleBranchCreateButtonClick"
                    >
                      <span
                        v-if="isLoading && isBranchCreateMode"
                        class="repo-panel__action-loader"
                        aria-hidden="true"
                      />
                      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M11.25 5.25a.75.75 0 0 1 1.5 0v6h6a.75.75 0 0 1 0 1.5h-6v6a.75.75 0 0 1-1.5 0v-6h-6a.75.75 0 0 1 0-1.5h6v-6Z"
                        />
                      </svg>
                    </button>
                  </div>

                  <div v-if="isBranchCreateMode" class="repo-panel__branch-hint">
                    {{ branchCreateHint }}
                  </div>

                  <div
                    v-if="isBranchCreateMode && canCreateBranch"
                    class="repo-panel__branch-create-actions"
                  >
                    <button
                      class="repo-panel__branch-create-action"
                      type="button"
                      :disabled="isLoading"
                      @click="handleCreateBranch('current-repo')"
                    >
                      Create Here
                    </button>
                    <button
                      class="repo-panel__branch-create-action repo-panel__branch-create-action--primary"
                      type="button"
                      :disabled="isLoading"
                      @click="handleCreateBranch('new-repo')"
                    >
                      New Repo
                    </button>
                  </div>

                  <div
                    v-if="!isBranchCreateMode && branchSections.length"
                    ref="branchListRef"
                    class="repo-panel__branch-list"
                  >
                    <section
                      v-for="section in branchSections"
                      :key="section.id"
                      class="repo-panel__branch-group"
                    >
                      <header class="repo-panel__branch-section">
                        <span class="repo-panel__branch-section-title">{{ section.title }}</span>
                        <span class="repo-panel__branch-section-count">{{ section.items.length }}</span>
                      </header>

                      <button
                        v-for="branch in section.items"
                        :key="branch.name"
                        class="repo-panel__branch-item"
                        :class="{
                          'repo-panel__branch-item--active': branch.current,
                          'repo-panel__branch-item--external': branch.checkedOutElsewhere,
                          'repo-panel__branch-item--remote': branch.kind === 'remote',
                        }"
                        type="button"
                        :title="branchItemTitle(branch)"
                        :disabled="branch.current"
                        @click="handleBranchSelect(branch)"
                        @contextmenu="openBranchItemMenu($event, branch)"
                      >
                        <span class="repo-panel__branch-item-main">
                          <span
                            v-if="branch.isWorktreeBranch"
                            class="repo-panel__branch-item-icon"
                            :class="{ 'repo-panel__branch-item-icon--dirty': branch.hasWorktreeChanges }"
                            aria-hidden="true"
                          >
                            <svg viewBox="0 0 24 24">
                              <path
                                d="M7.25 6.5a2.75 2.75 0 1 1 2.53 2.74v3.03h4.44a2.75 2.75 0 1 1 0 1.5H8.28V9.24A2.75 2.75 0 0 1 7.25 6.5Zm0 0a1.25 1.25 0 1 0 1.25-1.25A1.25 1.25 0 0 0 7.25 6.5Zm9.5 6.5a1.25 1.25 0 1 0 1.25-1.25A1.25 1.25 0 0 0 16.75 13Zm-9.5 4.5a2.75 2.75 0 1 1 2.53 2.74v-3.74h1.5v3.74A2.75 2.75 0 1 1 7.25 17.5Zm1.25 1.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"
                              />
                            </svg>
                          </span>
                          <span class="repo-panel__branch-item-text">
                            <span class="repo-panel__branch-item-name">{{ branch.displayName }}</span>
                            <span
                              v-if="branch.helperText && !branch.checkedOutElsewhere"
                              class="repo-panel__branch-item-helper"
                            >
                              {{ branch.helperText }}
                            </span>
                          </span>
                        </span>

                        <span v-if="branch.badges.length" class="repo-panel__branch-item-badges">
                          <span
                            v-for="badge in branch.badges"
                            :key="`${branch.name}-${badge.label}`"
                            class="repo-panel__branch-badge"
                            :class="`repo-panel__branch-badge--${badge.tone}`"
                          >
                            {{ badge.label }}
                          </span>
                        </span>
                      </button>
                    </section>
                  </div>

                  <div v-else-if="!isBranchCreateMode" class="repo-panel__branch-empty">
                    No branches match the current filter.
                  </div>
                </section>
              </div>

              <div
                v-if="visibleError"
                class="repo-panel__error"
                :title="visibleErrorTitle ?? undefined"
              >
                {{ visibleError }}
              </div>

              <div
                v-if="visibleOperationStatus"
                class="repo-panel__status-line"
                :title="visibleOperationStatus"
              >
                <span class="repo-panel__action-loader" aria-hidden="true" />
                <span>{{ visibleOperationStatus }}</span>
              </div>

              <div class="repo-panel__files-toolbar-stack">
                <div class="repo-panel__files-toolbar">
                  <button
                    class="repo-panel__files-toggle"
                    type="button"
                    :aria-expanded="isFilesExpanded"
                    @click="toggleFilesSection"
                  >
                    <span class="repo-panel__files-toggle-main">
                      <span class="repo-panel__label">Files</span>
                    </span>
                    <span class="repo-panel__files-toggle-meta">
                      <span
                        v-if="!isFilesExpanded"
                        class="repo-panel__files-indicators"
                        aria-hidden="true"
                      >
                        <span
                          v-for="indicator in fileStatusIndicators"
                          :key="indicator.id"
                          class="repo-panel__files-indicator"
                          :class="indicator.active ? indicator.accentClass : 'repo-panel__group-dot--inactive'"
                          :title="indicator.label"
                        />
                      </span>
                      <span class="repo-panel__group-chevron" aria-hidden="true">
                        {{ isFilesExpanded ? '▾' : '▸' }}
                      </span>
                    </span>
                  </button>
                  <div v-if="isFilesExpanded" class="repo-panel__files-toolbar-actions">
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
                    <button
                      class="repo-panel__mini-action repo-panel__mini-action--icon"
                      :class="{ 'repo-panel__action--active': isFilesFilterVisible || hasFilesFilter }"
                      type="button"
                      :title="filesFilterToggleTitle"
                      :aria-label="filesFilterToggleTitle"
                      @click="toggleFilesFilter"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M10.5 4a6.5 6.5 0 1 1-4.85 10.83l-2.12 2.12a.75.75 0 1 1-1.06-1.06l2.12-2.12A6.5 6.5 0 0 1 10.5 4Zm0 1.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"
                        />
                      </svg>
                    </button>
                  </div>
                </div>

                <div v-if="shouldShowFilesFilterRow" class="repo-panel__files-filter-row">
                  <input
                    ref="filesFilterInputRef"
                    v-model="filesFilter"
                    class="repo-panel__files-filter"
                    type="search"
                    placeholder="Filter files"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </div>
              </div>

              <div v-if="isFilesExpanded" class="repo-panel__groups">
                <section class="repo-panel__group">
                  <header class="repo-panel__group-header">
                    <button
                      class="repo-panel__group-toggle"
                      type="button"
                      :aria-expanded="isAllFilesExpanded"
                      @click="toggleAllFilesSection"
                    >
                      <span class="repo-panel__group-title">
                        <span class="repo-panel__group-dot repo-panel__group-dot--all" />
                        All files
                      </span>
                      <span class="repo-panel__group-chevron" aria-hidden="true">
                        {{ isAllFilesExpanded ? '▾' : '▸' }}
                      </span>
                    </button>

                    <div class="repo-panel__group-actions">
                      <button
                        v-if="!isAllFilesSearchMode && !shouldLoadAllFiles"
                        class="repo-panel__mini-action repo-panel__mini-action--icon"
                        type="button"
                        aria-label="Load files"
                        title="Load files"
                        @click.stop="requestAllFilesLoad"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M12 4.5a7.5 7.5 0 0 1 6.43 3.64V5.25a.75.75 0 0 1 1.5 0v5.25a.75.75 0 0 1-.75.75h-5.25a.75.75 0 0 1 0-1.5h3.5A6 6 0 1 0 18 13.5a.75.75 0 0 1 1.5 0A7.5 7.5 0 1 1 12 4.5Z"
                          />
                        </svg>
                      </button>
                      <span
                        v-if="(isAllFilesSearchMode && isSearchingAllFiles) || (!isAllFilesSearchMode && allFilesDirectoryLoading[''])"
                        class="repo-panel__group-loader"
                        aria-label="Loading file tree"
                        title="Loading file tree"
                      />
                      <span v-if="allFilesCountLabel" class="repo-panel__group-count">{{ allFilesCountLabel }}</span>
                    </div>
                  </header>

                  <div v-if="!isAllFilesExpanded" />

                  <div v-else-if="shouldShowAllFilesSearchHint" class="repo-panel__clean">
                    Type at least 2 characters to search files.
                  </div>

                  <div v-else-if="visibleAllFilesSearchError" class="repo-panel__error">
                    {{ visibleAllFilesSearchError }}
                  </div>

                  <p
                    v-else-if="isAllFilesSearchMode && isSearchingAllFiles && allFilesSearchResults === null"
                    class="repo-panel__group-collapsed-copy"
                  >
                    Searching files…
                  </p>

                  <p
                    v-else-if="!isAllFilesSearchMode && allFilesDirectoryLoading[''] && !hasAllFilesDirectoryLoaded('')"
                    class="repo-panel__group-collapsed-copy"
                  >
                    Loading file tree…
                  </p>

                  <div v-else-if="!shouldLoadAllFiles" />

                  <ul v-else-if="isAllFilesSearchMode && allFilesSearchResultsWithChanges.length" class="repo-panel__files">
                    <li
                      v-for="entry in allFilesSearchResultsWithChanges"
                      :key="`search:${entry.path}`"
                      class="repo-panel__file"
                    >
                      <button
                        v-if="canInteractWithAllFilesPath(entry.path)"
                        class="repo-panel__file-main"
                        :class="{ 'repo-panel__file-main--selected': selectedPath === entry.path }"
                        type="button"
                        @click="selectAllFilesPath(entry.path)"
                      >
                        <span class="repo-panel__file-meta">
                          <span class="repo-panel__file-name">{{ fileName(entry.path) }}</span>
                          <span class="repo-panel__file-directory">{{ fileDirectory(entry.path) }}</span>
                        </span>
                        <span
                          v-if="entry.item"
                          class="repo-panel__status-dot"
                          :class="statusDotClass(entry.item)"
                          aria-hidden="true"
                        />
                      </button>

                      <div v-else class="repo-panel__file-main repo-panel__file-main--static">
                        <span class="repo-panel__file-meta">
                          <span class="repo-panel__file-name">{{ fileName(entry.path) }}</span>
                          <span class="repo-panel__file-directory">{{ fileDirectory(entry.path) }}</span>
                        </span>
                      </div>
                    </li>
                  </ul>

                  <div v-else-if="isAllFilesSearchMode" class="repo-panel__clean">
                    No files match the current filter.
                  </div>

                  <div v-else-if="allFilesRootError" class="repo-panel__error">
                    {{ allFilesRootError }}
                  </div>

                  <ul v-else-if="allFilesTreeRows.length" class="repo-panel__tree">
                    <li
                      v-for="row in allFilesTreeRows"
                      :key="`repo:${row.type}:${row.path}`"
                      class="repo-panel__tree-row"
                    >
                      <button
                        v-if="row.type === 'directory'"
                        class="repo-panel__tree-directory repo-panel__tree-directory--button"
                        :style="treeRowStyle(row.depth)"
                        type="button"
                        @click="toggleAllFilesDirectory(row.path)"
                      >
                        <span class="repo-panel__tree-caret" aria-hidden="true">{{ row.isExpanded ? '▾' : '▸' }}</span>
                        <span class="repo-panel__tree-label">{{ row.name }}</span>
                        <span
                          v-if="row.isLoading"
                          class="repo-panel__group-loader"
                          aria-label="Loading directory"
                          title="Loading directory"
                        />
                        <span
                          v-else-if="row.item"
                          class="repo-panel__status-dot"
                          :class="statusDotClass(row.item)"
                          aria-hidden="true"
                        />
                      </button>

                      <div
                        v-else-if="row.type === 'message'"
                        class="repo-panel__tree-message"
                        :style="treeRowStyle(row.depth)"
                      >
                        {{ row.message }}
                      </div>

                      <button
                        v-else-if="canInteractWithAllFilesPath(row.path)"
                        class="repo-panel__tree-file"
                        :class="{ 'repo-panel__tree-file--selected': selectedPath === row.path }"
                        type="button"
                        :style="treeRowStyle(row.depth)"
                        @click="selectAllFilesPath(row.path)"
                      >
                        <span class="repo-panel__tree-label">{{ row.name }}</span>
                        <span
                          v-if="row.item"
                          class="repo-panel__status-dot"
                          :class="statusDotClass(row.item)"
                          aria-hidden="true"
                        />
                      </button>

                      <div
                        v-else
                        class="repo-panel__tree-file-static"
                        :style="treeRowStyle(row.depth)"
                      >
                        <span class="repo-panel__tree-label">{{ row.name }}</span>
                      </div>
                    </li>
                  </ul>

                  <div v-else class="repo-panel__clean">
                    No files found.
                  </div>
                </section>

                <template v-if="!areFileDetailsLoaded">
                  <div v-if="isNonGitRepository" class="repo-panel__clean">
                    Change tracking requires a Git repository.
                  </div>

                  <div v-else class="repo-panel__clean">
                    Opened files view is loading repository details…
                  </div>
                </template>

                <template v-else-if="hasVisibleSections">
                  <section
                    v-for="section in visibleSections"
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
                        <span class="repo-panel__group-count">{{ sectionCountLabel(section) }}</span>
                        <button
                          v-if="section.action && !(section.id === 'untracked' && isSectionCollapsed(section.id))"
                          class="repo-panel__mini-action"
                          type="button"
                          :disabled="isLoading || !section.filteredItems.length"
                          @click="triggerAction(section.action, getSectionActionPaths(section.filteredItems))"
                        >
                          {{ section.action === 'stage' ? 'Stage all' : 'Unstage all' }}
                        </button>
                      </div>
                    </header>

                    <div
                      v-if="section.id === 'staged'"
                      class="repo-panel__commit-box"
                      :class="{ 'repo-panel__commit-box--ready': canCommit }"
                    >
                      <div class="repo-panel__commit-box-header">
                        <span class="repo-panel__commit-label">Commit</span>
                        <span class="repo-panel__commit-hint">
                          {{ section.items.length.toLocaleString() }} staged
                        </span>
                      </div>

                      <div class="repo-panel__commit-row">
                        <input
                          id="commit-message"
                          ref="commitInputRef"
                          class="repo-panel__commit-input"
                          type="text"
                          :disabled="isLoading"
                          :value="commitMessage"
                          placeholder="feat(scope): short commit message"
                          @input="handleCommitMessageUpdate"
                          @keydown.enter.prevent="handleCommitSubmit"
                        />

                        <button
                          class="repo-panel__commit repo-panel__commit--icon"
                          :class="{ 'repo-panel__commit--active': canCommit }"
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
                    </div>

                    <p v-if="isSectionCollapsed(section.id)" class="repo-panel__group-collapsed-copy">
                      {{ sectionCollapsedCopy(section) }}
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
                          @click="emit('select-file', item.path, getSectionDiffMode(section.id))"
                          @contextmenu="openFileMenu($event, item)"
                          @dblclick="selectAndActivateFile(item.path, section.action)"
                          @keydown.enter.prevent="activateFile(item.path, section.action)"
                        >
                          <span class="repo-panel__file-meta">
                            <span class="repo-panel__file-name">{{ fileName(item.path) }}</span>
                            <span class="repo-panel__file-directory">{{ fileDirectory(item.path) }}</span>
                          </span>
                          <span class="repo-panel__status-dot" :class="statusDotClass(item, section.id)" aria-hidden="true" />
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
                          @click="emit('select-file', row.path, getSectionDiffMode(section.id))"
                          @contextmenu="row.item && openFileMenu($event, row.item)"
                          @dblclick="selectAndActivateFile(row.path, section.action)"
                          @keydown.enter.prevent="activateFile(row.path, section.action)"
                        >
                          <span class="repo-panel__tree-label">{{ row.name }}</span>
                          <span
                            v-if="row.item"
                            class="repo-panel__status-dot"
                            :class="statusDotClass(row.item, section.id)"
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    </ul>
                  </section>
                </template>

                <div v-else class="repo-panel__clean">
                  {{ noVisibleChangedFilesCopy() }}
                </div>
              </div>
            </div>

          </template>
        </div>
      </div>
    </section>

    <div v-if="!hasWorkspaceItems && !repoPath" class="repo-panel__empty">
      <span class="repo-panel__eyebrow">Source Control</span>
      <h2 class="repo-panel__title">Choose a repository</h2>
      <p class="repo-panel__empty-copy">
        Open any local Git repository to populate branches, changed files, and commit actions.
      </p>
      <button class="repo-panel__commit" type="button" @click="emit('open-repo')">
        Open Repo
      </button>
    </div>

    <div
      v-if="fileMenu"
      class="repo-panel__file-menu"
      :style="{ left: `${fileMenu.x}px`, top: `${fileMenu.y}px` }"
      role="menu"
      aria-label="File actions"
    >
      <template v-if="fileMenuMode === 'actions'">
        <button
          class="repo-panel__file-menu-item"
          type="button"
          role="menuitem"
          @click="handleShowFileDiff"
        >
          Show diff
        </button>
        <button
          v-if="fileMenu.canOpenFile"
          class="repo-panel__file-menu-item"
          type="button"
          role="menuitem"
          @click="handleOpenWorkspaceFile"
        >
          Open file
        </button>
        <button
          class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
          type="button"
          role="menuitem"
          @click="handleFileDiscardStart"
        >
          Discard file changes
        </button>
      </template>

      <div v-else class="repo-panel__workspace-remove-confirm">
        <p class="repo-panel__workspace-remove-copy">
          {{ fileDiscardTitle() }}
        </p>
        <p class="repo-panel__workspace-remove-note">
          {{ fileDiscardCopy() }}
        </p>
        <div class="repo-panel__workspace-rename-actions">
          <button
            class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
            type="button"
            @click="handleFileDiscard"
          >
            Discard
          </button>
          <button
            class="repo-panel__file-menu-item"
            type="button"
            @click="closeFileMenu"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="workspaceMenu"
      class="repo-panel__workspace-menu"
      :style="{ left: `${workspaceMenu.x}px`, top: `${workspaceMenu.y}px` }"
      role="menu"
      aria-label="Workspace actions"
    >
      <template v-if="workspaceMenuMode === 'actions'">
        <button
          class="repo-panel__file-menu-item"
          type="button"
          role="menuitem"
          @click="handleWorkspaceRenameStart"
        >
          Rename
        </button>
        <button
          class="repo-panel__file-menu-item"
          type="button"
          role="menuitem"
          @click="handleWorkspaceRepoChange"
        >
          Change repository folder…
        </button>
        <div
          v-if="workspaceMenu.worktreeRole === 'linked'"
          class="repo-panel__menu-divider"
          aria-hidden="true"
        />
        <button
          v-if="workspaceMenu.worktreeRole === 'linked'"
          class="repo-panel__file-menu-item"
          type="button"
          role="menuitem"
          @click="handleWorkspaceWorktreeMerge"
        >
          Merge into primary branch
        </button>
        <button
          v-if="workspaceMenu.worktreeRole === 'linked'"
          class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
          type="button"
          role="menuitem"
          @click="handleWorkspaceWorktreeRemoveStart"
        >
          Remove worktree
        </button>
        <button
          v-if="workspaceMenu.worktreeRole === 'linked'"
          class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
          type="button"
          role="menuitem"
          @click="handleWorkspaceWorktreeRemoveAndDeleteBranchStart"
        >
          Remove worktree and delete branch
        </button>
        <div class="repo-panel__menu-divider" aria-hidden="true" />
        <button
          class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
          type="button"
          role="menuitem"
          @click="handleWorkspaceRemoveStart"
        >
          Remove from list
        </button>
      </template>

      <form
        v-else-if="workspaceMenuMode === 'rename'"
        class="repo-panel__workspace-rename-form"
        @submit.prevent="handleWorkspaceRenameSubmit"
      >
        <label class="repo-panel__workspace-rename-label" for="workspace-rename-input">
          Workspace title
        </label>
        <input
          id="workspace-rename-input"
          ref="workspaceRenameInputRef"
          v-model="workspaceRenameValue"
          class="repo-panel__workspace-rename-input"
          type="text"
          autocomplete="off"
          @keydown="handleWorkspaceRenameKeydown"
        />
        <div class="repo-panel__workspace-rename-actions">
          <button
            class="repo-panel__file-menu-item"
            type="submit"
          >
            Save
          </button>
          <button
            class="repo-panel__file-menu-item"
            type="button"
            @click="closeWorkspaceMenu"
          >
            Cancel
          </button>
        </div>
      </form>

      <div v-else class="repo-panel__workspace-remove-confirm">
        <template v-if="workspaceMenuMode === 'worktree-remove-confirm'">
          <p class="repo-panel__workspace-remove-copy">
            Remove worktree <strong>{{ workspaceMenu.title }}</strong>?
          </p>
          <p class="repo-panel__workspace-remove-note">
            Removes the linked checkout folder from disk and this repo from the sidebar.
          </p>
          <div class="repo-panel__workspace-rename-actions">
            <button
              class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
              type="button"
              @click="handleWorkspaceWorktreeRemove"
            >
              Remove worktree
            </button>
            <button
              class="repo-panel__file-menu-item"
              type="button"
              @click="closeWorkspaceMenu"
            >
              Cancel
            </button>
          </div>
        </template>
        <template v-else-if="workspaceMenuMode === 'worktree-remove-delete-confirm'">
          <p class="repo-panel__workspace-remove-copy">
            Remove worktree <strong>{{ workspaceMenu.title }}</strong> and delete branch <strong>{{ workspaceMenu.branch ?? 'unknown' }}</strong>?
          </p>
          <p class="repo-panel__workspace-remove-note">
            Safe only. The primary repo must already be on its primary branch, and this branch must already be merged.
          </p>
          <div class="repo-panel__workspace-rename-actions">
            <button
              class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
              type="button"
              @click="handleWorkspaceWorktreeRemoveAndDeleteBranch"
            >
              Remove and delete branch
            </button>
            <button
              class="repo-panel__file-menu-item"
              type="button"
              @click="closeWorkspaceMenu"
            >
              Cancel
            </button>
          </div>
        </template>
        <template v-else>
        <p class="repo-panel__workspace-remove-copy">
          Remove <strong>{{ workspaceMenu.title }}</strong> from the workspace list?
        </p>
        <p class="repo-panel__workspace-remove-note">
          The repository on disk stays untouched. Local tabs and layout for this workspace will be forgotten.
        </p>
        <div class="repo-panel__workspace-rename-actions">
          <button
            class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
            type="button"
            @click="handleWorkspaceRemove"
          >
            Remove
          </button>
          <button
            class="repo-panel__file-menu-item"
            type="button"
            @click="closeWorkspaceMenu"
          >
            Cancel
          </button>
        </div>
        </template>
      </div>
    </div>

    <div
      v-if="branchItemMenu"
      class="repo-panel__file-menu repo-panel__branch-item-menu"
      :style="{ left: `${branchItemMenu.x}px`, top: `${branchItemMenu.y}px` }"
      role="menu"
      aria-label="Branch actions"
    >
      <template v-if="branchItemMenuMode === 'actions'">
        <button
          class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
          type="button"
          role="menuitem"
          @click="handleBranchDeleteStart"
        >
          Delete branch
        </button>
      </template>

      <div v-else class="repo-panel__workspace-remove-confirm">
        <p class="repo-panel__workspace-remove-copy">
          Delete branch <strong>{{ branchItemMenu.branch.name }}</strong>?
        </p>
        <p class="repo-panel__workspace-remove-note">
          Deletes only the local branch. Git will refuse if it is not safely merged yet.
        </p>
        <div class="repo-panel__workspace-rename-actions">
          <button
            class="repo-panel__file-menu-item repo-panel__file-menu-item--danger"
            type="button"
            @click="handleBranchDelete"
          >
            Delete branch
          </button>
          <button
            class="repo-panel__file-menu-item"
            type="button"
            @click="closeBranchItemMenu"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.git-panel {
  --repo-panel-content-inset: 0px;
  --repo-panel-control-pad-x: 10px;
  --repo-panel-control-pad-y: 4px;
  --repo-panel-item-pad-y: 6px;
  --repo-panel-card-pad: 10px;
  --repo-panel-scale: calc(var(--repo-panel-font-size-px, 12) / 12);
  --repo-panel-surface-bg: rgba(22, 29, 38, 0.82);
  --repo-panel-surface-active-bg: rgba(25, 34, 45, 0.92);
  --repo-panel-button-bg: rgba(16, 23, 31, 0.94);
  --repo-panel-button-strong-bg: linear-gradient(180deg, rgba(25, 34, 45, 0.92), rgba(18, 24, 32, 0.92));
  --repo-panel-button-active-bg: rgba(25, 34, 45, 0.96);
  --repo-panel-menu-bg:
    linear-gradient(160deg, rgba(69, 151, 250, 0.08), transparent 34%),
    rgba(10, 14, 19, 0.98);
  --repo-panel-menu-item-bg: rgba(17, 23, 31, 0.9);
  --repo-panel-input-bg: rgba(9, 12, 17, 0.92);
  --repo-panel-muted-surface-bg: rgba(13, 18, 24, 0.72);
  --repo-panel-commit-input-bg: rgba(8, 11, 14, 0.92);
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 12px 2px 10px 12px;
  box-sizing: border-box;
  overflow: hidden;
}

.git-panel[data-appearance-theme='bridgegit-light'] {
  --repo-panel-surface-bg: rgba(236, 242, 249, 0.96);
  --repo-panel-surface-active-bg: rgba(224, 234, 244, 0.98);
  --repo-panel-button-bg: rgba(236, 242, 249, 0.98);
  --repo-panel-button-strong-bg: linear-gradient(180deg, rgba(236, 242, 249, 0.98), rgba(227, 236, 245, 0.98));
  --repo-panel-button-active-bg: rgba(224, 234, 244, 0.98);
  --repo-panel-menu-bg:
    linear-gradient(160deg, rgba(88, 154, 225, 0.08), transparent 34%),
    rgba(248, 251, 255, 0.98);
  --repo-panel-menu-item-bg: rgba(236, 242, 249, 0.98);
  --repo-panel-input-bg: rgba(255, 255, 255, 0.98);
  --repo-panel-muted-surface-bg: rgba(240, 245, 250, 0.86);
  --repo-panel-commit-input-bg: rgba(255, 255, 255, 0.98);
}

.git-panel[data-appearance-theme='github-dark'] {
  --repo-panel-surface-bg: #161b22;
  --repo-panel-surface-active-bg: #21262d;
  --repo-panel-button-bg: #21262d;
  --repo-panel-button-strong-bg: linear-gradient(180deg, #21262d, #161b22);
  --repo-panel-button-active-bg: #30363d;
  --repo-panel-menu-bg:
    linear-gradient(160deg, rgba(56, 139, 253, 0.08), transparent 34%),
    #0d1117;
  --repo-panel-menu-item-bg: #161b22;
  --repo-panel-input-bg: #0d1117;
  --repo-panel-muted-surface-bg: rgba(22, 27, 34, 0.86);
  --repo-panel-commit-input-bg: #0d1117;
}

.git-panel[data-appearance-theme='github-light'] {
  --repo-panel-surface-bg: #f6f8fa;
  --repo-panel-surface-active-bg: #eef2f6;
  --repo-panel-button-bg: #f6f8fa;
  --repo-panel-button-strong-bg: linear-gradient(180deg, #ffffff, #f6f8fa);
  --repo-panel-button-active-bg: #eef2f6;
  --repo-panel-menu-bg:
    linear-gradient(160deg, rgba(9, 105, 218, 0.06), transparent 34%),
    #ffffff;
  --repo-panel-menu-item-bg: #f6f8fa;
  --repo-panel-input-bg: #ffffff;
  --repo-panel-muted-surface-bg: rgba(246, 248, 250, 0.9);
  --repo-panel-commit-input-bg: #ffffff;
}

.git-panel[data-appearance-theme='nord'] {
  --repo-panel-surface-bg: rgba(59, 66, 82, 0.9);
  --repo-panel-surface-active-bg: rgba(67, 76, 94, 0.96);
  --repo-panel-button-bg: rgba(67, 76, 94, 0.94);
  --repo-panel-button-strong-bg: linear-gradient(180deg, rgba(67, 76, 94, 0.96), rgba(59, 66, 82, 0.96));
  --repo-panel-button-active-bg: rgba(76, 86, 106, 0.98);
  --repo-panel-menu-bg:
    linear-gradient(160deg, rgba(136, 192, 208, 0.08), transparent 34%),
    rgba(46, 52, 64, 0.98);
  --repo-panel-menu-item-bg: rgba(59, 66, 82, 0.92);
  --repo-panel-input-bg: rgba(46, 52, 64, 0.96);
  --repo-panel-muted-surface-bg: rgba(46, 52, 64, 0.84);
  --repo-panel-commit-input-bg: rgba(46, 52, 64, 0.96);
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
  margin-right: 10px;
  padding: 0 0 10px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.14);
}

.repo-panel__workspaces {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.repo-panel__workspaces-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-right: 10px;
  padding-inline: var(--repo-panel-content-inset);
  box-sizing: border-box;
}

.repo-panel__workspaces-heading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.repo-panel__workspace-family-switcher {
  display: grid;
  gap: 8px;
  margin-right: 10px;
  padding-inline: var(--repo-panel-content-inset);
  box-sizing: border-box;
}

.repo-panel__workspace-family-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.repo-panel__workspace-family-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.76rem * var(--repo-panel-scale));
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__workspace-family-count {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: calc(0.72rem * var(--repo-panel-scale));
  white-space: nowrap;
}

.repo-panel__workspace-family-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.repo-panel__workspace-family-select {
  width: 100%;
  min-width: 0;
  padding: 0.58rem 0.72rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--repo-panel-input-bg);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.76rem * var(--repo-panel-scale));
}

.repo-panel__workspace-list {
  display: grid;
  align-content: start;
  gap: 6px;
  flex: 1 1 auto;
  width: 100%;
  overflow: auto;
  overflow-x: hidden;
  min-height: 0;
  padding-right: 0;
  box-sizing: border-box;
  scrollbar-gutter: stable;
}

.repo-panel__workspace-entry {
  display: grid;
  position: relative;
  width: 100%;
  transition:
    opacity 140ms ease,
    transform 140ms ease;
}

.repo-panel__workspace-entry--dragging {
  opacity: 0.48;
}

.repo-panel__workspace-entry--drop-target .repo-panel__workspace-item {
  border-color: rgba(110, 197, 255, 0.46);
  box-shadow:
    0 0 0 1px rgba(110, 197, 255, 0.18),
    inset 0 2px 0 rgba(110, 197, 255, 0.32);
}

.repo-panel__workspace-detail {
  display: grid;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 8px var(--repo-panel-content-inset) 6px;
  box-sizing: border-box;
}

.repo-panel__worktree-callout {
  width: 100%;
  min-width: 0;
  gap: 12px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    0 0 0 1px rgba(111, 224, 165, 0.08);
  box-sizing: border-box;
}

.repo-panel__worktree-copy {
  display: grid;
  gap: 4px;
}

.repo-panel__worktree-branch {
  color: #e7fff0;
  font-family: var(--font-mono);
  font-size: calc(0.74rem * var(--repo-panel-scale));
  font-weight: 600;
  letter-spacing: 0.01em;
}

.repo-panel__worktree-path {
  overflow: hidden;
  color: rgba(188, 210, 196, 0.78);
  font-family: var(--font-mono);
  font-size: calc(0.72rem * var(--repo-panel-scale));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__worktree-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
}

.repo-panel__worktree-add {
  min-height: 34px;
  padding: 0.5rem 0.8rem;
  font-size: calc(0.76rem * var(--repo-panel-scale));
}

.repo-panel__worktree-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  margin-left: auto;
  padding: 0.5rem 0.8rem;
  border: 1px solid rgba(111, 224, 165, 0.18);
  border-radius: 10px;
  background: rgba(8, 11, 14, 0.72);
  color: rgba(232, 255, 241, 0.86);
  font-size: calc(0.76rem * var(--repo-panel-scale));
  font-weight: 600;
  opacity: 0.9;
}

.repo-panel__worktree-dismiss:hover {
  border-color: rgba(111, 224, 165, 0.28);
  background: rgba(12, 18, 15, 0.92);
  opacity: 1;
}

.repo-panel__worktree-dismiss:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px rgba(111, 224, 165, 0.22);
}

.repo-panel__workspace-item {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: var(--repo-panel-item-pad-y) var(--repo-panel-control-pad-x);
  border: 1px solid transparent;
  border-radius: 12px;
  background: var(--repo-panel-surface-bg);
  color: var(--text-primary);
  text-align: left;
  box-sizing: border-box;
}

.repo-panel__workspace-item--current,
.repo-panel__workspace-item:hover {
  border-color: rgba(110, 197, 255, 0.34);
  background: var(--repo-panel-surface-active-bg);
}

.repo-panel__workspace-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: calc(0.74rem * var(--repo-panel-scale));
  font-weight: 500;
}

.repo-panel__workspace-mainline,
.repo-panel__workspace-subline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.repo-panel__workspace-mainline {
  align-items: baseline;
}

.repo-panel__workspace-branch {
  min-width: 0;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: calc(0.72rem * var(--repo-panel-scale));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__workspace-counts {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: calc(0.72rem * var(--repo-panel-scale));
  white-space: nowrap;
  flex: 0 0 auto;
}

.repo-panel__workspace-dots {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.repo-panel__workspace-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  opacity: 0.96;
  transform: translateZ(0);
}

.repo-panel__workspace-dot--activity {
  background: #6cb0ff;
}

.repo-panel__workspace-dot--repo {
  background: #d6975a;
}

.repo-panel__workspace-dot--attention {
  background: #d6975a;
}

.repo-panel__workspace-dot--inactive {
  opacity: 0.28;
}

.repo-panel__workspace-dot--active {
  opacity: 0.82;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.04);
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
  font-size: calc(0.76rem * var(--repo-panel-scale));
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
  background: var(--repo-panel-button-bg);
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
  border-color: rgba(255, 176, 102, 0.34);
  background: rgba(255, 176, 102, 0.12);
  box-shadow: 0 0 0 1px rgba(255, 176, 102, 0.08), 0 0 18px rgba(255, 176, 102, 0.18);
  color: #ffb066;
}

.repo-panel__eyebrow,
.repo-panel__summary-label,
.repo-panel__label {
  color: var(--text-dim);
  font-size: calc(0.72rem * var(--repo-panel-scale));
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.repo-panel__action,
.repo-panel__mini-action,
.repo-panel__commit {
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--repo-panel-button-strong-bg);
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

.repo-panel__action-loader {
  width: 14px;
  height: 14px;
  border: 1.5px solid rgba(127, 142, 164, 0.22);
  border-top-color: currentColor;
  border-radius: 999px;
  animation: repo-panel-spin 700ms linear infinite;
}

.repo-panel__action--active {
  border-color: rgba(110, 197, 255, 0.34);
  background: var(--repo-panel-button-active-bg);
  color: rgba(123, 208, 255, 0.94);
  opacity: 1;
}

.repo-panel__action--dimmed {
  color: var(--text-dim);
  opacity: 0.38;
}

.repo-panel__branch-block {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.repo-panel__summary {
  display: grid;
  gap: 6px;
  min-width: 0;
  width: 100%;
  padding: 0 0 8px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.14);
  box-sizing: border-box;
}

.repo-panel__summary-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.repo-panel__files-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  padding: var(--repo-panel-control-pad-y) var(--repo-panel-control-pad-x);
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    box-shadow 140ms ease;
}

.repo-panel__files-toggle:hover {
  background: rgba(108, 176, 255, 0.08);
}

.repo-panel__files-toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px rgba(108, 176, 255, 0.34);
}

.repo-panel__files-toggle-main,
.repo-panel__files-toggle-meta,
.repo-panel__files-indicators {
  display: inline-flex;
  align-items: center;
}

.repo-panel__files-toggle-main {
  min-width: 0;
  flex: 1 1 auto;
}

.repo-panel__files-toggle-meta {
  gap: 10px;
  flex: 0 0 auto;
}

.repo-panel__files-indicators {
  gap: 6px;
}

.repo-panel__summary-row--branch {
  grid-template-columns: minmax(0, 1fr);
}

.repo-panel__summary-row:not(:last-child) {
  padding-bottom: 6px;
}

.repo-panel__summary-branch {
  display: grid;
  gap: 8px;
  min-width: 0;
  position: relative;
  overflow: visible;
}

.repo-panel__summary-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.repo-panel__summary-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.repo-panel__summary-value {
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--text-muted);
  font-size: calc(0.76rem * var(--repo-panel-scale));
  font-weight: 500;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.repo-panel__summary-value--ahead-behind {
  color: var(--text-primary);
  font-size: calc(0.7rem * var(--repo-panel-scale));
  font-weight: 400;
}

.repo-panel__summary-value--counts {
  padding-inline: 2px;
  text-align: left;
  flex: 0 0 auto;
}

.repo-panel__select {
  width: 100%;
  min-width: 0;
}

.repo-panel__branch-menu {
  display: grid;
  gap: 6px;
  padding: 0 2px 2px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-size: calc(0.76rem * var(--repo-panel-scale));
}

.repo-panel__branch-menu input,
.repo-panel__branch-menu button {
  font: inherit;
}

.repo-panel__branch-search {
  width: 100%;
  padding: 0.68rem 0.78rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--repo-panel-input-bg);
  color: var(--text-primary);
  font-size: calc(0.76rem * var(--repo-panel-scale));
  line-height: 1.2;
}

.repo-panel__branch-search-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.repo-panel__branch-hint {
  color: var(--text-dim);
  font-size: calc(0.74rem * var(--repo-panel-scale));
  line-height: 1.3;
}

.repo-panel__branch-create-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.repo-panel__branch-create-action {
  min-height: 34px;
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  background: var(--repo-panel-input-bg);
  color: var(--text-secondary);
  transition:
    background 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.repo-panel__branch-create-action:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.repo-panel__branch-create-action--primary {
  color: var(--text-primary);
}

.repo-panel__branch-list {
  display: grid;
  gap: 10px;
}

.repo-panel__branch-group {
  display: grid;
  gap: 6px;
}

.repo-panel__branch-group + .repo-panel__branch-group {
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
}

.repo-panel__branch-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-inline: 4px;
}

.repo-panel__branch-section-title {
  color: var(--text-dim);
  font-size: calc(0.68rem * var(--repo-panel-scale));
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.repo-panel__branch-section-count {
  color: var(--text-muted);
  font-size: calc(0.68rem * var(--repo-panel-scale));
  font-variant-numeric: tabular-nums;
}

.repo-panel__branch-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: var(--repo-panel-item-pad-y) var(--repo-panel-control-pad-x);
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--repo-panel-menu-item-bg);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.82rem * var(--repo-panel-scale));
  line-height: 1.2;
  text-align: left;
}

.repo-panel__branch-item:disabled {
  cursor: default;
  opacity: 1;
}

.repo-panel__branch-item--active,
.repo-panel__branch-item:hover {
  border-color: rgba(110, 197, 255, 0.24);
  background: var(--repo-panel-surface-active-bg);
}

.repo-panel__branch-item--external {
  border-color: rgba(242, 165, 65, 0.16);
}

.repo-panel__branch-item--remote {
  border-color: rgba(110, 197, 255, 0.12);
}

.repo-panel__branch-item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__branch-item-main {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.repo-panel__branch-item-text {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.repo-panel__branch-item-helper {
  color: var(--text-dim);
  font-size: calc(0.71rem * var(--repo-panel-scale));
  line-height: 1.3;
}

.repo-panel__branch-item-badges {
  display: inline-flex;
  align-items: flex-start;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
  flex: 0 0 auto;
}

.repo-panel__branch-item-icon {
  display: inline-flex;
  width: 0.95rem;
  height: 0.95rem;
  flex: 0 0 auto;
  color: rgba(170, 176, 186, 0.88);
}

.repo-panel__branch-item-icon--dirty {
  color: rgba(242, 165, 65, 0.92);
}

.repo-panel__branch-item-icon svg {
  width: 100%;
  height: 100%;
  fill: currentColor;
}

.repo-panel__branch-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-panel__branch-badge {
  display: inline-flex;
  align-items: center;
  min-height: 1.35rem;
  padding: 0.16rem 0.44rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: calc(0.66rem * var(--repo-panel-scale));
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.repo-panel__branch-badge--neutral {
  border-color: rgba(160, 170, 184, 0.18);
  color: var(--text-muted);
  background: rgba(130, 140, 154, 0.1);
}

.repo-panel__branch-badge--success {
  border-color: rgba(94, 191, 126, 0.22);
  color: rgba(160, 232, 183, 0.96);
  background: rgba(40, 98, 61, 0.26);
}

.repo-panel__branch-badge--warning {
  border-color: rgba(242, 165, 65, 0.24);
  color: rgba(255, 210, 145, 0.98);
  background: rgba(108, 70, 23, 0.28);
}

.repo-panel__branch-badge--danger {
  border-color: rgba(236, 99, 99, 0.26);
  color: rgba(255, 186, 186, 0.98);
  background: rgba(114, 36, 36, 0.3);
}

.repo-panel__branch-empty {
  color: var(--text-dim);
  font-size: calc(0.74rem * var(--repo-panel-scale));
}

.repo-panel__file-menu {
  position: fixed;
  z-index: 40;
  display: grid;
  min-width: 168px;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--repo-panel-menu-bg);
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.34);
}

.repo-panel__workspace-menu {
  position: fixed;
  z-index: 40;
  display: grid;
  min-width: 200px;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--repo-panel-menu-bg);
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.34);
}

.repo-panel__file-menu-item {
  padding: 0.42rem 0.56rem;
  border: 1px solid transparent;
  border-radius: 9px;
  background: var(--repo-panel-menu-item-bg);
  color: var(--text-primary);
  font-size: calc(0.74rem * var(--repo-panel-scale));
  line-height: 1.2;
  text-align: left;
}

.repo-panel__file-menu-item:hover {
  border-color: rgba(110, 197, 255, 0.24);
  background: var(--repo-panel-surface-active-bg);
}

.repo-panel__file-menu-item--danger {
  color: #ffb3ad;
}

.repo-panel__menu-divider {
  height: 1px;
  margin: 4px 6px;
  background: color-mix(in srgb, var(--border-subtle) 72%, transparent);
}

.repo-panel__workspace-rename-form {
  display: grid;
  gap: 8px;
}

.repo-panel__workspace-remove-confirm {
  display: grid;
  gap: 8px;
}

.repo-panel__workspace-rename-label {
  color: var(--text-dim);
  font-size: calc(0.7rem * var(--repo-panel-scale));
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.repo-panel__workspace-rename-input {
  width: 100%;
  min-width: 0;
  padding: 0.55rem 0.62rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--repo-panel-input-bg);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.78rem * var(--repo-panel-scale));
}

.repo-panel__workspace-remove-copy,
.repo-panel__workspace-remove-note {
  margin: 0;
  color: var(--text-primary);
  font-size: calc(0.76rem * var(--repo-panel-scale));
  line-height: 1.4;
}

.repo-panel__workspace-remove-note {
  color: var(--text-muted);
}

.repo-panel__workspace-rename-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.repo-panel__files-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  width: 100%;
  flex: 0 0 auto;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.14);
  box-sizing: border-box;
}

.repo-panel__files-toolbar-stack {
  display: grid;
  gap: 10px;
}

.repo-panel__files-toolbar-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.repo-panel__files-filter-row {
  display: flex;
  min-width: 0;
}

.repo-panel__files-filter {
  width: 100%;
  min-width: 0;
  padding: 0.6rem 0.72rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--repo-panel-input-bg);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.76rem * var(--repo-panel-scale));
}

.repo-panel__view-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
}

.repo-panel__view-button {
  border: 0;
  border-right: 1px solid var(--border-subtle);
  background: var(--repo-panel-button-bg);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: calc(0.76rem * var(--repo-panel-scale));
  font-weight: 600;
  padding: 0.42rem 0.72rem;
}

.repo-panel__view-button:last-child {
  border-right: 0;
}

.repo-panel__view-button--active {
  background: var(--repo-panel-button-active-bg);
  color: var(--text-primary);
}

.repo-panel__groups {
  display: grid;
  flex: 1 1 auto;
  align-content: start;
  justify-items: stretch;
  grid-auto-rows: max-content;
  gap: 0;
  min-height: 0;
  width: 100%;
  overflow: auto;
  overflow-x: hidden;
  padding-right: 0;
  box-sizing: border-box;
}

.repo-panel__group {
  display: grid;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 10px 0;
  box-sizing: border-box;
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
  padding: var(--repo-panel-control-pad-y) var(--repo-panel-control-pad-x);
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    box-shadow 140ms ease;
}

.repo-panel__group-toggle:hover {
  background: rgba(108, 176, 255, 0.08);
}

.repo-panel__group-toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px rgba(108, 176, 255, 0.34);
}

.repo-panel__group-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: calc(0.72rem * var(--repo-panel-scale));
  min-width: 0;
}

.repo-panel__group-chevron {
  color: var(--text-dim);
  font-size: calc(0.76rem * var(--repo-panel-scale));
}

.repo-panel__group-collapsed-copy {
  margin: 0;
  color: var(--text-muted);
  font-size: calc(0.78rem * var(--repo-panel-scale));
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

.repo-panel__group-dot--all {
  background: rgba(127, 142, 164, 0.36);
  box-shadow: inset 0 0 0 1px rgba(127, 142, 164, 0.18);
}

.repo-panel__group-dot--inactive {
  background: rgba(127, 142, 164, 0.36);
  box-shadow: inset 0 0 0 1px rgba(127, 142, 164, 0.18);
}

.repo-panel__files-indicator {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.repo-panel__group-count {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: calc(0.72rem * var(--repo-panel-scale));
}

.repo-panel__group-loader {
  width: 12px;
  height: 12px;
  border: 1.5px solid rgba(127, 142, 164, 0.22);
  border-top-color: rgba(127, 142, 164, 0.86);
  border-radius: 999px;
  animation: repo-panel-spin 700ms linear infinite;
}

.repo-panel__mini-action {
  padding: 0.45rem 0.7rem;
  font-size: calc(0.78rem * var(--repo-panel-scale));
}

.repo-panel__mini-action--active {
  border-color: rgba(110, 197, 255, 0.34);
  background: var(--repo-panel-button-active-bg);
  color: rgba(123, 208, 255, 0.94);
  opacity: 1;
}

.repo-panel__mini-action--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
}

.repo-panel__mini-action--icon svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.repo-panel__files {
  display: grid;
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  box-sizing: border-box;
}

.repo-panel__file {
  display: block;
}

.repo-panel__file-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: var(--repo-panel-item-pad-y) var(--repo-panel-control-pad-x);
  border: 1px solid transparent;
  border-radius: 12px;
  background: var(--repo-panel-surface-bg);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.74rem * var(--repo-panel-scale));
  text-align: left;
}

.repo-panel__file-main--static {
  background: var(--repo-panel-muted-surface-bg);
  color: var(--text-muted);
}

.repo-panel__file-main--selected,
.repo-panel__file-main:hover {
  border-color: rgba(110, 197, 255, 0.34);
  background: var(--repo-panel-surface-active-bg);
}

.repo-panel__file-meta {
  min-width: 0;
  flex: 1 1 auto;
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
  font-size: calc(0.7rem * var(--repo-panel-scale));
}

.repo-panel__file-directory {
  color: var(--text-muted);
  font-size: calc(0.68rem * var(--repo-panel-scale));
}

.repo-panel__status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: 0 0 auto;
  margin-left: auto;
  margin-top: 0.2rem;
}

.repo-panel__status-dot--untracked {
  background: #7f8ea4;
  box-shadow: 0 0 0 1px rgba(127, 142, 164, 0.22);
}

.repo-panel__status-dot--added {
  background: #6ea7ea;
  box-shadow: 0 0 0 1px rgba(110, 167, 234, 0.24);
}

.repo-panel__status-dot--staged {
  background: #67c98f;
  box-shadow: 0 0 0 1px rgba(103, 201, 143, 0.24);
}

.repo-panel__status-dot--changed {
  background: #d59a56;
  box-shadow: 0 0 0 1px rgba(213, 154, 86, 0.24);
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
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  box-sizing: border-box;
}

.repo-panel__tree-row {
  min-width: 0;
}

.repo-panel__tree-directory,
.repo-panel__tree-file,
.repo-panel__tree-file-static {
  width: 100%;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.74rem * var(--repo-panel-scale));
  text-align: left;
}

.repo-panel__tree-directory {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-block: 0.18rem;
  color: var(--text-muted);
}

.repo-panel__tree-directory--button {
  justify-content: space-between;
  background: transparent;
  padding-inline-end: 0.48rem;
}

.repo-panel__tree-file {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--repo-panel-surface-bg);
  padding-block: var(--repo-panel-control-pad-y);
  padding-inline-end: var(--repo-panel-control-pad-x);
}

.repo-panel__tree-file-static {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  background: var(--repo-panel-muted-surface-bg);
  color: var(--text-muted);
  padding-block: 0.2rem;
  padding-inline-end: 0.48rem;
}

.repo-panel__tree-file:hover,
.repo-panel__tree-file--selected {
  border-color: rgba(110, 197, 255, 0.3);
  background: var(--repo-panel-surface-active-bg);
}

.repo-panel__tree-message {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: calc(0.68rem * var(--repo-panel-scale));
  padding-block: 0.18rem;
  padding-inline-end: 0.48rem;
}

@keyframes repo-panel-spin {
  to {
    transform: rotate(360deg);
  }
}

.repo-panel__tree-caret {
  color: var(--text-dim);
  font-size: calc(0.72rem * var(--repo-panel-scale));
}

.repo-panel__tree-label {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(0.7rem * var(--repo-panel-scale));
}

.repo-panel__error,
.repo-panel__clean {
  margin: 0;
  width: 100%;
  padding: var(--repo-panel-card-pad);
  border: 1px solid rgba(188, 87, 87, 0.28);
  border-radius: 14px;
  background: rgba(188, 87, 87, 0.1);
  color: #ffb3ad;
  font-size: calc(0.76rem * var(--repo-panel-scale));
  line-height: 1.4;
  box-sizing: border-box;
}

.repo-panel__clean {
  border-color: var(--border-subtle);
  background: var(--repo-panel-muted-surface-bg);
  color: var(--text-muted);
}

.repo-panel__status-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 9px var(--repo-panel-card-pad);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: var(--repo-panel-muted-surface-bg);
  color: var(--text-muted);
  font-size: calc(0.74rem * var(--repo-panel-scale));
  line-height: 1.35;
  box-sizing: border-box;
}

.repo-panel__status-line .repo-panel__action-loader {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
}

.repo-panel__commit-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.repo-panel__commit-box {
  display: grid;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: var(--repo-panel-card-pad);
  border: 1px solid rgba(111, 224, 165, 0.18);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(18, 34, 27, 0.92), rgba(13, 19, 16, 0.92)),
    rgba(12, 18, 15, 0.9);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  box-sizing: border-box;
}

.repo-panel__commit-box--ready {
  border-color: rgba(111, 224, 165, 0.32);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    0 0 0 1px rgba(111, 224, 165, 0.08);
}

.repo-panel__commit-box-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.repo-panel__commit-label {
  color: #9fe6bb;
  font-size: calc(0.72rem * var(--repo-panel-scale));
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.repo-panel__commit-hint {
  color: rgba(188, 210, 196, 0.78);
  font-family: var(--font-mono);
  font-size: calc(0.72rem * var(--repo-panel-scale));
}

.repo-panel__commit-input {
  width: 100%;
  min-width: 0;
  padding: 0.55rem 0.72rem;
  border: 1px solid rgba(111, 224, 165, 0.18);
  border-radius: 10px;
  background: var(--repo-panel-commit-input-bg);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(0.8rem * var(--repo-panel-scale));
}

.repo-panel__commit-input::placeholder {
  color: rgba(188, 210, 196, 0.46);
}

.repo-panel__commit-input:focus-visible {
  outline: none;
  border-color: rgba(111, 224, 165, 0.42);
  box-shadow: 0 0 0 1px rgba(111, 224, 165, 0.2);
}

.repo-panel__commit-input:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.repo-panel__commit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 0.72rem;
}

.repo-panel__commit:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.repo-panel__commit--icon {
  width: 34px;
  height: 34px;
  padding: 0;
}

.repo-panel__commit--active {
  border-color: rgba(111, 224, 165, 0.42);
  background: linear-gradient(180deg, rgba(40, 86, 58, 0.96), rgba(28, 63, 42, 0.96));
  color: #e8fff1;
  opacity: 1;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 8px 20px rgba(24, 58, 38, 0.24);
}

.repo-panel__commit--active:hover {
  border-color: rgba(111, 224, 165, 0.5);
  background: linear-gradient(180deg, rgba(48, 98, 67, 0.98), rgba(31, 71, 47, 0.98));
}

.repo-panel__commit--active:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 1px rgba(111, 224, 165, 0.34),
    0 8px 20px rgba(24, 58, 38, 0.24);
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
  padding-inline: var(--repo-panel-content-inset);
  text-align: left;
  box-sizing: border-box;
}

.repo-panel__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: calc(0.98rem * var(--repo-panel-scale));
  line-height: 1.2;
}

.repo-panel__empty-copy {
  margin: 0;
  color: var(--text-muted);
  font-size: calc(0.8rem * var(--repo-panel-scale));
  line-height: 1.55;
}
</style>
