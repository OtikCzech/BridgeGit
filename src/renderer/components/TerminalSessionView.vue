<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TerminalCommandPreset } from '../../shared/bridgegit';
import { SHORTCUTS, matchesCommandSlotShortcut, matchesShortcut } from '../shortcuts';
import { useTerminal } from '../composables/useTerminal';

interface Props {
  cwd: string;
  active: boolean;
  reconnectToken?: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  activity: [];
  input: [data: string];
}>();

const terminalRoot = ref<HTMLElement | null>(null);
const copyToast = ref<string | null>(null);
const { sessionInfo, isStarting, error, exitCode, start, restart, write, resize, dispose } =
  useTerminal();
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const MIN_TERMINAL_FONT_SIZE = 11;
const MAX_TERMINAL_FONT_SIZE = 22;
const OUTPUT_BUFFER_LIMIT = 12000;
const DEFAULT_PROMPT_TIMEOUT_MS = 20_000;
const terminalFontSize = ref(DEFAULT_TERMINAL_FONT_SIZE);

interface PromptWaiter {
  pattern: RegExp;
  startOffset: number;
  timeoutId: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let copySelectionTimer: number | null = null;
let copyToastTimer: number | null = null;
let lastCopiedSelection: string | null = null;
let plainTextBuffer = '';
let plainTextBufferOffset = 0;
let activePresetExecutionId = 0;
let nextPresetExecutionId = 1;
const promptWaiters = new Set<PromptWaiter>();
const terminalWheelListenerOptions = {
  passive: false,
  capture: true,
} as const;
const blockedTerminalShortcuts = [
  SHORTCUTS.historyOpen,
  SHORTCUTS.historySearch,
  SHORTCUTS.panelRepoToggle,
  SHORTCUTS.panelDiffToggle,
  SHORTCUTS.panelTerminalToggle,
  SHORTCUTS.workspaceNewTabMenu,
  SHORTCUTS.diffPrevious,
  SHORTCUTS.diffNext,
  SHORTCUTS.diffStageAndContinue,
  SHORTCUTS.terminalCloseTab,
  SHORTCUTS.terminalPreviousTab,
  SHORTCUTS.terminalNextTab,
];

function focusTerminal() {
  if (props.active) {
    terminal?.focus();
  }
}

function sleep(delayMs: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function getAbsoluteOutputOffset() {
  return plainTextBufferOffset + plainTextBuffer.length;
}

function stripTerminalSequences(value: string) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '');
}

function resetOutputTracking() {
  plainTextBuffer = '';
  plainTextBufferOffset = 0;
}

function getOutputSince(startOffset: number) {
  const relativeOffset = Math.max(0, startOffset - plainTextBufferOffset);
  return plainTextBuffer.slice(relativeOffset);
}

function getCurrentOutputLine() {
  const lastNewlineIndex = plainTextBuffer.lastIndexOf('\n');
  return lastNewlineIndex === -1 ? plainTextBuffer : plainTextBuffer.slice(lastNewlineIndex + 1);
}

function appendOutputToBuffer(data: string) {
  const normalizedData = stripTerminalSequences(data);

  if (!normalizedData) {
    return;
  }

  plainTextBuffer += normalizedData;

  if (plainTextBuffer.length > OUTPUT_BUFFER_LIMIT) {
    const removedLength = plainTextBuffer.length - OUTPUT_BUFFER_LIMIT;
    plainTextBuffer = plainTextBuffer.slice(removedLength);
    plainTextBufferOffset += removedLength;
  }

  flushPromptWaiters();
}

function sendInput(data: string) {
  emit('input', data);
  write(data);
}

function rejectPromptWaiters(message: string) {
  promptWaiters.forEach((waiter) => {
    window.clearTimeout(waiter.timeoutId);
    waiter.reject(new Error(message));
  });
  promptWaiters.clear();
}

function flushPromptWaiters() {
  promptWaiters.forEach((waiter) => {
    if (!waiter.pattern.test(getOutputSince(waiter.startOffset))) {
      return;
    }

    window.clearTimeout(waiter.timeoutId);
    promptWaiters.delete(waiter);
    waiter.resolve();
  });
}

function isCommandSlotShortcut(event: KeyboardEvent) {
  for (let slot = 1; slot <= 9; slot += 1) {
    if (matchesCommandSlotShortcut(event, slot)) {
      return true;
    }
  }

  return false;
}

function fitTerminal() {
  if (!terminal || !fitAddon) {
    return;
  }

  fitAddon.fit();

  if (terminal.cols > 0 && terminal.rows > 0) {
    resize(terminal.cols, terminal.rows);
  }
}

