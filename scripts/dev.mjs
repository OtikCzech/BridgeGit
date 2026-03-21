import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchElectron as spawnElectronProcess } from './electron-launch.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = resolve(projectRoot, 'dist/main/index.js');
const preloadEntry = resolve(projectRoot, 'dist/preload/index.js');
const tscBin = resolve(projectRoot, 'node_modules/typescript/bin/tsc');

let electronProcess = null;
let shutdownRequested = false;
let restartTimer = null;

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForArtifacts() {
  while (!(await fileExists(mainEntry)) || !(await fileExists(preloadEntry))) {
    await delay(250);
  }
}

function launchElectron(devServerUrl) {
  launchElectronForMode(devServerUrl, 'auto');
}

function launchElectronForMode(devServerUrl, dbusMode) {
  if (shutdownRequested) {
    return;
  }

  if (electronProcess && !electronProcess.killed) {
    electronProcess.removeAllListeners();
    electronProcess.kill();
  }

  electronProcess = spawnElectronProcess({
    cwd: projectRoot,
    extraEnv: {
      VITE_DEV_SERVER_URL: devServerUrl,
    },
    dbusMode,
  });
  const startedAt = Date.now();

  electronProcess.on('exit', (code) => {
    const exitedQuickly = Date.now() - startedAt < 2500;

    if (!shutdownRequested && dbusMode === 'auto' && code && exitedQuickly) {
      console.warn('[electron] DBus session wrapper failed, retrying without it');
      launchElectronForMode(devServerUrl, 'off');
      return;
    }

    if (!shutdownRequested && code && code !== 0) {
      console.error(`[electron] exited with code ${code}`);
    }
  });
}

function scheduleElectronRestart(devServerUrl) {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    launchElectron(devServerUrl);
  }, 180);
}

function createArtifactWatchers(devServerUrl) {
  const watchers = [
    watch(resolve(projectRoot, 'dist/main'), () => {
      scheduleElectronRestart(devServerUrl);
    }),
    watch(resolve(projectRoot, 'dist/preload'), () => {
      scheduleElectronRestart(devServerUrl);
    }),
  ];

  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}

async function main() {
  const tscWatcher = spawn(process.execPath, [tscBin, '-p', 'tsconfig.node.json', '--watch', '--preserveWatchOutput'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });

  tscWatcher.on('exit', (code) => {
    if (!shutdownRequested && code && code !== 0) {
      console.error(`[tsc] watcher exited with code ${code}`);
      process.exit(code);
    }
  });

  const viteServer = await createServer({
    configFile: resolve(projectRoot, 'vite.config.ts'),
  });

  await viteServer.listen();
  viteServer.printUrls();

  await waitForArtifacts();

  const devServerUrl = viteServer.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5173';
  launchElectron(devServerUrl);
  const disposeWatchers = createArtifactWatchers(devServerUrl);

  const shutdown = async (exitCode = 0) => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    disposeWatchers();

    if (restartTimer) {
      clearTimeout(restartTimer);
    }

    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill();
    }

    if (!tscWatcher.killed) {
      tscWatcher.kill();
    }

    await viteServer.close();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
}

void main();
