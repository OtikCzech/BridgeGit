import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix as posixPath, relative, resolve, win32 as win32Path } from 'node:path';
import { promisify } from 'node:util';
import { simpleGit, type FileStatusResult, type SimpleGit } from 'simple-git';
import {
  areRepoPathsEquivalent,
  BranchInfo,
  BranchSummary,
  CreateBranchOptions,
  CreateBranchResult,
  DeleteBranchResult,
  GitChange,
  GitChangeKind,
  GitCommitRef,
  GitDiffMode,
  GitLogResult,
  GitStatusRequestOptions,
  GitStatusSummary,
  GitTextSearchMatch,
  GitWorktreeSummary,
  MergeWorktreeIntoPrimaryBranchResult,
  RemoveWorktreeResult,
  RemoveWorktreeAndDeleteBranchResult,
  RepoDirectoryEntry,
} from '../shared/bridgegit';
import { formatWindowsWslPath, normalizeStoredPath, parseWindowsWslPath } from './path-utils';

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_BUFFER_BYTES = 64 * 1024 * 1024;
const FILE_TREE_IGNORED_DIRECTORIES = new Set(['.git']);
const FILE_SEARCH_RESULT_LIMIT = 200;
const TEXT_SEARCH_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'release',
  'vendor',
]);
const IDENTIFIER_PART_PATTERN = /[A-Za-z0-9_$\u00A0-\uFFFF]/;

interface NativeRepositoryContext {
  mode: 'native';
  repoPath: string;
  git: SimpleGit;
}

interface WslRepositoryContext {
  mode: 'wsl';
  repoPath: string;
  distro: string;
  linuxPath: string;
}

type RepositoryContext = NativeRepositoryContext | WslRepositoryContext;

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

function createRepositoryError(error: unknown): Error {
  if (
    error
    && typeof error === 'object'
    && ('stderr' in error || 'stdout' in error)
  ) {
    const gitError = error as { stderr?: unknown; stdout?: unknown };
    const stderr = typeof gitError.stderr === 'string' ? gitError.stderr.trim() : '';
    const stdout = typeof gitError.stdout === 'string' ? gitError.stdout.trim() : '';
    const message = stderr || stdout;

    if (message) {
      return new Error(message);
    }
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error('Git operation failed.');
}

async function runWslCommand(context: WslRepositoryContext, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'wsl.exe',
      ['-d', context.distro, '--cd', context.linuxPath, ...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
      },
    );

    return stdout;
  } catch (error) {
    throw createRepositoryError(error);
  }
}

async function runWslGit(context: WslRepositoryContext, args: string[]): Promise<string> {
  return runWslCommand(context, ['git', ...args]);
}

async function runGit(repository: RepositoryContext, args: string[]): Promise<string> {
  if (repository.mode === 'wsl') {
    return runWslGit(repository, args);
  }

  return repository.git.raw(args);
}

function normalizeDiffPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function createUntrackedDiff(filePath: string, fileContent: string): string {
  const normalizedPath = normalizeDiffPath(filePath);
  const normalizedContent = fileContent.replace(/\r\n/g, '\n');

  if (!normalizedContent.length) {
    return '';
  }

  const hasTrailingNewline = normalizedContent.endsWith('\n');
  const lines = normalizedContent.split('\n');

  if (hasTrailingNewline) {
    lines.pop();
  }

  const patch = [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');

  return hasTrailingNewline
    ? `${patch}\n`
    : `${patch}\n\\ No newline at end of file\n`;
}

async function createNativeUntrackedDiff(
  repository: NativeRepositoryContext,
  filePath: string,
): Promise<string> {
  const rawStatus = await repository.git.raw(['status', '--porcelain', '-z', '-u', '--', filePath]);
  const firstToken = rawStatus.split('\0').find(Boolean) ?? '';

  if (!firstToken.startsWith('?? ')) {
    return '';
  }

  const fileContent = await readFile(join(repository.repoPath, filePath), 'utf8');

  if (fileContent.includes('\0')) {
    return '';
  }

  return createUntrackedDiff(filePath, fileContent);
}

async function createWslUntrackedDiff(
  repository: WslRepositoryContext,
  filePath: string,
): Promise<string> {
  const rawStatus = await runWslGit(repository, ['status', '--porcelain', '-z', '-u', '--', filePath]);
  const firstToken = rawStatus.split('\0').find(Boolean) ?? '';

  if (!firstToken.startsWith('?? ')) {
    return '';
  }

  const fileContent = await runWslCommand(repository, ['cat', '--', filePath]);

  if (fileContent.includes('\0')) {
    return '';
  }

  return createUntrackedDiff(filePath, fileContent);
}

function parseStatusBranchHeader(
  headerLine: string,
): Pick<GitStatusSummary, 'currentBranch' | 'trackingBranch' | 'ahead' | 'behind'> {
  const aheadReg = /ahead (\d+)/;
  const behindReg = /behind (\d+)/;
  const currentReg = /^(.+?(?=(?:\.{3}|\s|$)))/;
  const trackingReg = /\.{3}(\S*)/;
  const onEmptyBranchReg = /\son\s(\S+?)(?=\.{3}|$)/;

  let currentBranch = currentReg.exec(headerLine)?.[1] ?? null;
  const trackingBranch = trackingReg.exec(headerLine)?.[1] ?? null;
  const onEmptyBranch = onEmptyBranchReg.exec(headerLine)?.[1];

  if (onEmptyBranch) {
    currentBranch = onEmptyBranch;
  }

  return {
    currentBranch,
    trackingBranch,
    ahead: Number(aheadReg.exec(headerLine)?.[1] ?? 0),
    behind: Number(behindReg.exec(headerLine)?.[1] ?? 0),
  };
}

function parseWslStatusSummary(rawStatus: string): GitStatusSummary {
  const tokens = rawStatus.split('\0');
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const untracked: GitChange[] = [];
  const conflicted: GitChange[] = [];
  let currentBranch: string | null = null;
  let trackingBranch: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token) {
      continue;
    }

    if (token.startsWith('## ')) {
      ({
        currentBranch,
        trackingBranch,
        ahead,
        behind,
      } = parseStatusBranchHeader(token.slice(3).trim()));
      continue;
    }

    const statusCode = token.slice(0, 2);
    const file: FileStatusResult = {
      path: token.slice(3),
      index: statusCode[0] ?? ' ',
      working_dir: statusCode[1] ?? ' ',
    };

    if (statusCode.includes('R') || statusCode.includes('C')) {
      file.from = tokens[index + 1] ?? '';
      index += 1;
    }

    const isConflicted = file.index === 'U' || file.working_dir === 'U';

    if (isConflicted) {
      conflicted.push(createChange(file, 'U'));
      continue;
    }

    const isUntracked = file.index === '?' || file.working_dir === '?';

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

  const dedupedStaged = sortAndDedupe(staged);
  const dedupedUnstaged = sortAndDedupe(unstaged);
  const dedupedUntracked = sortAndDedupe(untracked);
  const dedupedConflicted = sortAndDedupe(conflicted);

  return {
    currentBranch,
    trackingBranch,
    ahead,
    behind,
    isClean:
      dedupedStaged.length === 0
      && dedupedUnstaged.length === 0
      && dedupedUntracked.length === 0
      && dedupedConflicted.length === 0,
    staged: dedupedStaged,
    unstaged: dedupedUnstaged,
    untracked: dedupedUntracked,
    conflicted: dedupedConflicted,
  };
}