function applyTerminalFontSize(nextFontSize: number) {
  if (!terminal) {
    return;
  }

  const clampedFontSize = Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, nextFontSize));

  if (clampedFontSize === terminalFontSize.value) {
    return;
  }

  terminalFontSize.value = clampedFontSize;
  terminal.options.fontSize = clampedFontSize;
  fitTerminal();
}

function writeStatusLine(message: string) {
  terminal?.writeln(`\r\n${message}\r\n`);
}

function showCopyToast(message: string) {
  copyToast.value = message;

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
  }

  copyToastTimer = window.setTimeout(() => {
    copyToast.value = null;
  }, 1800);
}

async function writeClipboard(text: string) {
  try {
    if (window.bridgegit?.clipboard) {
      await Promise.resolve(window.bridgegit.clipboard.writeText(text));
      return;
    }
  } catch {
    // Fall back to the browser clipboard API when the Electron bridge is unavailable.
  }

  await navigator.clipboard.writeText(text);
}

async function readClipboardText() {
  try {
    if (window.bridgegit?.clipboard) {
      return await Promise.resolve(window.bridgegit.clipboard.readText());
    }
  } catch {
    // Fall back to the browser clipboard API when the Electron bridge is unavailable.
  }

  return navigator.clipboard.readText();
}

async function pasteTextFromClipboard(text?: string) {
  const resolvedText = (text ?? await readClipboardText()).replace(/\r\n/g, '\n');

  if (!resolvedText) {
    return;
  }

  sendInput(resolvedText);
  terminal?.focus();
}

function scheduleSelectionCopy() {
  if (!terminal) {
    return;
  }

  if (!terminal.hasSelection()) {
    lastCopiedSelection = null;

    if (copySelectionTimer) {
      window.clearTimeout(copySelectionTimer);
      copySelectionTimer = null;
    }

    return;
  }

  if (copySelectionTimer) {
    window.clearTimeout(copySelectionTimer);
  }

  copySelectionTimer = window.setTimeout(async () => {
    const selection = terminal?.getSelection() ?? '';

    if (!selection || selection === lastCopiedSelection) {
      return;
    }

    try {
      await writeClipboard(selection);
      lastCopiedSelection = selection;
      showCopyToast('Copied');
    } catch {
      showCopyToast('Copy failed');
    }
  }, 90);
}

function handleWheelZoom(event: WheelEvent) {
  if (!event.ctrlKey) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const deltaZoomStep = event.deltaY === 0
    ? 0
    : (event.deltaY < 0 ? 1 : -1);
  const legacyWheelDelta = Number(
    (
      event as WheelEvent & {
        wheelDelta?: number;
        wheelDeltaY?: number;
      }
    ).wheelDeltaY
      ?? (
        event as WheelEvent & {
          wheelDelta?: number;
        }
      ).wheelDelta
      ?? 0,
  );
  const legacyZoomStep = legacyWheelDelta === 0 ? 0 : Math.sign(legacyWheelDelta);
  const zoomStep = deltaZoomStep || legacyZoomStep;

  if (zoomStep === 0) {
    return;
  }

  applyTerminalFontSize(terminalFontSize.value + zoomStep);
}

function isPasteShortcut(event: KeyboardEvent) {
  return event.type === 'keydown'
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && event.key.toLowerCase() === 'v';
}

function isSoftLineBreakShortcut(event: KeyboardEvent) {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Enter';
}

function handleTerminalPaste(event: ClipboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  void pasteTextFromClipboard(event.clipboardData?.getData('text/plain') ?? '');
}

function handleContextMenuPaste(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  void pasteTextFromClipboard();
}

function handleTerminalKeydown(event: KeyboardEvent) {
  if (!isSoftLineBreakShortcut(event)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  sendInput('\n');
  terminal?.focus();
}

async function waitForPrompt(
  pattern: string,
  startOffset: number,
  options: {
    allowCurrentPrompt?: boolean;
  } = {},
) {
  let promptPattern: RegExp;

  try {
    promptPattern = new RegExp(pattern, 'm');
  } catch {
    throw new Error(`Invalid prompt pattern: ${pattern}`);
  }

  if (options.allowCurrentPrompt && promptPattern.test(getCurrentOutputLine())) {
    return;
  }

  if (promptPattern.test(getOutputSince(startOffset))) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      promptWaiters.delete(waiter);
      reject(new Error(`Prompt wait timed out after ${DEFAULT_PROMPT_TIMEOUT_MS} ms.`));
    }, DEFAULT_PROMPT_TIMEOUT_MS);

    const waiter: PromptWaiter = {
      pattern: promptPattern,
      startOffset,
      timeoutId,
      resolve: () => resolve(),
      reject,
    };

    promptWaiters.add(waiter);
  });
}

