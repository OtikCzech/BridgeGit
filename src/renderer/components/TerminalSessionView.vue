<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  normalizeShellFontSize,
  type AppAppearance,
  type AppLanguage,
  type CodeNavigationTarget,
  type NoteFileHandle,
  type TerminalCommandPreset,
  type ThemeVariant,
  type SupportedWorkspaceFileTabType,
} from '../../shared/bridgegit';
import {
  buildTerminalNavigationTargets,
  inferTerminalHomePath,
  TERMINAL_FILE_LINK_PATTERN,
} from '../../shared/terminalFileLinks';
import {
  readClipboardText as readSharedClipboardText,
  rememberClipboardText,
  writeClipboardText as writeSharedClipboardText,
} from '../clipboard';
import { useClipboardHistoryTarget } from '../composables/useClipboardHistoryTarget';
import CopyableErrorNotice from './CopyableErrorNotice.vue';
import { t } from '../i18n';
import { SHORTCUTS, matchesCommandSlotShortcut, matchesShortcut } from '../shortcuts';
import { useTerminal } from '../composables/useTerminal';

interface Props {
  sessionKey: string;
  cwd: string;
  shell?: string | null;
  projectRoot?: string | null;
  appLanguage: AppLanguage;
  fontSize: number;
  appearanceTheme: AppAppearance;
  appearanceThemeVariant: ThemeVariant;
  rightClickPasteEnabled: boolean;
  selectionAutoCopyEnabled: boolean;
  active: boolean;
  reconnectToken?: number;
}

interface TerminalNavigationTarget extends CodeNavigationTarget {
  openedFile?: NoteFileHandle;
  preferredType?: SupportedWorkspaceFileTabType;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  activity: [];
  attention: [];
  activate: [];
  exit: [exitCode: number];
  input: [data: string];
  'open-navigation-target': [target: TerminalNavigationTarget];
  'update:font-size': [fontSize: number];
}>();

