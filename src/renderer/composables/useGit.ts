import { ref } from 'vue';
import type {
  BranchSummary,
  CreateBranchOptions,
  CreateBranchResult,
  DeleteBranchResult,
  GitChange,
  GitCommitDetail,
  GitDiffMode,
  GitLogEntry,
  GitLogScope,
  GitLogResult,
  GitStatusSummary,
  MergeWorktreeIntoPrimaryBranchResult,
  RemoveWorktreeResult,
  RemoveWorktreeAndDeleteBranchResult,
} from '../../shared/bridgegit';

interface RefreshOptions {
  reloadDiff?: boolean;
  silent?: boolean;
  fetchOrigin?: boolean;
}

interface SetRepoPathOptions {
  loadMode?: 'branches' | 'full' | 'none';
}

interface SelectFileOptions {
  diffMode?: GitDiffMode;
}

interface SelectHistoryCommitOptions {
  force?: boolean;
}

interface LoadLogOptions {
  scope?: GitLogScope;
  query?: string;
  append?: boolean;
  preserveSelection?: boolean;
  loadAll?: boolean;
}

interface RepoStateCacheEntry {
  status: GitStatusSummary;
  branches: BranchSummary;
}

const HISTORY_PAGE_SIZE = 100;
const SILENT_REFRESH_FAILURES_BEFORE_ERROR = 2;
const REPO_POLL_INTERVAL_MS = 5000;
type HistoryPaginationMode = 'more' | 'all' | null;

function extractRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Git operation failed.';
}

function normalizeErrorDetail(rawMessage: string): string {
  return rawMessage
    .replace(/^Error occurred in handler for '[^']+':\s*/i, '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^GitError:\s*/i, '')
    .replace(/^fatal:\s*/i, '')
    .trim();
}

function normalizeGitError(error: unknown): { message: string; detail: string | null } {
  const rawMessage = extractRawErrorMessage(error);
  const detail = normalizeErrorDetail(rawMessage);
  const checkoutElsewhereMatch = detail.match(/^'([^']+)' is already checked out at '([^']+)'\.?$/i);
  const openElsewhereMatch = detail.match(/^Branch "([^"]+)" is already open in another repo\.(?:\s*Checked out at (.+))?$/i);
  const branchNotMergedMatch = detail.match(/^The branch '([^']+)' is not fully merged\./i);
  const branchNotSafelyMergedMatch = detail.match(/^Branch "([^"]+)" is not safely merged into ([^.\s]+)\.?$/i);
  const switchPrimaryRepoMatch = detail.match(/^Switch the primary repo to ([^.\s]+) before removing and deleting this branch\.?$/i);
  const primaryBranchDeleteMatch = detail.match(/^Branch "([^"]+)" is the primary branch and cannot be deleted\.?$/i);
  const noPrimaryBranchMatch = detail.match(/^Could not determine the primary branch from origin\/HEAD, main, or master\.?$/i);
  const linkedWorktreeMergeMatch = detail.match(/^Only linked worktree repos can be merged into the primary branch\.?$/i);

  if (checkoutElsewhereMatch) {
    const [, branchName, checkoutPath] = checkoutElsewhereMatch;

    return {
      message: `Branch "${branchName}" je už otevřená v jiném repo.`,
      detail: `Checked out at ${checkoutPath}`,
    };
  }

  if (openElsewhereMatch) {
    const [, branchName, checkoutPath = ''] = openElsewhereMatch;

    return {
      message: `Branch "${branchName}" je už otevřená v jiném repo.`,
      detail: checkoutPath.trim() || detail,
    };
  }

  if (branchNotMergedMatch) {
    const [, branchName] = branchNotMergedMatch;

    return {
      message: `Branch "${branchName}" ještě není bezpečně mergnutá.`,
      detail,
    };
  }

  if (branchNotSafelyMergedMatch) {
    const [, branchName, targetBranch] = branchNotSafelyMergedMatch;

    return {
      message: `Branch "${branchName}" ještě není bezpečně mergnutá do ${targetBranch}.`,
      detail,
    };
  }

  if (switchPrimaryRepoMatch) {
    const [, targetBranch] = switchPrimaryRepoMatch;

    return {
      message: `Primární repo musí být přepnuté na ${targetBranch}.`,
      detail,
    };
  }

  if (primaryBranchDeleteMatch) {
    const [, branchName] = primaryBranchDeleteMatch;

    return {
      message: `Primární branch "${branchName}" nejde smazat.`,
      detail,
    };
  }

  if (noPrimaryBranchMatch) {
    return {
      message: 'Nepodařilo se určit primární branch.',
      detail,
    };
  }

  if (linkedWorktreeMergeMatch) {
    return {
      message: 'Mergovat do primární branche jde jen z linked worktree repo.',
      detail,
    };
  }

  return {
    message: detail || 'Git operation failed.',
    detail: detail && detail !== rawMessage ? detail : rawMessage,
  };
}

