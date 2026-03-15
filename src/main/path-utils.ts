import { homedir } from 'node:os';

const WSL_MOUNT_PATH_PATTERN = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;

export function normalizeStoredPath(pathValue: string | null | undefined): string | null {
  const trimmedPath = pathValue?.trim();

  if (!trimmedPath) {
    return null;
  }

  if (process.platform !== 'win32') {
    return trimmedPath;
  }

  if (trimmedPath === '/') {
    return null;
  }

  const wslMountMatch = WSL_MOUNT_PATH_PATTERN.exec(trimmedPath);

  if (!wslMountMatch) {
    return trimmedPath;
  }

  const [, driveLetter, suffix = ''] = wslMountMatch;
  const normalizedSuffix = suffix.replace(/\//g, '\\');

  return normalizedSuffix
    ? `${driveLetter.toUpperCase()}:\\${normalizedSuffix}`
    : `${driveLetter.toUpperCase()}:\\`;
}

export function getDefaultTerminalCwd(preferredPath?: string | null): string {
  return normalizeStoredPath(preferredPath) ?? homedir();
}

export function normalizeTerminalCwd(
  cwd: string | null | undefined,
  fallbackPath?: string | null,
): string {
  return normalizeStoredPath(cwd) ?? getDefaultTerminalCwd(fallbackPath);
}
