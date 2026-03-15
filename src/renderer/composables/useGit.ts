import { ref } from 'vue';
import type {
  BranchSummary,
  GitLogEntry,
  GitLogResult,
  GitStatusSummary,
} from '../../shared/bridgegit';

interface RefreshOptions {
  reloadDiff?: boolean;
  silent?: boolean;
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
    diff.value = '';
    clearCommitDiffState();
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
    if (!repoPath.value || !window.bridgegit?.git) {
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
        window.bridgegit.git.status(repoPath.value),
        window.bridgegit.git.branches(repoPath.value),
      ]);

      status.value = nextStatus;
      branches.value = nextBranches;
      error.value = null;

      const shouldReloadDiff = options.reloadDiff ?? true;

      if (!selectedPathExists(nextStatus)) {
        selectedPath.value = null;
        diff.value = '';
        return;
      }

      if (shouldReloadDiff && selectedPath.value) {
        diff.value = await window.bridgegit.git.diff(repoPath.value, selectedPath.value);
      }
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
    } finally {
      refreshInFlight = false;
      isRefreshing.value = false;
      isLoading.value = false;
    }
  }

  async function setRepoPath(nextRepoPath: string | null) {
    repoPath.value = nextRepoPath;
    log.value = null;
    error.value = null;
    selectedPath.value = null;
    diff.value = '';
    clearCommitDiffState();

    stopPolling();

    if (!nextRepoPath) {
      clearState();
      return;
    }

    await refresh({ reloadDiff: false });
    startPolling();
  }

  async function selectFile(filePath: string) {
    if (!repoPath.value || !window.bridgegit?.git) {
      return;
    }

    selectedPath.value = filePath;
    clearCommitDiffState();
    isLoading.value = true;

    try {
      diff.value = await window.bridgegit.git.diff(repoPath.value, filePath);
      error.value = null;
    } catch (nextError) {
      diff.value = '';
      error.value = toErrorMessage(nextError);
    } finally {
      isLoading.value = false;
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

    selectedCommit.value = commit;
    commitDiff.value = '';
    commitDiffError.value = null;
    isLoadingCommitDiff.value = true;

    try {
      commitDiff.value = await window.bridgegit.git.commitDiff(
        repoPath.value,
        commit.hash,
        commit.parentHashes[0] ?? null,
      );
    } catch (nextError) {
      commitDiff.value = '';
      commitDiffError.value = toErrorMessage(nextError);
    } finally {
      isLoadingCommitDiff.value = false;
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

    isLoadingLog.value = true;

    try {
      const nextLog = await window.bridgegit.git.log(repoPath.value, limit);
      log.value = nextLog;
      error.value = null;
      return nextLog;
    } catch (nextError) {
      error.value = toErrorMessage(nextError);
      return null;
    } finally {
      isLoadingLog.value = false;
    }
  }

  return {
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
    isRefreshing,
    error,
    commitDiffError,
    isLoadingCommitDiff,
    refresh,
    loadLog,
    setRepoPath,
    selectFile,
    openCommitDiff,
    clearCommitDiff,
    stageFiles,
    unstageFiles,
    commitChanges,
    checkoutBranch,
    dispose,
  };
}