async function ensureSessionReady() {
  if (sessionInfo.value) {
    return true;
  }

  if (!terminal) {
    return false;
  }

  if (!isStarting.value) {
    await connectTerminal(error.value || exitCode.value !== null ? 'restart' : 'start');
  }

  const startedAt = Date.now();

  while (!sessionInfo.value) {
    if (Date.now() - startedAt >= DEFAULT_PROMPT_TIMEOUT_MS) {
      return false;
    }

    await sleep(40);
  }

  return true;
}

async function runPreset(preset: TerminalCommandPreset) {
  if (!preset.steps.length) {
    return false;
  }

  if (activePresetExecutionId) {
    writeStatusLine(`[preset busy: ${preset.name}]`);
    return false;
  }

  const hasSession = await ensureSessionReady();

  if (!hasSession) {
    writeStatusLine(`[preset failed: could not start shell for ${preset.name}]`);
    return false;
  }

  const executionId = nextPresetExecutionId++;
  activePresetExecutionId = executionId;
  let pendingPromptStartOffset: number | null = null;

  try {
    for (const [stepIndex, step] of preset.steps.entries()) {
      if (activePresetExecutionId !== executionId) {
        throw new Error('Preset execution was interrupted.');
      }

      if (step.type === 'delay') {
        await sleep(step.delayMs);
        continue;
      }

      if (step.type === 'wait-for-prompt') {
        await waitForPrompt(
          step.pattern,
          pendingPromptStartOffset ?? getAbsoluteOutputOffset(),
          {
            allowCurrentPrompt: pendingPromptStartOffset === null,
          },
        );
        pendingPromptStartOffset = null;
        continue;
      }

      const payload = step.value.replace(/\r\n/g, '\n');
      const outputOffsetBeforeWrite = getAbsoluteOutputOffset();

      if (payload) {
        sendInput(payload);
      }

      if (step.submit) {
        pendingPromptStartOffset = outputOffsetBeforeWrite;
        sendInput('\r');
      }
    }

    focusTerminal();
    return true;
  } catch (nextError) {
    writeStatusLine(`[preset failed: ${nextError instanceof Error ? nextError.message : preset.name}]`);
    focusTerminal();
    return false;
  } finally {
    if (activePresetExecutionId === executionId) {
      activePresetExecutionId = 0;
    }
  }
}

async function connectTerminal(mode: 'start' | 'restart' = 'start') {
  if (!terminal) {
    return;
  }

  const options = {
    cwd: props.cwd,
    cols: terminal.cols || 120,
    rows: terminal.rows || 32,
  };

  if (mode === 'restart') {
    rejectPromptWaiters('Terminal session restarted.');
    terminal.reset();
    resetOutputTracking();
  }

  const runner = mode === 'restart' ? restart : start;
  const session = await runner(options, {
    onData: ({ data }) => {
      appendOutputToBuffer(data);
      terminal?.write(data);
      emit('activity');
    },
    onExit: ({ exitCode: code }) => {
      rejectPromptWaiters(`Terminal session exited with code ${code}.`);
      writeStatusLine(`[process exited with code ${code}]`);
    },
  });

  if (session) {
    await nextTick();
    fitTerminal();
    focusTerminal();
  }
}

defineExpose({
  reconnect: () => connectTerminal('restart'),
  runPreset,
});

