import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron } from './electron-launch.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function startElectronProcess(dbusMode = 'auto') {
  return launchElectron({
    cwd: projectRoot,
    dbusMode,
  });
}

function attachExitHandler(electronProcess, dbusMode) {
  const startedAt = Date.now();

  electronProcess.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    const exitedQuickly = Date.now() - startedAt < 2500;

    if (dbusMode === 'auto' && code && exitedQuickly) {
      console.warn('[bridgegit] DBus session wrapper failed, retrying Electron directly.');
      attachExitHandler(startElectronProcess('off'), 'off');
      return;
    }

    process.exit(code ?? 0);
  });
}

attachExitHandler(startElectronProcess(), 'auto');