async function resolveRepository(repoPath: string): Promise<RepositoryContext> {
  const normalizedRepoPath = resolveRepoPath(repoPath);
  const wslPath = process.platform === 'win32' ? parseWindowsWslPath(normalizedRepoPath) : null;

  if (wslPath) {
    const context: WslRepositoryContext = {
      mode: 'wsl',
      repoPath: normalizedRepoPath,
      distro: wslPath.distro,
      linuxPath: wslPath.linuxPath,
    };

    if ((await runWslGit(context, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
      throw new Error(`${normalizedRepoPath} is not a git repository.`);
    }

    return context;
  }

  const git = getGit(repoPath);

  if (!(await git.checkIsRepo())) {
    throw new Error(`${normalizedRepoPath} is not a git repository.`);
  }

  return {
    mode: 'native',
    repoPath: normalizedRepoPath,
    git,
  };
}

async function isRepository(repoPath: string): Promise<boolean> {
  try {
    await resolveRepository(repoPath);
    return true;
  } catch {
    return false;
  }
}

async function initRepository(repoPath: string): Promise<void> {
  const normalizedRepoPath = resolveRepoPath(repoPath);
  const wslPath = process.platform === 'win32' ? parseWindowsWslPath(normalizedRepoPath) : null;

  if (wslPath) {
    await runWslCommand(
      {
        mode: 'wsl',
        repoPath: normalizedRepoPath,
        distro: wslPath.distro,
        linuxPath: wslPath.linuxPath,
      },
      ['git', 'init'],
    );
    return;
  }

  const git = getGit(normalizedRepoPath);
  await git.init();
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

function parseBranchList(rawBranches: string): BranchInfo[] {
  return rawBranches
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const current = line.startsWith('* ');
      const name = line.slice(2).trim();
      return {
        name,
        current,
        checkedOutElsewhere: false,
        worktreePath: null,
      };
    })
    .filter((branch) => branch.name && !branch.name.startsWith('('));
}

async function buildBranchSummary(
  branches: BranchInfo[],
  worktrees: GitWorktreeSummary[],
): Promise<BranchSummary> {
  const all = branches.map((branch) => {
    const matchingWorktree = worktrees.find((worktree) => (
      !worktree.current
      && !worktree.detached
      && !worktree.bare
      && worktree.branch === branch.name
    ));

    return {
      ...branch,
      checkedOutElsewhere: Boolean(matchingWorktree),
      worktreePath: matchingWorktree?.path ?? null,
    };
  });

  return {
    current: all.find((branch) => branch.current)?.name ?? null,
    all,
  };
}

function normalizeWorktreePath(pathValue: string, repository: RepositoryContext): string | null {
  const trimmedPath = pathValue.trim();

  if (!trimmedPath) {
    return null;
  }

  if (repository.mode === 'wsl' && process.platform === 'win32') {
    return formatWindowsWslPath(repository.distro, trimmedPath);
  }

  return normalizeStoredPath(trimmedPath);
}

function getRepositoryPathModule(repository: RepositoryContext) {
  if (repository.mode === 'wsl') {
    return posixPath;
  }

  return process.platform === 'win32' ? win32Path : posixPath;
}

function branchDirectorySlug(branchName: string): string {
  const slug = branchName
    .replace(/\/+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'branch';
}

function resolveProjectWorktreeBaseName(projectName: string): string {
  const trimmedProjectName = projectName.trim();
  const firstDotIndex = trimmedProjectName.indexOf('.');

  if (firstDotIndex <= 0) {
    return trimmedProjectName;
  }

  return trimmedProjectName.slice(0, firstDotIndex);
}

async function getPrimaryWorktreePath(repository: RepositoryContext): Promise<string> {
  const rawWorktrees = repository.mode === 'wsl'
    ? await runWslGit(repository, ['worktree', 'list', '--porcelain'])
    : await repository.git.raw(['worktree', 'list', '--porcelain']);
  const firstWorktreeLine = rawWorktrees
    .split('\n')
    .find((line) => line.startsWith('worktree '));

  if (!firstWorktreeLine) {
    return repository.mode === 'wsl' ? repository.linuxPath : repository.repoPath;
  }

  const rawPath = firstWorktreeLine.slice('worktree '.length).trim();

  if (repository.mode === 'wsl') {
    return rawPath || repository.linuxPath;
  }

  return normalizeStoredPath(rawPath) ?? repository.repoPath;
}

function buildBranchCheckoutPath(
  repository: RepositoryContext,
  primaryWorktreePath: string,
  branchName: string,
): string {
  const pathModule = getRepositoryPathModule(repository);
  const projectParent = pathModule.dirname(primaryWorktreePath);
  const primaryProjectName = pathModule.basename(primaryWorktreePath);
  const projectName = resolveProjectWorktreeBaseName(primaryProjectName) || primaryProjectName;

  return pathModule.join(projectParent, `${projectName}.${branchDirectorySlug(branchName)}`);
}

function parseWorktreeSummary(
  rawWorktrees: string,
  repository: RepositoryContext,
  currentRepoPath: string,
): GitWorktreeSummary[] {
  const worktrees: GitWorktreeSummary[] = [];
  const lines = rawWorktrees.split('\n');
  let path: string | null = null;
  let branch: string | null = null;
  let head: string | null = null;
  let detached = false;
  let bare = false;

  function commitCurrentBlock() {
    if (!path) {
      return;
    }

    worktrees.push({
      path,
      branch,
      head,
      detached,
      bare,
      current: areRepoPathsEquivalent(path, currentRepoPath),
    });
  }

  for (const line of [...lines, '']) {
    if (!line.trim()) {
      commitCurrentBlock();
      path = null;
      branch = null;
      head = null;
      detached = false;
      bare = false;
      continue;
    }

    if (line.startsWith('worktree ')) {
      path = normalizeWorktreePath(line.slice('worktree '.length), repository);
      continue;
    }

    if (line.startsWith('branch ')) {
      branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '') || null;
      continue;
    }

    if (line.startsWith('HEAD ')) {
      head = line.slice('HEAD '.length).trim() || null;
      continue;
    }

    if (line === 'detached') {
      detached = true;
      continue;
    }

    if (line === 'bare') {
      bare = true;
    }
  }

  return worktrees;
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

async function fetchOrigin(repository: RepositoryContext): Promise<void> {
  if (repository.mode === 'wsl') {
    await runWslGit(repository, ['fetch', '--prune', 'origin']);
    return;
  }

  await repository.git.raw(['fetch', '--prune', 'origin']);
}

async function getStatusSummary(
  repoPath: string,
  options: GitStatusRequestOptions = {},
): Promise<GitStatusSummary> {
  const repository = await resolveRepository(repoPath);

  if (options.fetchOrigin) {
    try {
      await fetchOrigin(repository);
    } catch {
      // Keep local status available even when fetching origin fails.
    }
  }

  if (repository.mode === 'wsl') {
    const rawStatus = await runWslGit(repository, ['status', '--porcelain', '-b', '-u', '--null']);
    return parseWslStatusSummary(rawStatus);
  }

  const status = await repository.git.status();

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
  const repository = await resolveRepository(repoPath);
  const branchArgs = ['branch', '--list', '--no-color'];
  const worktreeArgs = ['worktree', 'list', '--porcelain'];
  const currentRepoPath = resolveRepoPath(repoPath);

  const [rawBranches, rawWorktrees] = repository.mode === 'wsl'
    ? await Promise.all([
      runWslGit(repository, branchArgs),
      runWslGit(repository, worktreeArgs),
    ])
    : await Promise.all([
      repository.git.raw(branchArgs),
      repository.git.raw(worktreeArgs),
    ]);

  return buildBranchSummary(
    parseBranchList(rawBranches),
    parseWorktreeSummary(rawWorktrees, repository, currentRepoPath),
  );
}

function normalizeRepoRelativePath(pathValue: string | null | undefined): string {
  const trimmed = pathValue?.trim() ?? '';
  if (!trimmed) {
    return '';
  }

  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function resolveRepoChildPath(repoRoot: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRepoRelativePath(relativePath);

  if (!normalizedRelativePath) {
    return repoRoot;
  }

  const absolutePath = resolve(repoRoot, normalizedRelativePath);
  const relativeToRoot = relative(repoRoot, absolutePath);

  if (
    relativeToRoot.startsWith('..')
    || relativeToRoot.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Path '${relativePath}' is outside of the repository root.`);
  }

  return absolutePath;
}

function compareDirectoryEntries(left: RepoDirectoryEntry, right: RepoDirectoryEntry) {
  if (left.kind !== right.kind) {
    return left.kind === 'directory' ? -1 : 1;
  }

  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

async function listDirectory(repoPath: string, relativePath = ''): Promise<RepoDirectoryEntry[]> {
  const repoRoot = resolveRepoPath(repoPath);
  const targetPath = resolveRepoChildPath(repoRoot, relativePath);
  const entries = await readdir(targetPath, { withFileTypes: true });

  return entries
    .filter((entry) => {
      if (FILE_TREE_IGNORED_DIRECTORIES.has(entry.name)) {
        return false;
      }

      return entry.isDirectory() || entry.isFile();
    })
    .map<RepoDirectoryEntry>((entry) => {
      const normalizedRelativePath = normalizeRepoRelativePath(relativePath);
      const entryPath = normalizedRelativePath ? `${normalizedRelativePath}/${entry.name}` : entry.name;

      return {
        name: entry.name,
        path: entryPath,
        kind: entry.isDirectory() ? 'directory' : 'file',
      };
    })
    .sort(compareDirectoryEntries);
}

function getSearchRank(pathValue: string, query: string): number {
  const normalizedPath = pathValue.toLowerCase();
  const fileName = normalizedPath.split('/').at(-1) ?? normalizedPath;

  if (fileName === query) {
    return 0;
  }

  if (fileName.startsWith(query)) {
    return 1;
  }

  if (fileName.includes(query)) {
    return 2;
  }

  if (normalizedPath.startsWith(query)) {
    return 3;
  }

  return 4;
}

async function searchFiles(
  repoPath: string,
  query: string,
  limit = FILE_SEARCH_RESULT_LIMIT,
): Promise<string[]> {
  const repoRoot = resolveRepoPath(repoPath);
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : FILE_SEARCH_RESULT_LIMIT;

  if (!normalizedQuery) {
    return [];
  }

  async function searchWithRipgrep(): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'rg',
      ['--files', '--hidden', '-g', '!.git'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
      },
    );

    return stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  async function searchWithFilesystemWalk(): Promise<string[]> {
    const matches: string[] = [];

    async function visit(currentPath: string, relativePath = ''): Promise<boolean> {
      const entries = await readdir(currentPath, { withFileTypes: true });
      const sortedEntries = [...entries].sort((left, right) => (
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
      ));

      for (const entry of sortedEntries) {
        if (FILE_TREE_IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const nextAbsolutePath = join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (await visit(nextAbsolutePath, nextRelativePath)) {
            return true;
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        matches.push(nextRelativePath);
      }

      return false;
    }

    await visit(repoRoot);
    return matches;
  }

  let candidates: string[];

  try {
    candidates = await searchWithRipgrep();
  } catch {
    candidates = await searchWithFilesystemWalk();
  }

  return candidates
    .filter((pathValue) => pathValue.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const rankDiff = getSearchRank(left, normalizedQuery) - getSearchRank(right, normalizedQuery);

      if (rankDiff !== 0) {
        return rankDiff;
      }

      return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    })
    .slice(0, normalizedLimit);
}

function isNoMatchRipgrepError(error: unknown) {
  return (
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 1
  );
}

function normalizeSearchPath(pathValue: string) {
  return normalizeDiffPath(pathValue).replace(/^\.\//, '');
}

function isWholeWordTextMatch(lineText: string, column: number, query: string) {
  const start = Math.max(0, column - 1);

  if (lineText.slice(start, start + query.length) !== query) {
    return false;
  }

  const previousCharacter = lineText[start - 1] ?? '';
  const nextCharacter = lineText[start + query.length] ?? '';

  return !IDENTIFIER_PART_PATTERN.test(previousCharacter) && !IDENTIFIER_PART_PATTERN.test(nextCharacter);
}

async function searchText(
  repoPath: string,
  query: string,
  limit = FILE_SEARCH_RESULT_LIMIT,
  wholeWord = false,
): Promise<GitTextSearchMatch[]> {
  const repoRoot = resolveRepoPath(repoPath);
  const normalizedQuery = query.trim();
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : FILE_SEARCH_RESULT_LIMIT;

  if (!normalizedQuery) {
    return [];
  }

  async function searchWithRipgrep(): Promise<GitTextSearchMatch[]> {
    try {
      const { stdout } = await execFileAsync(
        'rg',
        [
          '--vimgrep',
          '--hidden',
          '-g',
          '!.git',
          '-g',
          '!node_modules',
          '-g',
          '!dist',
          '-g',
          '!build',
          '-g',
          '!coverage',
          '-g',
          '!release',
          '-g',
          '!vendor',
          '--fixed-strings',
          '--',
          normalizedQuery,
          '.',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
        },
      );

      return stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);

          if (!match) {
            return null;
          }

          const relativePath = normalizeSearchPath(match[1] ?? '');
          const lineNumber = Number.parseInt(match[2] ?? '0', 10);
          const column = Number.parseInt(match[3] ?? '0', 10);
          const text = match[4] ?? '';

          if (!relativePath || !Number.isFinite(lineNumber) || !Number.isFinite(column) || lineNumber < 1 || column < 1) {
            return null;
          }

          if (wholeWord && !isWholeWordTextMatch(text, column, normalizedQuery)) {
            return null;
          }

          return {
            path: relativePath,
            filePath: normalizeDiffPath(join(repoRoot, relativePath)),
            line: lineNumber,
            column,
            text,
          } satisfies GitTextSearchMatch;
        })
        .filter((entry): entry is GitTextSearchMatch => Boolean(entry))
        .slice(0, normalizedLimit);
    } catch (error) {
      if (isNoMatchRipgrepError(error)) {
        return [];
      }

      throw error;
    }
  }

  async function searchWithFilesystemWalk(): Promise<GitTextSearchMatch[]> {
    const matches: GitTextSearchMatch[] = [];

    async function visit(currentPath: string, relativePath = ''): Promise<boolean> {
      const entries = await readdir(currentPath, { withFileTypes: true });
      const sortedEntries = [...entries].sort((left, right) => (
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
      ));

      for (const entry of sortedEntries) {
        if (TEXT_SEARCH_IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const nextAbsolutePath = join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (await visit(nextAbsolutePath, nextRelativePath)) {
            return true;
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        let fileContent: string;

        try {
          fileContent = await readFile(nextAbsolutePath, 'utf8');
        } catch {
          continue;
        }

        if (fileContent.includes('\0')) {
          continue;
        }

        const normalizedContent = fileContent.replace(/\r\n/g, '\n');
        const lines = normalizedContent.split('\n');

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const lineText = lines[lineIndex] ?? '';
          let fromIndex = 0;

          while (fromIndex <= lineText.length) {
            const matchIndex = lineText.indexOf(normalizedQuery, fromIndex);

            if (matchIndex < 0) {
              break;
            }

            const column = matchIndex + 1;

            if (!wholeWord || isWholeWordTextMatch(lineText, column, normalizedQuery)) {
              matches.push({
                path: normalizeSearchPath(nextRelativePath),
                filePath: normalizeDiffPath(nextAbsolutePath),
                line: lineIndex + 1,
                column,
                text: lineText,
              });

              if (matches.length >= normalizedLimit) {
                return true;
              }
            }

            fromIndex = matchIndex + Math.max(1, normalizedQuery.length);
          }
        }
      }

      return false;
    }

    await visit(repoRoot);
    return matches;
  }

  try {
    return await searchWithRipgrep();
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 127)
    ) {
      return searchWithFilesystemWalk();
    }

    throw createRepositoryError(error);
  }
}

async function getWorktrees(repoPath: string): Promise<GitWorktreeSummary[]> {
  const repository = await resolveRepository(repoPath);
  const currentRepoPath = resolveRepoPath(repoPath);
  const worktreeArgs = ['worktree', 'list', '--porcelain'];
  const rawWorktrees = repository.mode === 'wsl'
    ? await runWslGit(repository, worktreeArgs)
    : await repository.git.raw(worktreeArgs);

  return parseWorktreeSummary(rawWorktrees, repository, currentRepoPath);
}

async function getDiff(
  repoPath: string,
  filePath?: string,
  mode: GitDiffMode = 'working-tree',
): Promise<string> {
  const repository = await resolveRepository(repoPath);
  const diffArgs = mode === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--no-color']
    : ['diff', '--no-ext-diff', '--no-color'];

  if (repository.mode === 'wsl') {
    const args = filePath
      ? [...diffArgs, '--', filePath]
      : diffArgs;
    const diff = await runWslGit(repository, args);

    if (diff.trim() || !filePath) {
      return diff;
    }

    if (mode === 'staged') {
      return '';
    }

    return createWslUntrackedDiff(repository, filePath);
  }

  if (filePath) {
    const diff = mode === 'staged'
      ? await repository.git.raw([...diffArgs, '--', filePath])
      : await repository.git.diff(['--no-ext-diff', '--no-color', '--', filePath]);

    if (diff.trim()) {
      return diff;
    }

    if (mode === 'staged') {
      return '';
    }

    return createNativeUntrackedDiff(repository, filePath);
  }

  return mode === 'staged'
    ? repository.git.raw(diffArgs)
    : repository.git.diff(['--no-ext-diff', '--no-color']);
}

async function getCommitDiff(
  repoPath: string,
  commitHash: string,
  parentHash?: string | null,
): Promise<string> {
  const repository = await resolveRepository(repoPath);

  if (!commitHash.trim()) {
    throw new Error('No commit selected.');
  }

  if (repository.mode === 'wsl') {
    if (parentHash) {
      return runWslGit(repository, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--find-renames',
        parentHash,
        commitHash,
      ]);
    }

    return runWslGit(repository, [
      'show',
      '--format=',
      '--root',
      '--no-ext-diff',
      '--no-color',
      '--find-renames',
      commitHash,
    ]);
  }

  if (parentHash) {
    return repository.git.raw([
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--find-renames',
      parentHash,
      commitHash,
    ]);
  }

  return repository.git.raw([
    'show',
    '--format=',
    '--root',
    '--no-ext-diff',
    '--no-color',
    '--find-renames',
    commitHash,
  ]);
}

function isMissingHeadError(error: unknown) {
  return /does not have any commits yet|unknown revision or path not in the working tree|ambiguous argument 'HEAD'|could not resolve HEAD/i
    .test(createRepositoryError(error).message);
}

function toWslMountPath(pathValue: string): string {
  const driveMatch = /^([A-Za-z]):\\(.*)$/.exec(pathValue);

  if (!driveMatch) {
    throw new Error(`Cannot convert path to WSL mount path: ${pathValue}`);
  }

  const [, driveLetter, suffix] = driveMatch;
  const normalizedSuffix = suffix.replace(/\\/g, '/');
  return `/mnt/${driveLetter.toLowerCase()}/${normalizedSuffix}`;
}

async function withTempPatchFile<T>(
  patch: string,
  callback: (patchFilePath: string) => Promise<T>,
): Promise<T> {
  const patchDir = await mkdtemp(join(tmpdir(), 'bridgegit-patch-'));
  const patchFilePath = join(patchDir, 'discard.patch');

  try {
    await writeFile(patchFilePath, patch, 'utf8');
    return await callback(patchFilePath);
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }
}

async function applyPatchFile(
  repository: RepositoryContext,
  args: string[],
  patch: string,
): Promise<void> {
  await withTempPatchFile(patch, async (patchFilePath) => {
    if (repository.mode === 'wsl') {
      await runWslGit(repository, [...args, toWslMountPath(patchFilePath)]);
      return;
    }

    await repository.git.raw([...args, patchFilePath]);
  });
}

async function discardUntrackedFile(
  repository: RepositoryContext,
  filePath: string,
): Promise<void> {
  if (repository.mode === 'wsl') {
    await runWslGit(repository, ['clean', '-f', '--', filePath]);
    await runWslCommand(repository, ['rm', '-f', '--', filePath]);
    return;
  }

  await repository.git.raw(['clean', '-f', '--', filePath]);
  await rm(join(repository.repoPath, filePath), { force: true });
}

async function discardWithoutHead(
  repository: RepositoryContext,
  filePaths: string[],
): Promise<void> {
  if (repository.mode === 'wsl') {
    await runWslGit(repository, ['rm', '--cached', '-f', '--ignore-unmatch', '--', ...filePaths]);
    await runWslGit(repository, ['clean', '-f', '--', ...filePaths]);
    await Promise.all(filePaths.map((filePath) => (
      runWslCommand(repository, ['rm', '-f', '--', filePath])
    )));
    return;
  }

  await repository.git.raw(['rm', '--cached', '-f', '--ignore-unmatch', '--', ...filePaths]);
  await repository.git.raw(['clean', '-f', '--', ...filePaths]);
  await Promise.all(filePaths.map((filePath) => (
    rm(join(repository.repoPath, filePath), { force: true })
  )));
}

async function discardFile(repoPath: string, change: GitChange): Promise<GitStatusSummary> {
  const repository = await resolveRepository(repoPath);
  const filePaths = change.type === 'renamed' && change.originalPath
    ? [change.originalPath, change.path]
    : [change.path];

  if (change.type === 'untracked') {
    await discardUntrackedFile(repository, change.path);
    return getStatusSummary(repoPath);
  }

  try {
    if (repository.mode === 'wsl') {
      await runWslGit(repository, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...filePaths]);
    } else {
      await repository.git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...filePaths]);
    }
  } catch (error) {
    if (!isMissingHeadError(error)) {
      throw error;
    }

    await discardWithoutHead(repository, filePaths);
  }

  return getStatusSummary(repoPath);
}

async function discardHunk(
  repoPath: string,
  patch: string,
  mode: GitDiffMode,
): Promise<GitStatusSummary> {
  const repository = await resolveRepository(repoPath);

  if (mode === 'staged') {
    await applyPatchFile(repository, ['apply', '-R', '--cached', '--recount', '--whitespace=nowarn'], patch);
    await applyPatchFile(repository, ['apply', '-R', '--recount', '--whitespace=nowarn'], patch);
    return getStatusSummary(repoPath);
  }

  await applyPatchFile(repository, ['apply', '-R', '--recount', '--whitespace=nowarn'], patch);
  return getStatusSummary(repoPath);
}

async function getLog(repoPath: string, limit = 20): Promise<GitLogResult> {
  const repository = await resolveRepository(repoPath);
  const maxCount = Math.max(20, Math.min(limit, 300));

  try {
    const rawLog = repository.mode === 'wsl'
      ? await runWslGit(repository, [
        'log',
        '--all',
        '--topo-order',
        '--decorate=full',
        '--date=iso-strict',
        `--max-count=${maxCount}`,
        '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e',
      ])
      : await repository.git.raw([
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
  const repository = await resolveRepository(repoPath);

  if (repository.mode === 'wsl') {
    await runWslGit(
      repository,
      files.length > 0 ? ['add', '--', ...files] : ['add', '.'],
    );
  } else {
    await repository.git.add(files.length > 0 ? files : ['.']);
  }

  return getStatusSummary(repoPath);
}

async function unstageFiles(repoPath: string, files: string[]): Promise<GitStatusSummary> {
  const repository = await resolveRepository(repoPath);

  if (files.length > 0) {
    if (repository.mode === 'wsl') {
      await runWslGit(repository, ['restore', '--staged', '--', ...files]);
    } else {
      await repository.git.raw(['restore', '--staged', '--', ...files]);
    }
  }

  return getStatusSummary(repoPath);
}

async function commitChanges(repoPath: string, message: string): Promise<GitStatusSummary> {
  const repository = await resolveRepository(repoPath);
  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    throw new Error('Commit message cannot be empty.');
  }

  if (repository.mode === 'wsl') {
    await runWslGit(repository, ['commit', '-m', trimmedMessage]);
  } else {
    await repository.git.commit(trimmedMessage);
  }

  return getStatusSummary(repoPath);
}

async function checkoutBranch(repoPath: string, branchName: string): Promise<BranchSummary> {
  const repository = await resolveRepository(repoPath);
  const branches = await getBranches(repoPath);
  const targetBranch = branches.all.find((branch) => branch.name === branchName) ?? null;

  if (targetBranch?.checkedOutElsewhere) {
    const detail = targetBranch.worktreePath
      ? ` Checked out at ${targetBranch.worktreePath}.`
      : '';

    throw new Error(`Branch "${branchName}" is already open in another repo.${detail}`);
  }

  if (repository.mode === 'wsl') {
    await runWslGit(repository, ['checkout', branchName]);
  } else {
    await repository.git.checkout(branchName);
  }

  return getBranches(repoPath);
}

async function validateBranchName(repository: RepositoryContext, branchName: string): Promise<string> {
  const trimmedBranchName = branchName.trim();

  if (!trimmedBranchName) {
    throw new Error('Branch name cannot be empty.');
  }

  try {
    if (repository.mode === 'wsl') {
      await runWslGit(repository, ['check-ref-format', '--branch', trimmedBranchName]);
    } else {
      await repository.git.raw(['check-ref-format', '--branch', trimmedBranchName]);
    }
  } catch {
    throw new Error(`Invalid branch name: ${trimmedBranchName}`);
  }

  return trimmedBranchName;
}

async function createBranch(
  repoPath: string,
  branchName: string,
  options: CreateBranchOptions = {},
): Promise<CreateBranchResult> {
  const repository = await resolveRepository(repoPath);
  const validatedBranchName = await validateBranchName(repository, branchName.trim());
  const placement = options.placement ?? 'current-repo';

  if (placement === 'current-repo') {
    const command = options.checkout === false
      ? ['branch', validatedBranchName]
      : ['checkout', '-b', validatedBranchName];

    if (repository.mode === 'wsl') {
      await runWslGit(repository, command);
    } else {
      await repository.git.raw(command);
    }

    return {
      branches: await getBranches(repoPath),
      repoPath: resolveRepoPath(repoPath),
    };
  }

  const primaryWorktreePath = await getPrimaryWorktreePath(repository);
  const nextRepoPath = buildBranchCheckoutPath(repository, primaryWorktreePath, validatedBranchName);
  const command = ['worktree', 'add', '-b', validatedBranchName, nextRepoPath, 'HEAD'];

  if (repository.mode === 'wsl') {
    await runWslGit(repository, command);
  } else {
    await repository.git.raw(command);
  }

  return {
    branches: await getBranches(repoPath),
    repoPath: normalizeWorktreePath(nextRepoPath, repository) ?? resolveRepoPath(nextRepoPath),
  };
}

async function deleteBranch(repoPath: string, branchName: string): Promise<DeleteBranchResult> {
  const repository = await resolveRepository(repoPath);
  const validatedBranchName = await validateBranchName(repository, branchName.trim());
  const branches = await getBranches(repoPath);
  const targetBranch = branches.all.find((branch) => branch.name === validatedBranchName) ?? null;

  if (!targetBranch) {
    throw new Error(`Branch "${validatedBranchName}" does not exist.`);
  }

  if (targetBranch.current) {
    throw new Error(`Branch "${validatedBranchName}" is currently checked out.`);
  }

  if (targetBranch.checkedOutElsewhere) {
    const detail = targetBranch.worktreePath
      ? ` Checked out at ${targetBranch.worktreePath}.`
      : '';

    throw new Error(`Branch "${validatedBranchName}" is already open in another repo.${detail}`);
  }

  await runGit(repository, ['branch', '-d', validatedBranchName]);

  return {
    branches: await getBranches(repoPath),
    deletedBranch: validatedBranchName,
  };
}

interface WorktreeLifecycleContext {
  currentRepoPath: string;
  currentWorktree: GitWorktreeSummary;
  primaryWorktree: GitWorktreeSummary;
}

async function resolveWorktreeLifecycleContext(repoPath: string): Promise<WorktreeLifecycleContext> {
  const currentRepoPath = resolveRepoPath(repoPath);
  const worktrees = await getWorktrees(currentRepoPath);
  const currentWorktree = worktrees.find((worktree) => worktree.current) ?? null;
  const primaryWorktree = worktrees.find((worktree) => !worktree.bare) ?? null;

  if (!currentWorktree) {
    throw new Error('The selected repository is not an active worktree.');
  }

  if (!primaryWorktree) {
    throw new Error('Could not determine the primary repository checkout.');
  }

  return {
    currentRepoPath,
    currentWorktree,
    primaryWorktree,
  };
}

async function resolveMergeTargetBranch(repository: RepositoryContext): Promise<string> {
  try {
    const symbolicRef = await runGit(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const normalizedRef = symbolicRef.trim();

    if (normalizedRef.startsWith('origin/')) {
      const branchName = normalizedRef.slice('origin/'.length).trim();

      if (branchName) {
        return branchName;
      }
    }
  } catch {
    // Fallback to local branch detection below.
  }

  const rawBranches = await runGit(repository, ['branch', '--list', '--no-color', 'master', 'main']);
  const branchNames = new Set(parseBranchList(rawBranches).map((branch) => branch.name));

  if (branchNames.has('main')) {
    return 'main';
  }

  if (branchNames.has('master')) {
    return 'master';
  }

  throw new Error('Could not determine the primary branch from origin/HEAD, main, or master.');
}

async function ensureWorktreeNodeModulesSymlinkRemoved(worktreePath: string): Promise<void> {
  const nodeModulesPath = join(worktreePath, 'node_modules');

  try {
    const stats = await lstat(nodeModulesPath);

    if (stats.isSymbolicLink()) {
      await rm(nodeModulesPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return;
    }

    throw error;
  }
}

async function mergeWorktreeIntoPrimaryBranch(repoPath: string): Promise<MergeWorktreeIntoPrimaryBranchResult> {
  const { currentRepoPath, currentWorktree, primaryWorktree } = await resolveWorktreeLifecycleContext(repoPath);

  if (areRepoPathsEquivalent(currentWorktree.path, primaryWorktree.path)) {
    throw new Error('Only linked worktree repos can be merged into the primary branch.');
  }

  const sourceStatus = await getStatusSummary(currentRepoPath);

  if (!sourceStatus.isClean) {
    throw new Error('Commit or discard changes in this worktree before merging.');
  }

  const sourceBranch = sourceStatus.currentBranch?.trim() ?? '';

  if (!sourceBranch) {
    throw new Error('Cannot merge a detached worktree.');
  }

  const primaryRepository = await resolveRepository(primaryWorktree.path);
  const targetBranch = await resolveMergeTargetBranch(primaryRepository);

  if (sourceBranch === targetBranch) {
    throw new Error(`Branch "${sourceBranch}" is already the target branch.`);
  }

  const primaryStatus = await getStatusSummary(primaryWorktree.path);

  if (!primaryStatus.isClean) {
    throw new Error('Commit or discard changes in the primary repo before merging.');
  }

  await runGit(primaryRepository, ['checkout', targetBranch]);
  await runGit(primaryRepository, ['merge', sourceBranch]);

  return {
    repoPath: currentRepoPath,
    primaryRepoPath: primaryWorktree.path,
    sourceBranch,
    targetBranch,
  };
}

async function removeWorktree(repoPath: string): Promise<RemoveWorktreeResult> {
  const { currentRepoPath, currentWorktree, primaryWorktree } = await resolveWorktreeLifecycleContext(repoPath);

  if (areRepoPathsEquivalent(currentWorktree.path, primaryWorktree.path)) {
    throw new Error('The primary repo cannot be removed as a worktree.');
  }

  const currentStatus = await getStatusSummary(currentRepoPath);

  if (!currentStatus.isClean) {
    throw new Error('Commit or discard changes in this worktree before removing it.');
  }

  await ensureWorktreeNodeModulesSymlinkRemoved(currentWorktree.path);

  const primaryRepository = await resolveRepository(primaryWorktree.path);
  await runGit(primaryRepository, ['worktree', 'remove', currentWorktree.path]);

  return {
    repoPath: currentRepoPath,
    primaryRepoPath: primaryWorktree.path,
    removedBranch: currentStatus.currentBranch?.trim() || null,
  };
}

async function isBranchMergedIntoTarget(
  repository: RepositoryContext,
  branchName: string,
  targetBranch: string,
): Promise<boolean> {
  try {
    await runGit(repository, ['merge-base', '--is-ancestor', branchName, targetBranch]);
    return true;
  } catch {
    return false;
  }
}

async function removeWorktreeAndDeleteBranch(repoPath: string): Promise<RemoveWorktreeAndDeleteBranchResult> {
  const { currentRepoPath, currentWorktree, primaryWorktree } = await resolveWorktreeLifecycleContext(repoPath);

  if (areRepoPathsEquivalent(currentWorktree.path, primaryWorktree.path)) {
    throw new Error('The primary repo cannot be removed as a worktree.');
  }

  const currentStatus = await getStatusSummary(currentRepoPath);

  if (!currentStatus.isClean) {
    throw new Error('Commit or discard changes in this worktree before removing it.');
  }

  const sourceBranch = currentStatus.currentBranch?.trim() ?? '';

  if (!sourceBranch) {
    throw new Error('Cannot delete a detached worktree branch.');
  }

  const primaryRepository = await resolveRepository(primaryWorktree.path);
  const targetBranch = await resolveMergeTargetBranch(primaryRepository);
  const primaryStatus = await getStatusSummary(primaryWorktree.path);

  if (sourceBranch === targetBranch) {
    throw new Error(`Branch "${sourceBranch}" is the primary branch and cannot be deleted.`);
  }

  if (primaryStatus.currentBranch !== targetBranch) {
    throw new Error(`Switch the primary repo to ${targetBranch} before removing and deleting this branch.`);
  }

  const isMerged = await isBranchMergedIntoTarget(primaryRepository, sourceBranch, targetBranch);

  if (!isMerged) {
    throw new Error(`Branch "${sourceBranch}" is not safely merged into ${targetBranch}.`);
  }

  await ensureWorktreeNodeModulesSymlinkRemoved(currentWorktree.path);
  await runGit(primaryRepository, ['worktree', 'remove', currentWorktree.path]);
  await runGit(primaryRepository, ['branch', '-d', sourceBranch]);

  return {
    repoPath: currentRepoPath,
    primaryRepoPath: primaryWorktree.path,
    removedBranch: sourceBranch,
    deletedBranch: sourceBranch,
  };
}

async function pushCurrentBranch(repoPath: string): Promise<GitStatusSummary> {
  const repository = await resolveRepository(repoPath);
  const status = await getStatusSummary(repoPath);
  const currentBranch = status.currentBranch?.trim() ?? '';

  if (!currentBranch) {
    throw new Error('Cannot push from detached HEAD.');
  }

  if (repository.mode === 'wsl') {
    if (status.trackingBranch) {
      await runWslGit(repository, ['push']);
    } else {
      await runWslGit(repository, ['push', '--set-upstream', 'origin', currentBranch]);
    }
  } else if (status.trackingBranch) {
    await repository.git.push();
  } else {
    await repository.git.raw(['push', '--set-upstream', 'origin', currentBranch]);
  }

  return getStatusSummary(repoPath);
}

export function registerGitIpcHandlers() {
  ipcMain.handle('git:isRepository', (_event, repoPath: string) => isRepository(repoPath));
  ipcMain.handle('git:initRepository', (_event, repoPath: string) => initRepository(repoPath));
  ipcMain.handle(
    'git:status',
    (_event, repoPath: string, options?: GitStatusRequestOptions) => getStatusSummary(repoPath, options),
  );
  ipcMain.handle('git:branches', (_event, repoPath: string) => getBranches(repoPath));
  ipcMain.handle('git:listDirectory', (_event, repoPath: string, relativePath?: string) =>
    listDirectory(repoPath, relativePath),
  );
  ipcMain.handle('git:searchFiles', (_event, repoPath: string, query: string, limit?: number) =>
    searchFiles(repoPath, query, limit),
  );
  ipcMain.handle('git:searchText', (_event, repoPath: string, query: string, limit?: number, wholeWord?: boolean) =>
    searchText(repoPath, query, limit, wholeWord),
  );
  ipcMain.handle('git:worktrees', (_event, repoPath: string) => getWorktrees(repoPath));
  ipcMain.handle('git:diff', (_event, repoPath: string, filePath?: string, mode?: GitDiffMode) =>
    getDiff(repoPath, filePath, mode),
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
  ipcMain.handle('git:discard', (_event, repoPath: string, change: GitChange) =>
    discardFile(repoPath, change),
  );
  ipcMain.handle('git:discardHunk', (_event, repoPath: string, patch: string, mode: GitDiffMode) =>
    discardHunk(repoPath, patch, mode),
  );
  ipcMain.handle('git:commit', (_event, repoPath: string, message: string) =>
    commitChanges(repoPath, message),
  );
  ipcMain.handle('git:checkout', (_event, repoPath: string, branchName: string) =>
    checkoutBranch(repoPath, branchName),
  );
  ipcMain.handle(
    'git:createBranch',
    (_event, repoPath: string, branchName: string, options?: CreateBranchOptions) =>
      createBranch(repoPath, branchName, options),
  );
  ipcMain.handle('git:deleteBranch', (_event, repoPath: string, branchName: string) =>
    deleteBranch(repoPath, branchName),
  );
  ipcMain.handle('git:mergeWorktreeIntoPrimaryBranch', (_event, repoPath: string) =>
    mergeWorktreeIntoPrimaryBranch(repoPath),
  );
  ipcMain.handle('git:removeWorktree', (_event, repoPath: string) =>
    removeWorktree(repoPath),
  );
  ipcMain.handle('git:removeWorktreeAndDeleteBranch', (_event, repoPath: string) =>
    removeWorktreeAndDeleteBranch(repoPath),
  );
  ipcMain.handle('git:push', (_event, repoPath: string) =>
    pushCurrentBranch(repoPath),
  );
}
