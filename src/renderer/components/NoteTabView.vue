<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  type DecorationSet,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  type AppLanguage,
  normalizeNoteFontSize,
  type AppAppearance,
  type ResolvedEditorTheme,
  type ThemeVariant,
  type WorkspaceEditorCursorState,
  type WorkspaceExternalFileChangeState,
  type WorkspaceNoteTabState,
} from '../../shared/bridgegit';
import {
  readClipboardText as readSharedClipboardText,
  writeClipboardText as writeSharedClipboardText,
} from '../clipboard';
import { bridgeGitEditorChromeTheme, getCodeEditorThemeExtension } from '../codemirror/codeEditor';
import { useClipboardHistoryTarget } from '../composables/useClipboardHistoryTarget';
import { useColumnSplitter } from '../composables/useColumnSplitter';
import { t } from '../i18n';
import { SHORTCUTS, matchesShortcut, shortcutBindingsRevision } from '../shortcuts';

interface Props {
  active: boolean;
  appLanguage: AppLanguage;
  busy: boolean;
  content: string;
  externalChange: WorkspaceExternalFileChangeState | null;
  filePath: string | null;
  isDirty: boolean;
  projectRoot: string | null;
  appearanceTheme: AppAppearance;
  appearanceThemeVariant: ThemeVariant;
  editorTheme: ResolvedEditorTheme;
  themeVariant: ThemeVariant;
  viewMode: WorkspaceNoteTabState['viewMode'];
  splitRatio: number;
  lineNumbersEnabled: boolean;
  lineWrappingEnabled: boolean;
  fontSize: number;
  rightClickPasteEnabled: boolean;
  selectionAutoCopyEnabled: boolean;
  cursor?: WorkspaceEditorCursorState;
}

const props = defineProps<Props>();
const shortcutBindingsVersion = shortcutBindingsRevision;
const tt = (key: string, params?: Record<string, string | number>) => t(props.appLanguage, key, params);

const emit = defineEmits<{
  'dismiss-external-change': [];
  'focus-next-tab': [];
  'focus-previous-tab': [];
  'open-file': [];
  'open-note-link': [filePath: string];
  'reveal-in-all-files': [];
  'reload-from-disk': [];
  'save-file': [];
  'save-file-as': [];
  'update:content': [content: string];
  'update:cursor': [cursor: WorkspaceEditorCursorState];
  'update:font-size': [fontSize: number];
  'update:line-numbers-enabled': [enabled: boolean];
  'update:line-wrapping-enabled': [enabled: boolean];
  'update:split-ratio': [splitRatio: number];
  'update:view-mode': [viewMode: WorkspaceNoteTabState['viewMode']];
}>();

const rootRef = ref<HTMLElement | null>(null);
const editorRootRef = ref<HTMLElement | null>(null);
const previewRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const copyToast = ref<string | null>(null);
const filePathMenu = ref<{ x: number; y: number } | null>(null);
const taskStateMenu = ref<{ x: number; y: number; taskIndex: number } | null>(null);
const taskCopyMenu = ref<{ x: number; y: number; taskIndex: number } | null>(null);
const previewLens = ref<'preview' | 'tasks'>('preview');
const taskFilter = ref<'all' | NoteTaskState>('all');
const activeTaskTagFilter = ref<string | null>(null);
const searchVisible = ref(false);
const searchQuery = ref('');
const activePreviewMatchIndex = ref(0);
const previewMatchCount = ref(0);
const renderedMarkdown = ref('');

const editableCompartment = new Compartment();
const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
const lineNumbersCompartment = new Compartment();
const lineWrappingCompartment = new Compartment();
let editorView: EditorView | null = null;
let suppressContentSync = false;
const lineNumbersEnabled = ref(props.lineNumbersEnabled);
const lineWrappingEnabled = ref(props.lineWrappingEnabled);
let copyToastTimer: number | null = null;
let copySelectionTimer: number | null = null;
let lastCopiedSelection: string | null = null;
let selectionPointerActive = false;
let selectionCopyPendingAfterPointer = false;
let selectionKeyboardActive = false;
let selectionCopyPendingAfterKeyboard = false;
let selectionKeyboardMode: 'range' | 'select-all' | null = null;
let markdownRenderToken = 0;
let mermaidInitialized = false;
let mermaidThemeVariant: ThemeVariant | null = null;
let nextMermaidDiagramId = 1;
const NOTE_PATH_LABEL_MAX_LENGTH = 36;
const FILE_PATH_MENU_WIDTH = 220;
const FILE_PATH_MENU_HEIGHT = 168;
const TASK_STATE_MENU_WIDTH = 196;
const TASK_STATE_MENU_HEIGHT = 232;
const TASK_COPY_MENU_WIDTH = 176;
const TASK_COPY_MENU_HEIGHT = 116;
const NOTE_VIEW_MODES: WorkspaceNoteTabState['viewMode'][] = ['source', 'split', 'preview'];
const NOTE_FILE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const TASK_LINE_PATTERN = /^(\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?\[)([ xX./\-!])(\].*)$/;
const BARE_TASK_MARKER_PATTERN = /^(\s*(?:>\s*)*)\[[ xX./\-!]\]/;
const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  yml: 'yaml',
  patch: 'diff',
};
const WIKI_LINK_TOKENIZER = {
  name: 'wikilink',
  level: 'inline',
  start(src: string) {
    return src.match(/\[\[/)?.index;
  },
  tokenizer(src: string) {
    const match = /^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(src);

    if (!match) {
      return undefined;
    }

    return {
      type: 'wikilink',
      raw: match[0],
      href: match[1]?.trim() ?? '',
      text: match[2]?.trim() || match[1]?.trim() || '',
      tokens: [],
    };
  },
  renderer(token: { href: string; text: string }) {
    return `<a href="#" data-note-link="${escapeHtmlAttribute(token.href)}">${escapeHtml(token.text)}</a>`;
  },
};

type NoteTaskState = 'open' | 'in-progress' | 'waiting' | 'done' | 'cancelled';

interface RenderedMarkdownTask {
  taskIndex: number;
  state: NoteTaskState;
  isBare: boolean;
}

interface ParsedNoteTask {
  taskIndex: number;
  lineIndex: number;
  state: NoteTaskState;
  text: string;
  tags: string[];
  rawText: string;
  sourceLine: string;
}

const TASK_STATE_MARKERS: Record<NoteTaskState, string> = {
  open: ' ',
  'in-progress': '/',
  waiting: '-',
  done: 'x',
  cancelled: '!',
};

const bareTaskMarkerDecoration = Decoration.mark({
  class: 'note-tab__bare-task-marker',
});

function buildBareTaskMarkerDecorations(state: EditorState): DecorationSet {
  const decorations = [];
  let activeFenceMarker: '`' | '~' | null = null;
  let activeFenceLength = 0;

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line.text);

    if (fenceMatch) {
      const markerCharacter = fenceMatch[2]?.[0];
      const markerLength = fenceMatch[2]?.length ?? 0;

      if (!activeFenceMarker) {
        activeFenceMarker = markerCharacter === '~' ? '~' : '`';
        activeFenceLength = markerLength;
      } else if (markerCharacter === activeFenceMarker && markerLength >= activeFenceLength) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      }

      continue;
    }

    if (activeFenceMarker) {
      continue;
    }

    const match = BARE_TASK_MARKER_PATTERN.exec(line.text);

    if (!match) {
      continue;
    }

    const markerStart = line.from + (match[1]?.length ?? 0);
    decorations.push(bareTaskMarkerDecoration.range(markerStart, markerStart + 3));
  }

  return Decoration.set(decorations);
}

const bareTaskMarkerField = StateField.define<DecorationSet>({
  create: buildBareTaskMarkerDecorations,
  update(value, transaction) {
    return transaction.docChanged ? buildBareTaskMarkerDecorations(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const taskStateMenuItems = computed<Array<{ state: NoteTaskState; label: string }>>(() => [
  { state: 'open', label: tt('note.task.state.open') },
  { state: 'in-progress', label: tt('note.task.state.inProgress') },
  { state: 'waiting', label: tt('note.task.state.waiting') },
  { state: 'done', label: tt('note.task.state.done') },
  { state: 'cancelled', label: tt('note.task.state.cancelled') },
]);
const taskFilterItems = computed<Array<{ value: 'all' | NoteTaskState; label: string }>>(() => [
  { value: 'all', label: tt('note.task.filter.all') },
  { value: 'open', label: tt('note.task.state.open') },
  { value: 'in-progress', label: tt('note.task.filter.active') },
  { value: 'waiting', label: tt('note.task.state.waiting') },
  { value: 'done', label: tt('note.task.state.done') },
  { value: 'cancelled', label: tt('note.task.state.cancelled') },
]);

marked.use({
  extensions: [WIKI_LINK_TOKENIZER as never],
});

marked.setOptions({
  gfm: true,
  breaks: true,
});

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value);
}

function previewEmptyHtml() {
  return `<p class="note-tab__preview-empty">${escapeHtml(tt('note.preview.empty'))}</p>`;
}

function previewErrorHtml() {
  return `<p class="note-tab__preview-error">${escapeHtml(tt('note.preview.failed'))}</p>`;
}

function getTaskStateFromMarker(marker: string): NoteTaskState | null {
  switch (marker) {
    case ' ':
      return 'open';
    case '/':
    case '.':
      return 'in-progress';
    case '-':
      return 'waiting';
    case 'x':
    case 'X':
      return 'done';
    case '!':
      return 'cancelled';
    default:
      return null;
  }
}

function isNoteTaskState(value: string | null | undefined): value is NoteTaskState {
  return value === 'open'
    || value === 'in-progress'
    || value === 'waiting'
    || value === 'done'
    || value === 'cancelled';
}

function getTaskStateLabel(state: NoteTaskState) {
  switch (state) {
    case 'open':
      return tt('note.task.state.open');
    case 'in-progress':
      return tt('note.task.state.inProgress');
    case 'waiting':
      return tt('note.task.state.waiting');
    case 'done':
      return tt('note.task.state.done');
    case 'cancelled':
      return tt('note.task.state.cancelled');
    default:
      return tt('note.task.state.task');
  }
}

function getTaskStateGlyph(state: NoteTaskState) {
  switch (state) {
    case 'in-progress':
      return '/';
    case 'waiting':
      return '-';
    case 'done':
      return 'x';
    case 'cancelled':
      return '!';
    case 'open':
    default:
      return '';
  }
}

function getTaskStateMarkerLabel(state: NoteTaskState) {
  const marker = TASK_STATE_MARKERS[state];
  return `[${marker === ' ' ? ' ' : marker}]`;
}

function getTaskStateIconSvg(state: NoteTaskState, includeFrame = false) {
  const frame = includeFrame
    ? '<rect x="3.1" y="1.9" width="9.8" height="12.2" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    : '';

  switch (state) {
    case 'in-progress':
      return `${frame}<path d="M5.7 10.9 10.3 5.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
    case 'waiting':
      return `${frame}<path d="M5.2 8h5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
    case 'done':
      return `${frame}<path d="m4.9 8.1 2.3 2.4 4.1-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'cancelled':
      return `${frame}<path d="M8 4.9v4.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.7" r="0.95" fill="currentColor"/>`;
    case 'open':
    default:
      return frame;
  }
}

function getNextPrimaryTaskState(currentState: NoteTaskState): NoteTaskState {
  switch (currentState) {
    case 'open':
      return 'in-progress';
    case 'in-progress':
      return 'done';
    case 'waiting':
      return 'in-progress';
    case 'cancelled':
      return 'open';
    case 'done':
    default:
      return 'open';
  }
}

function extractTaskTags(text: string) {
  const matches = text.match(/(^|\s)#([a-zA-Z0-9_-]+)/g) ?? [];
  const tags: string[] = [];
  const seen = new Set<string>();

  matches.forEach((match) => {
    const normalizedTag = match.trim().slice(1);
    const comparableTag = normalizedTag.toLocaleLowerCase();

    if (!normalizedTag || seen.has(comparableTag)) {
      return;
    }

    seen.add(comparableTag);
    tags.push(normalizedTag);
  });

  return tags;
}

function stripTaskTags(text: string) {
  return text.replace(/(^|\s)#[a-zA-Z0-9_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasMarkdownTaskListPrefix(prefix: string) {
  return /(?:^|\s|>)(?:[-*+]|\d+[.)])\s+\[$/.test(prefix);
}

function buildRenderedTaskPrefix(prefix: string) {
  if (hasMarkdownTaskListPrefix(prefix)) {
    return prefix;
  }

  return `${prefix.slice(0, -1)}- [`;
}

function parseNoteTasks(content: string) {
  const lines = content.split('\n');
  const parsedTasks: ParsedNoteTask[] = [];
  const renderedTasks: RenderedMarkdownTask[] = [];
  let taskIndex = 0;
  let activeFenceMarker: '`' | '~' | null = null;
  let activeFenceLength = 0;

  const nextLines = lines.map((line, lineIndex) => {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);

    if (fenceMatch) {
      const markerCharacter = fenceMatch[2]?.[0];
      const markerLength = fenceMatch[2]?.length ?? 0;

      if (!activeFenceMarker) {
        activeFenceMarker = markerCharacter === '~' ? '~' : '`';
        activeFenceLength = markerLength;
      } else if (markerCharacter === activeFenceMarker && markerLength >= activeFenceLength) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      }

      return line;
    }

    if (activeFenceMarker) {
      return line;
    }

    const match = TASK_LINE_PATTERN.exec(line);

    if (!match) {
      return line;
    }

    const state = getTaskStateFromMarker(match[2] ?? '');

    if (!state) {
      return line;
    }

    const taskPrefix = match[1] ?? '';
    const isBareTask = !hasMarkdownTaskListPrefix(taskPrefix);
    const rawText = (match[3] ?? '').replace(/^\]\s*/, '').trim();

    renderedTasks.push({
      taskIndex,
      state,
      isBare: isBareTask,
    });
    parsedTasks.push({
      taskIndex,
      lineIndex,
      state,
      rawText,
      text: stripTaskTags(rawText),
      tags: extractTaskTags(rawText),
      sourceLine: line.trimEnd(),
    });
    taskIndex += 1;

    return `${buildRenderedTaskPrefix(taskPrefix)}${state === 'done' ? 'x' : ' '}${match[3]}`;
  });

  return {
    parsedTasks,
    renderedMarkdownContent: nextLines.join('\n'),
    renderedTasks,
  };
}

function isWindowsAbsolutePath(pathValue: string) {
  return /^[a-zA-Z]:[\\/]/.test(pathValue);
}

function hasPotentialNoteExtension(pathValue: string) {
  const fileName = pathValue.split(/[\\/]/).at(-1) ?? '';
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  return NOTE_FILE_EXTENSIONS.has(extension);
}

function hasAnyFileExtension(pathValue: string) {
  const fileName = pathValue.split(/[\\/]/).at(-1) ?? '';
  return /\.[^./]+$/.test(fileName);
}

function isPotentialNoteLink(href: string, baseFilePath: string | null) {
  const decodedHref = decodeURIComponent(href.trim()).split('#')[0]?.split('?')[0]?.trim() ?? '';

  if (!decodedHref) {
    return false;
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decodedHref) && !isWindowsAbsolutePath(decodedHref)) {
    return false;
  }

  if (decodedHref.startsWith('//')) {
    return false;
  }

  if (decodedHref.startsWith('/') || isWindowsAbsolutePath(decodedHref)) {
    return hasPotentialNoteExtension(decodedHref) || !hasAnyFileExtension(decodedHref);
  }

  if (!baseFilePath) {
    return false;
  }

  return hasPotentialNoteExtension(decodedHref) || !hasAnyFileExtension(decodedHref);
}