const terminalRoot = ref<HTMLElement | null>(null);
const toastMessage = ref<string | null>(null);
const {
  sessionInfo,
  isStarting,
  error,
  exitCode,
  outputBuffer,
  attach,
  start,
  restart,
  write,
  resize,
  dispose,
} = useTerminal(props.sessionKey);
const OUTPUT_BUFFER_LIMIT = 12000;
const DEFAULT_PROMPT_TIMEOUT_MS = 20_000;
const RIGHT_CLICK_PASTE_DUPLICATE_WINDOW_MS = 700;
const terminalFontSize = ref(normalizeShellFontSize(props.fontSize));
const tt = (key: string, params?: Record<string, string | number>) => t(props.appLanguage, key, params);

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
let terminalFileLinkProviderDisposable: { dispose(): void } | null = null;
let copySelectionTimer: number | null = null;
let toastTimer: number | null = null;
let lastCopiedSelection: string | null = null;
let selectionPointerActive = false;
let selectionCopyPendingAfterPointer = false;
let copyInterruptGuardActive = false;
let suppressActivityUntilInput = true;
let plainTextBuffer = '';
let plainTextBufferOffset = 0;
let activePresetExecutionId = 0;
let nextPresetExecutionId = 1;
let lastChoicePromptOffset = -1;
let lastSentInput = {
  data: '',
  at: 0,
};
let lastRightClickPasteInput = {
  data: '',
  at: 0,
};
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
function getTerminalTheme(theme: AppAppearance) {
  if (theme === 'bridgegit-light') {
    return {
      background: '#f7fbff',
      foreground: '#1d2a38',
      cursor: '#2d7cd8',
      cursorAccent: '#f7fbff',
      selectionBackground: 'rgba(45, 124, 216, 0.2)',
      black: '#1f2935',
      red: '#b87373',
      green: '#5d8768',
      yellow: '#b98938',
      blue: '#2d7cd8',
      magenta: '#a25bc0',
      cyan: '#2f8ea0',
      white: '#d8e2ea',
      brightBlack: '#7b8a99',
      brightRed: '#cf8a83',
      brightGreen: '#7fa88a',
      brightYellow: '#d7ae63',
      brightBlue: '#5ba2f5',
      brightMagenta: '#c78de1',
      brightCyan: '#69b5c2',
      brightWhite: '#ffffff',
    };
  }

  if (theme === 'github-dark') {
    return {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      cursorAccent: '#0d1117',
      selectionBackground: 'rgba(56, 139, 253, 0.26)',
      black: '#161b22',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    };
  }

  if (theme === 'github-light') {
    return {
      background: '#ffffff',
      foreground: '#24292f',
      cursor: '#0969da',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(9, 105, 218, 0.2)',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#9a6700',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#d0d7de',
      brightBlack: '#6e7781',
      brightRed: '#ff8182',
      brightGreen: '#2da44e',
      brightYellow: '#bf8700',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#f6f8fa',
    };
  }

  if (theme === 'nord') {
    return {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(129, 161, 193, 0.24)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#d08770',
      brightGreen: '#b8d6a5',
      brightYellow: '#f0d49a',
      brightBlue: '#8fbcbb',
      brightMagenta: '#c895bf',
      brightCyan: '#93ccdc',
      brightWhite: '#eceff4',
    };
  }

  return {
    background: '#04070b',
    foreground: '#dde4ec',
    cursor: '#69b2ff',
    cursorAccent: '#04070b',
    selectionBackground: 'rgba(105, 178, 255, 0.24)',
    black: '#0b0f14',
    red: '#bd7c7c',
    green: '#6f9878',
    yellow: '#d7ba7d',
    blue: '#69b2ff',
    magenta: '#c586c0',
    cyan: '#78c0ff',
    white: '#d4d4d4',
    brightBlack: '#6e7681',
    brightRed: '#d69886',
    brightGreen: '#8db296',
    brightYellow: '#f2cc8f',
    brightBlue: '#9dcfff',
    brightMagenta: '#d8a5ff',
    brightCyan: '#b5d8ff',
    brightWhite: '#f5f7fa',
  };
}

function getTerminalNavigationTargets(rawLinkText: string) {
  return buildTerminalNavigationTargets(rawLinkText, {
    cwd: props.cwd,
    projectRoot: props.projectRoot,
    homePath: inferTerminalHomePath([props.cwd, props.projectRoot]),
  });
}

function parseTerminalNavigationTarget(rawLinkText: string): CodeNavigationTarget | null {
  const targets = getTerminalNavigationTargets(rawLinkText);
  return targets[0] ?? null;
}

async function activateTerminalFileLink(rawLinkText: string) {
  const targets = getTerminalNavigationTargets(rawLinkText);

  if (!targets.length || !window.bridgegit?.notes) {
    showToast(tt('terminal.link.noFileTarget'));
    return;
  }

  try {
    for (const target of targets) {
      const resolvedTarget = await window.bridgegit.notes.resolveOpenTarget(target.filePath);

      if (!resolvedTarget) {
        continue;
      }

      showToast(tt('terminal.link.openingFile', { path: resolvedTarget.file.path }));
      emit('open-navigation-target', {
        ...target,
        filePath: resolvedTarget.file.path,
        openedFile: resolvedTarget.file,
        preferredType: resolvedTarget.tabType,
      });
      return;
    }

    showToast(tt('terminal.link.fileNotFound', { path: targets[0]?.filePath ?? rawLinkText }));
  } catch {
    showToast(tt('terminal.link.openFileLinkFailed'));
  }
}

