<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  normalizeNoteFontSize,
  type WorkspaceNoteTabState,
} from '../../shared/bridgegit';
import { SHORTCUTS, matchesShortcut } from '../shortcuts';

interface Props {
  active: boolean;
  busy: boolean;
  content: string;
  filePath: string | null;
  isDirty: boolean;
  viewMode: WorkspaceNoteTabState['viewMode'];
  fontSize: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'focus-next-tab': [];
  'focus-previous-tab': [];
  'open-file': [];
  'save-file': [];
  'save-file-as': [];
  'update:content': [content: string];
  'update:font-size': [fontSize: number];
  'update:view-mode': [viewMode: WorkspaceNoteTabState['viewMode']];
}>();

const rootRef = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const copyToast = ref<string | null>(null);
let copyToastTimer: number | null = null;
const NOTE_PATH_LABEL_MAX_LENGTH = 36;
const NOTE_VIEW_MODES: WorkspaceNoteTabState['viewMode'][] = ['source', 'split', 'preview'];

marked.setOptions({
  gfm: true,
  breaks: true,
});

const renderedMarkdown = computed(() => {
  if (!props.content.trim()) {
    return '<p class="note-tab__preview-empty">Nothing to preview yet.</p>';
  }

  try {
    const parsed = marked.parse(props.content);
    const html = typeof parsed === 'string' ? parsed : '';
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
    });
  } catch {
    return '<p class="note-tab__preview-error">Preview failed.</p>';
  }
});

function truncatePathStart(pathValue: string, maxLength = NOTE_PATH_LABEL_MAX_LENGTH) {
  if (pathValue.length <= maxLength) {
    return pathValue;
  }

  return `...${pathValue.slice(-(maxLength - 3))}`;
}

const noteLocationLabel = computed(() => (
  props.filePath ? truncatePathStart(props.filePath) : 'Scratch note'
));
const resolvedFontSize = computed(() => normalizeNoteFontSize(props.fontSize));
const noteStyle = computed(() => ({
  '--note-font-size-px': String(resolvedFontSize.value),
}));

const noteStatusLabel = computed(() => {
  if (props.busy) {
    return 'Working...';
  }

  if (props.filePath && props.isDirty) {
    return 'Modified';
  }

  return null;
});

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

async function copyAll() {
  if (!props.content) {
    showCopyToast('Nothing to copy');
    return;
  }

  try {
    await writeClipboard(props.content);
    showCopyToast('Copied');
  } catch {
    showCopyToast('Copy failed');
  }
}

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement | null;
  emit('update:content', target?.value ?? '');
}

function applyFontSize(nextFontSize: number) {
  const clampedFontSize = normalizeNoteFontSize(nextFontSize);

  if (clampedFontSize === resolvedFontSize.value) {
    return;
  }

  emit('update:font-size', clampedFontSize);
}

function setViewMode(nextMode: WorkspaceNoteTabState['viewMode']) {
  if (props.viewMode === nextMode) {
    return;
  }

  emit('update:view-mode', nextMode);
  void focusEditor();
}

function cycleViewMode(direction: -1 | 1) {
  const currentIndex = NOTE_VIEW_MODES.indexOf(props.viewMode);
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeCurrentIndex + direction + NOTE_VIEW_MODES.length) % NOTE_VIEW_MODES.length;
  setViewMode(NOTE_VIEW_MODES[nextIndex] ?? 'split');
}

function handleWheelZoom(event: WheelEvent) {
  if (!props.active || !event.ctrlKey) {
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

  applyFontSize(resolvedFontSize.value + zoomStep);
}

function focusHotkeySurface() {
  if (props.viewMode !== 'preview') {
    return;
  }

  rootRef.value?.focus({ preventScroll: true });
}

async function focusEditor() {
  if (!props.active) {
    return;
  }

  await nextTick();

  if (props.viewMode === 'preview') {
    rootRef.value?.focus({ preventScroll: true });
    return;
  }

  textareaRef.value?.focus();
}

function isShortcutTargetWithinNote(event: KeyboardEvent) {
  if (!props.active || props.busy || !rootRef.value) {
    return false;
  }

  if (document.querySelector('.settings-dialog, .commit-history-dialog')) {
    return false;
  }

  const eventTarget = event.target;
  const activeElement = document.activeElement;

  return (
    (eventTarget instanceof Node && rootRef.value.contains(eventTarget))
    || (activeElement instanceof Node && rootRef.value.contains(activeElement))
  );
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (!isShortcutTargetWithinNote(event)) {
    return;
  }

  if (event.defaultPrevented) {
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.terminalPreviousTab)) {
    event.preventDefault();
    emit('focus-previous-tab');
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.terminalNextTab)) {
    event.preventDefault();
    emit('focus-next-tab');
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.noteViewPrevious)) {
    event.preventDefault();
    cycleViewMode(-1);
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.noteViewNext)) {
    event.preventDefault();
    cycleViewMode(1);
    return;
  }

  if (event.altKey || !(event.ctrlKey || event.metaKey)) {
    return;
  }

  const key = event.key.toLowerCase();

  if (key === 'o' && !event.shiftKey) {
    event.preventDefault();
    emit('open-file');
    return;
  }

  if (key !== 's') {
    return;
  }

  event.preventDefault();

  if (event.shiftKey) {
    emit('save-file-as');
    return;
  }

  emit('save-file');
}