function slugifyHeading(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeCodeLanguage(language: string | null) {
  if (!language) {
    return null;
  }

  const normalizedLanguage = language.trim().toLocaleLowerCase();

  if (!normalizedLanguage) {
    return null;
  }

  return CODE_LANGUAGE_ALIASES[normalizedLanguage] ?? normalizedLanguage;
}

function resolveCodeLanguage(codeElement: HTMLElement) {
  const className = codeElement.className || '';

  for (const token of className.split(/\s+/)) {
    if (token.startsWith('language-')) {
      return normalizeCodeLanguage(token.slice('language-'.length));
    }
  }

  return null;
}

type CodeBlockHighlighter = (code: string, language: string | null) => string;

function enhanceRenderedMarkdownHtml(
  html: string,
  baseFilePath: string | null,
  renderedTasks: RenderedMarkdownTask[],
  highlightCodeBlock?: CodeBlockHighlighter,
) {
  const parser = new DOMParser();
  const documentRoot = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const container = documentRoot.body;
  const headingSlugCounts = new Map<string, number>();
  const headingItems: Array<{ id: string; level: number; label: string }> = [];
  const calloutTitles: Record<string, string> = {
    note: tt('note.callout.note'),
    tip: tt('note.callout.tip'),
    warning: tt('note.callout.warning'),
    important: tt('note.callout.important'),
    caution: tt('note.callout.caution'),
  };

  container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox, index) => {
    const renderedTask = renderedTasks[index];
    const taskState = renderedTask?.state ?? (checkbox.checked ? 'done' : 'open');
    const taskItem = checkbox.closest<HTMLElement>('li');
    const toggle = documentRoot.createElement('button');
    toggle.className = `note-tab__task-toggle note-tab__task-toggle--${taskState}`;
    toggle.type = 'button';
    toggle.setAttribute('data-task-index', String(renderedTask?.taskIndex ?? index));
    toggle.setAttribute('data-task-state', taskState);
    toggle.setAttribute('aria-label', `Task state: ${getTaskStateLabel(taskState)}`);
    toggle.setAttribute('title', `Task state: ${getTaskStateLabel(taskState)}`);
    const icon = documentRoot.createElement('span');
    icon.className = 'note-tab__task-toggle-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg viewBox="0 0 16 16" focusable="false">${getTaskStateIconSvg(taskState, true)}</svg>`;
    toggle.append(icon);

    taskItem?.classList.add('note-tab__task-item');
    taskItem?.classList.add(`note-tab__task-item--${taskState}`);
    if (renderedTask?.isBare) {
      taskItem?.classList.add('note-tab__task-item--bare');
    }
    taskItem?.setAttribute('data-task-index', String(renderedTask?.taskIndex ?? index));
    taskItem?.setAttribute('data-task-state', taskState);

    if (!taskItem) {
      checkbox.replaceWith(toggle);
      return;
    }

    const content = documentRoot.createElement('div');
    content.className = 'note-tab__task-content';
    let nextSibling = checkbox.nextSibling;

    while (nextSibling) {
      const currentNode = nextSibling;
      nextSibling = nextSibling.nextSibling;
      content.append(currentNode);
    }

    checkbox.replaceWith(toggle);
    taskItem.append(content);
  });

  container.querySelectorAll<HTMLElement>('pre > code').forEach((codeElement) => {
    const preElement = codeElement.parentElement;
    const language = resolveCodeLanguage(codeElement);
    const codeText = codeElement.textContent ?? '';

    if (!preElement) {
      return;
    }

    const wrapper = documentRoot.createElement('div');
    wrapper.className = 'note-tab__code-block';
    wrapper.dataset.noteSource = codeText;
    const toolbar = documentRoot.createElement('div');
    toolbar.className = 'note-tab__code-toolbar';
    if (language) {
      const languageBadge = documentRoot.createElement('span');
      languageBadge.className = 'note-tab__code-language';
      languageBadge.textContent = language;
      toolbar.append(languageBadge);
    }
    const copyButton = documentRoot.createElement('button');
    copyButton.className = 'note-tab__code-copy';
    copyButton.type = 'button';
    copyButton.textContent = tt('note.copy');
    toolbar.append(copyButton);

    if (language === 'mermaid') {
      const diagramContainer = documentRoot.createElement('div');
      diagramContainer.className = 'note-tab__mermaid';
      diagramContainer.setAttribute('data-mermaid-source', codeText);
      diagramContainer.setAttribute('data-mermaid-state', 'pending');
      preElement.replaceWith(wrapper);
      wrapper.append(toolbar, diagramContainer);
      return;
    }

    codeElement.innerHTML = highlightCodeBlock
      ? highlightCodeBlock(codeText, language)
      : escapeHtml(codeText);
    preElement.replaceWith(wrapper);
    wrapper.append(toolbar, preElement);
  });

  container.querySelectorAll('blockquote').forEach((blockquote) => {
    const firstParagraph = blockquote.querySelector('p');

    if (!firstParagraph) {
      return;
    }

    const calloutMatch = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/i.exec(firstParagraph.textContent?.trimStart() ?? '');

    if (!calloutMatch) {
      return;
    }

    const calloutType = calloutMatch[1].toLowerCase();
    const title = calloutTitles[calloutType] ?? calloutMatch[1];
    blockquote.classList.add('note-tab__callout', `note-tab__callout--${calloutType}`);

    const header = documentRoot.createElement('div');
    header.className = 'note-tab__callout-title';
    header.textContent = title;
    blockquote.prepend(header);

    firstParagraph.innerHTML = firstParagraph.innerHTML.replace(/^\[![A-Z]+\]\s*/i, '');

    if (!firstParagraph.textContent?.trim()) {
      firstParagraph.remove();
    }
  });

  container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const headingLabel = (heading.textContent ?? '').trim();
    const baseSlug = slugifyHeading(headingLabel) || 'section';
    const slugCount = headingSlugCounts.get(baseSlug) ?? 0;
    headingSlugCounts.set(baseSlug, slugCount + 1);
    const headingId = slugCount === 0 ? baseSlug : `${baseSlug}-${slugCount + 1}`;
    heading.id = headingId;
    headingItems.push({
      id: headingId,
      level: Number.parseInt(heading.tagName.slice(1), 10),
      label: headingLabel,
    });

    const anchor = documentRoot.createElement('a');
    anchor.className = 'note-tab__heading-anchor';
    anchor.href = `#${headingId}`;
    anchor.setAttribute('aria-label', tt('note.heading.linkTo', { label: headingLabel || tt('note.heading.section') }));
    anchor.textContent = '#';
    heading.append(documentRoot.createTextNode(' '), anchor);
  });

  container.querySelectorAll('p').forEach((paragraph) => {
    const tocMatch = /^\[\[?toc\]?\]$/i.exec(paragraph.textContent?.trim() ?? '');

    if (!tocMatch || !headingItems.length) {
      return;
    }

    const nav = documentRoot.createElement('nav');
    nav.className = 'note-tab__toc';
    nav.setAttribute('aria-label', tt('note.toc.aria'));
    const title = documentRoot.createElement('div');
    title.className = 'note-tab__toc-title';
    title.textContent = tt('note.toc.contents');
    nav.append(title);
    const list = documentRoot.createElement('ol');
    list.className = 'note-tab__toc-list';

    headingItems.forEach((headingItem) => {
      const item = documentRoot.createElement('li');
      item.className = 'note-tab__toc-item';
      item.style.setProperty('--note-toc-level', String(Math.max(1, headingItem.level - 1)));
      const link = documentRoot.createElement('a');
      link.href = `#${headingItem.id}`;
      link.textContent = headingItem.label;
      item.append(link);
      list.append(item);
    });

    nav.append(list);
    paragraph.replaceWith(nav);
  });

  container.querySelectorAll<HTMLAnchorElement>('a').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    const noteLinkCandidate = anchor.dataset.noteLink?.trim() || href;

    if (isPotentialNoteLink(noteLinkCandidate, baseFilePath)) {
      anchor.dataset.noteLink = noteLinkCandidate;
      anchor.setAttribute('href', '#');
      return;
    }

    if (href.startsWith('#')) {
      return;
    }

    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noreferrer noopener');
  });

  return container.innerHTML;
}

async function updateRenderedMarkdown() {
  const renderToken = ++markdownRenderToken;

  if (!props.content.trim()) {
    renderedMarkdown.value = previewEmptyHtml();
    return;
  }

  try {
    const { renderedMarkdownContent, renderedTasks } = parsedNoteTaskState.value;
    const parsed = marked.parse(renderedMarkdownContent);
    const html = typeof parsed === 'string' ? parsed : '';
    const sanitizedHtml = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
    });

    const previewHtml = enhanceRenderedMarkdownHtml(sanitizedHtml, props.filePath, renderedTasks);

    if (renderToken !== markdownRenderToken) {
      return;
    }

    renderedMarkdown.value = previewHtml;

    if (!/<pre>\s*<code/i.test(sanitizedHtml)) {
      return;
    }

    try {
      const { renderHighlightedCodeHtml } = await import('../codemirror/codeEditor');

      if (renderToken !== markdownRenderToken) {
        return;
      }

      renderedMarkdown.value = enhanceRenderedMarkdownHtml(
        sanitizedHtml,
        props.filePath,
        renderedTasks,
        renderHighlightedCodeHtml,
      );
    } catch (error) {
      console.error('Failed to load markdown code highlighting.', error);
    }
  } catch {
    if (renderToken !== markdownRenderToken) {
      return;
    }

    renderedMarkdown.value = previewErrorHtml();
  }
}

async function renderMermaidDiagrams() {
  const markdownRoot = previewRef.value?.querySelector('.note-tab__markdown');

  if (!markdownRoot) {
    return;
  }

  const diagramNodes = Array.from(
    markdownRoot.querySelectorAll<HTMLElement>('.note-tab__mermaid[data-mermaid-source]'),
  );

  if (!diagramNodes.length) {
    return;
  }

  const mermaidModule = await import('mermaid');
  const mermaid = mermaidModule.default;

  if (!mermaidInitialized || mermaidThemeVariant !== props.appearanceThemeVariant) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: props.appearanceThemeVariant === 'light' ? 'default' : 'dark',
      suppressErrorRendering: true,
    });
    mermaidInitialized = true;
    mermaidThemeVariant = props.appearanceThemeVariant;
  }

  await Promise.all(diagramNodes.map(async (diagramNode) => {
    if (diagramNode.dataset.mermaidState === 'rendered') {
      return;
    }

    if (diagramNode.closest('details:not([open])')) {
      return;
    }

    const source = diagramNode.dataset.mermaidSource ?? '';

    if (!source) {
      return;
    }

    const diagramId = `bridgegit-mermaid-${nextMermaidDiagramId++}`;

    try {
      const { svg, bindFunctions } = await mermaid.render(diagramId, source);
      diagramNode.innerHTML = svg;
      bindFunctions?.(diagramNode);
      diagramNode.dataset.mermaidState = 'rendered';
    } catch (error) {
      console.error('Failed to render mermaid diagram.', error);
      diagramNode.dataset.mermaidState = 'error';
      diagramNode.innerHTML = `
        <div class="note-tab__mermaid-error">
          <strong>${escapeHtml(tt('note.mermaid.failed'))}</strong>
          <span>${escapeHtml(tt('note.mermaid.copyAvailable'))}</span>
        </div>
      `;
    }
  }));
}

function markPendingMermaidDiagramsAsError(message: string) {
  const markdownRoot = previewRef.value?.querySelector('.note-tab__markdown');

  if (!markdownRoot) {
    return;
  }

  markdownRoot.querySelectorAll<HTMLElement>('.note-tab__mermaid[data-mermaid-state="pending"]').forEach((diagramNode) => {
    diagramNode.dataset.mermaidState = 'error';
    diagramNode.innerHTML = `
      <div class="note-tab__mermaid-error">
        <strong>${escapeHtml(tt('note.mermaid.failed'))}</strong>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  });
}

async function refreshRenderedPreviewDecorations() {
  await nextTick();

  try {
    await renderMermaidDiagrams();
  } catch (error) {
    console.error('Failed to initialize mermaid preview.', error);
    markPendingMermaidDiagramsAsError(tt('note.mermaid.initFailed'));
  }

  if (!searchVisible.value) {
    return;
  }

  await refreshPreviewSearch();
}

function truncatePathStart(pathValue: string, maxLength = NOTE_PATH_LABEL_MAX_LENGTH) {
  if (pathValue.length <= maxLength) {
    return pathValue;
  }

  return `...${pathValue.slice(-(maxLength - 3))}`;
}

function normalizePathForComparison(pathValue: string) {
  const normalizedPath = pathValue.replace(/\\/g, '/').replace(/\/+$/, '');
  return window.bridgegit?.platform === 'win32'
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function resolveProjectRelativePath(filePath: string | null, projectRoot: string | null) {
  if (!filePath || !projectRoot) {
    return null;
  }

  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedProjectRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const comparableFilePath = normalizePathForComparison(filePath);
  const comparableProjectRoot = normalizePathForComparison(projectRoot);

  if (!comparableFilePath || !comparableProjectRoot) {
    return null;
  }

  if (comparableFilePath === comparableProjectRoot) {
    return noteFileNameLabel.value;
  }

  const comparablePrefix = `${comparableProjectRoot}/`;

  if (!comparableFilePath.startsWith(comparablePrefix)) {
    return null;
  }

  return normalizedFilePath.slice(normalizedProjectRoot.length + 1);
}

const noteLocationLabel = computed(() => (
  props.filePath ? truncatePathStart(props.filePath) : tt('note.scratch')
));
const noteFileNameLabel = computed(() => (
  props.filePath?.split(/[\\/]/).at(-1)?.trim() || noteLocationLabel.value
));
const projectRelativePathLabel = computed(() => resolveProjectRelativePath(props.filePath, props.projectRoot));
const resolvedFontSize = computed(() => normalizeNoteFontSize(props.fontSize));
const noteStyle = computed(() => ({
  '--note-font-size-px': String(resolvedFontSize.value),
}));
const parsedNoteTaskState = computed(() => parseNoteTasks(props.content));
const parsedNoteTasks = computed(() => parsedNoteTaskState.value.parsedTasks);
const availableTaskTags = computed(() => {
  const tags = new Map<string, string>();

  parsedNoteTasks.value.forEach((task) => {
    task.tags.forEach((tag) => {
      const normalizedTag = tag.toLocaleLowerCase();

      if (!tags.has(normalizedTag)) {
        tags.set(normalizedTag, tag);
      }
    });
  });

  return Array.from(tags.entries())
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([, tag]) => tag);
});
const filteredNoteTasks = computed(() => (
  parsedNoteTasks.value.filter((task) => {
    if (taskFilter.value !== 'all' && task.state !== taskFilter.value) {
      return false;
    }

    if (!activeTaskTagFilter.value) {
      return true;
    }

    return task.tags.some((tag) => tag.toLocaleLowerCase() === activeTaskTagFilter.value?.toLocaleLowerCase());
  })
));
const activeTaskMenuState = computed<NoteTaskState | null>(() => {
  const activeMenu = taskStateMenu.value;

  if (!activeMenu) {
    return null;
  }

  const lines = props.content.split('\n');
  let currentTaskIndex = 0;
  let activeFenceMarker: '`' | '~' | null = null;
  let activeFenceLength = 0;

  for (const line of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);

    if (fenceMatch) {
      const markerCharacter = fenceMatch[2]?.[0];
      const markerLength = fenceMatch[2]?.length ?? 0;

      if (!activeFenceMarker) {
        activeFenceMarker = markerCharacter === '~' ? '~' : '`';
        activeFenceLength = markerLength;
      } else if (markerCharacter === activeFenceMarker && markerLength >= activeFenceLength) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      }

      continue;
    }

    if (activeFenceMarker) {
      continue;
    }

    const match = TASK_LINE_PATTERN.exec(line);

    if (!match) {
      continue;
    }

    const taskState = getTaskStateFromMarker(match[2] ?? '');

    if (!taskState) {
      continue;
    }

    if (currentTaskIndex === activeMenu.taskIndex) {
      return taskState;
    }

    currentTaskIndex += 1;
  }

  return null;
});

function getParsedTaskByIndex(taskIndex: number) {
  return parsedNoteTasks.value.find((task) => task.taskIndex === taskIndex) ?? null;
}

const noteSplit = useColumnSplitter({ defaultRatio: props.splitRatio });
const noteSplitStyle = computed(() => (
  props.viewMode === 'split'
    ? { gridTemplateColumns: noteSplit.gridTemplate.value, gap: '0' }
    : undefined
));
const SPLIT_RATIO_EMIT_DEBOUNCE_MS = 250;
let splitRatioEmitTimer: number | null = null;

function flushSplitRatioEmit() {
  if (splitRatioEmitTimer !== null) {
    window.clearTimeout(splitRatioEmitTimer);
    splitRatioEmitTimer = null;
  }

  const nextSplitRatio = Number(noteSplit.ratio.value.toFixed(4));

  if (Math.abs(props.splitRatio - nextSplitRatio) < 0.0001) {
    return;
  }

  emit('update:split-ratio', nextSplitRatio);
}

