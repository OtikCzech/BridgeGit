import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { normalizeStoredPath, parseWindowsWslPath } from './path-utils';

const execFileAsync = promisify(execFile);

async function resolveWindowsWslPath(pathValue: string): Promise<string | null> {
  const trimmedPath = pathValue.trim();

  if (process.platform !== 'win32' || !trimmedPath.startsWith('/') || /^\/mnt\/[a-zA-Z](?:\/|$)/.test(trimmedPath)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('wsl.exe', ['wslpath', '-w', trimmedPath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const convertedPath = stdout.trim();
    return convertedPath || null;
  } catch {
    return null;
  }
}

export async function resolveDialogDefaultPath(defaultPath?: string | null): Promise<string | undefined> {
  const trimmedPath = defaultPath?.trim();

  if (!trimmedPath) {
    return undefined;
  }

  const resolvedWindowsWslPath = await resolveWindowsWslPath(trimmedPath);

  if (resolvedWindowsWslPath) {
    return resolvedWindowsWslPath;
  }

  return normalizeStoredPath(trimmedPath) ?? undefined;
}

export function buildReadableFilePathCandidates(filePath: string): string[] {
  const trimmedPath = filePath.trim();

  if (!trimmedPath) {
    return [];
  }

  const candidates = new Set<string>();
  const normalizedStoredPath = normalizeStoredPath(trimmedPath);
  const normalizedWslUncPath = /^\/(wsl\.localhost|wsl\$)\//i.test(trimmedPath) && !trimmedPath.startsWith('//')
    ? `/${trimmedPath}`
    : trimmedPath;

  candidates.add(trimmedPath);
  candidates.add(normalizedWslUncPath);

  if (normalizedStoredPath) {
    candidates.add(normalizedStoredPath);
  }

  if (process.platform !== 'win32') {
    const normalizedWindowsPath = trimmedPath.replace(/\\/g, '/');
    const windowsDriveMatch = normalizedWindowsPath.match(/^([A-Za-z]):\/(.*)$/);

    if (windowsDriveMatch) {
      const [, driveLetter, suffix] = windowsDriveMatch;
      candidates.add(`/mnt/${driveLetter.toLowerCase()}/${suffix}`);
    }

    const wslPath = parseWindowsWslPath(normalizedWslUncPath.replace(/\//g, '\\'));

    if (wslPath?.linuxPath) {
      candidates.add(wslPath.linuxPath);
    }
  }

  return [...candidates];
}

export async function resolveReadableFilePath(filePath: string): Promise<string> {
  const candidates = new Set(buildReadableFilePathCandidates(filePath));
  const resolvedWindowsWslPath = await resolveWindowsWslPath(filePath);

  if (resolvedWindowsWslPath) {
    candidates.add(resolvedWindowsWslPath);
  }

  for (const candidate of candidates) {
    try {
      const fileStat = await stat(candidate);

      if (fileStat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate path variant.
    }
  }

  throw new Error(`File not found: ${filePath}`);
}
