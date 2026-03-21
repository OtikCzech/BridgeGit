import { ref } from 'vue';
import type {
  BranchSummary,
  GitChange,
  GitDiffMode,
  GitLogEntry,
  GitLogResult,
  GitStatusSummary,
} from '../../shared/bridgegit';

interface RefreshOptions {
  reloadDiff?: boolean;
  silent?: boolean;
}

interface SetRepoPathOptions {
  loadMode?: 'branches' | 'full';
}

interface SelectFileOptions {
  diffMode?: GitDiffMode;
}

interface RepoStateCacheEntry {
  status: GitStatusSummary;
  branches: BranchSummary;
}

const HISTORY_LIMIT = 120;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Git operation failed.';
}

export function useGit() {
  const repoPath = ref<string | null>(null);
  const status = ref<GitStatusSummary | null>(null);
  const branches = ref<BranchSummary | null>(null);
  const log = ref<GitLogResult | null>(null);
  const selectedPath = ref<string | null>(null);
  const selectedDiffMode = ref<GitDiffMode>('working-tree');
  const selectedCommit = ref<GitLogEntry | null>(null);
  const diff = ref('');
  const commitDiff = ref('');
  const isLoading = ref(false);
  const isLoadingLog = ref(false);
  const error = ref<string | null>(null);
  const commitDiffError = ref<string | null>(null);
  const isLoadingCommitDiff = ref(false);
  const isRefreshing = ref(false);
  let pollTimer: number | null = null;
  let refreshInFlight = false;
  let repoRequestVersion = 0;
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
    };
  }

  function clearCommitDiffState() {
    selectedCommit.value = null;
    commitDiff.value = '';
    commitDiffError.value = null;
    isLoadingCommitDiff.value = false;
  }

  function clearState() {
    status.value = null;
    branches.value = null;
    log.value = null;
    selectedPath.value = null;
    selectedDiffMode.value = 'working-tree';
    diff.value = '';
    clearCommitDiffState();
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
        window.bridgegit.git.status(request.repoPath),
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
      error.value = null;

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

      clearState();
      error.value = toErrorMessage(nextError);
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
      error.value = null;
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      branches.value = null;
      error.value = toErrorMessage(nextError);
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
    isLoadingCommitDiff.value = false;
    error.value = null;

    if (!nextRepoPath) {
      return;
    }

    const loadMode = options.loadMode ?? 'full';
    const cachedRepoState = repoStateCache.get(nextRepoPath);

    if (loadMode === 'branches') {
      if (cachedRepoState) {
        branches.value = cloneBranchSummary(cachedRepoState.branches);
        return;
      }

      await loadBranchesOnly(nextRepoPath);
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
      error.value = null;
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return;
      }

      diff.value = '';
      error.value = toErrorMessage(nextError);
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
      error.value = null;
      await refresh();
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
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
      error.value = null;
      await refresh();
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
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
      error.value = null;
      await refresh();
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
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
      error.value = null;
      await refresh();
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
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
      error.value = null;
      await refresh({ reloadDiff: false });
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
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
      error.value = null;
      await refresh({ reloadDiff: false });
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
    } finally {
      isLoading.value = false;
    }
  }

  async function openCommitDiff(commit: GitLogEntry) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    const request = createRepoRequestSnapshot();
    selectedCommit.value = commit;
    commitDiff.value = '';
    commitDiffError.value = null;
    isLoadingCommitDiff.value = true;

    try {
      const nextCommitDiff = await window.bridgegit.git.commitDiff(
        request.repoPath!,
        commit.hash,
        commit.parentHashes[0] ?? null,
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
      commitDiffError.value = toErrorMessage(nextError);
    } finally {
      if (isRepoRequestCurrent(request)) {
        isLoadingCommitDiff.value = false;
      }
    }
  }

  function clearCommitDiff() {
    clearCommitDiffState();
  }

  function startPolling() {
    if (pollTimer !== null) {
      return;
    }

    pollTimer = window.setInterval(() => {
      if (isLoading.value || isRefreshing.value) {
        return;
      }

      void refresh({ silent: true });
    }, 2000);
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

  async function loadLog(limit = HISTORY_LIMIT) {
    if (!repoPath.value || !window.bridgegit?.git) {
      log.value = null;
      return null;
    }

    const request = createRepoRequestSnapshot();
    isLoadingLog.value = true;

    try {
      const nextLog = await window.bridgegit.git.log(request.repoPath!, limit);

      if (!isRepoRequestCurrent(request)) {
        return null;
      }

      log.value = nextLog;
      error.value = null;
      return nextLog;
    } catch (nextError) {
      if (!isRepoRequestCurrent(request)) {
        return null;
      }

      error.value = toErrorMessage(nextError);
      return null;
    } finally {
      if (isRepoRequestCurrent(request)) {
        isLoadingLog.value = false;
      }
    }
  }

  return {
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
    isRefreshing,
    error,
    commitDiffError,
    isLoadingCommitDiff,
    refresh,
    loadLog,
    setRepoPath,
    ensureFullStatus,
    selectFile,
    openCommitDiff,
    clearCommitDiff,
    stageFiles,
    unstageFiles,
    discardFile,
    discardHunk,
    commitChanges,
    checkoutBranch,
    dispose,
  };
}