function scheduleSplitRatioEmit() {
  if (props.viewMode !== 'split') {
    return;
  }

  if (splitRatioEmitTimer !== null) {
    window.clearTimeout(splitRatioEmitTimer);
  }

  splitRatioEmitTimer = window.setTimeout(() => {
    splitRatioEmitTimer = null;
    flushSplitRatioEmit();
  }, SPLIT_RATIO_EMIT_DEBOUNCE_MS);
}
const normalizedSearchQuery = computed(() => searchQuery.value.trim());
const activeMatchCount = computed(() => previewMatchCount.value);
const activeMatchDisplayIndex = computed(() => (
  activeMatchCount.value < 1 ? 0 : activePreviewMatchIndex.value + 1
));
const externalChangeCopy = computed(() => {
  if (props.externalChange === 'unavailable') {
    return {
      title: tt('note.external.unavailable.title'),
      body: props.isDirty
        ? tt('note.external.unavailable.dirty')
        : tt('note.external.unavailable.clean'),
      actionLabel: null,
    };
  }

  if (props.externalChange === 'session-dirty') {
    return {
      title: tt('note.external.sessionDirty.title'),
      body: tt('note.external.sessionDirty.body'),
      actionLabel: tt('note.refreshFromDisk'),
    };
  }

  return {
    title: props.isDirty
      ? tt('note.external.changedDirty.title')
      : tt('note.external.changedClean.title'),
    body: props.isDirty
      ? tt('note.external.changedDirty.body')
      : tt('note.external.changedClean.body'),
    actionLabel: tt('note.refreshFromDisk'),
  };
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
  await writeSharedClipboardText(text);
}

function clearPendingSelectionCopy() {
  if (copySelectionTimer) {
    window.clearTimeout(copySelectionTimer);
    copySelectionTimer = null;
  }
}

function getSelectedEditorText() {
  if (!editorView || !editorView.hasFocus) {
    return null;
  }

  const selection = editorView.state.selection.main;

  if (selection.empty) {
    return null;
  }

  return editorView.state.sliceDoc(selection.from, selection.to);
}

function getSelectedPreviewText() {
  const preview = previewRef.value;
  const selection = window.getSelection();

  if (!preview || !selection || selection.isCollapsed || selection.rangeCount < 1) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;

  if (!anchorNode || !focusNode) {
    return null;
  }

  if (!preview.contains(anchorNode) || !preview.contains(focusNode)) {
    return null;
  }

  const text = selection.toString();
  return text.length > 0 ? text : null;
}

function getSelectedNoteText() {
  if (!props.active) {
    return null;
  }

  return getSelectedEditorText() ?? getSelectedPreviewText();
}

function scheduleSelectionCopy({ force = false }: { force?: boolean } = {}) {
  if (!props.selectionAutoCopyEnabled) {
    lastCopiedSelection = null;
    selectionCopyPendingAfterKeyboard = false;
    selectionCopyPendingAfterPointer = false;
    clearPendingSelectionCopy();
    return;
  }

  if (selectionKeyboardActive) {
    selectionCopyPendingAfterKeyboard = true;
    return;
  }

  if (selectionPointerActive) {
    selectionCopyPendingAfterPointer = true;
    return;
  }

  if (!force) {
    return;
  }

  const selection = getSelectedNoteText();

  if (!selection) {
    lastCopiedSelection = null;
    clearPendingSelectionCopy();
    return;
  }

  clearPendingSelectionCopy();
  copySelectionTimer = window.setTimeout(async () => {
    const currentSelection = getSelectedNoteText();

    if (!currentSelection || currentSelection === lastCopiedSelection) {
      return;
    }

    try {
      await writeClipboard(currentSelection);
      lastCopiedSelection = currentSelection;
      showCopyToast(tt('note.toast.copied'));
    } catch {
      showCopyToast(tt('note.toast.copyFailed'));
    }
  }, 90);
}

function handleDocumentSelectionChange() {
  scheduleSelectionCopy();
}

async function copyFilePathText(text: string, successMessage: string) {
  try {
    await writeClipboard(text);
    showCopyToast(successMessage);
  } catch {
    showCopyToast(tt('note.toast.copyFailed'));
  }
}

function getMenuPosition(event: MouseEvent, width: number, height: number) {
  const maxX = Math.max(12, window.innerWidth - width - 12);
  const maxY = Math.max(12, window.innerHeight - height - 12);

  return {
    x: Math.min(event.clientX, maxX),
    y: Math.min(event.clientY, maxY),
  };
}

function getFilePathMenuPosition(event: MouseEvent) {
  return getMenuPosition(event, FILE_PATH_MENU_WIDTH, FILE_PATH_MENU_HEIGHT);
}

function getTaskStateMenuPosition(event: MouseEvent) {
  return getMenuPosition(event, TASK_STATE_MENU_WIDTH, TASK_STATE_MENU_HEIGHT);
}

function getTaskCopyMenuPosition(event: MouseEvent) {
  return getMenuPosition(event, TASK_COPY_MENU_WIDTH, TASK_COPY_MENU_HEIGHT);
}

async function copyFullPath() {
  await copyFilePathText(
    props.filePath ?? noteLocationLabel.value,
    props.filePath ? tt('note.toast.pathCopied') : tt('note.toast.copied'),
  );
}

async function copyProjectRelativePath() {
  if (!projectRelativePathLabel.value) {
    showCopyToast(tt('note.toast.projectRootUnavailable'));
    return;
  }

  await copyFilePathText(projectRelativePathLabel.value, tt('note.toast.projectPathCopied'));
}

async function copyFileName() {
  await copyFilePathText(noteFileNameLabel.value, tt('note.toast.nameCopied'));
}

function closeFilePathMenu() {
  filePathMenu.value = null;
}

function closeTaskStateMenu() {
  taskStateMenu.value = null;
}

function closeTaskCopyMenu() {
  taskCopyMenu.value = null;
}

async function handleFilePathClick() {
  closeFilePathMenu();
  if (projectRelativePathLabel.value) {
    await copyProjectRelativePath();
    return;
  }

  await copyFullPath();
}

function openFilePathMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  closeTaskStateMenu();
  closeTaskCopyMenu();
  filePathMenu.value = getFilePathMenuPosition(event);
}

function openTaskStateMenu(event: MouseEvent, taskIndex: number) {
  event.preventDefault();
  event.stopPropagation();
  closeFilePathMenu();
  closeTaskCopyMenu();
  taskStateMenu.value = {
    ...getTaskStateMenuPosition(event),
    taskIndex,
  };
}

function openTaskCopyMenu(event: MouseEvent, taskIndex: number) {
  event.preventDefault();
  event.stopPropagation();
  closeFilePathMenu();
  closeTaskStateMenu();
  taskCopyMenu.value = {
    ...getTaskCopyMenuPosition(event),
    taskIndex,
  };
}

async function handleCopyFullPathMenuClick() {
  closeFilePathMenu();
  await copyFullPath();
}

async function handleCopyProjectRelativePathMenuClick() {
  closeFilePathMenu();
  await copyProjectRelativePath();
}

async function handleCopyFileNameMenuClick() {
  closeFilePathMenu();
  await copyFileName();
}

function handleRevealInAllFilesMenuClick() {
  closeFilePathMenu();
  emit('reveal-in-all-files');
}

async function copyTaskLineByIndex(taskIndex: number) {
  closeTaskCopyMenu();
  const task = getParsedTaskByIndex(taskIndex);

  if (!task) {
    showCopyToast(tt('note.toast.taskNotFound'));
    return;
  }

  await copyTaskLine(task);
}

async function copyTaskText(task: ParsedNoteTask) {
  const text = task.rawText.trim();

  if (!text) {
    showCopyToast(tt('note.toast.nothingToCopy'));
    return;
  }

  try {
    await writeClipboard(text);
    showCopyToast(tt('note.toast.taskTextCopied'));
  } catch {
    showCopyToast(tt('note.toast.copyFailed'));
  }
}

async function applyTaskCopyMenuSelection(mode: 'line' | 'text') {
  const activeMenu = taskCopyMenu.value;

  if (!activeMenu) {
    return;
  }

  const task = getParsedTaskByIndex(activeMenu.taskIndex);
  closeTaskCopyMenu();

  if (!task) {
    showCopyToast(tt('note.toast.taskNotFound'));
    return;
  }

  if (mode === 'text') {
    await copyTaskText(task);
    return;
  }

  await copyTaskLine(task);
}

async function copyAll() {
  if (!props.content) {
    showCopyToast(tt('note.toast.nothingToCopy'));
    return;
  }

  try {
    await writeClipboard(props.content);
    showCopyToast(tt('note.toast.copied'));
  } catch {
    showCopyToast(tt('note.toast.copyFailed'));
  }
}

async function focusSearchInput(selectText = false) {
  await nextTick();
  searchInputRef.value?.focus({ preventScroll: true });

  if (selectText) {
    searchInputRef.value?.select();
  }
}

async function openSearch(selectText = false) {
  if (props.viewMode !== 'preview') {
    if (!editorView) {
      return;
    }

    editorView.focus();
    openSearchPanel(editorView);
    return;
  }

  previewLens.value = 'preview';

  if (!searchVisible.value) {
    searchVisible.value = true;
  }

  await focusSearchInput(selectText);
}

function closeSearch() {
  searchVisible.value = false;
  searchQuery.value = '';
  activePreviewMatchIndex.value = 0;
  previewMatchCount.value = 0;
  clearPreviewSearchHighlights();
  void focusEditor();
}

function insertTextIntoEditor(text: string) {
  if (!editorView || !text) {
    return;
  }

  editorView.dispatch(editorView.state.replaceSelection(text));
  editorView.focus();
}

async function pasteClipboardIntoEditor(
  eventText?: string | null,
  options: {
    forceSystemRead?: boolean;
  } = {},
) {
  const clipboardText = await readSharedClipboardText({
    eventText,
    forceSystemRead: options.forceSystemRead,
    preferPreviousDistinctOf: getSelectedEditorText(),
  });

  if (!clipboardText) {
    return;
  }

  insertTextIntoEditor(clipboardText);
}

useClipboardHistoryTarget({
  isTargetActive: () => props.active && props.viewMode !== 'preview' && Boolean(editorView),
  insertText: (text) => {
    insertTextIntoEditor(text);
  },
});

function buildEditableExtensions() {
  return [
    EditorState.readOnly.of(props.busy),
    EditorView.editable.of(!props.busy),
  ];
}

function buildLineNumbersExtension() {
  return lineNumbersEnabled.value ? lineNumbers() : [];
}

function toggleLineNumbers() {
  emit('update:line-numbers-enabled', !lineNumbersEnabled.value);
}

function buildLineWrappingExtension() {
  return lineWrappingEnabled.value ? EditorView.lineWrapping : [];
}

function toggleLineWrapping() {
  emit('update:line-wrapping-enabled', !lineWrappingEnabled.value);
}

const CURSOR_EMIT_DEBOUNCE_MS = 250;
let cursorEmitTimer: number | null = null;

function clampCursor(anchor: number, head: number, docLength: number) {
  return {
    anchor: Math.min(Math.max(0, Math.floor(anchor)), docLength),
    head: Math.min(Math.max(0, Math.floor(head)), docLength),
  };
}

function flushCursorEmit() {
  if (cursorEmitTimer !== null) {
    window.clearTimeout(cursorEmitTimer);
    cursorEmitTimer = null;
  }

  if (!editorView) {
    return;
  }

  const mainSelection = editorView.state.selection.main;
  const nextAnchor = mainSelection.anchor;
  const nextHead = mainSelection.head;

  if (props.cursor?.anchor === nextAnchor && props.cursor?.head === nextHead) {
    return;
  }

  emit('update:cursor', { anchor: nextAnchor, head: nextHead });
}

function scheduleCursorEmit() {
  if (cursorEmitTimer !== null) {
    window.clearTimeout(cursorEmitTimer);
  }

  cursorEmitTimer = window.setTimeout(() => {
    cursorEmitTimer = null;
    flushCursorEmit();
  }, CURSOR_EMIT_DEBOUNCE_MS);
}

function buildInitialSelection(docLength: number) {
  const cursor = props.cursor;

  if (!cursor) {
    return undefined;
  }

  const { anchor, head } = clampCursor(cursor.anchor, cursor.head, docLength);
  return EditorSelection.single(anchor, head);
}

function applyExternalCursor({ focus = false }: { focus?: boolean } = {}) {
  if (!editorView || !props.cursor) {
    return;
  }

  const docLength = editorView.state.doc.length;
  const { anchor, head } = clampCursor(props.cursor.anchor, props.cursor.head, docLength);
  const mainSelection = editorView.state.selection.main;
  const selectionChanged = mainSelection.anchor !== anchor || mainSelection.head !== head;

  if (selectionChanged) {
    editorView.dispatch({
      selection: EditorSelection.single(anchor, head),
      effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
    });
  }

  if (focus && props.active && props.viewMode !== 'preview') {
    editorView.focus();
  }
}

async function revealExternalCursor(options: { focus?: boolean } = {}) {
  if (!props.cursor || props.viewMode === 'preview') {
    return;
  }

  await nextTick();

  window.requestAnimationFrame(() => {
    applyExternalCursor(options);
  });
}

function handleEditorUpdate(update: ViewUpdate) {
  if (update.selectionSet) {
    scheduleSelectionCopy();
  }

  if (suppressContentSync) {
    return;
  }

  if (update.docChanged) {
    const nextContent = update.state.doc.toString();

    if (nextContent !== props.content) {
      emit('update:content', nextContent);
    }
  }

  if (update.selectionSet) {
    scheduleCursorEmit();
  }
}

function createEditor() {
  if (!editorRootRef.value) {
    return;
  }

  editorView?.destroy();

  const state = EditorState.create({
    doc: props.content,
    selection: buildInitialSelection(props.content.length),
    extensions: [
      EditorState.tabSize.of(2),
      lineWrappingCompartment.of(buildLineWrappingExtension()),
      lineNumbersCompartment.of(buildLineNumbersExtension()),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true }),
      highlightSelectionMatches(),
      bareTaskMarkerField,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.contentAttributes.of({
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      }),
      EditorView.domEventHandlers({
        contextmenu: (event) => {
          if (!props.rightClickPasteEnabled) {
            return false;
          }

          event.preventDefault();
          event.stopPropagation();
          void pasteClipboardIntoEditor(null, {
            forceSystemRead: true,
          });
          return true;
        },
        paste: (event) => {
          event.preventDefault();
          event.stopPropagation();
          void pasteClipboardIntoEditor(event.clipboardData?.getData('text/plain') ?? '');
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        handleEditorUpdate(update);
      }),
      editableCompartment.of(buildEditableExtensions()),
      languageCompartment.of(markdown({ base: markdownLanguage })),
      themeCompartment.of(getCodeEditorThemeExtension(props.editorTheme)),
      bridgeGitEditorChromeTheme,
    ],
  });

  editorView = new EditorView({
    state,
    parent: editorRootRef.value,
  });

  if (props.cursor) {
    void revealExternalCursor();
  }

  if (props.active && props.viewMode !== 'preview') {
    void nextTick(() => {
      editorView?.focus();
    });
  }
}

function destroyEditor() {
  flushCursorEmit();
  editorView?.destroy();
  editorView = null;
}

function syncEditorContent(nextContent: string) {
  if (!editorView) {
    return;
  }

  const currentContent = editorView.state.doc.toString();

  if (currentContent === nextContent) {
    return;
  }

  suppressContentSync = true;
  editorView.dispatch({
    changes: { from: 0, to: currentContent.length, insert: nextContent },
  });
  suppressContentSync = false;
}

function reconfigureEditor() {
  if (!editorView) {
    return;
  }

  editorView.dispatch({
    effects: [
      editableCompartment.reconfigure(buildEditableExtensions()),
      themeCompartment.reconfigure(getCodeEditorThemeExtension(props.editorTheme)),
    ],
  });
}

watch(
  () => props.lineNumbersEnabled,
  (enabled) => {
    lineNumbersEnabled.value = enabled;

    editorView?.dispatch({
      effects: lineNumbersCompartment.reconfigure(buildLineNumbersExtension()),
    });
  },
);

watch(
  () => props.lineWrappingEnabled,
  (enabled) => {
    lineWrappingEnabled.value = enabled;

    editorView?.dispatch({
      effects: lineWrappingCompartment.reconfigure(buildLineWrappingExtension()),
    });
  },
);

watch(
  () => props.cursor,
  (cursor) => {
    if (!editorView || !cursor) {
      return;
    }
    applyExternalCursor();
  },
);