function areGitLogScopesEqual(left: GitLogScope, right: GitLogScope): boolean {
  return left.kind === right.kind && (left.branchName ?? '') === (right.branchName ?? '');
}

export function useGit() {
  const repoPath = ref<string | null>(null);
  const status = ref<GitStatusSummary | null>(null);
  const branches = ref<BranchSummary | null>(null);
  const log = ref<GitLogResult | null>(null);
  const historyScope = ref<GitLogScope>({ kind: 'all' });
  const historyQuery = ref('');
  const hasMoreHistoryCommits = ref(false);
  const historyPaginationMode = ref<HistoryPaginationMode>(null);
  const selectedHistoryCommitHash = ref<string | null>(null);
  const commitDetail = ref<GitCommitDetail | null>(null);
  const selectedPath = ref<string | null>(null);
  const selectedDiffMode = ref<GitDiffMode>('working-tree');
  const selectedCommit = ref<GitLogEntry | null>(null);
  const selectedCommitDiffPath = ref<string | null>(null);
  const historyPreviewCommitHash = ref<string | null>(null);
  const historyPreviewDiffPath = ref<string | null>(null);
  const historyPreviewDiff = ref('');
  const diff = ref('');
  const commitDiff = ref('');
  const isLoading = ref(false);
  const isLoadingLog = ref(false);
  const error = ref<string | null>(null);
  const errorDetail = ref<string | null>(null);
  const commitDetailError = ref<string | null>(null);
  const commitDiffError = ref<string | null>(null);
  const historyPreviewDiffError = ref<string | null>(null);
  const isUpdatingCommitMessage = ref(false);
  const isLoadingCommitDetail = ref(false);
  const isLoadingCommitDiff = ref(false);
  const isLoadingHistoryPreviewDiff = ref(false);
  const isLoadingMoreHistoryCommits = ref(false);
  const isRefreshing = ref(false);
  let pollTimer: number | null = null;
  let refreshInFlight = false;
  let repoRequestVersion = 0;
  let logRequestVersion = 0;
  let commitDetailRequestVersion = 0;
  let consecutiveSilentRefreshFailures = 0;
  const repoStateCache = new Map<string, RepoStateCacheEntry>();

  function createRepoRequestSnapshot(expectedRepoPath: string | null = repoPath.value) {
    return {
      repoPath: expectedRepoPath,
      version: repoRequestVersion,
    };
  }

  function isRepoRequestCurrent(request: { repoPath: string | null; version: number }) {
    return request.version === repoRequestVersion && request.repoPath === repoPath.value;
  }

  function cloneStatusSummary(nextStatus: GitStatusSummary): GitStatusSummary {
    return {
      ...nextStatus,
      staged: nextStatus.staged.map((item) => ({ ...item })),
      unstaged: nextStatus.unstaged.map((item) => ({ ...item })),
      untracked: nextStatus.untracked.map((item) => ({ ...item })),
      conflicted: nextStatus.conflicted.map((item) => ({ ...item })),
    };
  }

  function cloneBranchSummary(nextBranches: BranchSummary): BranchSummary {
    return {
      ...nextBranches,
      all: nextBranches.all.map((item) => ({ ...item })),
      local: nextBranches.local.map((item) => ({ ...item })),
      remote: nextBranches.remote.map((item) => ({ ...item })),
    };
  }

  function cloneHistoryScope(nextScope: GitLogScope): GitLogScope {
    return nextScope.kind === 'branch'
      ? { kind: 'branch', branchName: nextScope.branchName ?? '' }
      : { kind: nextScope.kind };
  }

  function normalizeHistoryQueryValue(nextQuery: string | null | undefined): string {
    return nextQuery?.trim() ?? '';
  }

  function toGitLogEntry(detail: GitCommitDetail): GitLogEntry {
    return {
      hash: detail.hash,
      shortHash: detail.shortHash,
      parentHashes: [...detail.parentHashes],
      date: detail.date,
      message: detail.subject,
      authorName: detail.authorName,
      refs: detail.refs.map((ref) => ({ ...ref })),
    };
  }

  function clearCommitDiffState() {
    selectedCommit.value = null;
    selectedCommitDiffPath.value = null;
    commitDiff.value = '';
    commitDiffError.value = null;
    isLoadingCommitDiff.value = false;
  }

  function clearHistoryPreviewDiffState() {
    historyPreviewCommitHash.value = null;
    historyPreviewDiffPath.value = null;
    historyPreviewDiff.value = '';
    historyPreviewDiffError.value = null;
    isLoadingHistoryPreviewDiff.value = false;
  }

  function clearCommitDetailState() {
    selectedHistoryCommitHash.value = null;
    commitDetail.value = null;
    commitDetailError.value = null;
    isLoadingCommitDetail.value = false;
  }

  function clearHistoryState() {
    log.value = null;
    historyScope.value = { kind: 'all' };
    historyQuery.value = '';
    hasMoreHistoryCommits.value = false;
    clearCommitDetailState();
    clearHistoryPreviewDiffState();
    isLoadingLog.value = false;
    isLoadingMoreHistoryCommits.value = false;
  }

  function clearState() {
    status.value = null;
    branches.value = null;
    clearHistoryState();
    selectedPath.value = null;
    selectedDiffMode.value = 'working-tree';
    diff.value = '';
    clearCommitDiffState();
    errorDetail.value = null;
  }

  function clearErrorState() {
    error.value = null;
    errorDetail.value = null;
  }

  function resetSilentRefreshFailures() {
    consecutiveSilentRefreshFailures = 0;
  }

  function assignGitError(nextError: unknown) {
    const normalizedError = normalizeGitError(nextError);
    error.value = normalizedError.message;
    errorDetail.value = normalizedError.detail;
  }

  function resolveDiffMode(
    filePath: string,
    nextStatus: GitStatusSummary | null = status.value,
    preferredMode?: GitDiffMode,
  ): GitDiffMode {
    if (preferredMode) {
      return preferredMode;
    }

    if (!nextStatus) {
      return 'working-tree';
    }

    const hasWorkingTreeChange = [
      ...nextStatus.unstaged,
      ...nextStatus.untracked,
      ...nextStatus.conflicted,
    ].some((item) => item.path === filePath);

    if (hasWorkingTreeChange) {
      return 'working-tree';
    }

    const hasStagedChange = nextStatus.staged.some((item) => item.path === filePath);
    return hasStagedChange ? 'staged' : 'working-tree';
  }

  function selectedPathExists(nextStatus: GitStatusSummary | null): boolean {
    if (!nextStatus || !selectedPath.value) {
      return false;
    }

    const paths = [
      ...nextStatus.staged,
      ...nextStatus.unstaged,
      ...nextStatus.untracked,
      ...nextStatus.conflicted,
    ].map((item) => item.path);

    return paths.includes(selectedPath.value);
  }

  async function refresh(options: RefreshOptions = {}) {
    const request = createRepoRequestSnapshot();

    if (!request.repoPath || !window.bridgegit?.git) {
      clearState();
      return;
    }

    if (refreshInFlight) {
      return;
    }

    refreshInFlight = true;

    if (options.silent) {
      isRefreshing.value = true;
    } else {
      isLoading.value = true;
    }

    try {
      const [nextStatus, nextBranches] = await Promise.all([
        window.bridgegit.git.status(
          request.repoPath,
          options.fetchOrigin ? { fetchOrigin: true } : undefined,
        ),
        window.bridgegit.git.branches(request.repoPath),
      ]);

      if (!isRepoRequestCurrent(request)) {
        return;
      }

      status.value = nextStatus;
      branches.value = nextBranches;
      repoStateCache.set(request.repoPath, {
        status: cloneStatusSummary(nextStatus),
        branches: cloneBranchSummary(nextBranches),
      });
      resetSilentRefreshFailures();
      clearErrorState();

      const shouldReloadDiff = options.reloadDiff ?? true;

      if (!selectedPathExists(nextStatus)) {
        selectedPath.value = null;
        diff.value = '';
        return;
      }

      if (shouldReloadDiff && selectedPath.value) {
        const nextSelectedDiffMode = resolveDiffMode(selectedPath.value, nextStatus, selectedDiffMode.value);
        const nextDiff = await window.bridgegit.git.diff(
          request.repoPath,
          selectedPath.value,
          nextSelectedDiffMode,
        );

        if (!isRepoRequestCurrent(request)) {
          return;
        }

        selectedDiffMode.value = nextSelectedDiffMode;
        diff.value = nextDiff;
      }
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      if (options.silent) {
        consecutiveSilentRefreshFailures += 1;

        if (consecutiveSilentRefreshFailures < SILENT_REFRESH_FAILURES_BEFORE_ERROR) {
          return;
        }

        assignGitError(nextError);
        return;
      }

      resetSilentRefreshFailures();
      clearState();
      assignGitError(nextError);
    } finally {
      if (isRepoRequestCurrent(request)) {
        refreshInFlight = false;
        isRefreshing.value = false;
        isLoading.value = false;
      } else {
        refreshInFlight = false;
      }
    }
  }

  async function refreshBranchesOnly(options: Pick<RefreshOptions, 'silent'> = {}) {
    const request = createRepoRequestSnapshot();

    if (!request.repoPath || !window.bridgegit?.git) {
      branches.value = null;
      return;
    }

    try {
      const nextBranches = await window.bridgegit.git.branches(request.repoPath);

      if (!isRepoRequestCurrent(request)) {
        return;
      }

      branches.value = nextBranches;
      const cachedRepoState = repoStateCache.get(request.repoPath);

      if (cachedRepoState) {
        repoStateCache.set(request.repoPath, {
          ...cachedRepoState,
          branches: cloneBranchSummary(nextBranches),
        });
      }

      resetSilentRefreshFailures();
      clearErrorState();
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      if (options.silent) {
        consecutiveSilentRefreshFailures += 1;

        if (consecutiveSilentRefreshFailures < SILENT_REFRESH_FAILURES_BEFORE_ERROR) {
          return;
        }
      } else {
        resetSilentRefreshFailures();
      }

      assignGitError(nextError);
    }
  }

  async function loadBranchesOnly(nextRepoPath: string) {
    if (!window.bridgegit?.git) {
      return;
    }

    const request = createRepoRequestSnapshot(nextRepoPath);
    isLoading.value = true;

    try {
      const nextBranches = await window.bridgegit.git.branches(nextRepoPath);

      if (!isRepoRequestCurrent(request)) {
        return;
      }

      branches.value = nextBranches;
      clearErrorState();
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      branches.value = null;
      assignGitError(nextError);
    } finally {
      if (isRepoRequestCurrent(request)) {
        isLoading.value = false;
      }
    }
  }

  async function setRepoPath(nextRepoPath: string | null, options: SetRepoPathOptions = {}) {
    repoRequestVersion += 1;
    repoPath.value = nextRepoPath;
    stopPolling();
    clearState();
    refreshInFlight = false;
    isLoading.value = false;
    isRefreshing.value = false;
    isLoadingLog.value = false;
    isLoadingCommitDetail.value = false;
    isLoadingCommitDiff.value = false;
    isUpdatingCommitMessage.value = false;
    resetSilentRefreshFailures();
    clearErrorState();

    if (!nextRepoPath) {
      return;
    }

    const loadMode = options.loadMode ?? 'full';
    const cachedRepoState = repoStateCache.get(nextRepoPath);

    if (loadMode === 'none') {
      return;
    }

    if (loadMode === 'branches') {
      if (cachedRepoState) {
        branches.value = cloneBranchSummary(cachedRepoState.branches);
        startPolling();
        void refreshBranchesOnly({ silent: true });
        return;
      }

      await loadBranchesOnly(nextRepoPath);
      startPolling();
      return;
    }

    if (cachedRepoState) {
      status.value = cloneStatusSummary(cachedRepoState.status);
      branches.value = cloneBranchSummary(cachedRepoState.branches);
      startPolling();
      void refresh({ reloadDiff: false, silent: true });
      return;
    }

    await refresh({ reloadDiff: false });
    startPolling();
  }

  async function ensureFullStatus() {
    if (!repoPath.value) {
      return;
    }

    if (status.value && branches.value) {
      startPolling();
      return;
    }

    await refresh({ reloadDiff: false });
    startPolling();
  }

  async function selectFile(filePath: string, options: SelectFileOptions = {}) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    const request = createRepoRequestSnapshot();
    const nextSelectedDiffMode = resolveDiffMode(filePath, status.value, options.diffMode);
    selectedPath.value = filePath;
    selectedDiffMode.value = nextSelectedDiffMode;
    clearCommitDiffState();
    isLoading.value = true;

    try {
      const nextDiff = await window.bridgegit.git.diff(
        request.repoPath!,
        filePath,
        nextSelectedDiffMode,
      );

      if (!isRepoRequestCurrent(request)) {
        return;
      }

      diff.value = nextDiff;
      clearErrorState();
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      diff.value = '';
      assignGitError(nextError);
    } finally {
      if (isRepoRequestCurrent(request)) {
        isLoading.value = false;
      }
    }
  }

  async function stageFiles(files: string[]) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.stage(repoPath.value, files);
      clearErrorState();
      await refresh();
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function unstageFiles(files: string[]) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.unstage(repoPath.value, files);
      clearErrorState();
      await refresh();
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function discardFile(change: GitChange) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.discard(repoPath.value, change);
      clearErrorState();
      await refresh();
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function discardHunk(patch: string, mode: GitDiffMode = selectedDiffMode.value) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.discardHunk(repoPath.value, patch, mode);
      clearErrorState();
      await refresh();
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function commitChanges(message: string) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.commit(repoPath.value, message);
      selectedPath.value = null;
      diff.value = '';
      clearErrorState();
      await refresh({ reloadDiff: false });
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function checkoutBranch(branchName: string) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.checkout(repoPath.value, branchName);
      selectedPath.value = null;
      diff.value = '';
      clearErrorState();
      await refresh({ reloadDiff: false });
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function createBranch(
    branchName: string,
    options?: CreateBranchOptions,
  ): Promise<CreateBranchResult | null> {
    if (!repoPath.value || !window.bridgegit?.git) {
      return null;
    }

    isLoading.value = true;

    try {
      const result = await window.bridgegit.git.createBranch(repoPath.value, branchName, {
        checkout: true,
        ...options,
      });
      if (result.repoPath === repoPath.value) {
        selectedPath.value = null;
        diff.value = '';
        await refresh({ reloadDiff: false });
      }
      clearErrorState();
      return result;
    } catch (nextError) {
      assignGitError(nextError);
      return null;
    } finally {
      isLoading.value = false;
    }
  }

  async function initRepository(): Promise<boolean> {
    if (!repoPath.value || !window.bridgegit?.git) {
      return false;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.initRepository(repoPath.value);
      selectedPath.value = null;
      diff.value = '';
      clearErrorState();
      await refresh({ reloadDiff: false });
      return true;
    } catch (nextError) {
      assignGitError(nextError);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  async function deleteBranch(branchName: string): Promise<DeleteBranchResult | null> {
    if (!repoPath.value || !window.bridgegit?.git) {
      return null;
    }

    isLoading.value = true;

    try {
      const result = await window.bridgegit.git.deleteBranch(repoPath.value, branchName);
      selectedPath.value = null;
      diff.value = '';
      await refresh({ reloadDiff: false });
      clearErrorState();
      return result;
    } catch (nextError) {
      assignGitError(nextError);
      return null;
    } finally {
      isLoading.value = false;
    }
  }

  async function pushBranch() {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.push(repoPath.value);
      clearErrorState();
      await refresh({ reloadDiff: false });
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function pullBranch() {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    isLoading.value = true;

    try {
      await window.bridgegit.git.pull(repoPath.value);
      clearErrorState();
      await refresh({ reloadDiff: false });
    } catch (nextError) {
      assignGitError(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function mergeWorktreeIntoPrimaryBranch(targetRepoPath: string): Promise<MergeWorktreeIntoPrimaryBranchResult | null> {
    if (!targetRepoPath || !window.bridgegit?.git) {
      return null;
    }

    isLoading.value = true;

    try {
      const result = await window.bridgegit.git.mergeWorktreeIntoPrimaryBranch(targetRepoPath);

      if (repoPath.value && targetRepoPath === repoPath.value) {
        selectedPath.value = null;
        diff.value = '';
        await refresh({ reloadDiff: false });
      }

      clearErrorState();
      return result;
    } catch (nextError) {
      assignGitError(nextError);
      return null;
    } finally {
      isLoading.value = false;
    }
  }

  async function removeWorktree(targetRepoPath: string): Promise<RemoveWorktreeResult | null> {
    if (!targetRepoPath || !window.bridgegit?.git) {
      return null;
    }

    isLoading.value = true;

    try {
      const result = await window.bridgegit.git.removeWorktree(targetRepoPath);
      clearErrorState();
      return result;
    } catch (nextError) {
      assignGitError(nextError);
      return null;
    } finally {
      isLoading.value = false;
    }
  }

  async function removeWorktreeAndDeleteBranch(targetRepoPath: string): Promise<RemoveWorktreeAndDeleteBranchResult | null> {
    if (!targetRepoPath || !window.bridgegit?.git) {
      return null;
    }

    isLoading.value = true;

    try {
      const result = await window.bridgegit.git.removeWorktreeAndDeleteBranch(targetRepoPath);
      clearErrorState();
      return result;
    } catch (nextError) {
      assignGitError(nextError);
      return null;
    } finally {
      isLoading.value = false;
    }
  }

  async function openCommitDiff(commit: GitLogEntry, filePath?: string | null) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    const request = createRepoRequestSnapshot();
    const normalizedFilePath = filePath?.trim() || null;
    selectedCommit.value = commit;
    selectedCommitDiffPath.value = normalizedFilePath;
    commitDiff.value = '';
    commitDiffError.value = null;
    isLoadingCommitDiff.value = true;

    try {
      const nextCommitDiff = await window.bridgegit.git.commitDiff(
        request.repoPath!,
        commit.hash,
        commit.parentHashes[0] ?? null,
        normalizedFilePath,
      );

      if (!isRepoRequestCurrent(request)) {
        return;
      }

      commitDiff.value = nextCommitDiff;
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      commitDiff.value = '';
      commitDiffError.value = extractRawErrorMessage(nextError);
    } finally {
      if (isRepoRequestCurrent(request)) {
        isLoadingCommitDiff.value = false;
      }
    }
  }

  function clearCommitDiff() {
    clearCommitDiffState();
  }

  async function previewHistoryCommitDiff(commit: GitLogEntry, filePath: string) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    const normalizedFilePath = filePath.trim();

    if (!normalizedFilePath) {
      clearHistoryPreviewDiffState();
      return;
    }

    const request = createRepoRequestSnapshot();
    historyPreviewCommitHash.value = commit.hash;
    historyPreviewDiffPath.value = normalizedFilePath;
    historyPreviewDiff.value = '';
    historyPreviewDiffError.value = null;
    isLoadingHistoryPreviewDiff.value = true;

    try {
      const nextPreviewDiff = await window.bridgegit.git.commitDiff(
        request.repoPath!,
        commit.hash,
        commit.parentHashes[0] ?? null,
        normalizedFilePath,
      );

      if (!isRepoRequestCurrent(request)) {
        return;
      }

      historyPreviewDiff.value = nextPreviewDiff;
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      historyPreviewDiff.value = '';
      historyPreviewDiffError.value = extractRawErrorMessage(nextError);
    } finally {
      if (isRepoRequestCurrent(request)) {
        isLoadingHistoryPreviewDiff.value = false;
      }
    }
  }

  async function selectHistoryCommit(
    commitHash: string | null,
    options: SelectHistoryCommitOptions = {},
  ): Promise<GitCommitDetail | null> {
    if (!repoPath.value || !window.bridgegit?.git) {
      clearCommitDetailState();
      return null;
    }

    const normalizedCommitHash = commitHash?.trim() ?? null;
    const shouldReload = options.force ?? false;

    if (!normalizedCommitHash) {
      clearCommitDetailState();
      return null;
    }

    if (
      !shouldReload
      && selectedHistoryCommitHash.value === normalizedCommitHash
      && commitDetail.value?.hash === normalizedCommitHash
    ) {
      return commitDetail.value;
    }

    selectedHistoryCommitHash.value = normalizedCommitHash;
    commitDetail.value = null;
    commitDetailError.value = null;
    clearHistoryPreviewDiffState();
    isLoadingCommitDetail.value = true;
    const request = createRepoRequestSnapshot();
    const requestVersion = ++commitDetailRequestVersion;

    try {
      const nextCommitDetail = await window.bridgegit.git.commitDetail(
        request.repoPath!,
        normalizedCommitHash,
      );

      if (!isRepoRequestCurrent(request) || requestVersion !== commitDetailRequestVersion) {
        return null;
      }

      commitDetail.value = nextCommitDetail;
      clearErrorState();
      return nextCommitDetail;
    } catch (nextError) {
      if (!isRepoRequestCurrent(request) || requestVersion !== commitDetailRequestVersion) {
        return null;
      }

      commitDetail.value = null;
      commitDetailError.value = extractRawErrorMessage(nextError);
      return null;
    } finally {
      if (isRepoRequestCurrent(request) && requestVersion === commitDetailRequestVersion) {
        isLoadingCommitDetail.value = false;
      }
    }
  }

  async function updateCommitMessage(commitHash: string, message: string): Promise<GitCommitDetail | null> {
    if (!repoPath.value || !window.bridgegit?.git) {
      return null;
    }

    const normalizedCommitHash = commitHash.trim();

    if (!normalizedCommitHash) {
      return null;
    }

    isUpdatingCommitMessage.value = true;
    commitDetailError.value = null;

    try {
      const nextCommitDetail = await window.bridgegit.git.updateCommitMessage(
        repoPath.value,
        normalizedCommitHash,
        message,
      );
      const shouldRefreshOpenCommitDiff = selectedCommit.value?.hash === normalizedCommitHash;
      const openCommitDiffPath = shouldRefreshOpenCommitDiff ? selectedCommitDiffPath.value : null;

      selectedHistoryCommitHash.value = nextCommitDetail.hash;
      commitDetail.value = nextCommitDetail;
      clearErrorState();

      await refresh({ reloadDiff: false });

      if (shouldRefreshOpenCommitDiff) {
        await openCommitDiff(toGitLogEntry(nextCommitDetail), openCommitDiffPath);
      }

      await loadLog({
        scope: historyScope.value,
        query: historyQuery.value,
        preserveSelection: true,
      });
      return nextCommitDetail;
    } catch (nextError) {
      const normalizedError = normalizeGitError(nextError);
      error.value = normalizedError.message;
      errorDetail.value = normalizedError.detail;
      commitDetailError.value = normalizedError.message;
      return null;
    } finally {
      isUpdatingCommitMessage.value = false;
    }
  }

  function startPolling() {
    if (pollTimer !== null) {
      return;
    }

    pollTimer = window.setInterval(() => {
      if (isLoading.value || isRefreshing.value) {
        return;
      }

      if (status.value && branches.value) {
        void refresh({ silent: true });
        return;
      }

      if (branches.value || repoPath.value) {
        void refreshBranchesOnly({ silent: true });
      }
    }, REPO_POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer === null) {
      return;
    }

    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function dispose() {
    stopPolling();
  }

  async function loadLog(options: LoadLogOptions = {}) {
    if (!repoPath.value || !window.bridgegit?.git) {
      clearHistoryState();
      return null;
    }

    const request = createRepoRequestSnapshot();
    const requestVersion = ++logRequestVersion;
    const nextScope = cloneHistoryScope(options.scope ?? historyScope.value);
    const previousScope = cloneHistoryScope(historyScope.value);
    const nextQuery = normalizeHistoryQueryValue(options.query ?? historyQuery.value);
    const previousQuery = historyQuery.value;
    const scopeChanged = !areGitLogScopesEqual(previousScope, nextScope);
    const queryChanged = previousQuery !== nextQuery;
    const append = options.append === true && !scopeChanged && !queryChanged;
    const previousItems = append ? (log.value?.items ?? []) : [];
    const nextOffset = append ? previousItems.length : 0;
    const limit = options.loadAll === true ? undefined : HISTORY_PAGE_SIZE;
    const shouldPreserveSelection = options.preserveSelection === true;

    historyScope.value = nextScope;
    historyQuery.value = nextQuery;

    if (scopeChanged || queryChanged || !append) {
      clearHistoryPreviewDiffState();
    }

    if (scopeChanged || queryChanged) {
      clearCommitDetailState();
    }

    if (append || options.loadAll === true) {
      historyPaginationMode.value = options.loadAll === true ? 'all' : 'more';
      isLoadingMoreHistoryCommits.value = true;
    } else {
      historyPaginationMode.value = null;
      isLoadingLog.value = true;
    }

    try {
      const nextLog = await window.bridgegit.git.log(request.repoPath!, {
        limit,
        offset: nextOffset,
        query: nextQuery,
        scope: nextScope,
      });

      if (!isRepoRequestCurrent(request) || requestVersion !== logRequestVersion) {
        return null;
      }

      const mergedItems = append
        ? [...previousItems, ...nextLog.items.filter((item) => !previousItems.some((existing) => existing.hash === item.hash))]
        : nextLog.items;

      log.value = {
        ...nextLog,
        items: mergedItems,
        total: mergedItems.length,
        offset: 0,
      };
      hasMoreHistoryCommits.value = nextLog.hasMore;

      const selectedHashStillVisible = Boolean(
        selectedHistoryCommitHash.value
        && mergedItems.some((commit) => commit.hash === selectedHistoryCommitHash.value),
      );
      const shouldSelectFirstCommit = !append && !shouldPreserveSelection && !selectedHashStillVisible;
      const nextSelectedHash = selectedHashStillVisible
        ? selectedHistoryCommitHash.value
        : (shouldSelectFirstCommit ? (mergedItems[0]?.hash ?? null) : null);

      if (!nextSelectedHash) {
        clearCommitDetailState();
      } else if (
        nextSelectedHash !== selectedHistoryCommitHash.value
        || commitDetail.value?.hash !== nextSelectedHash
      ) {
        await selectHistoryCommit(nextSelectedHash, {
          force: commitDetail.value?.hash === nextSelectedHash,
        });
      }

      clearErrorState();
      return log.value;
    } catch (nextError) {
      if (!isRepoRequestCurrent(request) || requestVersion !== logRequestVersion) {
        return null;
      }

      assignGitError(nextError);
      return null;
    } finally {
      if (isRepoRequestCurrent(request) && requestVersion === logRequestVersion) {
        isLoadingLog.value = false;
        isLoadingMoreHistoryCommits.value = false;
        historyPaginationMode.value = null;
      }
    }
  }

  async function loadMoreLog() {
    if (!hasMoreHistoryCommits.value || isLoadingMoreHistoryCommits.value) {
      return null;
    }

    return loadLog({
      append: true,
      preserveSelection: true,
    });
  }

  async function loadAllLog() {
    if (!hasMoreHistoryCommits.value || isLoadingMoreHistoryCommits.value) {
      return null;
    }

    return loadLog({
      loadAll: true,
      preserveSelection: true,
    });
  }

  return {
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
    isRefreshing,
    error,
    errorDetail,
    commitDetailError,
    commitDiffError,
    historyPreviewDiffError,
    isUpdatingCommitMessage,
    isLoadingCommitDetail,
    isLoadingCommitDiff,
    isLoadingHistoryPreviewDiff,
    isLoadingMoreHistoryCommits,
    refresh,
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
    clearCommitDiff,
    clearHistoryPreviewDiffState,
    stageFiles,
    unstageFiles,
    discardFile,
    discardHunk,
    commitChanges,
    checkoutBranch,
    createBranch,
    initRepository,
    deleteBranch,
    mergeWorktreeIntoPrimaryBranch,
    removeWorktree,
    removeWorktreeAndDeleteBranch,
    pullBranch,
    pushBranch,
    dispose,
  };
}