function initializeTerminal() {
  if (!terminalRoot.value) {
    return;
  }

  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'JetBrains Mono, Cascadia Code, monospace',
    fontSize: terminalFontSize.value,
    lineHeight: 1.35,
    scrollback: 5000,
    theme: {
      background: '#04070b',
      foreground: '#dde4ec',
      cursor: '#69b2ff',
      cursorAccent: '#04070b',
      selectionBackground: 'rgba(105, 178, 255, 0.24)',
      black: '#0b0f14',
      red: '#d16969',
      green: '#4f9b67',
      yellow: '#d7ba7d',
      blue: '#69b2ff',
      magenta: '#c586c0',
      cyan: '#78c0ff',
      white: '#d4d4d4',
      brightBlack: '#6e7681',
      brightRed: '#f48771',
      brightGreen: '#8fdbab',
      brightYellow: '#f2cc8f',
      brightBlue: '#9dcfff',
      brightMagenta: '#d8a5ff',
      brightCyan: '#b5d8ff',
      brightWhite: '#f5f7fa',
    },
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.attachCustomKeyEventHandler((event) => {
    if (isPasteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      void pasteTextFromClipboard();
      return false;
    }

    if (isCommandSlotShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    if (blockedTerminalShortcuts.some((shortcut) => matchesShortcut(event, shortcut))) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    return true;
  });
  terminal.open(terminalRoot.value);

  terminal.onData((data) => {
    sendInput(data);
  });

  terminal.onResize(({ cols, rows }) => {
    resize(cols, rows);
  });

  terminal.onSelectionChange(() => {
    scheduleSelectionCopy();
  });

  resizeObserver = new ResizeObserver(() => {
    fitTerminal();
  });

  resizeObserver.observe(terminalRoot.value);
  terminalRoot.value.addEventListener('pointerup', scheduleSelectionCopy);
  terminalRoot.value.addEventListener('keyup', scheduleSelectionCopy);
  terminalRoot.value.addEventListener('keydown', handleTerminalKeydown, true);
  terminalRoot.value.addEventListener('wheel', handleWheelZoom, terminalWheelListenerOptions);
  terminalRoot.value.addEventListener('paste', handleTerminalPaste);
  terminalRoot.value.addEventListener('contextmenu', handleContextMenuPaste);
}

onMounted(async () => {
  initializeTerminal();
  await connectTerminal();
});

watch(
  () => props.cwd,
  async (nextCwd, previousCwd) => {
    if (!terminal || !nextCwd || nextCwd === previousCwd) {
      return;
    }

    await connectTerminal('restart');
  },
);

watch(
  () => props.active,
  async (isActive) => {
    if (!isActive) {
      return;
    }

    await nextTick();
    fitTerminal();
    focusTerminal();
  },
);

watch(
  () => props.reconnectToken,
  async (nextToken, previousToken) => {
    if (!terminal || !nextToken || nextToken === previousToken) {
      return;
    }

    await connectTerminal('restart');
  },
);

onBeforeUnmount(() => {
  if (copySelectionTimer) {
    window.clearTimeout(copySelectionTimer);
  }

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
  }

  terminalRoot.value?.removeEventListener('pointerup', scheduleSelectionCopy);
  terminalRoot.value?.removeEventListener('keyup', scheduleSelectionCopy);
  terminalRoot.value?.removeEventListener('keydown', handleTerminalKeydown, true);
  terminalRoot.value?.removeEventListener('wheel', handleWheelZoom, terminalWheelListenerOptions);
  terminalRoot.value?.removeEventListener('paste', handleTerminalPaste);
  terminalRoot.value?.removeEventListener('contextmenu', handleContextMenuPaste);
  resizeObserver?.disconnect();
  rejectPromptWaiters('Terminal session closed.');
  dispose();
  terminal?.dispose();
});
</script>

<template>
  <section class="terminal-session">
    <div v-if="error" class="terminal-session__notice terminal-session__notice--error">
      {{ error }}
    </div>

    <div v-else-if="exitCode !== null" class="terminal-session__notice terminal-session__notice--info">
      Process exited with code {{ exitCode }}.
    </div>

    <div class="terminal-session__viewport">
      <div ref="terminalRoot" class="terminal-session__screen" />

      <transition name="terminal-session-toast">
        <div v-if="copyToast" class="terminal-session__toast">
          {{ copyToast }}
        </div>
      </transition>
    </div>
  </section>
</template>

<style scoped lang="scss">
.terminal-session {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 7px;
}

.terminal-session__notice {
  margin: 0;
  padding: 0.8rem 0.9rem;
  border-radius: 14px;
  font-size: 0.82rem;
}

.terminal-session__notice--error {
  border: 1px solid rgba(188, 87, 87, 0.28);
  background: rgba(188, 87, 87, 0.1);
  color: #ffb3ad;
}

.terminal-session__notice--info {
  border: 1px solid rgba(110, 197, 255, 0.18);
  background: rgba(110, 197, 255, 0.08);
  color: var(--text-muted);
}

.terminal-session__viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

.terminal-session__screen {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  border-top: 1px solid rgba(108, 124, 148, 0.12);
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  border-radius: 0;
  background:
    radial-gradient(circle at top right, rgba(110, 197, 255, 0.12), transparent 30%),
    rgba(4, 7, 11, 0.95);
}

.terminal-session__toast {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 3;
  padding: 0.42rem 0.72rem;
  border: 1px solid rgba(110, 197, 255, 0.26);
  border-radius: 10px;
  background: rgba(8, 12, 17, 0.98);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  color: #f2f8ff;
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  pointer-events: none;
}

.terminal-session-toast-enter-active,
.terminal-session-toast-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.terminal-session-toast-enter-from,
.terminal-session-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