function setTaskState(taskIndex: number, nextState: NoteTaskState) {
  if (!Number.isInteger(taskIndex) || taskIndex < 0) {
    return;
  }

  const lines = props.content.split('\n');
  let currentTaskIndex = 0;
  let activeFenceMarker: '`' | '~' | null = null;
  let activeFenceLength = 0;

  const nextLines = lines.map((line) => {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);

    if (fenceMatch) {
      const markerCharacter = fenceMatch[2]?.[0];
      const markerLength = fenceMatch[2]?.length ?? 0;

      if (!activeFenceMarker) {
        activeFenceMarker = markerCharacter === '~' ? '~' : '`';
        activeFenceLength = markerLength;
      } else if (markerCharacter === activeFenceMarker && markerLength >= activeFenceLength) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      }

      return line;
    }

    if (activeFenceMarker) {
      return line;
    }

    const match = TASK_LINE_PATTERN.exec(line);

    if (!match) {
      return line;
    }

    if (currentTaskIndex !== taskIndex) {
      currentTaskIndex += 1;
      return line;
    }

    currentTaskIndex += 1;
    return `${match[1]}${TASK_STATE_MARKERS[nextState]}${match[3]}`;
  });

  emit('update:content', nextLines.join('\n'));
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

function handlePreviewTaskToggle(taskIndex: number, currentState: NoteTaskState) {
  closeTaskStateMenu();
  setTaskState(taskIndex, getNextPrimaryTaskState(currentState));
}

function setPreviewLens(nextLens: 'preview' | 'tasks') {
  previewLens.value = nextLens;
}

function toggleTaskTagFilter(tag: string) {
  activeTaskTagFilter.value = activeTaskTagFilter.value?.toLocaleLowerCase() === tag.toLocaleLowerCase()
    ? null
    : tag;
}

function getLineStartOffset(content: string, lineIndex: number) {
  if (lineIndex <= 0) {
    return 0;
  }

  const lines = content.split('\n');
  let offset = 0;

  for (let index = 0; index < lines.length && index < lineIndex; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }

  return offset;
}

async function revealTaskInNote(task: ParsedNoteTask) {
  const lineStartOffset = getLineStartOffset(props.content, task.lineIndex);
  emit('update:cursor', { anchor: lineStartOffset, head: lineStartOffset });
  previewLens.value = 'preview';

  if (props.viewMode !== 'preview') {
    await nextTick();
    editorView?.focus();
    editorView?.dispatch({
      selection: EditorSelection.single(lineStartOffset, lineStartOffset),
      effects: EditorView.scrollIntoView(lineStartOffset, { y: 'center' }),
    });
    return;
  }

  await nextTick();
  const previewTask = previewRef.value?.querySelector<HTMLElement>(`.note-tab__task-item[data-task-index="${task.taskIndex}"]`);
  previewTask?.scrollIntoView({
    block: 'center',
    behavior: 'smooth',
  });
}

async function copyTaskLine(task: ParsedNoteTask) {
  const sourceLine = task.sourceLine.trimEnd();

  if (!sourceLine.trim()) {
    showCopyToast(tt('note.toast.nothingToCopy'));
    return;
  }

  try {
    await writeClipboard(sourceLine);
    showCopyToast(tt('note.toast.taskLineCopied'));
  } catch {
    showCopyToast(tt('note.toast.copyFailed'));
  }
}

async function handlePreviewClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;

  if (!target) {
    return;
  }

  const summary = target.closest<HTMLElement>('summary');

  if (summary) {
    await nextTick();
    void refreshRenderedPreviewDecorations();
  }

  const taskToggle = target.closest<HTMLElement>('.note-tab__task-toggle');

  if (taskToggle) {
    event.preventDefault();
    event.stopPropagation();
    const taskIndex = Number.parseInt(taskToggle.dataset.taskIndex ?? '', 10);
    const taskState = isNoteTaskState(taskToggle.dataset.taskState)
      ? taskToggle.dataset.taskState
      : null;

    if (Number.isNaN(taskIndex) || !taskState) {
      return;
    }

    handlePreviewTaskToggle(taskIndex, taskState);
    return;
  }

  const copyButton = target.closest<HTMLButtonElement>('.note-tab__code-copy');

  if (copyButton) {
    event.preventDefault();
    event.stopPropagation();

    const codeBlock = copyButton.closest<HTMLElement>('.note-tab__code-block');
    const codeText = codeBlock?.dataset.noteSource
      ?? codeBlock?.querySelector('pre > code')?.textContent
      ?? '';

    if (!codeText) {
      showCopyToast(tt('note.toast.nothingToCopy'));
      return;
    }

    try {
      await writeClipboard(codeText);
      showCopyToast(tt('note.toast.codeCopied'));
    } catch {
      showCopyToast(tt('note.toast.copyFailed'));
    }

    return;
  }

  const anchor = target.closest<HTMLAnchorElement>('a');

  if (!anchor) {
    return;
  }

  const noteLinkTarget = anchor.dataset.noteLink?.trim();

  if (noteLinkTarget) {
    event.preventDefault();
    event.stopPropagation();
    const resolvedPath = await window.bridgegit?.notes.resolveLink(props.filePath, noteLinkTarget) ?? null;

    if (!resolvedPath) {
      showCopyToast(tt('note.toast.noteNotFound'));
      return;
    }

    emit('open-note-link', resolvedPath);
    return;
  }

  const href = anchor.getAttribute('href')?.trim() ?? '';

  if (href.startsWith('#')) {
    event.preventDefault();
    event.stopPropagation();

    const targetHeading = previewRef.value?.querySelector<HTMLElement>(href);
    targetHeading?.scrollIntoView({
      block: 'start',
      behavior: 'smooth',
    });
    return;
  }

  if (!href) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  window.open(href, '_blank', 'noopener');
}

function handlePreviewContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null;

  if (!target) {
    return;
  }

  if (target.closest('.note-tab__task-card-copy')) {
    return;
  }

  const taskToggle = target.closest<HTMLElement>('.note-tab__task-toggle');
  const taskItem = target.closest<HTMLElement>('.note-tab__task-item');

  if (!taskToggle && !taskItem) {
    return;
  }

  const taskIndex = Number.parseInt(
    taskToggle?.dataset.taskIndex
      ?? taskItem?.dataset.taskIndex
      ?? '',
    10,
  );

  if (Number.isNaN(taskIndex)) {
    return;
  }

  openTaskStateMenu(event, taskIndex);
}

function applyTaskStateMenuSelection(nextState: NoteTaskState) {
  const activeMenu = taskStateMenu.value;

  if (!activeMenu) {
    return;
  }

  setTaskState(activeMenu.taskIndex, nextState);
  closeTaskStateMenu();
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (event.button === 0 && rootRef.value?.contains(event.target as Node | null)) {
    selectionPointerActive = true;
    selectionCopyPendingAfterPointer = false;
  }

  if (!filePathMenu.value && !taskStateMenu.value && !taskCopyMenu.value) {
    return;
  }

  const target = event.target as HTMLElement | null;

  if (target?.closest('.note-tab__path-menu, .note-tab__file-path-button')) {
    return;
  }

  if (target?.closest('.note-tab__task-menu, .note-tab__task-toggle')) {
    return;
  }

  if (target?.closest('.note-tab__task-copy-menu, .note-tab__task-card-copy')) {
    return;
  }

  closeFilePathMenu();
  closeTaskStateMenu();
  closeTaskCopyMenu();
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
  scheduleSelectionCopy({ force: true });
}

function clearPreviewSearchHighlights() {
  const markdownRoot = previewRef.value?.querySelector('.note-tab__markdown');

  if (!markdownRoot) {
    previewMatchCount.value = 0;
    return;
  }

  markdownRoot.querySelectorAll<HTMLElement>('mark.note-tab__search-match').forEach((highlight) => {
    highlight.replaceWith(document.createTextNode(highlight.textContent ?? ''));
  });
  markdownRoot.normalize();
  previewMatchCount.value = 0;
}

function syncActivePreviewMatch(scrollIntoView: boolean) {
  const matches = previewRef.value?.querySelectorAll<HTMLElement>('mark.note-tab__search-match') ?? [];

  matches.forEach((match, index) => {
    match.classList.toggle('note-tab__search-match--active', index === activePreviewMatchIndex.value);
  });

  if (!scrollIntoView || matches.length < 1) {
    return;
  }

  matches[activePreviewMatchIndex.value]?.scrollIntoView({
    block: 'center',
    behavior: 'smooth',
  });
}

async function refreshPreviewSearch(scrollIntoView = false) {
  await nextTick();

  clearPreviewSearchHighlights();

  const query = normalizedSearchQuery.value;
  const markdownRoot = previewRef.value?.querySelector('.note-tab__markdown');

  if (!query || !markdownRoot || props.viewMode === 'source') {
    return;
  }

  const documentRoot = markdownRoot.ownerDocument;
  const walker = documentRoot.createTreeWalker(markdownRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      const parentElement = node.parentElement;

      if (!parentElement) {
        return NodeFilter.FILTER_REJECT;
      }

      if (parentElement.closest('.note-tab__code-toolbar, .note-tab__heading-anchor, button, script, style')) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const normalizedQueryValue = query.toLocaleLowerCase();
  const textNodes: Text[] = [];
  let currentNode = walker.nextNode();

  while (currentNode) {
    if (currentNode instanceof Text) {
      textNodes.push(currentNode);
    }

    currentNode = walker.nextNode();
  }

  let matchIndex = 0;

  textNodes.forEach((textNode) => {
    const nodeValue = textNode.nodeValue ?? '';
    const normalizedValue = nodeValue.toLocaleLowerCase();
    let searchIndex = 0;
    let nextMatchIndex = normalizedValue.indexOf(normalizedQueryValue, searchIndex);

    if (nextMatchIndex < 0) {
      return;
    }

    const fragment = documentRoot.createDocumentFragment();

    while (nextMatchIndex >= 0) {
      if (nextMatchIndex > searchIndex) {
        fragment.append(nodeValue.slice(searchIndex, nextMatchIndex));
      }

      const highlight = documentRoot.createElement('mark');
      highlight.className = 'note-tab__search-match';
      highlight.dataset.searchMatchIndex = String(matchIndex);
      highlight.textContent = nodeValue.slice(nextMatchIndex, nextMatchIndex + query.length);
      fragment.append(highlight);
      matchIndex += 1;
      searchIndex = nextMatchIndex + query.length;
      nextMatchIndex = normalizedValue.indexOf(normalizedQueryValue, searchIndex);
    }

    if (searchIndex < nodeValue.length) {
      fragment.append(nodeValue.slice(searchIndex));
    }

    textNode.replaceWith(fragment);
  });

  previewMatchCount.value = matchIndex;

  if (previewMatchCount.value < 1) {
    activePreviewMatchIndex.value = 0;
    return;
  }

  if (activePreviewMatchIndex.value >= previewMatchCount.value) {
    activePreviewMatchIndex.value = 0;
  }

  syncActivePreviewMatch(scrollIntoView);
}

function goToNextSearchMatch() {
  if (!normalizedSearchQuery.value || previewMatchCount.value < 1) {
    return;
  }

  activePreviewMatchIndex.value = (activePreviewMatchIndex.value + 1) % previewMatchCount.value;
  syncActivePreviewMatch(true);
}

function goToPreviousSearchMatch() {
  if (!normalizedSearchQuery.value || previewMatchCount.value < 1) {
    return;
  }

  activePreviewMatchIndex.value = (
    activePreviewMatchIndex.value - 1 + previewMatchCount.value
  ) % previewMatchCount.value;
  syncActivePreviewMatch(true);
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
    return;
  }

  if (event.key !== 'Enter') {
    return;
  }

  event.preventDefault();

  if (event.shiftKey) {
    goToPreviousSearchMatch();
    return;
  }

  goToNextSearchMatch();
}

function isSelectionRangeKeyboardShortcut(event: KeyboardEvent) {
  return (
    event.shiftKey
    && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
  );
}

function isSelectAllKeyboardShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a';
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

  if (searchVisible.value) {
    searchInputRef.value?.focus({ preventScroll: true });
    return;
  }

  if (props.viewMode === 'preview') {
    rootRef.value?.focus({ preventScroll: true });
    return;
  }

  editorView?.focus();
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

  if (isSelectionRangeKeyboardShortcut(event)) {
    selectionKeyboardActive = true;
    selectionKeyboardMode = 'range';
  } else if (isSelectAllKeyboardShortcut(event)) {
    selectionKeyboardActive = true;
    selectionKeyboardMode = 'select-all';
  }

  if (event.defaultPrevented) {
    return;
  }

  if ((filePathMenu.value || taskStateMenu.value) && event.key === 'Escape') {
    event.preventDefault();
    closeFilePathMenu();
    closeTaskStateMenu();
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

  if (matchesShortcut(event, SHORTCUTS.noteSearch)) {
    event.preventDefault();
    void openSearch(true);
    return;
  }

  if (searchVisible.value && event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
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

function handleDocumentKeyup(event: KeyboardEvent) {
  if (!selectionKeyboardActive) {
    return;
  }

  const shouldFinalizeRangeSelection = (
    selectionKeyboardMode === 'range'
    && (
      event.key === 'Shift'
      || (
        !event.shiftKey
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
      )
    )
  );
  const shouldFinalizeSelectAll = selectionKeyboardMode === 'select-all' && isSelectAllKeyboardShortcut(event);

  if (!shouldFinalizeRangeSelection && !shouldFinalizeSelectAll) {
    return;
  }

  selectionKeyboardActive = false;
  selectionKeyboardMode = null;

  if (!selectionCopyPendingAfterKeyboard) {
    return;
  }

  selectionCopyPendingAfterKeyboard = false;
  scheduleSelectionCopy({ force: true });
}

const handleFlushEditorState = () => {
  flushCursorEmit();
  flushSplitRatioEmit();
};

onMounted(() => {
  createEditor();
  document.addEventListener('keydown', handleDocumentKeydown);
  document.addEventListener('keyup', handleDocumentKeyup);
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('pointerup', handleDocumentPointerUp);
  document.addEventListener('selectionchange', handleDocumentSelectionChange);
  window.addEventListener('bridgegit:flush-editor-state', handleFlushEditorState);
  void focusEditor();
  void refreshRenderedPreviewDecorations();
});

onBeforeUnmount(() => {
  destroyEditor();
  document.removeEventListener('keydown', handleDocumentKeydown);
  document.removeEventListener('keyup', handleDocumentKeyup);
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('pointerup', handleDocumentPointerUp);
  document.removeEventListener('selectionchange', handleDocumentSelectionChange);
  window.removeEventListener('bridgegit:flush-editor-state', handleFlushEditorState);
  clearPendingSelectionCopy();
  flushSplitRatioEmit();

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
    copyToastTimer = null;
  }
});

watch(
  () => props.splitRatio,
  (nextSplitRatio) => {
    if (noteSplit.isDragging.value || Math.abs(noteSplit.ratio.value - nextSplitRatio) < 0.0001) {
      return;
    }

    noteSplit.ratio.value = nextSplitRatio;
  },
);

watch(noteSplit.ratio, () => {
  scheduleSplitRatioEmit();
});

watch(
  [() => props.content, () => props.filePath],
  () => {
    void updateRenderedMarkdown();
  },
  { immediate: true },
);

watch(
  () => props.appearanceThemeVariant,
  () => {
    void updateRenderedMarkdown();
  },
);

watch(
  renderedMarkdown,
  async () => {
    await refreshRenderedPreviewDecorations();
  },
);

watch(
  () => props.active,
  (isActive) => {
    if (!isActive) {
      return;
    }

    void focusEditor();

    if (props.cursor && props.viewMode !== 'preview') {
      void revealExternalCursor({ focus: true });
    }
  },
);

watch(
  () => props.viewMode,
  (viewMode) => {
    void focusEditor();

    if (viewMode === 'preview' && previewLens.value === 'preview') {
      void refreshRenderedPreviewDecorations();
      return;
    }

    if (props.cursor) {
      void revealExternalCursor({ focus: props.active });
    }
  },
);

watch(
  () => previewLens.value,
  (lens) => {
    if (lens === 'preview' && props.viewMode === 'preview') {
      void refreshRenderedPreviewDecorations();
    }
  },
);

watch(
  () => normalizedSearchQuery.value,
  () => {
    activePreviewMatchIndex.value = 0;

    if (searchVisible.value) {
      void refreshPreviewSearch();
    }
  },
);

watch(
  () => props.content,
  (nextContent) => {
    syncEditorContent(nextContent);

    if (searchVisible.value && normalizedSearchQuery.value) {
      void refreshPreviewSearch();
    }
  },
);

watch(
  () => [props.busy, props.editorTheme, props.themeVariant] as const,
  () => {
    reconfigureEditor();
  },
);

defineExpose({
  copyAll,
  focusEditor,
});
</script>

<template>
  <section
    ref="rootRef"
    class="note-tab"
    :data-shortcut-bindings-version="shortcutBindingsVersion"
    :data-appearance-theme="appearanceTheme"
    :data-editor-theme-id="editorTheme"
    :data-editor-theme="themeVariant"
    :style="noteStyle"
    tabindex="-1"
  >
    <div class="note-tab__toolbar">
      <div class="note-tab__meta">
        <div class="note-tab__meta-copy">
          <button
            class="note-tab__file-path-button"
            type="button"
            :title="tt('note.pathButtonTitle', { path: filePath || noteLocationLabel })"
            :aria-label="tt('note.copyNotePath')"
            aria-haspopup="menu"
            @click="handleFilePathClick"
            @contextmenu="openFilePathMenu"
          >
            <span class="note-tab__file-path">{{ noteLocationLabel }}</span>
          </button>
          <button
            class="note-tab__action note-tab__action--inline"
            type="button"
            :aria-pressed="searchVisible"
            :title="tt('note.findInNoteTitle', { shortcut: SHORTCUTS.noteSearch.display })"
            :aria-label="tt('note.findInNote')"
            @click="openSearch(true)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.75 4a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm0 1.5a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5Zm5.66 9.85a.75.75 0 0 1 1.06 0l2.32 2.32a.75.75 0 1 1-1.06 1.06l-2.32-2.32a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>
      </div>

      <div class="note-tab__file-actions">
        <button
          class="note-tab__action"
          type="button"
          :disabled="busy"
          :title="tt('note.openFileTitle')"
          :aria-label="tt('code.openFile')"
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
          :title="tt('note.saveFileTitle')"
          :aria-label="tt('note.saveFile')"
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
          :title="tt('note.saveFileAsTitle')"
          :aria-label="tt('note.saveFileAs')"
          @click="emit('save-file-as')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5.75 3.75h9.7c.6 0 1.17.24 1.6.66l2.54 2.54c.42.42.66 1 .66 1.6v4.2a.75.75 0 0 1-1.5 0v-4.2a.76.76 0 0 0-.22-.53l-2.54-2.53a.75.75 0 0 0-.53-.22h-1.21V9a1.75 1.75 0 0 1-1.75 1.75h-3A1.75 1.75 0 0 1 7.75 9V5.25h-2A.75.75 0 0 0 5 6v12c0 .41.34.75.75.75h5.5a.75.75 0 0 1 0 1.5h-5.5A2.25 2.25 0 0 1 3.5 18V6A2.25 2.25 0 0 1 5.75 3.75Zm3.5 1.5V9a.25.25 0 0 0 .25.25h3A.25.25 0 0 0 12.75 9V5.25h-3.5Zm8.22 8.22a.75.75 0 0 1 1.06 0l2.47 2.47a.75.75 0 0 1 0 1.06l-2.47 2.47a.75.75 0 1 1-1.06-1.06l1.19-1.19h-5.91a.75.75 0 0 1 0-1.5h5.9l-1.18-1.19a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      <div class="note-tab__actions">

        <div class="note-tab__mode-toggle" role="group" :aria-label="tt('note.viewMode')">
          <button
            class="note-tab__mode-button"
            :class="{ 'note-tab__mode-button--active': viewMode === 'source' }"
            type="button"
            :title="tt('note.mode.source')"
            :aria-label="tt('note.mode.source')"
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
            :title="tt('note.mode.split')"
            :aria-label="tt('note.mode.split')"
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
            :title="tt('note.mode.preview')"
            :aria-label="tt('note.mode.preview')"
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
          :class="{ 'note-tab__action--active': lineNumbersEnabled }"
          type="button"
          :title="lineNumbersEnabled ? tt('note.hideLineNumbers') : tt('note.showLineNumbers')"
          :aria-label="lineNumbersEnabled ? tt('note.hideLineNumbers') : tt('note.showLineNumbers')"
          :aria-pressed="lineNumbersEnabled"
          @click="toggleLineNumbers"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6.5a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 4 6.5Zm5 0a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5h-10A.75.75 0 0 1 9 6.5ZM4 12a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 4 12Zm5 0a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5h-10A.75.75 0 0 1 9 12Zm-5 5.5a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Zm5 0a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5h-10a.75.75 0 0 1-.75-.75Z" />
          </svg>
        </button>

        <button
          class="note-tab__action"
          :class="{ 'note-tab__action--active': lineWrappingEnabled }"
          type="button"
          :title="lineWrappingEnabled ? tt('note.disableLineWrapping') : tt('note.enableLineWrapping')"
          :aria-label="lineWrappingEnabled ? tt('note.disableLineWrapping') : tt('note.enableLineWrapping')"
          :aria-pressed="lineWrappingEnabled"
          @click="toggleLineWrapping"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4.75 6.25h14.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1 0-1.5Zm0 5h10.5a3.5 3.5 0 1 1 0 7h-3.69l1.22 1.22a.75.75 0 1 1-1.06 1.06l-2.5-2.5a.75.75 0 0 1 0-1.06l2.5-2.5a.75.75 0 1 1 1.06 1.06l-1.22 1.22h3.69a2 2 0 1 0 0-4H4.75a.75.75 0 0 1 0-1.5Zm0 5.5h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1 0-1.5Z" />
          </svg>
        </button>

        <button
          class="note-tab__action"
          type="button"
          :title="tt('note.copyFullNote')"
          :aria-label="tt('note.copyFullNote')"
          @click="copyAll"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8.75 5.25A2.75 2.75 0 0 1 11.5 2.5h6A2.75 2.75 0 0 1 20.25 5.25v8.5a2.75 2.75 0 0 1-2.75 2.75h-6a2.75 2.75 0 0 1-2.75-2.75v-8.5Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v8.5c0 .69.56 1.25 1.25 1.25h6c.69 0 1.25-.56 1.25-1.25v-8.5c0-.69-.56-1.25-1.25-1.25h-6Zm-5 4A2.75 2.75 0 0 1 9.25 10.75V18A2.75 2.75 0 0 0 12 20.75h6.25a.75.75 0 0 1 0 1.5H12A4.25 4.25 0 0 1 7.75 18v-7.25a.75.75 0 0 1-1.5 0V8.5A2.75 2.75 0 0 1 9 5.75h1.25a.75.75 0 0 1 0 1.5H9A1.25 1.25 0 0 0 7.75 8.5Z" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="externalChange" class="note-tab__external-change">
      <div class="note-tab__external-copy">
        <strong>{{ externalChangeCopy.title }}</strong>
        <span>{{ externalChangeCopy.body }}</span>
      </div>
      <div class="note-tab__external-actions">
        <button
          v-if="externalChangeCopy.actionLabel"
          class="note-tab__external-button note-tab__external-button--primary"
          type="button"
          :disabled="busy"
          @click="emit('reload-from-disk')"
        >
          {{ externalChangeCopy.actionLabel }}
        </button>
        <button
          class="note-tab__external-button"
          type="button"
          :disabled="busy"
          @click="emit('dismiss-external-change')"
        >
          {{ tt('code.keepCurrent') }}
        </button>
      </div>
    </div>

    <div v-if="searchVisible && viewMode === 'preview' && previewLens === 'preview'" class="note-tab__search">
      <div class="note-tab__search-meta">
        <span class="note-tab__search-count">
          <template v-if="normalizedSearchQuery">
            <span v-if="activeMatchCount">
              {{ activeMatchDisplayIndex }} / {{ activeMatchCount }}
            </span>
            <span v-else>
              0 / 0
            </span>
          </template>
        </span>

        <button
          class="note-tab__search-action"
          type="button"
          :disabled="activeMatchCount < 1"
          :title="tt('note.search.previous')"
          @click="goToPreviousSearchMatch"
        >
          ↑
        </button>

        <button
          class="note-tab__search-action"
          type="button"
          :disabled="activeMatchCount < 1"
          :title="tt('note.search.next')"
          @click="goToNextSearchMatch"
        >
          ↓
        </button>

        <button
          class="note-tab__search-action"
          type="button"
          :title="tt('note.search.closeTitle', { shortcut: SHORTCUTS.noteSearch.display })"
          :aria-label="tt('note.search.close')"
          @click="closeSearch"
        >
          ×
        </button>
      </div>

      <label class="note-tab__search-field">
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          class="note-tab__search-input"
          type="search"
          :placeholder="tt('note.search.placeholder', { shortcut: SHORTCUTS.noteSearch.display })"
          @keydown="handleSearchKeydown"
        >
      </label>
    </div>

    <div
      :ref="(el) => { noteSplit.containerRef.value = el as HTMLElement | null; }"
      class="note-tab__body"
      :class="{
        'note-tab__body--source-only': viewMode === 'source',
        'note-tab__body--preview-only': viewMode === 'preview',
        'note-tab__body--split': viewMode === 'split',
      }"
      :style="noteSplitStyle"
      @wheel.capture="handleWheelZoom"
    >
      <div class="note-tab__source" :class="{ 'note-tab__source--hidden': viewMode === 'preview' }">
        <div ref="editorRootRef" class="note-tab__editor" />
      </div>

      <div
        v-if="viewMode === 'split'"
        class="note-tab__split-divider"
        :class="{ 'note-tab__split-divider--active': noteSplit.isDragging.value }"
        role="separator"
        aria-orientation="vertical"
        :title="tt('note.resizeSplit')"
        @pointerdown="noteSplit.startDrag"
        @dblclick="noteSplit.reset"
      />

      <div
        ref="previewRef"
        class="note-tab__preview"
        :class="{ 'note-tab__preview--hidden': viewMode === 'source' }"
        @pointerdown="focusHotkeySurface"
        @click="handlePreviewClick"
        @contextmenu="handlePreviewContextMenu"
      >
        <div class="note-tab__preview-lens">
          <div class="note-tab__preview-lens-toggle" role="group" :aria-label="tt('note.previewLens')">
            <button
              class="note-tab__preview-lens-button"
              :class="{ 'note-tab__preview-lens-button--active': previewLens === 'preview' }"
              type="button"
              :aria-pressed="previewLens === 'preview'"
              @click="setPreviewLens('preview')"
            >
              {{ tt('note.preview') }}
            </button>
            <button
              class="note-tab__preview-lens-button"
              :class="{ 'note-tab__preview-lens-button--active': previewLens === 'tasks' }"
              type="button"
              :aria-pressed="previewLens === 'tasks'"
              @click="setPreviewLens('tasks')"
            >
              {{ tt('note.tasks') }}
              <span v-if="parsedNoteTasks.length" class="note-tab__preview-lens-count">{{ parsedNoteTasks.length }}</span>
            </button>
          </div>
        </div>

        <article
          v-if="previewLens === 'preview'"
          class="note-tab__markdown"
          v-html="renderedMarkdown"
        />

        <section v-else class="note-tab__tasks" :aria-label="tt('note.tasks.aria')">
          <div class="note-tab__tasks-filters">
            <div class="note-tab__tasks-filter-group" role="group" :aria-label="tt('note.task.stateFilter')">
              <button
                v-for="item in taskFilterItems"
                :key="item.value"
                class="note-tab__tasks-filter"
                :class="{ 'note-tab__tasks-filter--active': taskFilter === item.value }"
                type="button"
                :aria-pressed="taskFilter === item.value"
                @click="taskFilter = item.value"
              >
                {{ item.label }}
              </button>
            </div>

            <div v-if="availableTaskTags.length" class="note-tab__tasks-tags" role="group" :aria-label="tt('note.task.tagFilter')">
              <button
                class="note-tab__tasks-tag"
                :class="{ 'note-tab__tasks-tag--active': activeTaskTagFilter === null }"
                type="button"
                :aria-pressed="activeTaskTagFilter === null"
                @click="activeTaskTagFilter = null"
              >
                {{ tt('note.task.allTags') }}
              </button>
              <button
                v-for="tag in availableTaskTags"
                :key="tag"
                class="note-tab__tasks-tag"
                :class="{ 'note-tab__tasks-tag--active': activeTaskTagFilter?.toLocaleLowerCase() === tag.toLocaleLowerCase() }"
                type="button"
                :aria-pressed="activeTaskTagFilter?.toLocaleLowerCase() === tag.toLocaleLowerCase()"
                @click="toggleTaskTagFilter(tag)"
              >
                #{{ tag }}
              </button>
            </div>
          </div>

          <div v-if="filteredNoteTasks.length" class="note-tab__tasks-list">
            <article
              v-for="task in filteredNoteTasks"
              :key="task.taskIndex"
              class="note-tab__task-card"
              :class="`note-tab__task-card--${task.state}`"
            >
              <button
                class="note-tab__task-card-toggle"
                :class="`note-tab__task-card-toggle--${task.state}`"
                type="button"
                :aria-label="getTaskStateLabel(task.state)"
                :title="getTaskStateLabel(task.state).toUpperCase()"
                @click="handlePreviewTaskToggle(task.taskIndex, task.state)"
                @contextmenu="openTaskStateMenu($event, task.taskIndex)"
              >
                <span class="note-tab__task-card-toggle-icon" aria-hidden="true" v-html="`<svg viewBox='0 0 16 16' focusable='false'>${getTaskStateIconSvg(task.state, true)}</svg>`" />
              </button>

              <div
                class="note-tab__task-card-body"
                role="button"
                tabindex="0"
                :title="tt('note.task.toggleStateTitle', { state: getTaskStateLabel(task.state) })"
                @click="handlePreviewTaskToggle(task.taskIndex, task.state)"
                @contextmenu="openTaskStateMenu($event, task.taskIndex)"
                @keydown.enter.prevent="handlePreviewTaskToggle(task.taskIndex, task.state)"
                @keydown.space.prevent="handlePreviewTaskToggle(task.taskIndex, task.state)"
              >
                <p class="note-tab__task-card-text">{{ task.text }}</p>
                <div v-if="task.tags.length" class="note-tab__task-card-tags">
                  <button
                    v-for="tag in task.tags"
                    :key="`${task.taskIndex}:${tag}`"
                    class="note-tab__task-card-tag"
                    :class="{ 'note-tab__task-card-tag--active': activeTaskTagFilter?.toLocaleLowerCase() === tag.toLocaleLowerCase() }"
                    type="button"
                    @click.stop="toggleTaskTagFilter(tag)"
                  >
                    #{{ tag }}
                  </button>
                </div>
              </div>

              <div class="note-tab__task-card-actions">
                <button
                  v-if="viewMode !== 'preview'"
                  class="note-tab__task-card-action"
                  type="button"
                  :title="tt('note.task.showInNoteTitle', { line: task.lineIndex + 1 })"
                  @click.stop="revealTaskInNote(task)"
                >
                  {{ tt('note.task.show') }}
                </button>
                <button
                  class="note-tab__action note-tab__action--inline note-tab__task-card-copy"
                  type="button"
                  :title="tt('note.task.copyLineTitle')"
                  :aria-label="tt('note.task.copyLine')"
                  @click.stop="void copyTaskLineByIndex(task.taskIndex)"
                  @contextmenu.stop="openTaskCopyMenu($event, task.taskIndex)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8.75 5.25A2.75 2.75 0 0 1 11.5 2.5h6A2.75 2.75 0 0 1 20.25 5.25v8.5a2.75 2.75 0 0 1-2.75 2.75h-6a2.75 2.75 0 0 1-2.75-2.75v-8.5Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v8.5c0 .69.56 1.25 1.25 1.25h6c.69 0 1.25-.56 1.25-1.25v-8.5c0-.69-.56-1.25-1.25-1.25h-6Zm-5 4A2.75 2.75 0 0 1 9.25 10.75V18A2.75 2.75 0 0 0 12 20.75h6.25a.75.75 0 0 1 0 1.5H12A4.25 4.25 0 0 1 7.75 18v-7.25a.75.75 0 0 1-1.5 0V8.5A2.75 2.75 0 0 1 9 5.75h1.25a.75.75 0 0 1 0 1.5H9A1.25 1.25 0 0 0 7.75 8.5Z" />
                  </svg>
                </button>
              </div>
            </article>
          </div>

          <p v-else class="note-tab__tasks-empty">
            {{ tt('note.task.empty') }}
          </p>
        </section>
      </div>
    </div>

    <transition name="note-tab-toast">
      <div v-if="copyToast" class="note-tab__toast">
        {{ copyToast }}
      </div>
    </transition>

    <div
      v-if="filePathMenu"
      class="note-tab__path-menu"
      :style="{ left: `${filePathMenu.x}px`, top: `${filePathMenu.y}px` }"
      role="menu"
      :aria-label="tt('note.copyNotePath')"
    >
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        @click="handleCopyFullPathMenuClick"
      >
        {{ tt('code.copyFullPath') }}
      </button>
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        :disabled="!projectRelativePathLabel"
        @click="handleCopyProjectRelativePathMenuClick"
      >
        {{ tt('code.copyProjectPath') }}
      </button>
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        :disabled="!filePath"
        @click="handleRevealInAllFilesMenuClick"
      >
        {{ tt('code.revealInAllFiles') }}
      </button>
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        @click="handleCopyFileNameMenuClick"
      >
        {{ tt('code.copyFileName') }}
      </button>
    </div>

    <div
      v-if="taskStateMenu"
      class="note-tab__task-menu"
      :style="{ left: `${taskStateMenu.x}px`, top: `${taskStateMenu.y}px` }"
      role="menu"
      :aria-label="tt('note.task.stateMenu')"
    >
      <button
        v-for="item in taskStateMenuItems"
        :key="item.state"
        class="note-tab__task-menu-item"
        :class="{ 'note-tab__task-menu-item--active': activeTaskMenuState === item.state }"
        type="button"
        role="menuitemradio"
        :aria-checked="activeTaskMenuState === item.state"
        @click="applyTaskStateMenuSelection(item.state)"
      >
        <span class="note-tab__task-menu-marker">{{ getTaskStateMarkerLabel(item.state) }}</span>
        <span>{{ item.label }}</span>
      </button>
    </div>

    <div
      v-if="taskCopyMenu"
      class="note-tab__task-copy-menu"
      :style="{ left: `${taskCopyMenu.x}px`, top: `${taskCopyMenu.y}px` }"
      role="menu"
      :aria-label="tt('note.task.copy')"
    >
      <button
        class="note-tab__task-copy-menu-item"
        type="button"
        role="menuitem"
        @click="void applyTaskCopyMenuSelection('line')"
      >
        {{ tt('note.copy') }}
      </button>
      <button
        class="note-tab__task-copy-menu-item"
        type="button"
        role="menuitem"
        @click="void applyTaskCopyMenuSelection('text')"
      >
        {{ tt('note.copyText') }}
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.note-tab {
  --bridgegit-editor-selection-bg: var(--note-editor-selection-bg);
  --note-tab-mode-bg: rgba(13, 18, 25, 0.9);
  --note-tab-mode-color: rgba(188, 201, 215, 0.82);
  --note-tab-mode-hover-bg: rgba(21, 30, 41, 0.94);
  --note-tab-mode-hover-color: #eff6ff;
  --note-tab-mode-active-bg: rgba(47, 91, 124, 0.56);
  --note-tab-mode-active-color: #f2f9ff;
  --note-tab-action-bg: rgba(14, 20, 27, 0.88);
  --note-tab-action-hover-bg: rgba(24, 33, 43, 0.92);
  --note-tab-action-active-bg: rgba(29, 42, 57, 0.94);
  --note-tab-action-active-color: #f2f8ff;
  --note-tab-warning-border: rgba(255, 176, 102, 0.24);
  --note-tab-warning-bg: rgba(74, 48, 18, 0.18);
  --note-tab-warning-strong: #ffe1bc;
  --note-tab-warning-muted: rgba(255, 225, 188, 0.82);
  --note-tab-warning-button-bg: rgba(24, 18, 11, 0.76);
  --note-tab-warning-button-primary-bg: rgba(110, 63, 13, 0.6);
  --note-tab-search-bg: rgba(11, 16, 22, 0.92);
  --note-tab-search-action-bg: rgba(16, 22, 29, 0.92);
  --note-tab-input-bg: linear-gradient(180deg, rgba(17, 24, 33, 0.96), rgba(12, 17, 24, 0.98));
  --note-tab-preview-bg: linear-gradient(180deg, rgba(12, 18, 25, 0.96), rgba(10, 15, 21, 0.98));
  --note-tab-markdown-heading: #f6fbff;
  --note-tab-table-bg: rgba(11, 16, 23, 0.92);
  --note-tab-table-header-bg: rgba(53, 78, 102, 0.28);
  --note-tab-table-alt-bg: rgba(47, 66, 84, 0.17);
  --note-tab-inline-code-bg: rgba(16, 24, 34, 0.96);
  --note-tab-pre-bg: rgba(10, 15, 22, 0.96);
  --note-tab-code-toolbar-bg: rgba(20, 28, 39, 0.96);
  --note-tab-code-toolbar-hover-bg: rgba(28, 39, 54, 0.98);
  --note-tab-mermaid-error-bg: rgba(124, 84, 36, 0.18);
  --note-tab-mermaid-error-text: #ffd099;
  --note-tab-link-color: #7ac8ff;
  --note-tab-link-decoration: rgba(122, 200, 255, 0.45);
  --note-tab-blockquote-border: rgba(110, 197, 255, 0.55);
  --note-tab-blockquote-bg: rgba(55, 88, 112, 0.16);
  --note-tab-blockquote-text: rgba(231, 241, 249, 0.92);
  --note-tab-toc-bg: rgba(18, 26, 36, 0.62);
  --note-tab-toc-link-hover-bg: rgba(36, 51, 66, 0.42);
  --note-tab-callout-note-border: #69b2ff;
  --note-tab-callout-note-bg: rgba(46, 93, 134, 0.18);
  --note-tab-callout-note-title: #9ad0ff;
  --note-tab-callout-tip-border: #6fe0a5;
  --note-tab-callout-tip-bg: rgba(46, 110, 73, 0.18);
  --note-tab-callout-tip-title: #9cf0bf;
  --note-tab-callout-warning-border: #ffb066;
  --note-tab-callout-warning-bg: rgba(124, 84, 36, 0.18);
  --note-tab-callout-warning-title: #ffd099;
  --note-tab-callout-important-border: #d391ff;
  --note-tab-callout-important-bg: rgba(108, 59, 140, 0.18);
  --note-tab-callout-important-title: #efc4ff;
  --note-tab-task-open-border: rgba(122, 140, 162, 0.42);
  --note-tab-task-open-glyph: rgba(0, 0, 0, 0);
  --note-tab-task-open-bg: rgba(24, 32, 42, 0.18);
  --note-tab-task-progress-border: rgba(102, 185, 246, 0.52);
  --note-tab-task-progress-glyph: #8bd2ff;
  --note-tab-task-progress-bg: rgba(49, 96, 132, 0.2);
  --note-tab-task-waiting-border: rgba(240, 189, 96, 0.48);
  --note-tab-task-waiting-glyph: #f5cb79;
  --note-tab-task-waiting-bg: rgba(116, 81, 22, 0.18);
  --note-tab-task-done-border: rgba(119, 222, 154, 0.44);
  --note-tab-task-done-glyph: #8fe2a6;
  --note-tab-task-done-bg: rgba(41, 110, 64, 0.18);
  --note-tab-task-cancelled-border: rgba(255, 144, 144, 0.46);
  --note-tab-task-cancelled-glyph: #ff9f9a;
  --note-tab-task-cancelled-bg: rgba(119, 46, 46, 0.18);
  --code-token-comment: #6f879c;
  --code-token-string: #8dd8a6;
  --code-token-number: #f1c27a;
  --code-token-keyword: #8dc7ff;
  --code-token-variable: #f7a8ff;
  --code-token-property: #7ee0d0;
  --code-token-tag: #ffb37f;
  --code-token-punctuation: rgba(226, 234, 242, 0.82);
  --code-token-invalid: #ff9e97;
  --note-editor-bg: rgba(11, 16, 22, 0.92);
  --note-editor-text: var(--text-primary);
  --note-editor-accent: var(--accent-strong);
  --note-editor-gutter-bg: rgba(13, 19, 26, 0.92);
  --note-editor-gutter-color: rgba(143, 158, 177, 0.72);
  --note-editor-active-line-bg: rgba(42, 62, 84, 0.16);
  --note-editor-active-gutter-bg: rgba(36, 52, 69, 0.92);
  --note-editor-active-gutter-color: rgba(232, 240, 246, 0.88);
  --note-editor-selection-bg: rgba(59, 130, 246, 0.3);
  --note-editor-panel-bg: rgba(15, 21, 29, 0.98);
  --note-editor-search-input-bg: rgba(10, 15, 22, 0.96);
  --note-editor-search-button-bg: rgba(20, 28, 39, 0.96);
  --note-editor-search-button-hover-bg: rgba(28, 39, 54, 0.98);
  --note-editor-search-match-bg: rgba(241, 194, 122, 0.2);
  --note-editor-search-match-outline: rgba(241, 194, 122, 0.28);
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 10px;
}

