<script setup lang="ts">
import { html as renderDiffHtml } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui-base';
import hljs from 'highlight.js/lib/core';
import bashLanguage from 'highlight.js/lib/languages/bash';
import cssLanguage from 'highlight.js/lib/languages/css';
import javascriptLanguage from 'highlight.js/lib/languages/javascript';
import jsonLanguage from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import phpLanguage from 'highlight.js/lib/languages/php';
import powershellLanguage from 'highlight.js/lib/languages/powershell';
import scssLanguage from 'highlight.js/lib/languages/scss';
import shellLanguage from 'highlight.js/lib/languages/shell';
import sqlLanguage from 'highlight.js/lib/languages/sql';
import typescriptLanguage from 'highlight.js/lib/languages/typescript';
import xmlLanguage from 'highlight.js/lib/languages/xml';
import yamlLanguage from 'highlight.js/lib/languages/yaml';
import { computed, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';
import type { GitDiffMode } from '../../shared/bridgegit';
import { writeClipboardText as writeSharedClipboardText } from '../clipboard';
import CopyableErrorNotice from './CopyableErrorNotice.vue';

interface Props {
  repoPath: string | null;
  viewerMode: 'working-tree' | 'commit';
  viewMode?: 'side-by-side' | 'line-by-line';
  showViewToggle?: boolean;
  eyebrowText?: string | null;
  title: string;
  titleMeta?: string | null;
  hasTarget: boolean;
  diff: string;
  gitDiffMode: GitDiffMode;
  isLoading: boolean;
  error: string | null;
  changePosition: number;
  changeCount: number;
  canSelectPrevious: boolean;
  canSelectNext: boolean;
  canStageCurrent: boolean;
  canDiscardCurrent: boolean;
  canOpenCurrentFile: boolean;
  stageActionLabel: string;
  canCollapse: boolean;
  collapseShortcutDisplay: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'select-previous': [];
  'select-next': [];
  'update:view-mode': [value: 'side-by-side' | 'line-by-line'];
  'stage-current': [];
  'discard-current': [];
  'open-current-file': [targetLine?: number];
  'open-diff-target': [payload: { filePath: string; line?: number }];
  'discard-hunk': [patch: string];
  'toggle-collapse': [];
}>();

hljs.registerLanguage('bash', bashLanguage);
hljs.registerLanguage('css', cssLanguage);
hljs.registerLanguage('javascript', javascriptLanguage);
hljs.registerLanguage('json', jsonLanguage);
hljs.registerLanguage('markdown', markdownLanguage);
hljs.registerLanguage('php', phpLanguage);
hljs.registerLanguage('powershell', powershellLanguage);
hljs.registerLanguage('scss', scssLanguage);
hljs.registerLanguage('shell', shellLanguage);
hljs.registerLanguage('sql', sqlLanguage);
hljs.registerLanguage('typescript', typescriptLanguage);
hljs.registerLanguage('xml', xmlLanguage);
hljs.registerLanguage('yaml', yamlLanguage);

const HIGHLIGHT_LANGUAGE_MAP = new Map<string, string>([
  ['cjs', 'javascript'],
  ['dockerfile', 'bash'],
  ['htm', 'xml'],
  ['html', 'xml'],
  ['js', 'javascript'],
  ['jsonc', 'json'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['md', 'markdown'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['pwsh', 'powershell'],
  ['sass', 'scss'],
  ['sh', 'bash'],
  ['svg', 'xml'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['vue', 'xml'],
  ['xml', 'xml'],
  ['yml', 'yaml'],
  ['zsh', 'bash'],
]);

interface DiffHunkSection {
  id: string;
  patch: string;
  renderedHtml: string;
  lineActions: Array<{
    id: string;
    label: string;
    patch: string;
  }>;
}

interface ParsedHunkLine {
  prefix: ' ' | '+' | '-' | '\\';
  raw: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

interface DiffFileEntry {
  filePath: string;
}

const rootRef = ref<HTMLElement | null>(null);
const internalViewMode = ref<'side-by-side' | 'line-by-line'>('side-by-side');
const copyToast = ref<string | null>(null);
const isCommitMode = computed(() => props.viewerMode === 'commit');
const currentViewMode = computed(() => props.viewMode ?? internalViewMode.value);
const showViewToggle = computed(() => props.showViewToggle ?? true);
const resolvedEyebrowText = computed(() => (
  props.eyebrowText === undefined
    ? (isCommitMode.value ? 'Commit Diff' : 'Diff Viewer')
    : props.eyebrowText
));
const isSideBySide = computed(() => currentViewMode.value === 'side-by-side');
const viewToggleTitle = computed(() => (
  isSideBySide.value ? 'Switch diff to unified view' : 'Switch diff to side by side view'
));
const collapseButtonTitle = computed(() => (
  props.canCollapse
    ? `Collapse diff panel ${props.collapseShortcutDisplay}`
    : 'Diff panel cannot be collapsed while it is the last visible panel'
));
const canDiscardHunks = computed(() => !isCommitMode.value && props.gitDiffMode !== 'working-tree' ? true : !isCommitMode.value);
const currentDiffTargetLine = computed(() => findFirstChangedLine(props.diff));
const openCurrentFileLabel = computed(() => (
  currentDiffTargetLine.value ? `Open at line ${currentDiffTargetLine.value}` : 'Open file'
));
let copySelectionTimer: number | null = null;
let copyToastTimer: number | null = null;
let lastCopiedSelection: string | null = null;
let selectionPointerActive = false;
let selectionCopyPendingAfterPointer = false;

const hasDiff = computed(() => props.diff.includes('diff --git'));
const diffFileEntries = computed(() => parseDiffFileEntries(props.diff));
const renderedDiff = computed(() => {
  if (!hasDiff.value) {
    return '';
  }

  return renderDiffHtml(props.diff, {
    colorScheme: ColorSchemeType.DARK,
    drawFileList: false,
    matching: 'lines',
    outputFormat: currentViewMode.value,
  });
});

const hunkSections = computed<DiffHunkSection[]>(() => {
  if (!hasDiff.value || isCommitMode.value) {
    return [];
  }

  const normalizedDiff = props.diff.replace(/\r\n/g, '\n');
  const diffLines = normalizedDiff.split('\n');
  const diffHeaders = diffLines.filter((line) => line.startsWith('diff --git '));

  if (diffHeaders.length !== 1) {
    return [];
  }

  const firstHunkIndex = diffLines.findIndex((line) => line.startsWith('@@ '));

  if (firstHunkIndex < 0) {
    return [];
  }

  const headerLines = diffLines.slice(0, firstHunkIndex);

  if (headerLines.some((line) => /^new file mode |^deleted file mode |^Binary files /.test(line))) {
    return [];
  }

  const hunks: string[][] = [];
  let currentHunk: string[] = [];

  diffLines.slice(firstHunkIndex).forEach((line) => {
    if (line.startsWith('@@ ') && currentHunk.length > 0) {
      hunks.push(currentHunk);
      currentHunk = [];
    }

    currentHunk.push(line);
  });

  if (currentHunk.length > 0) {
    hunks.push(currentHunk);
  }

  return hunks.map((hunkLines, index) => {
    const patch = [...headerLines, ...hunkLines].join('\n');
    const lineActions = buildLineActions(headerLines, hunkLines, index);
    return {
      id: `hunk-${index + 1}`,
      patch,
      renderedHtml: renderDiffHtml(patch, {
        colorScheme: ColorSchemeType.DARK,
        drawFileList: false,
        matching: 'lines',
        outputFormat: currentViewMode.value,
      }),
      lineActions,
    };
  });
});

const shouldRenderHunkSections = computed(() => hunkSections.value.length > 0);

function toggleViewMode() {
  const nextValue = isSideBySide.value ? 'line-by-line' : 'side-by-side';

  if (props.viewMode) {
    emit('update:view-mode', nextValue);
    return;
  }

  internalViewMode.value = nextValue;
  emit('update:view-mode', nextValue);
}

function formatHunkRange(start: number, count: number) {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function parseHunkHeader(hunkHeader: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);

  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

function parseHunkLines(hunkLines: string[]) {
  const parsedHeader = parseHunkHeader(hunkLines[0] ?? '');

  if (!parsedHeader) {
    return [];
  }

  const parsedLines: ParsedHunkLine[] = [];
  let oldLineNumber = parsedHeader.oldStart;
  let newLineNumber = parsedHeader.newStart;

  hunkLines.slice(1).forEach((line) => {
    if (line.startsWith(' ')) {
      parsedLines.push({
        prefix: ' ',
        raw: line,
        oldLineNumber,
        newLineNumber,
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      return;
    }

    if (line.startsWith('-')) {
      parsedLines.push({
        prefix: '-',
        raw: line,
        oldLineNumber,
        newLineNumber: null,
      });
      oldLineNumber += 1;
      return;
    }

    if (line.startsWith('+')) {
      parsedLines.push({
        prefix: '+',
        raw: line,
        oldLineNumber: null,
        newLineNumber,
      });
      newLineNumber += 1;
      return;
    }

    parsedLines.push({
      prefix: '\\',
      raw: line,
      oldLineNumber: null,
      newLineNumber: null,
    });
  });

  return parsedLines;
}

function buildLineActions(headerLines: string[], hunkLines: string[], hunkIndex: number) {
  const parsedLines = parseHunkLines(hunkLines);
  const lineActions: DiffHunkSection['lineActions'] = [];
  let lineActionIndex = 0;

  for (let index = 0; index < parsedLines.length; index += 1) {
    const currentLine = parsedLines[index];

    if (currentLine.prefix === ' ' || currentLine.prefix === '\\') {
      continue;
    }

    const blockStart = index;
    let blockEnd = index;

    while (blockEnd + 1 < parsedLines.length) {
      const nextLine = parsedLines[blockEnd + 1];

      if (nextLine.prefix === ' ' || nextLine.prefix === '\\') {
        break;
      }

      blockEnd += 1;
    }

    const sliceStart = blockStart > 0 && parsedLines[blockStart - 1]?.prefix === ' '
      ? blockStart - 1
      : blockStart;
    const sliceEnd = blockEnd + 1 < parsedLines.length && parsedLines[blockEnd + 1]?.prefix === ' '
      ? blockEnd + 1
      : blockEnd;
    const sliceLines = parsedLines.slice(sliceStart, sliceEnd + 1).filter((line) => line.prefix !== '\\');
    const firstOldLineNumber = sliceLines.find((line) => line.oldLineNumber !== null)?.oldLineNumber;
    const firstNewLineNumber = sliceLines.find((line) => line.newLineNumber !== null)?.newLineNumber;

    if (firstOldLineNumber === undefined || firstOldLineNumber === null || firstNewLineNumber === undefined || firstNewLineNumber === null) {
      index = blockEnd;
      continue;
    }

    const oldCount = sliceLines.filter((line) => line.prefix !== '+').length;
    const newCount = sliceLines.filter((line) => line.prefix !== '-').length;
    const firstChangedLine = parsedLines[blockStart];
    const targetLineNumber = firstChangedLine.newLineNumber ?? firstChangedLine.oldLineNumber;

    if (!targetLineNumber) {
      index = blockEnd;
      continue;
    }

    const patch = [
      ...headerLines,
      `@@ -${formatHunkRange(firstOldLineNumber, oldCount)} +${formatHunkRange(firstNewLineNumber, newCount)} @@`,
      ...sliceLines.map((line) => line.raw),
    ].join('\n');

    lineActions.push({
      id: `hunk-${hunkIndex + 1}-line-${lineActionIndex + 1}`,
      label: `Discard line ${targetLineNumber}`,
      patch,
    });
    lineActionIndex += 1;
    index = blockEnd;
  }

  return lineActions;
}

function findFirstChangedLine(diffText: string) {
  if (!diffText.includes('diff --git')) {
    return null;
  }

  const normalizedDiff = diffText.replace(/\r\n/g, '\n');
  const diffLines = normalizedDiff.split('\n');
  const firstHunkIndex = diffLines.findIndex((line) => line.startsWith('@@ '));

  if (firstHunkIndex < 0) {
    return null;
  }

  const hunkLines = diffLines.slice(firstHunkIndex);
  let currentHunk: string[] = [];

  for (const line of hunkLines) {
    if (line.startsWith('@@ ') && currentHunk.length > 0) {
      const targetLine = findFirstChangedLineInHunk(currentHunk);
      if (targetLine) {
        return targetLine;
      }
      currentHunk = [];
    }

    currentHunk.push(line);
  }

  return currentHunk.length > 0 ? findFirstChangedLineInHunk(currentHunk) : null;
}

function findFirstChangedLineInHunk(hunkLines: string[]) {
  const parsedLines = parseHunkLines(hunkLines);
  const firstChangedLine = parsedLines.find((line) => line.prefix !== ' ' && line.prefix !== '\\');

  return firstChangedLine?.newLineNumber ?? firstChangedLine?.oldLineNumber ?? null;
}

function parseDiffPath(rawPath: string): string | null {
  const trimmedPath = rawPath.trim();

  if (!trimmedPath || trimmedPath === '/dev/null') {
    return null;
  }

  const unquotedPath = (
    (trimmedPath.startsWith('"') && trimmedPath.endsWith('"'))
    || (trimmedPath.startsWith('\'') && trimmedPath.endsWith('\''))
  )
    ? trimmedPath.slice(1, -1)
    : trimmedPath;

  const normalizedPath = unquotedPath.replace(/\\/g, '/').replace(/^[ab]\//, '');
  return normalizedPath || null;
}

function parseDiffFileEntries(diffText: string): DiffFileEntry[] {
  if (!diffText.includes('diff --git')) {
    return [];
  }

  const entries: DiffFileEntry[] = [];
  const lines = diffText.replace(/\r\n/g, '\n').split('\n');
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let hasActiveBlock = false;

  function flushCurrentEntry() {
    if (!hasActiveBlock) {
      return;
    }

    const filePath = newPath ?? oldPath;

    if (filePath) {
      entries.push({ filePath });
    }

    oldPath = null;
    newPath = null;
    hasActiveBlock = false;
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushCurrentEntry();
      hasActiveBlock = true;
      continue;
    }

    if (!hasActiveBlock) {
      continue;
    }

    if (line.startsWith('--- ')) {
      oldPath = parseDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith('+++ ')) {
      newPath = parseDiffPath(line.slice(4));
    }
  }

  flushCurrentEntry();
  return entries;
}

function findClosestDiffFileWrapper(target: HTMLElement | null) {
  return target?.closest<HTMLElement>('.d2h-file-wrapper') ?? null;
}

function deriveFilePathFromWrapper(wrapper: HTMLElement): string | null {
  const annotatedPath = wrapper.dataset.bridgegitFilePath?.trim();

  if (annotatedPath) {
    return annotatedPath;
  }

  const fileName = wrapper.querySelector<HTMLElement>('.d2h-file-name')?.textContent?.trim() ?? '';
  return parseDiffPath(fileName);
}

function getTargetLineFromCell(cell: HTMLElement): number | null {
  if (cell.classList.contains('d2h-code-side-linenumber')) {
    const lineNumber = Number.parseInt(cell.textContent?.trim() ?? '', 10);
    return Number.isFinite(lineNumber) ? lineNumber : null;
  }

  const newLineNumber = Number.parseInt(
    cell.querySelector<HTMLElement>('.line-num2')?.textContent?.trim() ?? '',
    10,
  );

  if (Number.isFinite(newLineNumber)) {
    return newLineNumber;
  }

  const oldLineNumber = Number.parseInt(
    cell.querySelector<HTMLElement>('.line-num1')?.textContent?.trim() ?? '',
    10,
  );

  return Number.isFinite(oldLineNumber) ? oldLineNumber : null;
}

function annotateDiffTargets() {
  if (!rootRef.value) {
    return;
  }

  const wrappers = rootRef.value.querySelectorAll<HTMLElement>('.d2h-file-wrapper');
  const entries = diffFileEntries.value;

  wrappers.forEach((wrapper, index) => {
    const filePath = (
      entries.length === 1
        ? entries[0]?.filePath
        : entries[index]?.filePath
    ) ?? deriveFilePathFromWrapper(wrapper);

    if (filePath) {
      wrapper.dataset.bridgegitFilePath = filePath;
    } else {
      delete wrapper.dataset.bridgegitFilePath;
    }
  });
}

function applySyntaxHighlighting() {
  if (!rootRef.value) {
    return;
  }

  const highlightTargets = rootRef.value.querySelectorAll<HTMLElement>(
    '.diff-viewer__rendered:not(.diff-viewer__rendered--hunks), .diff-viewer__hunk-rendered',
  );

  highlightTargets.forEach((target) => {
    const codeLines = target.querySelectorAll('.d2h-code-line-ctn');

    if (!codeLines.length) {
      return;
    }

    const hasUnhighlightedLines = Array.from(codeLines).some((line) => !line.classList.contains('hljs'));

    if (!hasUnhighlightedLines) {
      return;
    }

    try {
      const diffUi = new Diff2HtmlUI(target, undefined, {
        highlightLanguages: HIGHLIGHT_LANGUAGE_MAP,
      }, hljs);
      diffUi.highlightCode();
    } catch (error) {
      console.error('Failed to apply diff syntax highlighting.', error);
    }
  });
}

function handleRenderedDiffClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }

  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  const selection = window.getSelection();

  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    return;
  }

  const target = event.target instanceof HTMLElement ? event.target : null;

  if (!target) {
    return;
  }

  const headerTarget = target.closest<HTMLElement>('.d2h-file-name-wrapper');

  if (headerTarget && !target.closest('.d2h-file-collapse')) {
    const wrapper = findClosestDiffFileWrapper(headerTarget);
    const filePath = wrapper ? deriveFilePathFromWrapper(wrapper) : null;

    if (!filePath) {
      return;
    }

    event.preventDefault();
    emit('open-diff-target', { filePath });
    return;
  }

  const lineNumberCell = target.closest<HTMLElement>('.d2h-code-linenumber, .d2h-code-side-linenumber');
  const lineContentCell = target.closest<HTMLElement>('td.d2h-ins, td.d2h-del, td.d2h-change');
  const activeLineCell = lineNumberCell ?? lineContentCell?.parentElement?.querySelector<HTMLElement>(
    '.d2h-code-linenumber, .d2h-code-side-linenumber',
  ) ?? null;

  if (!activeLineCell) {
    return;
  }

  const wrapper = findClosestDiffFileWrapper(activeLineCell);
  const filePath = wrapper ? deriveFilePathFromWrapper(wrapper) : null;
  const line = getTargetLineFromCell(activeLineCell);

  if (!filePath || !line) {
    return;
  }

  event.preventDefault();
  emit('open-diff-target', {
    filePath,
    line,
  });
}

async function writeClipboard(text: string) {
  await writeSharedClipboardText(text);
}

function getRenderedDiffElement() {
  return rootRef.value?.querySelector<HTMLElement>('.diff-viewer__rendered') ?? null;
}

function getSelectedDiffText() {
  const renderedDiffElement = getRenderedDiffElement();
  const selection = window.getSelection();

  if (!renderedDiffElement || !selection || selection.isCollapsed || selection.rangeCount < 1) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;

  if (!anchorNode || !focusNode) {
    return null;
  }

  if (!renderedDiffElement.contains(anchorNode) || !renderedDiffElement.contains(focusNode)) {
    return null;
  }

  const text = selection.toString();
  return text.length > 0 ? text : null;
}

function clearPendingSelectionCopy() {
  if (copySelectionTimer) {
    window.clearTimeout(copySelectionTimer);
    copySelectionTimer = null;
  }
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

function scheduleSelectionCopy() {
  if (selectionPointerActive) {
    selectionCopyPendingAfterPointer = true;
    return;
  }

  const selection = getSelectedDiffText();

  if (!selection) {
    lastCopiedSelection = null;
    clearPendingSelectionCopy();
    return;
  }

  clearPendingSelectionCopy();
  copySelectionTimer = window.setTimeout(async () => {
    const currentSelection = getSelectedDiffText();

    if (!currentSelection || currentSelection === lastCopiedSelection) {
      return;
    }

    try {
      await writeClipboard(currentSelection);
      lastCopiedSelection = currentSelection;
      showCopyToast('Copied');
    } catch {
      showCopyToast('Copy failed');
    }
  }, 90);
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (event.button !== 0 || !rootRef.value?.contains(event.target as Node | null)) {
    return;
  }

  selectionPointerActive = true;
  selectionCopyPendingAfterPointer = false;
}

function handleDocumentPointerUp() {
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

onMounted(() => {
  applySyntaxHighlighting();
  annotateDiffTargets();
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('pointerup', handleDocumentPointerUp);
  document.addEventListener('selectionchange', scheduleSelectionCopy);
});

onUpdated(() => {
  applySyntaxHighlighting();
  annotateDiffTargets();
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('pointerup', handleDocumentPointerUp);
  document.removeEventListener('selectionchange', scheduleSelectionCopy);
  clearPendingSelectionCopy();

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
    copyToastTimer = null;
  }
});
</script>

<template>
  <section ref="rootRef" class="diff-viewer" @click="handleRenderedDiffClick">
    <header class="diff-viewer__header">
      <div class="diff-viewer__heading">
        <span v-if="resolvedEyebrowText" class="diff-viewer__eyebrow">
          {{ resolvedEyebrowText }}
        </span>
        <h2 v-if="title" class="diff-viewer__title">{{ title }}</h2>
        <p v-if="titleMeta" class="diff-viewer__title-meta">
          {{ titleMeta }}
        </p>
      </div>

      <div class="diff-viewer__navigator">
        <button
          class="diff-viewer__icon-button"
          type="button"
          :disabled="!canSelectPrevious"
          title="Previous change"
          aria-label="Previous change"
          @click="emit('select-previous')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.78 5.97a.75.75 0 0 1 0 1.06L10.81 11l3.97 3.97a.75.75 0 1 1-1.06 1.06l-4.5-4.5a.75.75 0 0 1 0-1.06l4.5-4.5a.75.75 0 0 1 1.06 0Z" />
          </svg>
        </button>

        <span class="diff-viewer__navigator-count">
          <span class="diff-viewer__navigator-count-value">
            {{ changePosition }}
          </span>
          <button
            class="diff-viewer__icon-button diff-viewer__icon-button--inline"
            type="button"
            :disabled="!canOpenCurrentFile"
            :title="openCurrentFileLabel"
            :aria-label="openCurrentFileLabel"
            @click="emit('open-current-file', currentDiffTargetLine ?? undefined)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15.86 4.64a2.25 2.25 0 1 1 3.18 3.18l-9.9 9.9a.75.75 0 0 1-.33.2l-3.5 1a.75.75 0 0 1-.93-.93l1-3.5a.75.75 0 0 1 .2-.33l9.9-9.9Zm2.12 1.06a.75.75 0 0 0-1.06 0l-9.74 9.74-.58 2.03 2.03-.58 9.74-9.74a.75.75 0 0 0 0-1.06l-.39-.39Z" />
            </svg>
          </button>
          <span class="diff-viewer__navigator-count-value">
            {{ changeCount }}
          </span>
        </span>

        <button
          class="diff-viewer__icon-button"
          type="button"
          :disabled="!canSelectNext"
          title="Next change"
          aria-label="Next change"
          @click="emit('select-next')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9.22 5.97a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06L13.19 11 9.22 7.03a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      <div class="diff-viewer__toolbar">
        <slot name="toolbar-prefix" />

        <button
          v-if="!isCommitMode"
          class="diff-viewer__stage"
          type="button"
          :disabled="!canStageCurrent"
          @click="emit('stage-current')"
        >
          {{ stageActionLabel }}
        </button>

        <button
          v-if="!isCommitMode"
          class="diff-viewer__stage diff-viewer__stage--danger"
          type="button"
          :disabled="!canDiscardCurrent"
          @click="emit('discard-current')"
        >
          Discard current
        </button>

        <button
          v-if="showViewToggle"
          class="diff-viewer__icon-button diff-viewer__icon-button--view-toggle"
          type="button"
          :title="viewToggleTitle"
          :aria-label="viewToggleTitle"
          @click="toggleViewMode"
        >
          <svg v-if="isSideBySide" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6.25 5.75A1.75 1.75 0 0 0 4.5 7.5v9A1.75 1.75 0 0 0 6.25 18.25h11.5A1.75 1.75 0 0 0 19.5 16.5v-9a1.75 1.75 0 0 0-1.75-1.75H6.25Zm0 1.5h5v9.5h-5A.25.25 0 0 1 6 16.5v-9c0-.14.11-.25.25-.25Zm6.5 9.5v-9.5h5c.14 0 .25.11.25.25v9a.25.25 0 0 1-.25.25h-5Z"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6.25 5.75A1.75 1.75 0 0 0 4.5 7.5v9A1.75 1.75 0 0 0 6.25 18.25h11.5A1.75 1.75 0 0 0 19.5 16.5v-9a1.75 1.75 0 0 0-1.75-1.75H6.25Zm0 1.5h11.5c.14 0 .25.11.25.25v9a.25.25 0 0 1-.25.25H6.25A.25.25 0 0 1 6 16.5v-9c0-.14.11-.25.25-.25Zm2.5 2.25a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Zm0 3a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Z"
            />
          </svg>
        </button>

        <button
          v-if="canCollapse"
          class="diff-viewer__icon-button"
          type="button"
          :title="collapseButtonTitle"
          aria-label="Collapse diff panel"
          @click="emit('toggle-collapse')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.75 11.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H6.75Z" />
          </svg>
        </button>

        <slot name="toolbar-suffix" />
      </div>
    </header>

    <div v-if="error" class="diff-viewer__meta">
      <CopyableErrorNotice
        v-if="error"
        class="diff-viewer__badge diff-viewer__badge--remove"
        :message="error"
      />
    </div>

    <div v-if="!repoPath" class="diff-viewer__empty">
      Open a Git repository to inspect diffs.
    </div>

    <div v-else-if="!hasTarget" class="diff-viewer__empty">
      {{ isCommitMode
        ? 'Pick a commit in history to render its patch.'
        : 'Pick a file in the Repo panel to render its patch.' }}
    </div>

    <div v-else-if="isLoading && !hasDiff" class="diff-viewer__empty">
      Loading diff...
    </div>

    <div v-else-if="!hasDiff" class="diff-viewer__empty">
      No textual diff is available for this file yet. Untracked files usually show content after staging.
    </div>

    <div v-else-if="shouldRenderHunkSections" class="diff-viewer__rendered diff-viewer__rendered--hunks">
      <section
        v-for="(hunk, index) in hunkSections"
        :key="hunk.id"
        class="diff-viewer__hunk"
      >
        <header class="diff-viewer__hunk-header">
          <span class="diff-viewer__hunk-label">Hunk {{ index + 1 }}</span>
          <div class="diff-viewer__hunk-actions">
            <button
              v-if="canDiscardHunks"
              class="diff-viewer__hunk-action"
              type="button"
              @click="emit('discard-hunk', hunk.patch)"
            >
              Discard hunk
            </button>
          </div>
        </header>
        <div v-if="hunk.lineActions.length" class="diff-viewer__line-actions">
          <button
            v-for="lineAction in hunk.lineActions"
            :key="lineAction.id"
            class="diff-viewer__line-action"
            type="button"
            @click="emit('discard-hunk', lineAction.patch)"
          >
            {{ lineAction.label }}
          </button>
        </div>
        <div class="diff-viewer__hunk-rendered" v-html="hunk.renderedHtml" />
      </section>
    </div>

    <div v-else class="diff-viewer__rendered" v-html="renderedDiff" />

    <transition name="diff-viewer-toast">
      <div v-if="copyToast" class="diff-viewer__toast">
        {{ copyToast }}
      </div>
    </transition>
  </section>
</template>

<style scoped lang="scss">
.diff-viewer {
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 16px;
  position: relative;
  height: 100%;
  padding: 20px;
}

.diff-viewer__header,
.diff-viewer__toolbar,
.diff-viewer__meta,
.diff-viewer__navigator {
  display: flex;
  align-items: center;
}

.diff-viewer__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 16px;
}

.diff-viewer__heading {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.diff-viewer__eyebrow {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.diff-viewer__title {
  overflow: hidden;
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.12rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-viewer__title-meta {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.78rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff-viewer__toolbar {
  gap: 8px;
  justify-self: end;
}

.diff-viewer__navigator {
  justify-self: center;
  gap: 8px;
}

.diff-viewer__navigator-count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 72px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  text-align: center;
}

.diff-viewer__navigator-count-value {
  min-width: 1ch;
}

.diff-viewer__icon-button,
.diff-viewer__stage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(17, 23, 31, 0.9);
  color: var(--text-primary);
}

.diff-viewer__icon-button {
  width: 32px;
  height: 32px;
  padding: 0;
}

.diff-viewer__icon-button svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.diff-viewer__icon-button:disabled,
.diff-viewer__stage:disabled {
  cursor: default;
  opacity: 0.42;
}

.diff-viewer__icon-button:disabled:not(.diff-viewer__icon-button--view-toggle),
.diff-viewer__stage:disabled {
  color: var(--text-dim);
}

.diff-viewer__icon-button--view-toggle {
  color: rgba(123, 208, 255, 0.9);
}

.diff-viewer__icon-button--inline {
  width: 24px;
  height: 24px;
  color: rgba(123, 208, 255, 0.92);
}

.diff-viewer__stage {
  padding: 0.55rem 0.78rem;
  font-size: 0.78rem;
  font-weight: 600;
}

.diff-viewer__stage--danger {
  border-color: rgba(188, 87, 87, 0.24);
  background: rgba(188, 87, 87, 0.14);
  color: #ffb3ad;
}

.diff-viewer__stage--neutral {
  border-color: rgba(123, 208, 255, 0.24);
  background: rgba(123, 208, 255, 0.1);
  color: #c6eeff;
}

.diff-viewer__meta {
  flex-wrap: wrap;
  gap: 8px;
}

.diff-viewer__badge {
  max-width: 100%;
  padding: 0.38rem 0.65rem;
  overflow: hidden;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-viewer__badge--add {
  background: rgba(72, 170, 110, 0.18);
  color: #93efb9;
}

.diff-viewer__badge--remove {
  background: rgba(188, 87, 87, 0.18);
  color: #ffada4;
}

.diff-viewer__badge--neutral {
  background: rgba(110, 197, 255, 0.16);
  color: var(--accent-strong);
}

.diff-viewer__empty,
.diff-viewer__rendered {
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  background: rgba(10, 14, 19, 0.88);
}

.diff-viewer__empty {
  display: grid;
  place-items: center;
  padding: 24px;
  color: var(--text-muted);
  text-align: center;
}

.diff-viewer__rendered {
  padding: 14px;
}

.diff-viewer__rendered--hunks {
  display: grid;
  gap: 16px;
}

.diff-viewer__hunk {
  display: grid;
  gap: 10px;
}

.diff-viewer__hunk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.diff-viewer__hunk-actions,
.diff-viewer__line-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.diff-viewer__hunk-label {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.diff-viewer__hunk-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.45rem 0.72rem;
  border: 1px solid rgba(188, 87, 87, 0.24);
  border-radius: 10px;
  background: rgba(188, 87, 87, 0.14);
  color: #ffb3ad;
  font-size: 0.74rem;
  font-weight: 600;
}

.diff-viewer__hunk-action:hover {
  background: rgba(188, 87, 87, 0.2);
}

.diff-viewer__line-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.38rem 0.62rem;
  border: 1px solid rgba(188, 87, 87, 0.16);
  border-radius: 999px;
  background: rgba(188, 87, 87, 0.1);
  color: #ffc1ba;
  font-size: 0.7rem;
  font-weight: 600;
}

.diff-viewer__line-action:hover {
  background: rgba(188, 87, 87, 0.16);
}

.diff-viewer__hunk-rendered {
  min-width: 0;
}

.diff-viewer__toast {
  position: absolute;
  right: 20px;
  bottom: 20px;
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

.diff-viewer-toast-enter-active,
.diff-viewer-toast-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.diff-viewer-toast-enter-from,
.diff-viewer-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

:deep(.d2h-wrapper) {
  color: var(--text-primary);
}

:deep(.d2h-file-name-wrapper) {
  cursor: pointer;
}

:deep(.d2h-file-name-wrapper:hover .d2h-file-name) {
  color: rgba(151, 219, 255, 0.96);
}

:deep(.d2h-code-linenumber),
:deep(.d2h-code-side-linenumber),
:deep(td.d2h-ins),
:deep(td.d2h-del),
:deep(td.d2h-change) {
  cursor: pointer;
}

:deep(.d2h-code-linenumber:hover),
:deep(.d2h-code-side-linenumber:hover) {
  color: rgba(151, 219, 255, 0.96);
  background: rgba(18, 34, 48, 0.92);
}

:deep(td.d2h-ins:hover),
:deep(td.d2h-del:hover),
:deep(td.d2h-change:hover) {
  box-shadow: inset 3px 0 0 rgba(123, 208, 255, 0.52);
}

@media (max-width: 900px) {
  .diff-viewer__header {
    grid-template-columns: 1fr;
    justify-items: start;
  }

  .diff-viewer__navigator,
  .diff-viewer__toolbar {
    justify-self: start;
  }
}
</style>
