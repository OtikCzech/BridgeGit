import { ipcMain } from 'electron';
import { simpleGit, type FileStatusResult, type SimpleGit } from 'simple-git';
import type {
  BranchSummary,
  GitChange,
  GitChangeKind,
  GitCommitRef,
  GitLogResult,
  GitStatusSummary,
} from '../shared/bridgegit';
import { normalizeStoredPath } from './path-utils';

function resolveRepoPath(repoPath: string): string {
  const normalizedRepoPath = normalizeStoredPath(repoPath);

  if (!normalizedRepoPath) {
    throw new Error('No repository selected.');
  }

  return normalizedRepoPath;
}

function getGit(repoPath: string): SimpleGit {
  return simpleGit({
    baseDir: resolveRepoPath(repoPath),
    binary: 'git',
    maxConcurrentProcesses: 1,
  });
}

async function resolveRepository(repoPath: string): Promise<SimpleGit> {
  const normalizedRepoPath = resolveRepoPath(repoPath);
  const git = getGit(repoPath);

  if (!(await git.checkIsRepo())) {
    throw new Error(`${normalizedRepoPath} is not a git repository.`);
  }

  return git;
}

function mapStatusCode(code: string): GitChangeKind {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechanged';
    case '?':
      return 'untracked';
    case 'U':
      return 'conflicted';
    default:
      return 'unknown';
  }
}

function createChange(file: FileStatusResult, code: string): GitChange {
  const change: GitChange = {
    path: file.path,
    type: mapStatusCode(code),
  };

  if (file.from) {
    change.originalPath = file.from;
  }

  return change;
}

function sortAndDedupe(changes: GitChange[]): GitChange[] {
  const unique = new Map<string, GitChange>();

  for (const change of changes) {
    const key = `${change.type}:${change.originalPath ?? ''}:${change.path}`;
    unique.set(key, change);
  }

  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRefShortName(name: string): string {
  return name
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '');
}

function createCommitRef(rawRef: string, current = false): GitCommitRef {
  const trimmedRef = rawRef.trim();
  const normalizedRef = trimmedRef.replace(/^tag:\s*/, '');

  if (normalizedRef === 'HEAD') {
    return {
      name: 'HEAD',
      shortName: 'HEAD',
      kind: 'head',
      current: true,
    };
  }

  if (normalizedRef.startsWith('refs/heads/')) {
    return {
      name: normalizedRef,
      shortName: normalizeRefShortName(normalizedRef),
      kind: 'local-branch',
      current,
    };
  }

  if (normalizedRef.startsWith('refs/remotes/')) {
    return {
      name: normalizedRef,
      shortName: normalizeRefShortName(normalizedRef),
      kind: 'remote-branch',
      current,
    };
  }

  if (trimmedRef.startsWith('tag: ') || normalizedRef.startsWith('refs/tags/')) {
    return {
      name: normalizedRef,
      shortName: normalizeRefShortName(normalizedRef),
      kind: 'tag',
      current,
    };
  }

  return {
    name: normalizedRef,
    shortName: normalizeRefShortName(normalizedRef),
    kind: 'other',
    current,
  };
}

function parseCommitRefs(rawRefs: string): GitCommitRef[] {
  const refs = rawRefs
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      if (!item.includes(' -> ')) {
        return [createCommitRef(item, item === 'HEAD')];
      }

      const [leftRef, rightRef] = item.split(/\s+->\s+/, 2);
      return [
        createCommitRef(leftRef, true),
        createCommitRef(rightRef, true),
      ];
    });

  const uniqueRefs = new Map<string, GitCommitRef>();

  for (const ref of refs) {
    const existingRef = uniqueRefs.get(ref.name);

    if (!existingRef || ref.current) {
      uniqueRefs.set(ref.name, ref);
    }
  }

  return [...uniqueRefs.values()];
}

async function getStatusSummary(repoPath: string): Promise<GitStatusSummary> {
  const git = await resolveRepository(repoPath);
  const status = await git.status();

  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const untracked: GitChange[] = [];
  const conflicted: GitChange[] = [];

  for (const file of status.files) {
    const isConflicted =
      status.conflicted.includes(file.path) || file.index === 'U' || file.working_dir === 'U';

    if (isConflicted) {
      conflicted.push(createChange(file, 'U'));
      continue;
    }

    const isUntracked =
      status.not_added.includes(file.path) || file.index === '?' || file.working_dir === '?';

    if (isUntracked) {
      untracked.push(createChange(file, '?'));
      continue;
    }

    if (file.index && file.index !== ' ') {
      staged.push(createChange(file, file.index));
    }

    if (file.working_dir && file.working_dir !== ' ') {
      unstaged.push(createChange(file, file.working_dir));
    }
  }

  return {
    currentBranch: status.current,
    trackingBranch: status.tracking,
    ahead: status.ahead,
    behind: status.behind,
    isClean: status.isClean(),
    staged: sortAndDedupe(staged),
    unstaged: sortAndDedupe(unstaged),
    untracked: sortAndDedupe(untracked),
    conflicted: sortAndDedupe(conflicted),
  };
}