.note-tab[data-editor-theme='light'] {
  --note-editor-bg: rgba(252, 253, 255, 0.98);
  --note-editor-text: #182535;
  --note-editor-accent: #2d7cd8;
  --note-editor-gutter-bg: rgba(240, 245, 251, 0.98);
  --note-editor-gutter-color: rgba(103, 118, 135, 0.72);
  --note-editor-active-line-bg: rgba(86, 143, 214, 0.1);
  --note-editor-active-gutter-bg: rgba(211, 225, 242, 0.96);
  --note-editor-active-gutter-color: #1f3a5c;
  --note-editor-selection-bg: rgba(74, 139, 232, 0.2);
  --note-editor-panel-bg: rgba(244, 248, 252, 0.98);
  --note-editor-search-input-bg: rgba(255, 255, 255, 0.98);
  --note-editor-search-button-bg: rgba(236, 242, 249, 0.98);
  --note-editor-search-button-hover-bg: rgba(224, 234, 244, 0.98);
  --note-editor-search-match-bg: rgba(241, 194, 122, 0.3);
  --note-editor-search-match-outline: rgba(195, 142, 62, 0.32);
}

.note-tab[data-editor-theme-id='github-dark'] {
  --note-editor-bg: #0d1117;
  --note-editor-text: #c9d1d9;
  --note-editor-accent: #58a6ff;
  --note-editor-gutter-bg: #0d1117;
  --note-editor-gutter-color: #6e7681;
  --note-editor-active-line-bg: rgba(56, 139, 253, 0.08);
  --note-editor-active-gutter-bg: rgba(56, 139, 253, 0.12);
  --note-editor-active-gutter-color: #c9d1d9;
  --note-editor-selection-bg: rgba(56, 139, 253, 0.28);
  --note-editor-panel-bg: #161b22;
  --note-editor-search-input-bg: #0d1117;
  --note-editor-search-button-bg: #21262d;
  --note-editor-search-button-hover-bg: #30363d;
  --note-editor-search-match-bg: rgba(210, 153, 34, 0.2);
  --note-editor-search-match-outline: rgba(210, 153, 34, 0.28);
}

.note-tab[data-editor-theme-id='github-light'] {
  --note-editor-bg: #ffffff;
  --note-editor-text: #24292f;
  --note-editor-accent: #0969da;
  --note-editor-gutter-bg: #f6f8fa;
  --note-editor-gutter-color: #57606a;
  --note-editor-active-line-bg: rgba(9, 105, 218, 0.08);
  --note-editor-active-gutter-bg: rgba(9, 105, 218, 0.12);
  --note-editor-active-gutter-color: #24292f;
  --note-editor-selection-bg: rgba(9, 105, 218, 0.18);
  --note-editor-panel-bg: #f6f8fa;
  --note-editor-search-input-bg: #ffffff;
  --note-editor-search-button-bg: #f6f8fa;
  --note-editor-search-button-hover-bg: #eef2f6;
  --note-editor-search-match-bg: rgba(191, 135, 0, 0.2);
  --note-editor-search-match-outline: rgba(191, 135, 0, 0.28);
}

.note-tab[data-editor-theme-id='nord'] {
  --note-editor-bg: #2e3440;
  --note-editor-text: #d8dee9;
  --note-editor-accent: #88c0d0;
  --note-editor-gutter-bg: #3b4252;
  --note-editor-gutter-color: #7b8799;
  --note-editor-active-line-bg: rgba(136, 192, 208, 0.12);
  --note-editor-active-gutter-bg: rgba(136, 192, 208, 0.2);
  --note-editor-active-gutter-color: #eceff4;
  --note-editor-selection-bg: rgba(136, 192, 208, 0.3);
  --note-editor-panel-bg: #3b4252;
  --note-editor-search-input-bg: #2e3440;
  --note-editor-search-button-bg: #3b4252;
  --note-editor-search-button-hover-bg: #434c5e;
  --note-editor-search-match-bg: rgba(235, 203, 139, 0.18);
  --note-editor-search-match-outline: rgba(235, 203, 139, 0.28);
}

.note-tab[data-appearance-theme='bridgegit-light'] {
  --note-tab-mode-bg: rgba(236, 242, 249, 0.96);
  --note-tab-mode-color: rgba(84, 101, 120, 0.82);
  --note-tab-mode-hover-bg: rgba(224, 234, 244, 0.98);
  --note-tab-mode-hover-color: #1f3145;
  --note-tab-mode-active-bg: rgba(120, 173, 229, 0.28);
  --note-tab-mode-active-color: #1f3f63;
  --note-tab-action-bg: rgba(236, 242, 249, 0.96);
  --note-tab-action-hover-bg: rgba(224, 234, 244, 0.98);
  --note-tab-action-active-bg: rgba(216, 228, 241, 0.98);
  --note-tab-action-active-color: #1f3f63;
  --note-tab-warning-border: rgba(213, 160, 94, 0.34);
  --note-tab-warning-bg: rgba(255, 231, 196, 0.72);
  --note-tab-warning-strong: #774a11;
  --note-tab-warning-muted: rgba(119, 74, 17, 0.8);
  --note-tab-warning-button-bg: rgba(255, 244, 224, 0.96);
  --note-tab-warning-button-primary-bg: rgba(243, 207, 152, 0.92);
  --note-tab-search-bg: rgba(252, 253, 255, 0.98);
  --note-tab-search-action-bg: rgba(236, 242, 249, 0.98);
  --note-tab-input-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(247, 250, 253, 0.98));
  --note-tab-preview-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 251, 254, 0.98));
  --note-tab-markdown-heading: #1e3248;
  --note-tab-table-bg: rgba(255, 255, 255, 0.98);
  --note-tab-table-header-bg: rgba(215, 229, 243, 0.82);
  --note-tab-table-alt-bg: rgba(235, 242, 249, 0.72);
  --note-tab-inline-code-bg: rgba(239, 244, 250, 0.98);
  --note-tab-pre-bg: rgba(248, 251, 255, 0.98);
  --note-tab-code-toolbar-bg: rgba(236, 242, 249, 0.98);
  --note-tab-code-toolbar-hover-bg: rgba(224, 234, 244, 0.98);
  --note-tab-mermaid-error-bg: rgba(255, 231, 196, 0.72);
  --note-tab-mermaid-error-text: #8a5a18;
  --note-tab-link-color: #2d7cd8;
  --note-tab-link-decoration: rgba(45, 124, 216, 0.28);
  --note-tab-blockquote-border: rgba(45, 124, 216, 0.34);
  --note-tab-blockquote-bg: rgba(224, 234, 244, 0.72);
  --note-tab-blockquote-text: rgba(41, 59, 81, 0.94);
  --note-tab-toc-bg: rgba(236, 242, 249, 0.92);
  --note-tab-toc-link-hover-bg: rgba(224, 234, 244, 0.98);
  --note-tab-callout-note-border: #4f96e8;
  --note-tab-callout-note-bg: rgba(212, 230, 248, 0.82);
  --note-tab-callout-note-title: #2d6fc2;
  --note-tab-callout-tip-border: #5fbf88;
  --note-tab-callout-tip-bg: rgba(217, 243, 226, 0.86);
  --note-tab-callout-tip-title: #27724a;
  --note-tab-callout-warning-border: #d89a47;
  --note-tab-callout-warning-bg: rgba(255, 235, 204, 0.88);
  --note-tab-callout-warning-title: #8a5a18;
  --note-tab-callout-important-border: #b67ae6;
  --note-tab-callout-important-bg: rgba(238, 224, 249, 0.88);
  --note-tab-callout-important-title: #7d49a9;
  --note-tab-task-open-border: rgba(126, 140, 158, 0.42);
  --note-tab-task-open-bg: rgba(222, 231, 240, 0.52);
  --note-tab-task-progress-border: rgba(70, 144, 220, 0.42);
  --note-tab-task-progress-glyph: #2b77cf;
  --note-tab-task-progress-bg: rgba(214, 230, 246, 0.82);
  --note-tab-task-waiting-border: rgba(201, 153, 74, 0.4);
  --note-tab-task-waiting-glyph: #9f6920;
  --note-tab-task-waiting-bg: rgba(248, 233, 201, 0.88);
  --note-tab-task-done-border: rgba(79, 170, 110, 0.4);
  --note-tab-task-done-glyph: #2f8a5d;
  --note-tab-task-done-bg: rgba(218, 241, 226, 0.9);
  --note-tab-task-cancelled-border: rgba(201, 101, 101, 0.4);
  --note-tab-task-cancelled-glyph: #b44c4c;
  --note-tab-task-cancelled-bg: rgba(248, 223, 223, 0.9);
  --code-token-comment: #75859a;
  --code-token-string: #2f8a5d;
  --code-token-number: #b87421;
  --code-token-keyword: #2d7cd8;
  --code-token-variable: #b25dcc;
  --code-token-property: #188783;
  --code-token-tag: #bf6d3f;
  --code-token-punctuation: rgba(40, 52, 67, 0.82);
  --code-token-invalid: #d25d5d;
}

