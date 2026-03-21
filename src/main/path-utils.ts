import { homedir } from 'node:os';

const WSL_MOUNT_PATH_PATTERN = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;
const WINDOWS_WSL_UNC_PATH_PATTERN = /^\\\\wsl\.localhost\\([^\\]+)(?:\\(.*))?$/i;

export interface WindowsWslPath {
  distro: string;
  linuxPath: string;
}

export function parseWindowsWslPath(pathValue: string | null | undefined): WindowsWslPath | null {
  const trimmedPath = pathValue?.trim();

  if (!trimmedPath) {
    return null;
  }

  const match = WINDOWS_WSL_UNC_PATH_PATTERN.exec(trimmedPath);

  if (!match) {
    return null;
  }

  const [, distro, suffix = ''] = match;
  const normalizedSuffix = suffix.replace(/\\/g, '/');

  return {
    distro,
    linuxPath: normalizedSuffix ? `/${normalizedSuffix}` : '/',
  };
}

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
    return trimmedPath.replace(/\//g, '\\');
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
