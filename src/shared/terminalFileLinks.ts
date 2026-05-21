import type { CodeNavigationTarget } from './bridgegit';
import { resolveWorkspaceFileTabType } from './bridgegit';

export const TERMINAL_FILE_LINK_PATTERN = /(?:\\\\[^\s"'`(){}<>|]+|[A-Za-z]:[\\/][^\s"'`(){}<>|]+|~[\\/][^\s"'`(){}<>|]+|(?:\.{1,2}[\\/]|\/)[^\s"'`(){}<>|]+|(?:[\w.-]+[\\/])+[^\s"'`(){}<>|]+)(?::\d+(?::\d+)?)?/g;

export function normalizeTerminalPath(value: string) {
  const normalizedValue = value.replace(/\\/g, '/');

  if (/^\/(wsl\.localhost|wsl\$)\//i.test(normalizedValue) && !normalizedValue.startsWith('//')) {
    return `/${normalizedValue}`;
  }

  return normalizedValue;
}

export function parseTerminalUncPath(value: string) {
  const match = normalizeTerminalPath(value).match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/);

  if (!match) {
    return null;
  }

  return {
    host: match[1],
    share: match[2],
    path: match[3] ?? '/',
  };
}

export function splitTerminalPath(value: string) {
  return normalizeTerminalPath(value).split('/');
}

export function resolvePosixRelativePath(basePath: string, relativePath: string) {
  const baseSegments = splitTerminalPath(basePath);
  const relativeSegments = splitTerminalPath(relativePath);
  const resolvedSegments: string[] = [];

  for (const segment of baseSegments) {
    if (!segment || segment === '.') {
      continue;
    }

    resolvedSegments.push(segment);
  }

  for (const segment of relativeSegments) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (resolvedSegments.length > 0 && resolvedSegments.at(-1) !== '..') {
        resolvedSegments.pop();
      }
      continue;
    }

    resolvedSegments.push(segment);
  }

  if (/^[A-Za-z]:$/.test(resolvedSegments[0] ?? '')) {
    return resolvedSegments.join('/');
  }

  return `/${resolvedSegments.join('/')}`;
}

export function sanitizeTerminalNavigationPath(value: string) {
  let normalizedValue = value.trim();

  const wrappedPathMatch = normalizedValue.match(/^[A-Za-z][\w-]*\((.+)\)$/);

  if (wrappedPathMatch?.[1]) {
    normalizedValue = wrappedPathMatch[1].trim();
  }

  normalizedValue = normalizedValue
    .replace(/^[`"'<>]+/, '')
    .replace(/[)`"',;.!<>]+$/, '');

  if (
    (normalizedValue.startsWith('(') && normalizedValue.endsWith(')'))
    || (normalizedValue.startsWith('[') && normalizedValue.endsWith(']'))
  ) {
    normalizedValue = normalizedValue.slice(1, -1).trim();
  }

  return normalizedValue;
}

export function inferTerminalHomePath(candidates: Array<string | null | undefined>) {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeTerminalPath(candidate ?? '');
    const unixMatch = normalizedCandidate.match(/^(\/home\/[^/]+|\/Users\/[^/]+)(?:\/|$)/);

    if (unixMatch?.[1]) {
      return unixMatch[1];
    }

    const windowsMatch = normalizedCandidate.match(/^([A-Za-z]:\/Users\/[^/]+)(?:\/|$)/);

    if (windowsMatch?.[1]) {
      return windowsMatch[1];
    }
  }

  return null;
}

export function resolveTerminalPath(basePath: string, relativePath: string) {
  const normalizedBasePath = normalizeTerminalPath(basePath);
  const normalizedRelativePath = normalizeTerminalPath(relativePath);
  const isWindowsAbsolutePath = /^[A-Za-z]:\//.test(normalizedRelativePath);
  const relativeUncPath = parseTerminalUncPath(normalizedRelativePath);

  if (isWindowsAbsolutePath || relativeUncPath || normalizedRelativePath.startsWith('/')) {
    return normalizedRelativePath;
  }

  const baseUncPath = parseTerminalUncPath(normalizedBasePath);

  if (baseUncPath) {
    const resolvedUncPath = resolvePosixRelativePath(baseUncPath.path, normalizedRelativePath);
    return `//${baseUncPath.host}/${baseUncPath.share}${resolvedUncPath === '/' ? '' : resolvedUncPath}`;
  }

  return resolvePosixRelativePath(normalizedBasePath, normalizedRelativePath);
}

export function matchTerminalFileLinks(value: string) {
  return value.match(TERMINAL_FILE_LINK_PATTERN) ?? [];
}

export function buildTerminalNavigationTargets(
  rawLinkText: string,
  options: {
    cwd?: string | null;
    projectRoot?: string | null;
    homePath?: string | null;
  },
): CodeNavigationTarget[] {
  const normalizedLinkText = rawLinkText.trim();

  if (!normalizedLinkText) {
    return [];
  }

  const match = normalizedLinkText.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  const rawPath = sanitizeTerminalNavigationPath(match?.[1]?.trim() ?? normalizedLinkText);
  const line = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
  const column = match?.[3] ? Number.parseInt(match[3], 10) : undefined;
  const normalizedRawPath = normalizeTerminalPath(rawPath);
  const inferredHomePath = options.homePath ?? inferTerminalHomePath([options.cwd, options.projectRoot]);
  const expandedRawPath = normalizedRawPath.startsWith('~/')
    ? `${inferredHomePath ?? '~'}${normalizedRawPath.slice(1)}`
    : normalizedRawPath;

  if (expandedRawPath.startsWith('~/')) {
    return [];
  }

  const isAbsolutePath = /^[A-Za-z]:\//.test(expandedRawPath) || expandedRawPath.startsWith('/');
  const candidateBasePaths = isAbsolutePath
    ? [null]
    : [options.cwd, options.projectRoot].filter((value, index, source): value is string => (
      Boolean(value) && source.indexOf(value) === index
    ));

  return candidateBasePaths
    .map((basePath) => (
      basePath
        ? resolveTerminalPath(basePath, expandedRawPath)
        : expandedRawPath
    ))
    .filter((filePath, index, source) => (
      resolveWorkspaceFileTabType(filePath) !== 'unsupported'
      && source.findIndex((candidate) => normalizeTerminalPath(candidate) === normalizeTerminalPath(filePath)) === index
    ))
    .map<CodeNavigationTarget>((filePath) => ({
      filePath,
      line,
      column,
    }));
}
