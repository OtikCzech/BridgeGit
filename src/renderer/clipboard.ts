import {
  CLIPBOARD_HISTORY_LIMIT,
  type ClipboardHistoryEntry,
} from '../shared/bridgegit';

let clipboardHistory: ClipboardHistoryEntry[] = [];

export const CLIPBOARD_HISTORY_CAPTURE_TARGET_EVENT = 'bridgegit:clipboard-history-capture-target';
export const CLIPBOARD_HISTORY_CLEAR_TARGET_EVENT = 'bridgegit:clipboard-history-clear-target';
export const CLIPBOARD_HISTORY_INSERT_EVENT = 'bridgegit:clipboard-history-insert';
export const CLIPBOARD_HISTORY_UPDATED_EVENT = 'bridgegit:clipboard-history-updated';

export interface ClipboardHistoryUpdatedDetail {
  entries: ClipboardHistoryEntry[];
}

function normalizeClipboardText(value: string) {
  return value.replace(/\r\n/g, '\n');
}

function normalizeClipboardHistoryEntries(entries: ClipboardHistoryEntry[]) {
  const normalizedEntries: ClipboardHistoryEntry[] = [];
  const seenTexts = new Set<string>();

  for (const entry of entries) {
    const normalizedText = normalizeClipboardText(entry.text);

    if (!normalizedText || seenTexts.has(normalizedText)) {
      continue;
    }

    const normalizedCapturedAt = !Number.isNaN(Date.parse(entry.capturedAt))
      ? entry.capturedAt
      : new Date(0).toISOString();

    normalizedEntries.push({
      text: normalizedText,
      capturedAt: normalizedCapturedAt,
    });
    seenTexts.add(normalizedText);

    if (normalizedEntries.length >= CLIPBOARD_HISTORY_LIMIT) {
      break;
    }
  }

  return normalizedEntries;
}

function getNormalizedCaptureTimestamp(capturedAt?: string) {
  return typeof capturedAt === 'string' && !Number.isNaN(Date.parse(capturedAt))
    ? capturedAt
    : new Date().toISOString();
}

function emitClipboardHistoryUpdated() {
  window.dispatchEvent(new CustomEvent<ClipboardHistoryUpdatedDetail>(CLIPBOARD_HISTORY_UPDATED_EVENT, {
    detail: {
      entries: getClipboardHistoryEntries(),
    },
  }));
}

function applyClipboardHistory(entries: ClipboardHistoryEntry[], options: { emit?: boolean } = {}) {
  clipboardHistory = normalizeClipboardHistoryEntries(entries);

  if (options.emit ?? true) {
    emitClipboardHistoryUpdated();
  }
}

function rememberClipboardEntry(
  text: string,
  options: {
    capturedAt?: string;
    emit?: boolean;
    skipIfAlreadyLatest?: boolean;
  } = {},
) {
  const normalizedText = normalizeClipboardText(text);

  if (!normalizedText) {
    return null;
  }

  if (options.skipIfAlreadyLatest && clipboardHistory[0]?.text === normalizedText) {
    return clipboardHistory[0];
  }

  const nextEntry: ClipboardHistoryEntry = {
    text: normalizedText,
    capturedAt: getNormalizedCaptureTimestamp(options.capturedAt),
  };

  applyClipboardHistory([
    nextEntry,
    ...clipboardHistory.filter((entry) => entry.text !== normalizedText),
  ], { emit: options.emit });

  return nextEntry;
}

async function writeSystemClipboardText(text: string) {
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

async function readSystemClipboardText() {
  try {
    if (window.bridgegit?.clipboard) {
      return normalizeClipboardText(await Promise.resolve(window.bridgegit.clipboard.readText()));
    }
  } catch {
    // Fall back to the browser clipboard API when the Electron bridge is unavailable.
  }

  return normalizeClipboardText(await navigator.clipboard.readText());
}

export async function writeClipboardText(text: string) {
  const entry = rememberClipboardEntry(text);

  if (!entry) {
    return '';
  }

  await writeSystemClipboardText(entry.text);
  return entry.text;
}

export function rememberClipboardText(text: string) {
  return rememberClipboardEntry(text);
}

export function setClipboardHistoryEntries(entries: ClipboardHistoryEntry[], options: { emit?: boolean } = {}) {
  applyClipboardHistory(entries, options);
}

export function getClipboardHistoryEntries() {
  return clipboardHistory.map((entry) => ({ ...entry }));
}

export async function syncClipboardHistoryFromSystem() {
  const systemText = await readSystemClipboardText();

  if (!systemText) {
    return null;
  }

  return rememberClipboardEntry(systemText, {
    skipIfAlreadyLatest: true,
  });
}

export async function listClipboardHistory() {
  await syncClipboardHistoryFromSystem();
  return getClipboardHistoryEntries();
}

export async function readClipboardText(options?: {
  eventText?: string | null;
  preferPreviousDistinctOf?: string | null;
}) {
  const eventText = normalizeClipboardText(options?.eventText ?? '');
  const latestEntry = eventText
    ? rememberClipboardEntry(eventText, {
      skipIfAlreadyLatest: true,
    })
    : await syncClipboardHistoryFromSystem();
  const latestText = clipboardHistory[0]?.text ?? latestEntry?.text ?? '';

  if (!latestText) {
    return '';
  }

  const preferredSelection = normalizeClipboardText(options?.preferPreviousDistinctOf ?? '');

  if (!preferredSelection || latestText !== preferredSelection) {
    return latestText;
  }

  return clipboardHistory.find((entry) => entry.text !== preferredSelection)?.text ?? latestText;
}
