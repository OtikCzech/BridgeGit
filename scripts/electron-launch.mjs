import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';

function resolveBusSocketPath(busAddress) {
  if (!busAddress) {
    return null;
  }

  const match = busAddress.match(/(?:^|,)unix:path=([^,]+)/);
  return match?.[1] ?? null;
}

function pathIsSocket(path) {
  if (!path) {
    return false;
  }

  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

function shouldWrapWithDbus(env) {
  if (process.platform !== 'linux') {
    return false;
  }

  const busSocketPath = resolveBusSocketPath(env.DBUS_SESSION_BUS_ADDRESS ?? '');

  if (busSocketPath) {
    return !pathIsSocket(busSocketPath);
  }

  const runtimeBusPath = env.XDG_RUNTIME_DIR
    ? `${env.XDG_RUNTIME_DIR.replace(/\/+$/, '')}/bus`
    : null;

  if (runtimeBusPath && existsSync(runtimeBusPath)) {
    return false;
  }

  return true;
}

function buildChildEnv(extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
  };
}

function ensureDbusRuntimeDir() {
  const runtimeDir = join(tmpdir(), `bridgegit-dbus-runtime-${process.getuid?.() ?? 'unknown'}`);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  return runtimeDir;
}

export function launchElectron(options = {}) {
  const {
    args = ['.'],
    cwd,
    stdio = 'inherit',
    extraEnv = {},
    dbusMode = 'auto',
  } = options;

  const childEnv = buildChildEnv(extraEnv);
  const needsDbusWrap = dbusMode === 'auto' && shouldWrapWithDbus(childEnv);

  if (needsDbusWrap) {
    delete childEnv.DBUS_SESSION_BUS_ADDRESS;
    childEnv.XDG_RUNTIME_DIR = ensureDbusRuntimeDir();

    if (!childEnv.GSETTINGS_BACKEND) {
      childEnv.GSETTINGS_BACKEND = 'memory';
    }

    return spawn('dbus-run-session', ['--', electronPath, ...args], {
      cwd,
      stdio,
      env: childEnv,
    });
  }

  if (dbusMode === 'off' && shouldWrapWithDbus(childEnv)) {
    delete childEnv.DBUS_SESSION_BUS_ADDRESS;

    if (!childEnv.GSETTINGS_BACKEND) {
      childEnv.GSETTINGS_BACKEND = 'memory';
    }
  }

  return spawn(electronPath, args, {
    cwd,
    stdio,
    env: childEnv,
  });
}