.note-tab[data-appearance-theme='github-dark'] {
  --note-tab-mode-bg: #161b22;
  --note-tab-mode-color: #8b949e;
  --note-tab-mode-hover-bg: #21262d;
  --note-tab-mode-hover-color: #c9d1d9;
  --note-tab-mode-active-bg: rgba(56, 139, 253, 0.18);
  --note-tab-mode-active-color: #79c0ff;
  --note-tab-action-bg: #161b22;
  --note-tab-action-hover-bg: #21262d;
  --note-tab-action-active-bg: #30363d;
  --note-tab-action-active-color: #c9d1d9;
  --note-tab-search-bg: rgba(13, 17, 23, 0.98);
  --note-tab-search-action-bg: #21262d;
  --note-tab-input-bg: linear-gradient(180deg, rgba(13, 17, 23, 0.98), rgba(9, 13, 19, 0.98));
  --note-tab-preview-bg: linear-gradient(180deg, rgba(22, 27, 34, 0.98), rgba(13, 17, 23, 0.98));
  --note-tab-markdown-heading: #f0f6fc;
  --note-tab-table-bg: rgba(13, 17, 23, 0.98);
  --note-tab-table-header-bg: rgba(33, 38, 45, 0.92);
  --note-tab-table-alt-bg: rgba(22, 27, 34, 0.76);
  --note-tab-inline-code-bg: rgba(22, 27, 34, 0.98);
  --note-tab-pre-bg: rgba(13, 17, 23, 0.98);
  --note-tab-code-toolbar-bg: rgba(22, 27, 34, 0.98);
  --note-tab-code-toolbar-hover-bg: rgba(33, 38, 45, 0.98);
  --note-tab-link-color: #79c0ff;
  --note-tab-link-decoration: rgba(121, 192, 255, 0.32);
}

.note-tab[data-appearance-theme='github-light'] {
  --note-tab-mode-bg: #f6f8fa;
  --note-tab-mode-color: #57606a;
  --note-tab-mode-hover-bg: #eef2f6;
  --note-tab-mode-hover-color: #24292f;
  --note-tab-mode-active-bg: rgba(9, 105, 218, 0.14);
  --note-tab-mode-active-color: #0969da;
  --note-tab-action-bg: #f6f8fa;
  --note-tab-action-hover-bg: #eef2f6;
  --note-tab-action-active-bg: #eaeef2;
  --note-tab-action-active-color: #24292f;
  --note-tab-search-bg: rgba(255, 255, 255, 0.98);
  --note-tab-search-action-bg: #f6f8fa;
  --note-tab-input-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 248, 250, 0.98));
  --note-tab-preview-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 248, 250, 0.98));
  --note-tab-markdown-heading: #24292f;
  --note-tab-table-bg: rgba(255, 255, 255, 0.98);
  --note-tab-table-header-bg: rgba(246, 248, 250, 0.98);
  --note-tab-table-alt-bg: rgba(246, 248, 250, 0.72);
  --note-tab-inline-code-bg: rgba(246, 248, 250, 0.98);
  --note-tab-pre-bg: rgba(255, 255, 255, 0.98);
  --note-tab-code-toolbar-bg: rgba(246, 248, 250, 0.98);
  --note-tab-code-toolbar-hover-bg: rgba(234, 238, 242, 0.98);
  --note-tab-link-color: #0969da;
  --note-tab-link-decoration: rgba(9, 105, 218, 0.24);
}

.note-tab[data-appearance-theme='nord'] {
  --note-tab-mode-bg: rgba(59, 66, 82, 0.94);
  --note-tab-mode-color: #a7b3c4;
  --note-tab-mode-hover-bg: rgba(67, 76, 94, 0.98);
  --note-tab-mode-hover-color: #e5e9f0;
  --note-tab-mode-active-bg: rgba(136, 192, 208, 0.16);
  --note-tab-mode-active-color: #88c0d0;
  --note-tab-action-bg: rgba(59, 66, 82, 0.96);
  --note-tab-action-hover-bg: rgba(67, 76, 94, 0.98);
  --note-tab-action-active-bg: rgba(76, 86, 106, 0.98);
  --note-tab-action-active-color: #e5e9f0;
  --note-tab-search-bg: rgba(46, 52, 64, 0.98);
  --note-tab-search-action-bg: rgba(59, 66, 82, 0.96);
  --note-tab-input-bg: linear-gradient(180deg, rgba(46, 52, 64, 0.98), rgba(36, 41, 51, 0.98));
  --note-tab-preview-bg: linear-gradient(180deg, rgba(59, 66, 82, 0.98), rgba(46, 52, 64, 0.98));
  --note-tab-markdown-heading: #eceff4;
  --note-tab-table-bg: rgba(46, 52, 64, 0.98);
  --note-tab-table-header-bg: rgba(67, 76, 94, 0.92);
  --note-tab-table-alt-bg: rgba(59, 66, 82, 0.76);
  --note-tab-inline-code-bg: rgba(59, 66, 82, 0.98);
  --note-tab-pre-bg: rgba(46, 52, 64, 0.98);
  --note-tab-code-toolbar-bg: rgba(59, 66, 82, 0.98);
  --note-tab-code-toolbar-hover-bg: rgba(67, 76, 94, 0.98);
  --note-tab-link-color: #88c0d0;
  --note-tab-link-decoration: rgba(136, 192, 208, 0.28);
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
  min-width: 0;
  max-width: 28rem;
}

.note-tab__meta-copy {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.note-tab__file-path-button {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: copy;
}

.note-tab__file-path-button:hover .note-tab__file-path,
.note-tab__file-path-button:focus-visible .note-tab__file-path {
  color: var(--text-primary);
}

.note-tab__file-path-button:focus-visible {
  outline: none;
}

.note-tab__file-path {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: var(--note-tab-mode-bg);
  color: var(--note-tab-mode-color);
}

.note-tab__mode-button:last-child {
  border-right: 0;
}

.note-tab__mode-button:hover {
  color: var(--note-tab-mode-hover-color);
  background: var(--note-tab-mode-hover-bg);
}

.note-tab__mode-button--active {
  background: var(--note-tab-mode-active-bg);
  color: var(--note-tab-mode-active-color);
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
  background: var(--note-tab-action-bg);
  color: var(--text-primary);
}

.note-tab__action:hover {
  border-color: rgba(110, 197, 255, 0.2);
  background: var(--note-tab-action-hover-bg);
}

.note-tab__action--active {
  border-color: rgba(110, 197, 255, 0.34);
  background: var(--note-tab-action-active-bg);
  color: var(--note-tab-action-active-color, var(--text-primary));
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

.note-tab__action--inline {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
}

.note-tab__action--inline[aria-pressed='true'] {
  border-color: rgba(110, 197, 255, 0.24);
  background: var(--note-tab-action-active-bg);
  color: var(--note-tab-action-active-color);
}

.note-tab__external-change {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--note-tab-warning-border);
  border-radius: 12px;
  background: var(--note-tab-warning-bg);
}

.note-tab__external-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.note-tab__external-copy strong {
  color: var(--note-tab-warning-strong);
  font-size: 0.82rem;
}

.note-tab__external-copy span {
  color: var(--note-tab-warning-muted);
  font-size: 0.76rem;
  line-height: 1.4;
}

.note-tab__external-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.note-tab__external-button {
  padding: 0.45rem 0.72rem;
  border: 1px solid var(--note-tab-warning-border);
  border-radius: 9px;
  background: var(--note-tab-warning-button-bg);
  color: var(--text-primary);
  font-size: 0.76rem;
  white-space: nowrap;
}

.note-tab__external-button--primary {
  border-color: rgba(255, 196, 127, 0.32);
  background: var(--note-tab-warning-button-primary-bg);
}

.note-tab__external-button:disabled,
.note-tab__path-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.note-tab__search {
  --note-search-action-count: 3;
  --note-search-action-size: 34px;
  --note-search-action-gap: 8px;
  --note-search-count-width: 72px;
  --note-search-input-height: 46px;
  --note-search-input-padding-left: 0.82rem;
  --note-search-input-padding-right-extra: 0.5rem;
  --note-search-action-cluster-width:
    calc(
      (var(--note-search-action-size) * var(--note-search-action-count))
      + (var(--note-search-action-gap) * (var(--note-search-action-count) - 1))
    );
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.note-tab__search-field {
  display: block;
  min-width: 0;
  width: 100%;
}

.note-tab__search-input {
  width: 100%;
  min-width: 0;
  min-height: var(--note-search-input-height);
  padding:
    0.7rem
    calc(
      var(--note-search-action-cluster-width)
      + var(--note-search-count-width)
      + var(--note-search-action-gap)
      + var(--note-search-input-padding-right-extra)
    )
    0.7rem
    var(--note-search-input-padding-left);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--note-tab-search-bg);
  color: var(--text-primary);
  font-family: var(--font-mono), 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', monospace;
  font-size: calc(var(--note-font-size-px, 14) * 1px);
  font-weight: 500;
  line-height: 1.4;
}

.note-tab__search-input:focus {
  outline: none;
  border-color: rgba(110, 197, 255, 0.4);
  box-shadow: 0 0 0 1px rgba(110, 197, 255, 0.18);
}

.note-tab__search-meta {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--note-search-action-gap);
  align-self: flex-end;
  z-index: 1;
  margin-bottom: calc(var(--note-search-input-height) * -1);
  padding-right: 8px;
}

.note-tab__search-count {
  min-width: var(--note-search-count-width);
  color: var(--text-muted);
  font-size: 0.76rem;
  text-align: right;
  white-space: nowrap;
}

.note-tab__search-action {
  width: var(--note-search-action-size);
  height: var(--note-search-action-size);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--note-tab-search-action-bg);
  color: var(--text-primary);
  font-size: 0.96rem;
  line-height: 1;
  transition: opacity 120ms ease;
}

.note-tab__search-action:disabled {
  opacity: 0.4;
}

.note-tab__body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
}

.note-tab__body--source-only,
.note-tab__body--preview-only {
  grid-template-columns: minmax(0, 1fr);
}

.note-tab__source,
.note-tab__preview {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.note-tab__source--hidden,
.note-tab__preview--hidden {
  display: none;
}

.note-tab__split-divider {
  align-self: stretch;
  cursor: col-resize;
  background: transparent;
  position: relative;
  touch-action: none;
}

.note-tab__split-divider::before {
  content: '';
  position: absolute;
  inset: 4px 3px;
  border-radius: 2px;
  background: var(--border-subtle, rgba(108, 124, 148, 0.32));
  opacity: 0.55;
  transition: opacity 120ms ease, background 120ms ease;
}

.note-tab__split-divider:hover::before {
  opacity: 0.92;
  background: rgba(110, 197, 255, 0.5);
}

.note-tab__split-divider--active::before {
  opacity: 1;
  background: rgba(110, 197, 255, 0.78);
}

.note-tab__editor {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  border: 1px solid rgba(108, 124, 148, 0.16);
  border-radius: 14px;
  background: var(--note-editor-bg);
  overflow: hidden;
}

.note-tab__editor :deep(.cm-editor) {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  background: var(--note-editor-bg);
  color: var(--note-editor-text);
  font-family: var(--font-mono), 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', monospace;
  font-size: calc(var(--note-font-size-px, 14) * 1px);
}

.note-tab__editor :deep(.cm-focused) {
  outline: none;
}

.note-tab__editor :deep(.cm-scroller) {
  overflow: auto;
  font-family: inherit;
  line-height: 1.6;
}

.note-tab__editor :deep(.cm-content),
.note-tab__editor :deep(.cm-gutter) {
  min-height: 100%;
}

.note-tab__editor :deep(.cm-content) {
  padding: 0.95rem 0 1.1rem;
  caret-color: var(--note-editor-accent);
}

.note-tab__editor :deep(.cm-line) {
  padding: 0 1rem;
}

.note-tab__editor :deep(.cm-gutters) {
  border-right: 1px solid rgba(108, 124, 148, 0.18);
  background: var(--note-editor-gutter-bg);
  color: var(--note-editor-gutter-color);
}

.note-tab__editor :deep(.cm-gutterElement) {
  padding: 0 0.8rem 0 0.95rem;
}

.note-tab__editor :deep(.cm-activeLine) {
  background: var(--note-editor-active-line-bg);
}

.note-tab__editor :deep(.cm-activeLineGutter) {
  background: var(--note-editor-active-gutter-bg);
  color: var(--note-editor-active-gutter-color);
}

.note-tab__editor :deep(.cm-selectionBackground),
.note-tab__editor :deep(.cm-content ::selection),
.note-tab__editor :deep(.cm-searchMatch.cm-searchMatch-selected) {
  background: var(--note-editor-selection-bg);
}

.note-tab__editor :deep(.cm-cursor) {
  border-left-color: var(--note-editor-accent);
}

.note-tab__editor :deep(.cm-matchingBracket),
.note-tab__editor :deep(.cm-nonmatchingBracket) {
  border-bottom: 1px solid rgba(123, 208, 255, 0.55);
}

.note-tab__editor :deep(.cm-selectionMatch) {
  background: rgba(141, 199, 255, 0.14);
}

.note-tab__editor :deep(.note-tab__bare-task-marker) {
  color: var(--code-token-number);
}

.note-tab__editor :deep(.cm-panels) {
  border-bottom: 1px solid rgba(108, 124, 148, 0.22);
  background: var(--note-editor-panel-bg);
  color: var(--note-editor-text);
}

.note-tab__editor :deep(.cm-panels-top) {
  border-bottom: 1px solid rgba(108, 124, 148, 0.22);
}

.note-tab__editor :deep(.cm-search) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font: 500 0.78rem/1.35 var(--font-mono);
}

.note-tab__editor :deep(.cm-search label) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.note-tab__editor :deep(.cm-search .cm-textfield) {
  min-width: 12rem;
  border: 1px solid rgba(108, 124, 148, 0.28);
  border-radius: 8px;
  background: var(--note-editor-search-input-bg);
  color: var(--note-editor-text);
  padding: 0.3rem 0.48rem;
}

.note-tab__editor :deep(.cm-search .cm-button) {
  border: 1px solid rgba(108, 124, 148, 0.26);
  border-radius: 8px;
  background: var(--note-editor-search-button-bg);
  color: var(--note-editor-text);
  padding: 0.26rem 0.5rem;
  font: 600 0.74rem/1.2 var(--font-mono);
}

.note-tab__editor :deep(.cm-search .cm-button:hover) {
  border-color: rgba(110, 197, 255, 0.28);
  background: var(--note-editor-search-button-hover-bg);
}

.note-tab__editor :deep(.cm-searchMatch) {
  background: var(--note-editor-search-match-bg);
  outline: 1px solid var(--note-editor-search-match-outline);
}

.note-tab__editor:focus-within {
  border-color: rgba(110, 197, 255, 0.34);
  box-shadow: inset 0 0 0 1px rgba(110, 197, 255, 0.14);
}

.note-tab__preview {
  overflow: auto;
  border: 1px solid rgba(108, 124, 148, 0.16);
  border-radius: 14px;
  background: var(--note-tab-preview-bg);
  padding: 16px 18px;
}

.note-tab__preview-lens {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.note-tab__preview-lens-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  border: 1px solid rgba(108, 124, 148, 0.22);
  border-radius: 12px;
  background: rgba(12, 18, 25, 0.28);
}

.note-tab__preview-lens-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0.45rem 0.72rem;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-secondary);
  font: 600 0.76rem/1.2 var(--font-mono);
}

.note-tab__preview-lens-button--active {
  background: rgba(110, 197, 255, 0.14);
  color: var(--text-primary);
}