async function getBranches(repoPath: string): Promise<BranchSummary> {
  const git = await resolveRepository(repoPath);
  const branches = await git.branchLocal();

  return {
    current: branches.current,
    all: branches.all.map((name) => ({
      name,
      current: name === branches.current,
    })),
  };
}

async function getDiff(repoPath: string, filePath?: string): Promise<string> {
  const git = await resolveRepository(repoPath);

  if (filePath) {
    return git.diff(['--no-ext-diff', '--no-color', '--', filePath]);
  }

  return git.diff(['--no-ext-diff', '--no-color']);
}

async function getCommitDiff(
  repoPath: string,
  commitHash: string,
  parentHash?: string | null,
): Promise<string> {
  const git = await resolveRepository(repoPath);

  if (!commitHash.trim()) {
    throw new Error('No commit selected.');
  }

  if (parentHash) {
    return git.raw([
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--find-renames',
      parentHash,
      commitHash,
    ]);
  }

  return git.raw([
    'show',
    '--format=',
    '--root',
    '--no-ext-diff',
    '--no-color',
    '--find-renames',
    commitHash,
  ]);
}

async function getLog(repoPath: string, limit = 20): Promise<GitLogResult> {
  const git = await resolveRepository(repoPath);
  const maxCount = Math.max(20, Math.min(limit, 300));

  try {
    const rawLog = await git.raw([
      'log',
      '--all',
      '--topo-order',
      '--decorate=full',
      '--date=iso-strict',
      `--max-count=${maxCount}`,
      '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e',
    ]);

    const items = rawLog
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [
          hash = '',
          shortHash = '',
          rawParents = '',
          authorName = '',
          date = '',
          message = '',
          rawRefs = '',
        ] = record.split('\x1f');

        return {
          hash,
          shortHash,
          parentHashes: rawParents.split(' ').filter(Boolean),
          date,
          message,
          authorName,
          refs: parseCommitRefs(rawRefs),
        };
      });

    return {
      total: items.length,
      items,
    };
  } catch (error) {
    if (
      error instanceof Error
      && /(does not have any commits yet|unknown revision or path not in the working tree|ambiguous argument 'HEAD')/i
        .test(error.message)
    ) {
      return {
        total: 0,
        items: [],
      };
    }

    throw error;
  }
}

async function stageFiles(repoPath: string, files: string[]): Promise<GitStatusSummary> {
  const git = await resolveRepository(repoPath);
  await git.add(files.length > 0 ? files : ['.']);
  return getStatusSummary(repoPath);
}

async function unstageFiles(repoPath: string, files: string[]): Promise<GitStatusSummary> {
  const git = await resolveRepository(repoPath);

  if (files.length > 0) {
    await git.raw(['restore', '--staged', '--', ...files]);
  }

  return getStatusSummary(repoPath);
}

async function commitChanges(repoPath: string, message: string): Promise<GitStatusSummary> {
  const git = await resolveRepository(repoPath);
  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    throw new Error('Commit message cannot be empty.');
  }

  await git.commit(trimmedMessage);
  return getStatusSummary(repoPath);
}

async function checkoutBranch(repoPath: string, branchName: string): Promise<BranchSummary> {
  const git = await resolveRepository(repoPath);
  await git.checkout(branchName);
  return getBranches(repoPath);
}

export function registerGitIpcHandlers() {
  ipcMain.handle('git:status', (_event, repoPath: string) => getStatusSummary(repoPath));
  ipcMain.handle('git:branches', (_event, repoPath: string) => getBranches(repoPath));
  ipcMain.handle('git:diff', (_event, repoPath: string, filePath?: string) =>
    getDiff(repoPath, filePath),
  );
  ipcMain.handle(
    'git:commitDiff',
    (_event, repoPath: string, commitHash: string, parentHash?: string | null) =>
      getCommitDiff(repoPath, commitHash, parentHash),
  );
  ipcMain.handle('git:log', (_event, repoPath: string, limit?: number) =>
    getLog(repoPath, limit),
  );
  ipcMain.handle('git:stage', (_event, repoPath: string, files: string[]) =>
    stageFiles(repoPath, files),
  );
  ipcMain.handle('git:unstage', (_event, repoPath: string, files: string[]) =>
    unstageFiles(repoPath, files),
  );
  ipcMain.handle('git:commit', (_event, repoPath: string, message: string) =>
    commitChanges(repoPath, message),
  );
  ipcMain.handle('git:checkout', (_event, repoPath: string, branchName: string) =>
    checkoutBranch(repoPath, branchName),
  );
}