function registerTerminalFileLinkProvider() {
  if (!terminal) {
    return;
  }

  terminalFileLinkProviderDisposable?.dispose();
  const terminalInstance = terminal;

  const linkProvider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = terminalInstance.buffer.active.getLine(bufferLineNumber - 1);
      const lineText = line?.translateToString(false) ?? '';

      if (!lineText) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      let match: RegExpExecArray | null;
      const matcher = new RegExp(TERMINAL_FILE_LINK_PATTERN.source, TERMINAL_FILE_LINK_PATTERN.flags);

      while ((match = matcher.exec(lineText)) !== null) {
        const linkText = match[0] ?? '';
        const target = parseTerminalNavigationTarget(linkText);

        if (!target || match.index === undefined) {
          continue;
        }

        links.push({
          text: linkText,
          range: {
            start: {
              x: match.index + 1,
              y: bufferLineNumber,
            },
            end: {
              x: match.index + linkText.length,
              y: bufferLineNumber,
            },
          },
          activate: () => {
            void activateTerminalFileLink(linkText);
          },
        });
      }

      callback(links.length ? links : undefined);
    },
  };

  terminalFileLinkProviderDisposable = terminal.registerLinkProvider(linkProvider);
}

function openTerminalWebLink(_event: MouseEvent, uri: string) {
  void window.bridgegit?.system.openExternalUrl(uri).catch(() => {
    showToast(tt('terminal.link.openBrowserLinkFailed'));
  });
}

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
  lastChoicePromptOffset = -1;
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

function detectChoicePromptOffset() {
  const absoluteEndOffset = getAbsoluteOutputOffset();
  const windowStartOffset = Math.max(plainTextBufferOffset, absoluteEndOffset - 1600);
  const recentOutput = getOutputSince(windowStartOffset);

  if (!recentOutput) {
    return null;
  }

  const patterns = [
    /request_user_input[\s\S]{0,1200}(?:questions|options)/gi,
    /(?:^|\n)[^\n?]{0,180}\?[\s\S]{0,800}\(Recommended\)/gi,
    /(?:choose|select|pick|question|options?)[:\s\S]{0,800}\(Recommended\)/gi,
  ];

  let newestMatchOffset: number | null = null;

  patterns.forEach((pattern) => {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(recentOutput)) !== null) {
      if (match.index === undefined) {
        continue;
      }

      const absoluteMatchOffset = windowStartOffset + match.index;
      if (newestMatchOffset === null || absoluteMatchOffset > newestMatchOffset) {
        newestMatchOffset = absoluteMatchOffset;
      }
    }
  });

  return newestMatchOffset;
}

function emitAttentionForChoicePrompt() {
  const choicePromptOffset = detectChoicePromptOffset();

  if (choicePromptOffset === null || choicePromptOffset <= lastChoicePromptOffset) {
    return;
  }

  lastChoicePromptOffset = choicePromptOffset;
  emit('attention');
}

function sendInput(
  data: string,
  options: {
    markRightClickPaste?: boolean;
    skipRecentRightClickPasteDuplicate?: boolean;
  } = {},
) {
  if (
    options.skipRecentRightClickPasteDuplicate
    && data === lastRightClickPasteInput.data
    && Date.now() - lastRightClickPasteInput.at <= RIGHT_CLICK_PASTE_DUPLICATE_WINDOW_MS
  ) {
    lastRightClickPasteInput = {
      data: '',
      at: 0,
    };
    terminal?.focus();
    return;
  }

  suppressActivityUntilInput = false;
  lastChoicePromptOffset = getAbsoluteOutputOffset();
  lastSentInput = {
    data,
    at: Date.now(),
  };
  if (options.markRightClickPaste) {
    lastRightClickPasteInput = {
      data,
      at: lastSentInput.at,
    };
  }
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

  const clampedFontSize = normalizeShellFontSize(nextFontSize);

  if (clampedFontSize === terminalFontSize.value) {
    return;
  }

  terminalFontSize.value = clampedFontSize;
  terminal.options.fontSize = clampedFontSize;
  emit('update:font-size', clampedFontSize);
  fitTerminal();
}

function writeStatusLine(message: string) {
  terminal?.writeln(`\r\n${message}\r\n`);
}

function showToast(message: string) {
  toastMessage.value = message;

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    toastMessage.value = null;
  }, 1800);
}