.note-tab__preview-lens-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.3rem;
  padding: 0 0.32rem;
  border-radius: 999px;
  background: rgba(110, 197, 255, 0.16);
  color: var(--text-primary);
  font-size: 0.72rem;
}

.note-tab__markdown {
  color: var(--text-primary);
  font-size: calc(var(--note-font-size-px, 14) * 1px);
  line-height: 1.62;
  word-break: break-word;
  font-family: var(--font-mono), 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', monospace;
}

.note-tab__tasks {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.note-tab__tasks-filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.note-tab__tasks-filter-group,
.note-tab__tasks-tags,
.note-tab__task-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.note-tab__tasks-filter,
.note-tab__tasks-tag,
.note-tab__task-card-tag,
.note-tab__task-card-action {
  padding: 0.4rem 0.62rem;
  border: 1px solid rgba(108, 124, 148, 0.24);
  border-radius: 9px;
  background: rgba(16, 24, 34, 0.4);
  color: var(--text-secondary);
  font: 600 0.74rem/1.2 var(--font-mono);
}

.note-tab__tasks-filter--active,
.note-tab__tasks-tag--active,
.note-tab__task-card-tag--active {
  border-color: rgba(110, 197, 255, 0.3);
  background: rgba(110, 197, 255, 0.14);
  color: var(--text-primary);
}

.note-tab__tasks-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.note-tab__task-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid rgba(108, 124, 148, 0.2);
  border-radius: 12px;
  background: rgba(14, 21, 29, 0.34);
}

.note-tab__task-card-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.28em;
  min-width: 1.28em;
  height: 1.28em;
  margin-top: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--note-tab-task-open-border);
  font-size: calc(var(--note-font-size-px, 14) * 1px);
  line-height: 1;
  cursor: pointer;
  transform: translateY(0.08em);
}

.note-tab__task-card-toggle:hover,
.note-tab__task-card-toggle:focus-visible {
  color: rgba(110, 197, 255, 0.88);
  outline: none;
}

.note-tab__task-card-toggle-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
}

.note-tab__task-card-toggle-icon svg {
  display: block;
  width: 1em;
  height: 1em;
}

.note-tab__task-card-toggle--in-progress {
  color: var(--note-tab-task-progress-glyph);
}

.note-tab__task-card-toggle--waiting {
  color: var(--note-tab-task-waiting-glyph);
}

.note-tab__task-card-toggle--done {
  color: var(--note-tab-task-done-glyph);
}

.note-tab__task-card-toggle--cancelled {
  color: var(--note-tab-task-cancelled-glyph);
}

.note-tab__task-card-body {
  display: grid;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}

.note-tab__task-card-body:focus-visible {
  outline: 1px solid rgba(110, 197, 255, 0.34);
  outline-offset: 4px;
  border-radius: 8px;
}

.note-tab__task-card-meta {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--text-muted);
  font: 600 0.72rem/1.2 var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.note-tab__task-card-state {
  color: var(--text-primary);
}

.note-tab__task-card-text {
  margin: 0;
  color: var(--text-primary);
  font-size: calc(var(--note-font-size-px, 14) * 1px);
  line-height: 1.55;
}

.note-tab__task-card-actions {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  align-self: flex-start;
}

.note-tab__task-card-copy {
  margin: 0;
}

.note-tab__task-card--done .note-tab__task-card-text,
.note-tab__task-card--cancelled .note-tab__task-card-text {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

.note-tab__tasks-empty {
  margin: 0;
  color: var(--text-muted);
  font: 500 0.82rem/1.5 var(--font-mono);
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
  color: var(--note-tab-markdown-heading);
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
  background: var(--note-tab-table-bg);
}

.note-tab__markdown :deep(th),
.note-tab__markdown :deep(td) {
  border: 1px solid rgba(108, 124, 148, 0.28);
  padding: 0.46em 0.62em;
  text-align: left;
  vertical-align: top;
}

.note-tab__markdown :deep(th) {
  background: var(--note-tab-table-header-bg);
  color: var(--note-tab-markdown-heading);
  font-weight: 600;
}

.note-tab__markdown :deep(tbody tr:nth-child(even) td) {
  background: var(--note-tab-table-alt-bg);
}

.note-tab__markdown :deep(.task-list-item) {
  margin-left: 0;
}

.note-tab__markdown :deep(.note-tab__task-item) {
  position: relative;
  min-height: 1.25em;
  padding-left: 1.65em;
}

.note-tab__markdown :deep(.note-tab__task-item--bare) {
  list-style: none;
}

.note-tab__markdown :deep(.note-tab__task-item--bare::marker) {
  content: '';
}

.note-tab__markdown :deep(.note-tab__task-content) {
  display: block;
  min-width: 0;
}

.note-tab__markdown :deep(.note-tab__task-content > p:first-child) {
  margin-top: 0;
}

.note-tab__markdown :deep(.note-tab__task-content > p:last-child),
.note-tab__markdown :deep(.note-tab__task-content > ul:last-child),
.note-tab__markdown :deep(.note-tab__task-content > ol:last-child) {
  margin-bottom: 0;
}

.note-tab__markdown :deep(.note-tab__task-item--done) {
  color: color-mix(in srgb, var(--text-primary) 76%, transparent);
}

.note-tab__markdown :deep(.note-tab__task-item--cancelled) {
  color: color-mix(in srgb, var(--text-primary) 68%, transparent);
}

.note-tab__markdown :deep(.note-tab__task-item--done .note-tab__task-content),
.note-tab__markdown :deep(.note-tab__task-item--cancelled .note-tab__task-content) {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

.note-tab__markdown :deep(.note-tab__task-toggle) {
  position: absolute;
  top: 0.12em;
  left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25em;
  min-width: 1.25em;
  height: 1.25em;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--note-tab-task-open-border);
  font: inherit;
  line-height: 1;
  transform: none;
}

.note-tab__markdown :deep(.note-tab__task-toggle:hover),
.note-tab__markdown :deep(.note-tab__task-toggle:focus-visible) {
  color: rgba(110, 197, 255, 0.88);
  outline: none;
}

.note-tab__markdown :deep(.note-tab__task-toggle--in-progress) {
  color: var(--note-tab-task-progress-glyph);
}

.note-tab__markdown :deep(.note-tab__task-toggle--waiting) {
  color: var(--note-tab-task-waiting-glyph);
}

.note-tab__markdown :deep(.note-tab__task-toggle--done) {
  color: var(--note-tab-task-done-glyph);
}

.note-tab__markdown :deep(.note-tab__task-toggle--cancelled) {
  color: var(--note-tab-task-cancelled-glyph);
}

.note-tab__markdown :deep(.note-tab__task-toggle-icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25em;
  height: 1.25em;
}

.note-tab__markdown :deep(.note-tab__task-toggle-icon svg) {
  display: block;
  width: 1.25em;
  height: 1.25em;
}

.note-tab__markdown :deep(.note-tab__callout) {
  margin-inline: 0;
  border-left-width: 3px;
  border-left-style: solid;
  border-radius: 10px;
  padding: 0.7em 0.9em;
}

.note-tab__markdown :deep(.note-tab__callout-title) {
  margin-bottom: 0.45em;
  font-size: 0.82em;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.note-tab__markdown :deep(.note-tab__callout--note) {
  border-left-color: var(--note-tab-callout-note-border);
  background: var(--note-tab-callout-note-bg);
}

.note-tab__markdown :deep(.note-tab__callout--note .note-tab__callout-title) {
  color: var(--note-tab-callout-note-title);
}

.note-tab__markdown :deep(.note-tab__callout--tip) {
  border-left-color: var(--note-tab-callout-tip-border);
  background: var(--note-tab-callout-tip-bg);
}

.note-tab__markdown :deep(.note-tab__callout--tip .note-tab__callout-title) {
  color: var(--note-tab-callout-tip-title);
}

.note-tab__markdown :deep(.note-tab__callout--warning),
.note-tab__markdown :deep(.note-tab__callout--caution) {
  border-left-color: var(--note-tab-callout-warning-border);
  background: var(--note-tab-callout-warning-bg);
}

.note-tab__markdown :deep(.note-tab__callout--warning .note-tab__callout-title),
.note-tab__markdown :deep(.note-tab__callout--caution .note-tab__callout-title) {
  color: var(--note-tab-callout-warning-title);
}

.note-tab__markdown :deep(.note-tab__callout--important) {
  border-left-color: var(--note-tab-callout-important-border);
  background: var(--note-tab-callout-important-bg);
}

.note-tab__markdown :deep(.note-tab__callout--important .note-tab__callout-title) {
  color: var(--note-tab-callout-important-title);
}

.note-tab__markdown :deep(blockquote) {
  margin-inline: 0;
  padding: 0.5em 0.8em;
  border-left: 3px solid var(--note-tab-blockquote-border);
  background: var(--note-tab-blockquote-bg);
  border-radius: 8px;
  color: var(--note-tab-blockquote-text);
}

.note-tab__markdown :deep(code) {
  border: 1px solid rgba(108, 124, 148, 0.3);
  border-radius: 6px;
  background: var(--note-tab-inline-code-bg);
  padding: 0.08em 0.34em;
  font: 500 0.82em/1.4 var(--font-mono);
}

.note-tab__markdown :deep(pre) {
  overflow: auto;
  border: 1px solid rgba(108, 124, 148, 0.3);
  border-radius: 10px;
  background: var(--note-tab-pre-bg);
  padding: 10px 12px;
}

.note-tab__markdown :deep(.note-tab__code-block) {
  margin: 0.65em 0;
  border: 1px solid rgba(108, 124, 148, 0.3);
  border-radius: 10px;
  background: var(--note-tab-pre-bg);
  overflow: hidden;
}

.note-tab__markdown :deep(.note-tab__code-toolbar) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 8px 0;
}

.note-tab__markdown :deep(.note-tab__code-language) {
  color: rgba(173, 184, 197, 0.72);
  font: 700 0.68rem/1.2 var(--font-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.note-tab__markdown :deep(.note-tab__code-copy) {
  border: 1px solid rgba(108, 124, 148, 0.26);
  border-radius: 8px;
  background: var(--note-tab-code-toolbar-bg);
  color: var(--text-primary);
  padding: 0.22rem 0.48rem;
  font: 600 0.74rem/1.2 var(--font-mono);
}

.note-tab__markdown :deep(.note-tab__code-copy:hover) {
  border-color: rgba(110, 197, 255, 0.28);
  background: var(--note-tab-code-toolbar-hover-bg);
}

.note-tab__markdown :deep(.note-tab__code-block pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.note-tab__markdown :deep(.note-tab__mermaid) {
  overflow: auto;
  padding: 12px;
}

.note-tab__markdown :deep(.note-tab__mermaid[data-mermaid-state='rendered'] svg) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}

.note-tab__markdown :deep(.note-tab__mermaid-error) {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 176, 102, 0.25);
  border-radius: 10px;
  background: var(--note-tab-mermaid-error-bg);
  color: var(--note-tab-mermaid-error-text);
}

.note-tab__markdown :deep(.note-tab__mermaid-error strong) {
  font-size: 0.84rem;
}

.note-tab__markdown :deep(.note-tab__mermaid-error span) {
  color: rgba(255, 225, 188, 0.88);
  font-size: 0.76rem;
}

.note-tab__markdown :deep(pre code) {
  border: 0;
  background: transparent;
  padding: 0;
}

.note-tab__markdown :deep(.note-tab__code-token--comment) {
  color: var(--code-token-comment);
}

.note-tab__markdown :deep(.note-tab__code-token--string) {
  color: var(--code-token-string);
}

.note-tab__markdown :deep(.note-tab__code-token--number) {
  color: var(--code-token-number);
}

.note-tab__markdown :deep(.note-tab__code-token--keyword) {
  color: var(--code-token-keyword);
}

.note-tab__markdown :deep(.note-tab__code-token--variable) {
  color: var(--code-token-variable);
}

.note-tab__markdown :deep(.note-tab__code-token--property),
.note-tab__markdown :deep(.note-tab__code-token--key) {
  color: var(--code-token-property);
}

.note-tab__markdown :deep(.note-tab__code-token--tag),
.note-tab__markdown :deep(.note-tab__code-token--entity) {
  color: var(--code-token-tag);
}

.note-tab__markdown :deep(.note-tab__code-token--diff-add) {
  color: #95e3a8;
  background: rgba(53, 112, 71, 0.2);
}

.note-tab__markdown :deep(.note-tab__code-token--diff-remove) {
  color: #ff9e97;
  background: rgba(122, 48, 48, 0.2);
}

.note-tab__markdown :deep(.note-tab__code-token--diff-meta) {
  color: var(--code-token-keyword);
}

.note-tab__markdown :deep(a) {
  color: var(--note-tab-link-color);
  text-decoration-color: var(--note-tab-link-decoration);
}

.note-tab__markdown :deep(.note-tab__heading-anchor) {
  opacity: 0.32;
  text-decoration: none;
  transition: opacity 120ms ease;
}

.note-tab__markdown :deep(h1:hover .note-tab__heading-anchor),
.note-tab__markdown :deep(h2:hover .note-tab__heading-anchor),
.note-tab__markdown :deep(h3:hover .note-tab__heading-anchor),
.note-tab__markdown :deep(h4:hover .note-tab__heading-anchor),
.note-tab__markdown :deep(h5:hover .note-tab__heading-anchor),
.note-tab__markdown :deep(h6:hover .note-tab__heading-anchor) {
  opacity: 0.9;
}

.note-tab__markdown :deep(.note-tab__toc) {
  margin: 0.85em 0;
  padding: 0.8em 0.95em;
  border: 1px solid rgba(108, 124, 148, 0.24);
  border-radius: 10px;
  background: var(--note-tab-toc-bg);
}

.note-tab__markdown :deep(.note-tab__toc-title) {
  margin-bottom: 0.5em;
  color: var(--text-primary);
  font-size: 0.84em;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.note-tab__markdown :deep(.note-tab__toc-list) {
  margin: 0;
  padding-left: 1.2em;
}

.note-tab__markdown :deep(.note-tab__toc-item) {
  margin: 0.22em 0;
  padding-left: calc((var(--note-toc-level, 1) - 1) * 0.8em);
}

.note-tab__markdown :deep(.note-tab__toc-item > a) {
  display: inline-flex;
  width: 100%;
  padding: 0.14em 0.22em;
  border-radius: 6px;
  text-decoration: none;
}

.note-tab__markdown :deep(.note-tab__toc-item > a:hover) {
  background: var(--note-tab-toc-link-hover-bg);
}

.note-tab__markdown :deep(.note-tab__search-match) {
  border-radius: 0.24em;
  background: rgba(255, 220, 120, 0.34);
  color: inherit;
  padding: 0 0.06em;
}

.note-tab__markdown :deep(.note-tab__search-match--active) {
  background: rgba(255, 174, 71, 0.68);
  box-shadow: 0 0 0 1px rgba(255, 174, 71, 0.2);
}

.note-tab__path-menu,
.note-tab__task-menu,
.note-tab__task-copy-menu {
  position: fixed;
  z-index: 50;
  display: grid;
  min-width: 220px;
  padding: 6px;
  border: 1px solid rgba(108, 124, 148, 0.3);
  border-radius: 12px;
  background: rgba(10, 15, 22, 0.98);
  box-shadow: 0 18px 34px rgba(0, 0, 0, 0.34);
}

.note-tab__task-copy-menu {
  min-width: 176px;
}

.note-tab__path-menu-item,
.note-tab__task-menu-item,
.note-tab__task-copy-menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0.58rem 0.72rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.82rem;
  text-align: left;
}

.note-tab__path-menu-item:hover,
.note-tab__path-menu-item:focus-visible,
.note-tab__task-menu-item:hover,
.note-tab__task-menu-item:focus-visible,
.note-tab__task-copy-menu-item:hover,
.note-tab__task-copy-menu-item:focus-visible {
  background: rgba(36, 51, 66, 0.92);
  outline: none;
}

.note-tab__task-menu-item {
  gap: 0.72rem;
}

.note-tab__task-menu-item--active {
  background: rgba(36, 51, 66, 0.82);
}

.note-tab__task-menu-marker {
  min-width: 2rem;
  color: var(--text-secondary);
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

  .note-tab__search {
    gap: 8px;
  }

  .note-tab__file-actions,
  .note-tab__actions {
    flex-wrap: wrap;
    justify-self: start;
  }

  .note-tab__search-meta {
    justify-content: flex-end;
  }

  .note-tab__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
