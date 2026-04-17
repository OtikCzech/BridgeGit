import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DockerContainerInfo, DockerContainerState, DockerImageInfo } from '../shared/bridgegit';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 15_000;
const COMPOSE_TIMEOUT_MS = 60_000;

type DockerBackend = 'windows' | 'wsl' | null;

let cachedBackend: DockerBackend | undefined;

async function execDocker(args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  const backend = await detectBackend();

  if (!backend) {
    throw new Error('Docker is not available. Install Docker Desktop or Docker Engine in WSL.');
  }

  if (backend === 'windows') {
    const { stdout } = await execFileAsync('docker.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
    });
    return stdout;
  }

  const { stdout } = await execFileAsync(
    'wsl.exe',
    ['bash', '-lc', `docker ${args.map(shellEscape).join(' ')}`],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
    },
  );
  return stdout;
}

async function execCompose(args: string[], cwd: string, timeoutMs = COMPOSE_TIMEOUT_MS): Promise<string> {
  const backend = await detectBackend();

  if (!backend) {
    throw new Error('Docker is not available.');
  }

  if (backend === 'windows') {
    const { stdout } = await execFileAsync('docker.exe', ['compose', ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      cwd,
    });
    return stdout;
  }

  const wslCwd = windowsPathToWsl(cwd);
  const composeArgs = ['compose', ...args].map(shellEscape).join(' ');
  const { stdout } = await execFileAsync(
    'wsl.exe',
    ['bash', '-lc', `cd ${shellEscape(wslCwd)} && docker ${composeArgs}`],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
    },
  );
  return stdout;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function windowsPathToWsl(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);

  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }

  return normalized;
}

async function detectBackend(): Promise<DockerBackend> {
  if (cachedBackend !== undefined) {
    return cachedBackend;
  }

  try {
    await execFileAsync('docker.exe', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    cachedBackend = 'windows';
    return cachedBackend;
  } catch {
    // docker.exe not available, try WSL
  }

  try {
    await execFileAsync('wsl.exe', ['bash', '-lc', 'docker info --format "{{.ServerVersion}}"'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8_000,
    });
    cachedBackend = 'wsl';
    return cachedBackend;
  } catch {
    // WSL docker not available either
  }

  cachedBackend = null;
  return cachedBackend;
}

function parseContainerState(rawState: string): DockerContainerState {
  const normalized = rawState.toLowerCase().trim();
  const knownStates: DockerContainerState[] = ['running', 'exited', 'paused', 'created', 'restarting', 'dead', 'removing'];

  return knownStates.includes(normalized as DockerContainerState)
    ? (normalized as DockerContainerState)
    : 'exited';
}

function parseContainerJson(line: string): DockerContainerInfo | null {
  try {
    const raw = JSON.parse(line);
    const labels: Record<string, string> = {};

    if (raw.Labels) {
      for (const pair of raw.Labels.split(',')) {
        const eqIndex = pair.indexOf('=');

        if (eqIndex > 0) {
          labels[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
        }
      }
    }

    const composeProject = labels['com.docker.compose.project'] ?? null;
    const composeService = labels['com.docker.compose.service'] ?? null;

    return {
      id: raw.ID ?? '',
      name: (raw.Names ?? '').replace(/^\//, ''),
      image: raw.Image ?? '',
      status: raw.Status ?? '',
      state: parseContainerState(raw.State ?? ''),
      ports: raw.Ports ?? '',
      compose: composeProject && composeService
        ? { project: composeProject, service: composeService }
        : null,
    };
  } catch {
    return null;
  }
}

function parseImageJson(line: string): DockerImageInfo | null {
  try {
    const raw = JSON.parse(line);

    return {
      id: (raw.ID ?? '').slice(0, 12),
      repository: raw.Repository ?? '<none>',
      tag: raw.Tag ?? '<none>',
      size: raw.Size ?? '',
      created: raw.CreatedSince ?? raw.CreatedAt ?? '',
    };
  } catch {
    return null;
  }
}

async function listContainers(): Promise<DockerContainerInfo[]> {
  const stdout = await execDocker(['ps', '-a', '--format', '{{json .}}', '--no-trunc']);

  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map(parseContainerJson)
    .filter((item): item is DockerContainerInfo => item !== null);
}

async function listImages(): Promise<DockerImageInfo[]> {
  const stdout = await execDocker(['images', '--format', '{{json .}}']);

  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map(parseImageJson)
    .filter((item): item is DockerImageInfo => item !== null);
}

async function containerAction(containerId: string, action: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> {
  const dockerAction = action === 'remove' ? 'rm' : action;
  const args = action === 'remove'
    ? [dockerAction, '-f', containerId]
    : [dockerAction, containerId];

  await execDocker(args);
}

async function removeImage(imageId: string): Promise<void> {
  await execDocker(['rmi', imageId]);
}

async function composeUp(cwd: string): Promise<void> {
  await execCompose(['up', '-d'], cwd);
}

async function composeDown(cwd: string): Promise<void> {
  await execCompose(['down'], cwd);
}

async function composeRestart(cwd: string): Promise<void> {
  await execCompose(['restart'], cwd);
}

async function isAvailable(): Promise<boolean> {
  const backend = await detectBackend();
  return backend !== null;
}

function resetBackendCache(): void {
  cachedBackend = undefined;
}

async function getLogsCommand(containerId: string): Promise<{ shell: string; command: string }> {
  const backend = await detectBackend();

  if (backend === 'windows') {
    return {
      shell: 'powershell.exe',
      command: `docker logs -f --tail 200 ${containerId}`,
    };
  }

  return {
    shell: 'wsl.exe',
    command: `docker logs -f --tail 200 ${containerId}`,
  };
}

export function registerDockerIpcHandlers() {
  ipcMain.handle('docker:available', () => isAvailable());
  ipcMain.handle('docker:containers', () => listContainers());
  ipcMain.handle('docker:images', () => listImages());
  ipcMain.handle(
    'docker:containerAction',
    (_event, containerId: string, action: 'start' | 'stop' | 'restart' | 'remove') =>
      containerAction(containerId, action),
  );
  ipcMain.handle('docker:removeImage', (_event, imageId: string) => removeImage(imageId));
  ipcMain.handle('docker:composeUp', (_event, cwd: string) => composeUp(cwd));
  ipcMain.handle('docker:composeDown', (_event, cwd: string) => composeDown(cwd));
  ipcMain.handle('docker:composeRestart', (_event, cwd: string) => composeRestart(cwd));
  ipcMain.handle('docker:resetBackend', () => resetBackendCache());
  ipcMain.handle('docker:logsCommand', (_event, containerId: string) => getLogsCommand(containerId));
}