async function writeClipboard(text: string) {
  await writeSharedClipboardText(text);
}

async function pasteTextFromClipboard(
  eventText?: string | null,
  options: {
    forceSystemRead?: boolean;
    markRightClickPaste?: boolean;
    skipRecentDuplicate?: boolean;
  } = {},
) {
  const resolvedText = await readSharedClipboardText({
    eventText,
    forceSystemRead: options.forceSystemRead,
  });

  if (!resolvedText) {
    return;
  }

  if (
    options.skipRecentDuplicate
    && resolvedText === lastSentInput.data
    && Date.now() - lastSentInput.at <= RIGHT_CLICK_PASTE_DUPLICATE_WINDOW_MS
  ) {
    terminal?.focus();
    return;
  }

  sendInput(resolvedText, {
    markRightClickPaste: options.markRightClickPaste,
  });
  terminal?.focus();
}

function normalizeCopiedTerminalSelection(value: string) {
  return value.replace(/[ \t]+(?=\r?\n|$)/g, '');
}

function scheduleSelectionCopy() {
  if (!props.selectionAutoCopyEnabled) {
    lastCopiedSelection = null;
    selectionCopyPendingAfterPointer = false;

    if (copySelectionTimer) {
      window.clearTimeout(copySelectionTimer);
      copySelectionTimer = null;
    }

    return;
  }

  if (selectionPointerActive) {
    selectionCopyPendingAfterPointer = true;
    return;
  }

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
    const selection = normalizeCopiedTerminalSelection(terminal?.getSelection() ?? '');

    if (!selection || selection === lastCopiedSelection) {
      return;
    }

    try {
      await writeClipboard(selection);
      lastCopiedSelection = selection;
      showToast(tt('clipboard.copied'));
    } catch {
      showToast(tt('clipboard.copyFailed'));
    }
  }, 90);
}

function handleTerminalCopy(event: ClipboardEvent) {
  const selection = normalizeCopiedTerminalSelection(terminal?.getSelection() ?? '');

  if (!selection || !event.clipboardData) {
    return;
  }

  event.preventDefault();
  event.clipboardData.setData('text/plain', selection);
  rememberClipboardText(selection);
  lastCopiedSelection = selection;
  showToast(tt('clipboard.copied'));
}

useClipboardHistoryTarget({
  isTargetActive: () => props.active && Boolean(terminal),
  insertText: (text) => {
    if (!text) {
      return;
    }

    sendInput(text.replace(/\r\n/g, '\n'));
    terminal?.focus();
  },
});

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

function isCopyShortcut(event: KeyboardEvent) {
  return event.type === 'keydown'
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && event.key.toLowerCase() === 'c';
}

function isModifierOnlyKey(event: KeyboardEvent) {
  return event.key === 'Control'
    || event.key === 'Shift'
    || event.key === 'Alt'
    || event.key === 'Meta';
}

function clearCopyInterruptGuard() {
  copyInterruptGuardActive = false;
}

function armCopyInterruptGuard() {
  copyInterruptGuardActive = true;
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
  if (!props.rightClickPasteEnabled) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void pasteTextFromClipboard(null, {
    forceSystemRead: true,
    markRightClickPaste: true,
    skipRecentDuplicate: true,
  });
}

