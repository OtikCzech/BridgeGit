import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';

const NOISY_DBUS_PATTERNS = [
  /^dbus-daemon\[\d+\]: .*org\.a11y\.Bus.*$/,
  /^dbus-daemon\[\d+\]: Failed to start message bus: .*$/,
  /^dbus-run-session: .*$/,
];

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
  const childEnv = {
    ...process.env,
    ...extraEnv,
  };

  // Avoid AT-SPI bridge activation noise during local Linux Electron launches.
  if (process.platform === 'linux' && childEnv.NO_AT_BRIDGE == null) {
    childEnv.NO_AT_BRIDGE = '1';
  }

  return childEnv;
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
    quietDbusLogs = true,
  } = options;

  const childEnv = buildChildEnv(extraEnv);
  const needsDbusWrap = dbusMode === 'auto' && shouldWrapWithDbus(childEnv);

  if (needsDbusWrap) {
    delete childEnv.DBUS_SESSION_BUS_ADDRESS;
    childEnv.XDG_RUNTIME_DIR = ensureDbusRuntimeDir();

    if (!childEnv.GSETTINGS_BACKEND) {
      childEnv.GSETTINGS_BACKEND = 'memory';
    }

    const childProcess = spawn('dbus-run-session', ['--', electronPath, ...args], {
      cwd,
      stdio: quietDbusLogs && stdio === 'inherit' ? ['inherit', 'pipe', 'pipe'] : stdio,
      env: childEnv,
    });

    attachFilteredOutput(childProcess, quietDbusLogs && stdio === 'inherit');
    return childProcess;
  }

  if (dbusMode === 'off' && shouldWrapWithDbus(childEnv)) {
    delete childEnv.DBUS_SESSION_BUS_ADDRESS;

    if (!childEnv.GSETTINGS_BACKEND) {
      childEnv.GSETTINGS_BACKEND = 'memory';
    }
  }

  const childProcess = spawn(electronPath, args, {
    cwd,
    stdio: quietDbusLogs && stdio === 'inherit' ? ['inherit', 'pipe', 'pipe'] : stdio,
    env: childEnv,
  });
  attachFilteredOutput(childProcess, quietDbusLogs && stdio === 'inherit');
  return childProcess;
}

function shouldSuppressOutputLine(line) {
  return NOISY_DBUS_PATTERNS.some((pattern) => pattern.test(line.trim()));
}

function relayStream(source, target) {
  if (!source) {
    return;
  }

  let pending = '';
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';

    for (const line of lines) {
      if (!shouldSuppressOutputLine(line)) {
        target.write(`${line}\n`);
      }
    }
  });
  source.on('end', () => {
    if (pending && !shouldSuppressOutputLine(pending)) {
      target.write(pending);
    }
  });
}

function attachFilteredOutput(childProcess, enabled) {
  if (!enabled) {
    return;
  }

  relayStream(childProcess.stdout, process.stdout);
  relayStream(childProcess.stderr, process.stderr);
}