onMounted(() => {
  document.addEventListener('keydown', handleDocumentKeydown);
  void focusEditor();
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown);

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
    copyToastTimer = null;
  }
});

watch(
  () => props.active,
  (isActive) => {
    if (!isActive) {
      return;
    }

    void focusEditor();
  },
);

watch(
  () => props.viewMode,
  () => {
    void focusEditor();
  },
);

defineExpose({
  copyAll,
  focusEditor,
});
</script>

<template>
  <section ref="rootRef" class="note-tab" :style="noteStyle" tabindex="-1">
    <div class="note-tab__toolbar">
      <div class="note-tab__meta">
        <span class="note-tab__eyebrow">Notes</span>
        <div class="note-tab__meta-copy">
          <span class="note-tab__file-path" :title="filePath || noteLocationLabel">{{ noteLocationLabel }}</span>
          <span
            v-if="noteStatusLabel"
            class="note-tab__status"
            :class="{
              'note-tab__status--dirty': isDirty,
              'note-tab__status--busy': busy,
            }"
          >
            {{ noteStatusLabel }}
          </span>
        </div>
      </div>

      <div class="note-tab__file-actions">
        <button
          class="note-tab__action"
          type="button"
          :disabled="busy"
          title="Open note file [Ctrl+O]"
          aria-label="Open note file"
          @click="emit('open-file')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h4.1c.6 0 1.16.24 1.59.66l1.15 1.15c.14.14.33.22.53.22H18A2.25 2.25 0 0 1 20.25 8v8A2.25 2.25 0 0 1 18 18.25H6A2.25 2.25 0 0 1 3.75 16V6Zm2.25-.75a.75.75 0 0 0-.75.75v10c0 .41.34.75.75.75h12a.75.75 0 0 0 .75-.75V8a.75.75 0 0 0-.75-.75h-4.63a2.23 2.23 0 0 1-1.59-.66l-1.15-1.15a.75.75 0 0 0-.53-.22H6Z" />
          </svg>
        </button>

        <button
          class="note-tab__action"
          type="button"
          :disabled="busy"
          title="Save note file [Ctrl+S]"
          aria-label="Save note file"
          @click="emit('save-file')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5.75 3.75h9.7c.6 0 1.17.24 1.6.66l2.54 2.54c.42.42.66 1 .66 1.6v9.7a2.25 2.25 0 0 1-2.25 2.25H5.75A2.25 2.25 0 0 1 3.5 18V6A2.25 2.25 0 0 1 5.75 3.75Zm0 1.5a.75.75 0 0 0-.75.75v12c0 .41.34.75.75.75H18a.75.75 0 0 0 .75-.75V8.56a.76.76 0 0 0-.22-.53l-2.54-2.53a.75.75 0 0 0-.53-.22h-1.21V9a1.75 1.75 0 0 1-1.75 1.75h-3A1.75 1.75 0 0 1 7.75 9V5.25h-2Zm3.5 0V9a.25.25 0 0 0 .25.25h3A.25.25 0 0 0 12.75 9V5.25h-3.5Zm.5 8.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-4.5Z" />
          </svg>
        </button>

        <button
          class="note-tab__action"
          type="button"
          :disabled="busy"
          title="Save note file as [Ctrl+Shift+S]"
          aria-label="Save note file as"
          @click="emit('save-file-as')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5.75 3.75h9.7c.6 0 1.17.24 1.6.66l2.54 2.54c.42.42.66 1 .66 1.6v4.2a.75.75 0 0 1-1.5 0v-4.2a.76.76 0 0 0-.22-.53l-2.54-2.53a.75.75 0 0 0-.53-.22h-1.21V9a1.75 1.75 0 0 1-1.75 1.75h-3A1.75 1.75 0 0 1 7.75 9V5.25h-2A.75.75 0 0 0 5 6v12c0 .41.34.75.75.75h5.5a.75.75 0 0 1 0 1.5h-5.5A2.25 2.25 0 0 1 3.5 18V6A2.25 2.25 0 0 1 5.75 3.75Zm3.5 1.5V9a.25.25 0 0 0 .25.25h3A.25.25 0 0 0 12.75 9V5.25h-3.5Zm8.22 8.22a.75.75 0 0 1 1.06 0l2.47 2.47a.75.75 0 0 1 0 1.06l-2.47 2.47a.75.75 0 1 1-1.06-1.06l1.19-1.19h-5.91a.75.75 0 0 1 0-1.5h5.9l-1.18-1.19a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      <div class="note-tab__actions">

        <div class="note-tab__mode-toggle" role="group" aria-label="Notes view mode">
          <button
            class="note-tab__mode-button"
            :class="{ 'note-tab__mode-button--active': viewMode === 'source' }"
            type="button"
            title="Source only"
            aria-label="Source only"
            :aria-pressed="viewMode === 'source'"
            @click="setViewMode('source')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8.32 7.41a.75.75 0 0 1 0 1.06L4.78 12l3.54 3.53a.75.75 0 1 1-1.06 1.06l-4.07-4.06a.75.75 0 0 1 0-1.06L7.26 7.4a.75.75 0 0 1 1.06 0Zm7.42 0a.75.75 0 0 1 1.06 0l4.07 4.06a.75.75 0 0 1 0 1.06l-4.07 4.06a.75.75 0 1 1-1.06-1.06L19.28 12l-3.54-3.53a.75.75 0 0 1 0-1.06Zm-2.4-2.95a.75.75 0 0 1 .5.94l-3.7 14.08a.75.75 0 1 1-1.45-.38l3.7-14.08a.75.75 0 0 1 .95-.56Z" />
            </svg>
          </button>

          <button
            class="note-tab__mode-button"
            :class="{ 'note-tab__mode-button--active': viewMode === 'split' }"
            type="button"
            title="Source and preview"
            aria-label="Source and preview"
            :aria-pressed="viewMode === 'split'"
            @click="setViewMode('split')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.75 5A2.75 2.75 0 0 1 7.5 2.25h9A2.75 2.75 0 0 1 19.25 5v14A2.75 2.75 0 0 1 16.5 21.75h-9A2.75 2.75 0 0 1 4.75 19V5Zm2.75-1.25C6.81 3.75 6.25 4.31 6.25 5v14c0 .69.56 1.25 1.25 1.25H11V3.75H7.5Zm5 .01v16.49h4c.69 0 1.25-.56 1.25-1.25V5c0-.69-.56-1.25-1.25-1.25h-4Z" />
            </svg>
          </button>

          <button
            class="note-tab__mode-button"
            :class="{ 'note-tab__mode-button--active': viewMode === 'preview' }"
            type="button"
            title="Preview only"
            aria-label="Preview only"
            :aria-pressed="viewMode === 'preview'"
            @click="setViewMode('preview')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4.5c4.1 0 7.72 2.2 9.73 5.5a1.75 1.75 0 0 1 0 2c-2.01 3.3-5.63 5.5-9.73 5.5S4.28 15.3 2.27 12a1.75 1.75 0 0 1 0-2C4.28 6.7 7.9 4.5 12 4.5Zm0 1.5c-3.55 0-6.72 1.9-8.45 4.75a.25.25 0 0 0 0 .26C5.28 13.85 8.45 15.75 12 15.75s6.72-1.9 8.45-4.74a.25.25 0 0 0 0-.26C18.72 7.9 15.55 6 12 6Zm0 2.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Zm0 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" />
            </svg>
          </button>
        </div>

        <button
          class="note-tab__action"
          type="button"
          title="Copy full note"
          aria-label="Copy full note"
          @click="copyAll"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8.75 5.25A2.75 2.75 0 0 1 11.5 2.5h6A2.75 2.75 0 0 1 20.25 5.25v8.5a2.75 2.75 0 0 1-2.75 2.75h-6a2.75 2.75 0 0 1-2.75-2.75v-8.5Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v8.5c0 .69.56 1.25 1.25 1.25h6c.69 0 1.25-.56 1.25-1.25v-8.5c0-.69-.56-1.25-1.25-1.25h-6Zm-5 4A2.75 2.75 0 0 1 9.25 10.75V18A2.75 2.75 0 0 0 12 20.75h6.25a.75.75 0 0 1 0 1.5H12A4.25 4.25 0 0 1 7.75 18v-7.25a.75.75 0 0 1-1.5 0V8.5A2.75 2.75 0 0 1 9 5.75h1.25a.75.75 0 0 1 0 1.5H9A1.25 1.25 0 0 0 7.75 8.5Z" />
          </svg>
        </button>
      </div>
    </div>

    <div
      class="note-tab__body"
      :class="{
        'note-tab__body--source-only': viewMode === 'source',
        'note-tab__body--preview-only': viewMode === 'preview',
      }"
      @wheel.capture="handleWheelZoom"
    >
      <div class="note-tab__source" :class="{ 'note-tab__source--hidden': viewMode === 'preview' }">
        <textarea
          ref="textareaRef"
          class="note-tab__input"
          :value="content"
          spellcheck="false"
          placeholder="Write markdown notes, prompts, and snippets..."
          @input="handleInput"
        />
      </div>

      <div
        class="note-tab__preview"
        :class="{ 'note-tab__preview--hidden': viewMode === 'source' }"
        @pointerdown="focusHotkeySurface"
      >
        <article class="note-tab__markdown" v-html="renderedMarkdown" />
      </div>
    </div>

    <transition name="note-tab-toast">
      <div v-if="copyToast" class="note-tab__toast">
        {{ copyToast }}
      </div>
    </transition>
  </section>
