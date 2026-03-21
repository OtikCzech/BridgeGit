import { ref, type Ref } from 'vue';
import type {
  PtyCreateOptions,
  PtyDataEvent,
  PtyExitEvent,
  PtySessionInfo,
} from '../../shared/bridgegit';

interface TerminalHandlers {
  onData: (payload: PtyDataEvent) => void;
  onExit?: (payload: PtyExitEvent) => void;
}

interface TerminalRuntime {
  sessionInfo: Ref<PtySessionInfo | null>;
  isStarting: Ref<boolean>;
  error: Ref<string | null>;
  exitCode: Ref<number | null>;
  outputBuffer: Ref<string>;
  subscribers: Set<TerminalHandlers>;
  dataUnsubscribe: (() => void) | null;
  exitUnsubscribe: (() => void) | null;
}

const OUTPUT_BUFFER_LIMIT = 512_000;
const terminalRuntimes = new Map<string, TerminalRuntime>();

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Terminal session failed.';
}

function getOrCreateRuntime(runtimeKey: string): TerminalRuntime {
  const existingRuntime = terminalRuntimes.get(runtimeKey);

  if (existingRuntime) {
    return existingRuntime;
  }

  const runtime: TerminalRuntime = {
    sessionInfo: ref<PtySessionInfo | null>(null),
    isStarting: ref(false),
    error: ref<string | null>(null),
    exitCode: ref<number | null>(null),
    outputBuffer: ref(''),
    subscribers: new Set(),
    dataUnsubscribe: null,
    exitUnsubscribe: null,
  };

  terminalRuntimes.set(runtimeKey, runtime);
  return runtime;
}

function cleanupListeners(runtime: TerminalRuntime) {
  runtime.dataUnsubscribe?.();
  runtime.exitUnsubscribe?.();
  runtime.dataUnsubscribe = null;
  runtime.exitUnsubscribe = null;
}

function trimOutputBuffer(runtime: TerminalRuntime) {
  if (runtime.outputBuffer.value.length <= OUTPUT_BUFFER_LIMIT) {
    return;
  }

  runtime.outputBuffer.value = runtime.outputBuffer.value.slice(-OUTPUT_BUFFER_LIMIT);
}

function attachBridgeListeners(runtime: TerminalRuntime) {
  if (runtime.dataUnsubscribe || runtime.exitUnsubscribe || !window.bridgegit?.terminal) {
    return;
  }

  runtime.dataUnsubscribe = window.bridgegit.terminal.onData((payload) => {
    if (payload.ptyId !== runtime.sessionInfo.value?.ptyId) {
      return;
    }

    runtime.outputBuffer.value += payload.data;
    trimOutputBuffer(runtime);
    runtime.subscribers.forEach((handlers) => {
      handlers.onData(payload);
    });
  });

  runtime.exitUnsubscribe = window.bridgegit.terminal.onExit((payload) => {
    if (payload.ptyId !== runtime.sessionInfo.value?.ptyId) {
      return;
    }

    runtime.exitCode.value = payload.exitCode;
    runtime.sessionInfo.value = null;
    runtime.subscribers.forEach((handlers) => {
      handlers.onExit?.(payload);
    });
    cleanupListeners(runtime);
  });
}

export function useTerminal(runtimeKey: string) {
  const runtime = getOrCreateRuntime(runtimeKey);
  let activeHandlers: TerminalHandlers | null = null;

  function attach(handlers: TerminalHandlers) {
    if (activeHandlers) {
      runtime.subscribers.delete(activeHandlers);
    }

    activeHandlers = handlers;
    runtime.subscribers.add(handlers);
    attachBridgeListeners(runtime);
  }

  function detach() {
    if (!activeHandlers) {
      return;
    }

    runtime.subscribers.delete(activeHandlers);
    activeHandlers = null;
  }

  async function start(options: PtyCreateOptions) {
    if (!window.bridgegit?.terminal) {
      runtime.error.value = 'Terminal API is unavailable in the current runtime.';
      return null;
    }

    if (runtime.sessionInfo.value) {
      attachBridgeListeners(runtime);
      return runtime.sessionInfo.value;
    }

    runtime.isStarting.value = true;
    runtime.error.value = null;
    runtime.exitCode.value = null;
    runtime.outputBuffer.value = '';

    try {
      const nextSession = await window.bridgegit.terminal.create(options);
      runtime.sessionInfo.value = nextSession;
      attachBridgeListeners(runtime);
      return nextSession;
    } catch (nextError) {
      cleanupListeners(runtime);
      runtime.error.value = toErrorMessage(nextError);
      return null;
    } finally {
      runtime.isStarting.value = false;
    }
  }

  async function restart(options: PtyCreateOptions) {
    kill();
    return start(options);
  }

  function write(data: string) {
    if (!runtime.sessionInfo.value || !window.bridgegit?.terminal) {
      return;
    }

    window.bridgegit.terminal.write(runtime.sessionInfo.value.ptyId, data);
  }

  function resize(cols: number, rows: number) {
    if (!runtime.sessionInfo.value || !window.bridgegit?.terminal) {
      return;
    }

    window.bridgegit.terminal.resize(runtime.sessionInfo.value.ptyId, cols, rows);
  }

  function kill() {
    if (!runtime.sessionInfo.value || !window.bridgegit?.terminal) {
      cleanupListeners(runtime);
      return;
    }

    window.bridgegit.terminal.kill(runtime.sessionInfo.value.ptyId);
    runtime.sessionInfo.value = null;
    runtime.exitCode.value = null;
    runtime.outputBuffer.value = '';
    cleanupListeners(runtime);
  }

  function dispose() {
    detach();
  }

  return {
    sessionInfo: runtime.sessionInfo,
    isStarting: runtime.isStarting,
    error: runtime.error,
    exitCode: runtime.exitCode,
    outputBuffer: runtime.outputBuffer,
    attach,
    detach,
    start,
    restart,
    write,
    resize,
    kill,
    dispose,
  };
}
