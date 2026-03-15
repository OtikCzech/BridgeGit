import { ref } from 'vue';
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Terminal session failed.';
}

export function useTerminal() {
  const sessionInfo = ref<PtySessionInfo | null>(null);
  const isStarting = ref(false);
  const error = ref<string | null>(null);
  const exitCode = ref<number | null>(null);

  let dataUnsubscribe: (() => void) | null = null;
  let exitUnsubscribe: (() => void) | null = null;

  function cleanupListeners() {
    dataUnsubscribe?.();
    exitUnsubscribe?.();
    dataUnsubscribe = null;
    exitUnsubscribe = null;
  }

  function attachListeners(handlers: TerminalHandlers) {
    cleanupListeners();

    dataUnsubscribe =
      window.bridgegit?.terminal.onData((payload) => {
        if (payload.ptyId !== sessionInfo.value?.ptyId) {
          return;
        }

        handlers.onData(payload);
      }) ?? null;

    exitUnsubscribe =
      window.bridgegit?.terminal.onExit((payload) => {
        if (payload.ptyId !== sessionInfo.value?.ptyId) {
          return;
        }

        exitCode.value = payload.exitCode;
        sessionInfo.value = null;
        handlers.onExit?.(payload);
      }) ?? null;
  }

  async function start(options: PtyCreateOptions, handlers: TerminalHandlers) {
    if (!window.bridgegit?.terminal) {
      error.value = 'Terminal API is unavailable in the current runtime.';
      return null;
    }

    isStarting.value = true;
    error.value = null;
    exitCode.value = null;

    try {
      attachListeners(handlers);
      const nextSession = await window.bridgegit.terminal.create(options);
      sessionInfo.value = nextSession;
      return nextSession;
    } catch (nextError) {
      cleanupListeners();
      error.value = toErrorMessage(nextError);
      return null;
    } finally {
      isStarting.value = false;
    }
  }

  async function restart(options: PtyCreateOptions, handlers: TerminalHandlers) {
    kill();
    return start(options, handlers);
  }

  function write(data: string) {
    if (!sessionInfo.value || !window.bridgegit?.terminal) {
      return;
    }

    window.bridgegit.terminal.write(sessionInfo.value.ptyId, data);
  }

  function resize(cols: number, rows: number) {
    if (!sessionInfo.value || !window.bridgegit?.terminal) {
      return;
    }

    window.bridgegit.terminal.resize(sessionInfo.value.ptyId, cols, rows);
  }

  function kill() {
    if (!sessionInfo.value || !window.bridgegit?.terminal) {
      cleanupListeners();
      return;
    }

    window.bridgegit.terminal.kill(sessionInfo.value.ptyId);
    sessionInfo.value = null;
    cleanupListeners();
  }

  function dispose() {
    kill();
    cleanupListeners();
  }

  return {
    sessionInfo,
    isStarting,
    error,
    exitCode,
    start,
    restart,
    write,
    resize,
    kill,
    dispose,
  };
}