</template>

<style scoped lang="scss">
.note-tab {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 10px;
}

.note-tab:focus {
  outline: none;
}

.note-tab__toolbar {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 12px;
}

.note-tab__meta {
  display: grid;
  gap: 4px;
  min-width: 0;
  max-width: 28rem;
}

.note-tab__eyebrow {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.note-tab__meta-copy {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.note-tab__file-path {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-tab__status {
  color: rgba(168, 182, 196, 0.78);
  font-size: 0.72rem;
  white-space: nowrap;
}

.note-tab__status--dirty {
  color: rgba(255, 192, 118, 0.92);
}

.note-tab__status--busy {
  color: rgba(122, 200, 255, 0.9);
}

.note-tab__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  justify-self: end;
  min-width: 0;
}

.note-tab__file-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  grid-column: 2;
  justify-self: center;
}

.note-tab__mode-toggle {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
}

.note-tab__mode-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 31px;
  height: 30px;
  border: 0;
  border-right: 1px solid var(--border-subtle);
  background: rgba(13, 18, 25, 0.9);
  color: rgba(188, 201, 215, 0.82);
}

.note-tab__mode-button:last-child {
  border-right: 0;
}

.note-tab__mode-button:hover {
  color: #eff6ff;
  background: rgba(21, 30, 41, 0.94);
}