function handleTerminalKeydown(event: KeyboardEvent) {
  emit('activate');

  if (!isModifierOnlyKey(event) && !isCopyShortcut(event)) {
    clearCopyInterruptGuard();
  }

  if (!isSoftLineBreakShortcut(event)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  sendInput('\n');
  terminal?.focus();
}

function handleTerminalPointerdown(event: PointerEvent) {
  emit('activate');

  if (event.button === 2 && !props.rightClickPasteEnabled) {
    event.preventDefault();
    event.stopPropagation();
    terminal?.focus();
    return;
  }

  if (event.button !== 0) {
    return;
  }

  selectionPointerActive = true;
  selectionCopyPendingAfterPointer = false;

  if (copyInterruptGuardActive) {
    clearCopyInterruptGuard();
    return;
  }

  armCopyInterruptGuard();
}

function handleTerminalPointerup() {
  if (!selectionPointerActive) {
    return;
  }

  selectionPointerActive = false;

  if (!selectionCopyPendingAfterPointer) {
    return;
  }

  selectionCopyPendingAfterPointer = false;
  scheduleSelectionCopy();
}

function setTerminalRefreshShortcutEnabled(enabled: boolean) {
  window.bridgegit?.app.setTerminalFocusState(enabled);
}

function handleTerminalFocusIn() {
  setTerminalRefreshShortcutEnabled(true);
}

function handleTerminalFocusOut() {
  setTerminalRefreshShortcutEnabled(false);
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
    shell: props.shell ?? undefined,
    cwd: props.cwd,
    cols: terminal.cols || 120,
    rows: terminal.rows || 32,
  };

  if (mode === 'restart') {
    rejectPromptWaiters('Terminal session restarted.');
    terminal.reset();
    resetOutputTracking();
  }

  suppressActivityUntilInput = true;

  const runner = mode === 'restart' ? restart : start;
  const session = await runner(options);

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
    theme: getTerminalTheme(props.appearanceTheme),
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon(openTerminalWebLink));
  registerTerminalFileLinkProvider();
  terminal.attachCustomKeyEventHandler((event) => {
    if (isPasteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      void pasteTextFromClipboard();
      return false;
    }

    if (isCopyShortcut(event) && copyInterruptGuardActive) {
      event.preventDefault();
      event.stopPropagation();
      showToast(tt('terminal.copyBlockedDuringSelection'));
      return false;
    }

    if (!isModifierOnlyKey(event) && !isCopyShortcut(event)) {
      clearCopyInterruptGuard();
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
    sendInput(data, {
      skipRecentRightClickPasteDuplicate: true,
    });
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
  terminalRoot.value.addEventListener('pointerdown', handleTerminalPointerdown, true);
  document.addEventListener('pointerup', handleTerminalPointerup);
  terminalRoot.value.addEventListener('keyup', scheduleSelectionCopy);
  terminalRoot.value.addEventListener('keydown', handleTerminalKeydown, true);
  terminalRoot.value.addEventListener('wheel', handleWheelZoom, terminalWheelListenerOptions);
  terminalRoot.value.addEventListener('paste', handleTerminalPaste);
  terminalRoot.value.addEventListener('copy', handleTerminalCopy);
  terminalRoot.value.addEventListener('contextmenu', handleContextMenuPaste);
  terminalRoot.value.addEventListener('focusin', handleTerminalFocusIn);
  terminalRoot.value.addEventListener('focusout', handleTerminalFocusOut);
}

onMounted(async () => {
  initializeTerminal();
  attach({
    onData: ({ data }) => {
      appendOutputToBuffer(data);
      terminal?.write(data);

      if (!suppressActivityUntilInput) {
        emit('activity');
      }

      emitAttentionForChoicePrompt();
    },
    onExit: ({ exitCode: code }) => {
      rejectPromptWaiters(`Terminal session exited with code ${code}.`);
      writeStatusLine(`[process exited with code ${code}]`);
      emit('exit', code);
    },
  });

  if (outputBuffer.value) {
    terminal?.write(outputBuffer.value);
    appendOutputToBuffer(outputBuffer.value);
  }

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
  () => props.fontSize,
  (nextFontSize) => {
    const normalizedFontSize = normalizeShellFontSize(nextFontSize);

    if (normalizedFontSize === terminalFontSize.value) {
      return;
    }

    terminalFontSize.value = normalizedFontSize;

    if (!terminal) {
      return;
    }

    terminal.options.fontSize = normalizedFontSize;
    fitTerminal();
  },
);

watch(
  () => props.appearanceTheme,
  (nextTheme) => {
    if (!terminal) {
      return;
    }

    terminal.options.theme = getTerminalTheme(nextTheme);
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

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  document.removeEventListener('pointerup', handleTerminalPointerup);
  terminalRoot.value?.removeEventListener('pointerdown', handleTerminalPointerdown, true);
  terminalRoot.value?.removeEventListener('keyup', scheduleSelectionCopy);
  terminalRoot.value?.removeEventListener('keydown', handleTerminalKeydown, true);
  terminalRoot.value?.removeEventListener('wheel', handleWheelZoom, terminalWheelListenerOptions);
  terminalRoot.value?.removeEventListener('paste', handleTerminalPaste);
  terminalRoot.value?.removeEventListener('copy', handleTerminalCopy);
  terminalRoot.value?.removeEventListener('contextmenu', handleContextMenuPaste);
  terminalRoot.value?.removeEventListener('focusin', handleTerminalFocusIn);
  terminalRoot.value?.removeEventListener('focusout', handleTerminalFocusOut);
  setTerminalRefreshShortcutEnabled(false);
  terminalFileLinkProviderDisposable?.dispose();
  terminalFileLinkProviderDisposable = null;
  resizeObserver?.disconnect();
  rejectPromptWaiters(tt('terminal.sessionClosed'));
  dispose();
  terminal?.dispose();
});
</script>

<template>
  <section class="terminal-session" :data-appearance-theme="appearanceTheme">
    <CopyableErrorNotice
      v-if="error"
      class="terminal-session__notice terminal-session__notice--error"
      :app-language="appLanguage"
      :message="error"
    />

    <div v-else-if="exitCode !== null" class="terminal-session__notice terminal-session__notice--info">
      {{ tt('terminal.processExitedWithCode', { code: exitCode }) }}
    </div>

    <div class="terminal-session__viewport">
      <div ref="terminalRoot" class="terminal-session__screen" />

      <transition name="terminal-session-toast">
        <div v-if="toastMessage" class="terminal-session__toast">
          {{ toastMessage }}
        </div>
      </transition>
    </div>
  </section>
</template>

<style scoped lang="scss">
.terminal-session {
  --terminal-screen-bg:
    radial-gradient(circle at top right, rgba(110, 197, 255, 0.12), transparent 30%),
    rgba(4, 7, 11, 0.95);
  --terminal-toast-bg: rgba(8, 12, 17, 0.98);
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 7px;
}

.terminal-session[data-appearance-theme='bridgegit-light'] {
  --terminal-screen-bg:
    radial-gradient(circle at top right, rgba(45, 124, 216, 0.08), transparent 30%),
    rgba(247, 251, 255, 0.98);
  --terminal-toast-bg: rgba(255, 255, 255, 0.98);
}

.terminal-session[data-appearance-theme='github-dark'] {
  --terminal-screen-bg:
    radial-gradient(circle at top right, rgba(56, 139, 253, 0.1), transparent 30%),
    rgba(13, 17, 23, 0.98);
  --terminal-toast-bg: rgba(22, 27, 34, 0.98);
}

.terminal-session[data-appearance-theme='github-light'] {
  --terminal-screen-bg:
    radial-gradient(circle at top right, rgba(9, 105, 218, 0.08), transparent 30%),
    rgba(255, 255, 255, 0.98);
  --terminal-toast-bg: rgba(255, 255, 255, 0.98);
}

.terminal-session[data-appearance-theme='nord'] {
  --terminal-screen-bg:
    radial-gradient(circle at top right, rgba(136, 192, 208, 0.1), transparent 30%),
    rgba(46, 52, 64, 0.98);
  --terminal-toast-bg: rgba(59, 66, 82, 0.98);
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
  background: var(--terminal-screen-bg);
}

.terminal-session__toast {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 3;
  padding: 0.42rem 0.72rem;
  border: 1px solid rgba(110, 197, 255, 0.26);
  border-radius: 10px;
  background: var(--terminal-toast-bg);
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