.note-tab__mode-button--active {
  background: rgba(47, 91, 124, 0.56);
  color: #f2f9ff;
}

.note-tab__mode-button svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.note-tab__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: rgba(14, 20, 27, 0.88);
  color: var(--text-primary);
}

.note-tab__action:hover {
  border-color: rgba(110, 197, 255, 0.2);
  background: rgba(24, 33, 43, 0.92);
}

.note-tab__action:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.note-tab__action svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.note-tab__body {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

.note-tab__body--source-only,
.note-tab__body--preview-only {
  grid-template-columns: minmax(0, 1fr);
}

.note-tab__source,
.note-tab__preview {
  min-height: 0;
}

.note-tab__source--hidden,
.note-tab__preview--hidden {
  display: none;
}

.note-tab__input {
  width: 100%;
  height: 100%;
  min-height: 0;
  resize: none;
  padding: 16px 18px;
  border: 1px solid rgba(108, 124, 148, 0.16);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(17, 24, 33, 0.96), rgba(12, 17, 24, 0.98));
  color: var(--text-primary);
  font-family: var(--font-mono), 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', monospace;
  font-size: calc(var(--note-font-size-px, 14) * 1px);
  font-weight: 500;
  line-height: 1.55;
  outline: none;
}

.note-tab__input:focus {
  border-color: rgba(110, 197, 255, 0.34);
  box-shadow: inset 0 0 0 1px rgba(110, 197, 255, 0.14);
}

.note-tab__input::placeholder {
  color: rgba(173, 184, 197, 0.48);
}

.note-tab__preview {
  overflow: auto;
  border: 1px solid rgba(108, 124, 148, 0.16);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(12, 18, 25, 0.96), rgba(10, 15, 21, 0.98));
  padding: 16px 18px;
}

.note-tab__markdown {
  color: var(--text-primary);
  font-size: calc(var(--note-font-size-px, 14) * 1px);
  line-height: 1.62;
  word-break: break-word;
  font-family: var(--font-mono), 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', monospace;
}

.note-tab__markdown :deep(.note-tab__preview-empty),
.note-tab__markdown :deep(.note-tab__preview-error) {
  margin: 0;
  color: rgba(173, 184, 197, 0.6);
}

.note-tab__markdown :deep(h1),
.note-tab__markdown :deep(h2),
.note-tab__markdown :deep(h3),
.note-tab__markdown :deep(h4),
.note-tab__markdown :deep(h5),
.note-tab__markdown :deep(h6) {
  margin: 1.2em 0 0.5em;
  font-weight: 700;
  color: #f6fbff;
}

.note-tab__markdown :deep(h1) {
  font-size: 1.44em;
}

.note-tab__markdown :deep(h2) {
  font-size: 1.28em;
}

.note-tab__markdown :deep(h3) {
  font-size: 1.16em;
}

.note-tab__markdown :deep(p),
.note-tab__markdown :deep(ul),
.note-tab__markdown :deep(ol),
.note-tab__markdown :deep(blockquote),
.note-tab__markdown :deep(pre) {
  margin: 0.65em 0;
}

.note-tab__markdown :deep(ul),
.note-tab__markdown :deep(ol) {
  padding-inline-start: 1.5em;
}

.note-tab__markdown :deep(table) {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  margin: 0.85em 0;
  border: 1px solid rgba(108, 124, 148, 0.36);
  background: rgba(11, 16, 23, 0.92);
}

.note-tab__markdown :deep(th),
.note-tab__markdown :deep(td) {
  border: 1px solid rgba(108, 124, 148, 0.28);
  padding: 0.46em 0.62em;
  text-align: left;
  vertical-align: top;
}

.note-tab__markdown :deep(th) {
  background: rgba(53, 78, 102, 0.28);
  color: #f6fbff;
  font-weight: 600;
}

.note-tab__markdown :deep(tbody tr:nth-child(even) td) {
  background: rgba(47, 66, 84, 0.17);
}

.note-tab__markdown :deep(.task-list-item) {
  list-style: none;
  margin-left: -1.2em;
}

.note-tab__markdown :deep(.task-list-item input[type='checkbox']) {
  margin-right: 0.42em;
  accent-color: #66b9f6;
}

.note-tab__markdown :deep(blockquote) {
  margin-inline: 0;
  padding: 0.5em 0.8em;
  border-left: 3px solid rgba(110, 197, 255, 0.55);
  background: rgba(55, 88, 112, 0.16);
  border-radius: 8px;
  color: rgba(231, 241, 249, 0.92);
}

.note-tab__markdown :deep(code) {
  border: 1px solid rgba(108, 124, 148, 0.3);
  border-radius: 6px;
  background: rgba(16, 24, 34, 0.96);
  padding: 0.08em 0.34em;
  font: 500 0.82em/1.4 var(--font-mono);
}

.note-tab__markdown :deep(pre) {
  overflow: auto;
  border: 1px solid rgba(108, 124, 148, 0.3);
  border-radius: 10px;
  background: rgba(10, 15, 22, 0.96);
  padding: 10px 12px;
}

.note-tab__markdown :deep(pre code) {
  border: 0;
  background: transparent;
  padding: 0;
}

.note-tab__markdown :deep(a) {
  color: #7ac8ff;
  text-decoration-color: rgba(122, 200, 255, 0.45);
}

.note-tab__toast {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 2;
  padding: 0.42rem 0.72rem;
  border: 1px solid rgba(110, 197, 255, 0.26);
  border-radius: 10px;
  background: rgba(8, 12, 17, 0.98);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  color: #f2f8ff;
  font-size: 0.76rem;
  font-weight: 600;
}

.note-tab-toast-enter-active,
.note-tab-toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.note-tab-toast-enter-from,
.note-tab-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 980px) {
  .note-tab__toolbar {
    align-items: flex-start;
    grid-template-columns: minmax(0, 1fr);
  }

  .note-tab__file-actions,
  .note-tab__actions {
    flex-wrap: wrap;
    justify-self: start;
  }

  .note-tab__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
