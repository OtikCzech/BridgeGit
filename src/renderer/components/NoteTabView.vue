<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  normalizeNoteFontSize,
  type AppAppearance,
  type ThemeVariant,
  type WorkspaceExternalFileChangeState,
  type WorkspaceNoteTabState,
} from '../../shared/bridgegit';
import { SHORTCUTS, matchesShortcut } from '../shortcuts';

interface Props {
  active: boolean;
  busy: boolean;
  content: string;
  externalChange: WorkspaceExternalFileChangeState | null;
  filePath: string | null;
  isDirty: boolean;
  projectRoot: string | null;
  appearanceTheme: AppAppearance;
  appearanceThemeVariant: ThemeVariant;
  viewMode: WorkspaceNoteTabState['viewMode'];
  fontSize: number;
}

const props = defineProps<Props>();

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
  'update:font-size': [fontSize: number];
  'update:view-mode': [viewMode: WorkspaceNoteTabState['viewMode']];
}>();

const rootRef = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const previewRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const copyToast = ref<string | null>(null);
const filePathMenu = ref<{ x: number; y: number } | null>(null);
const searchVisible = ref(false);
const searchQuery = ref('');
const activeSourceMatchIndex = ref(0);
const activePreviewMatchIndex = ref(0);
const previewMatchCount = ref(0);
const renderedMarkdown = ref('<p class="note-tab__preview-empty">Nothing to preview yet.</p>');
let copyToastTimer: number | null = null;
let copySelectionTimer: number | null = null;
let lastCopiedSelection: string | null = null;
let markdownRenderToken = 0;
let mermaidInitialized = false;
let mermaidThemeVariant: ThemeVariant | null = null;
let nextMermaidDiagramId = 1;
const NOTE_PATH_LABEL_MAX_LENGTH = 36;
const FILE_PATH_MENU_WIDTH = 220;
const FILE_PATH_MENU_HEIGHT = 168;
const NOTE_VIEW_MODES: WorkspaceNoteTabState['viewMode'][] = ['source', 'split', 'preview'];
const NOTE_FILE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
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
  highlightCodeBlock?: CodeBlockHighlighter,
) {
  const parser = new DOMParser();
  const documentRoot = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const container = documentRoot.body;
  const headingSlugCounts = new Map<string, number>();
  const headingItems: Array<{ id: string; level: number; label: string }> = [];
  const calloutTitles: Record<string, string> = {
    note: 'Note',
    tip: 'Tip',
    warning: 'Warning',
    important: 'Important',
    caution: 'Caution',
  };

  container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox, index) => {
    checkbox.removeAttribute('disabled');
    checkbox.setAttribute('data-task-index', String(index));
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
    copyButton.textContent = 'Copy';
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
    anchor.setAttribute('aria-label', `Link to ${headingLabel || 'section'}`);
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
    nav.setAttribute('aria-label', 'Table of contents');
    const title = documentRoot.createElement('div');
    title.className = 'note-tab__toc-title';
    title.textContent = 'Contents';
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
    renderedMarkdown.value = '<p class="note-tab__preview-empty">Nothing to preview yet.</p>';
    return;
  }

  try {
    const parsed = marked.parse(props.content);
    const html = typeof parsed === 'string' ? parsed : '';
    const sanitizedHtml = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
    });

    const previewHtml = enhanceRenderedMarkdownHtml(sanitizedHtml, props.filePath);

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
        renderHighlightedCodeHtml,
      );
    } catch (error) {
      console.error('Failed to load markdown code highlighting.', error);
    }
  } catch {
    if (renderToken !== markdownRenderToken) {
      return;
    }

    renderedMarkdown.value = '<p class="note-tab__preview-error">Preview failed.</p>';
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
          <strong>Mermaid render failed.</strong>
          <span>The diagram source is still available via Copy.</span>
        </div>
      `;
    }
  }));
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
  props.filePath ? truncatePathStart(props.filePath) : 'Scratch note'
));
const noteFileNameLabel = computed(() => (
  props.filePath?.split(/[\\/]/).at(-1)?.trim() || noteLocationLabel.value
));
const projectRelativePathLabel = computed(() => resolveProjectRelativePath(props.filePath, props.projectRoot));
const resolvedFontSize = computed(() => normalizeNoteFontSize(props.fontSize));
const noteStyle = computed(() => ({
  '--note-font-size-px': String(resolvedFontSize.value),
}));
const normalizedSearchQuery = computed(() => searchQuery.value.trim());
const searchMode = computed(() => (props.viewMode === 'preview' ? 'preview' : 'source'));
const sourceMatches = computed(() => findSearchMatches(props.content, normalizedSearchQuery.value));
const activeMatchCount = computed(() => (
  searchMode.value === 'preview' ? previewMatchCount.value : sourceMatches.value.length
));
const activeMatchDisplayIndex = computed(() => {
  if (activeMatchCount.value < 1) {
    return 0;
  }

  return (searchMode.value === 'preview' ? activePreviewMatchIndex.value : activeSourceMatchIndex.value) + 1;
});
const externalChangeCopy = computed(() => {
  if (props.externalChange === 'unavailable') {
    return {
      title: 'File is no longer available on disk.',
      body: props.isDirty
        ? 'Reload is unavailable until the file becomes readable again. Your current note edits stay only in this tab.'
        : 'The note preview is showing the last loaded version. Reload becomes available once the file is readable again.',
      actionLabel: null,
    };
  }

  if (props.externalChange === 'session-dirty') {
    return {
      title: 'This tab restored unsaved session changes.',
      body: 'The note content differs from the file currently saved on disk. Reload to discard the restored version, or keep working and save when ready.',
      actionLabel: 'Refresh from disk',
    };
  }

  return {
    title: props.isDirty
      ? 'File changed on disk.'
      : 'A newer version of this note is available.',
    body: props.isDirty
      ? 'Reload will replace your current unsaved edits with the version from disk.'
      : 'Reload this tab to sync it with the latest file content from disk.',
    actionLabel: 'Refresh from disk',
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

function clearPendingSelectionCopy() {
  if (copySelectionTimer) {
    window.clearTimeout(copySelectionTimer);
    copySelectionTimer = null;
  }
}

function getSelectedTextareaText() {
  const textarea = textareaRef.value;

  if (!textarea || document.activeElement !== textarea) {
    return null;
  }

  const selectionStart = textarea.selectionStart ?? 0;
  const selectionEnd = textarea.selectionEnd ?? 0;

  if (selectionEnd <= selectionStart) {
    return null;
  }

  return textarea.value.slice(selectionStart, selectionEnd);
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

  return getSelectedTextareaText() ?? getSelectedPreviewText();
}

function scheduleSelectionCopy() {
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
      showCopyToast('Copied');
    } catch {
      showCopyToast('Copy failed');
    }
  }, 90);
}

async function copyFilePathText(text: string, successMessage: string) {
  try {
    await writeClipboard(text);
    showCopyToast(successMessage);
  } catch {
    showCopyToast('Copy failed');
  }
}

function getFilePathMenuPosition(event: MouseEvent) {
  const maxX = Math.max(12, window.innerWidth - FILE_PATH_MENU_WIDTH - 12);
  const maxY = Math.max(12, window.innerHeight - FILE_PATH_MENU_HEIGHT - 12);

  return {
    x: Math.min(event.clientX, maxX),
    y: Math.min(event.clientY, maxY),
  };
}

async function copyFullPath() {
  await copyFilePathText(props.filePath ?? noteLocationLabel.value, props.filePath ? 'Path copied' : 'Copied');
}

async function copyProjectRelativePath() {
  if (!projectRelativePathLabel.value) {
    showCopyToast('Project root not available');
    return;
  }

  await copyFilePathText(projectRelativePathLabel.value, 'Project path copied');
}

async function copyFileName() {
  await copyFilePathText(noteFileNameLabel.value, 'Name copied');
}

function closeFilePathMenu() {
  filePathMenu.value = null;
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
  filePathMenu.value = getFilePathMenuPosition(event);
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

async function focusSearchInput(selectText = false) {
  await nextTick();
  searchInputRef.value?.focus({ preventScroll: true });

  if (selectText) {
    searchInputRef.value?.select();
  }
}

async function openSearch(selectText = false) {
  if (!searchVisible.value) {
    searchVisible.value = true;
  }

  await focusSearchInput(selectText);
}

function closeSearch() {
  searchVisible.value = false;
  searchQuery.value = '';
  activeSourceMatchIndex.value = 0;
  activePreviewMatchIndex.value = 0;
  previewMatchCount.value = 0;
  clearPreviewSearchHighlights();
  void focusEditor();
}

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement | null;
  emit('update:content', target?.value ?? '');
}

function findSearchMatches(content: string, query: string) {
  if (!query) {
    return [] as Array<{ start: number; end: number }>;
  }

  const normalizedContent = content.toLocaleLowerCase();
  const normalizedQueryValue = query.toLocaleLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let searchIndex = 0;

  while (searchIndex <= normalizedContent.length - normalizedQueryValue.length) {
    const matchIndex = normalizedContent.indexOf(normalizedQueryValue, searchIndex);

    if (matchIndex < 0) {
      break;
    }

    matches.push({
      start: matchIndex,
      end: matchIndex + normalizedQueryValue.length,
    });
    searchIndex = matchIndex + Math.max(1, normalizedQueryValue.length);
  }

  return matches;
}

function updateChecklistItem(taskIndex: number, checked: boolean) {
  if (!Number.isInteger(taskIndex) || taskIndex < 0) {
    return;
  }

  const lines = props.content.split('\n');
  let currentTaskIndex = 0;

  const nextLines = lines.map((line) => {
    const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(?: |x|X)(\].*)$/.exec(line);

    if (!match) {
      return line;
    }

    if (currentTaskIndex !== taskIndex) {
      currentTaskIndex += 1;
      return line;
    }

    currentTaskIndex += 1;
    return `${match[1]}${checked ? 'x' : ' '}${match[2]}`;
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

function handlePreviewChange(event: Event) {
  const target = event.target as HTMLInputElement | null;

  if (!target || target.type !== 'checkbox') {
    return;
  }

  const taskIndex = Number.parseInt(target.dataset.taskIndex ?? '', 10);

  if (Number.isNaN(taskIndex)) {
    return;
  }

  updateChecklistItem(taskIndex, target.checked);
}

async function handlePreviewClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;

  if (!target) {
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
      showCopyToast('Nothing to copy');
      return;
    }

    try {
      await writeClipboard(codeText);
      showCopyToast('Code copied');
    } catch {
      showCopyToast('Copy failed');
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
      showCopyToast('Note not found');
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

function handleDocumentPointerDown(event: PointerEvent) {
  if (!filePathMenu.value) {
    return;
  }

  const target = event.target as HTMLElement | null;

  if (target?.closest('.note-tab__path-menu, .note-tab__file-path-button')) {
    return;
  }

  closeFilePathMenu();
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

function syncSourceMatchSelection() {
  const textarea = textareaRef.value;
  const matches = sourceMatches.value;

  if (!textarea || matches.length < 1 || props.viewMode === 'preview') {
    return;
  }

  const match = matches[Math.min(activeSourceMatchIndex.value, matches.length - 1)];

  if (!match) {
    return;
  }

  textarea.setSelectionRange(match.start, match.end, 'forward');
  textarea.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    searchInputRef.value?.focus({ preventScroll: true });
  });
}

function goToNextSearchMatch() {
  if (!normalizedSearchQuery.value) {
    return;
  }

  if (searchMode.value === 'preview') {
    if (previewMatchCount.value < 1) {
      return;
    }

    activePreviewMatchIndex.value = (activePreviewMatchIndex.value + 1) % previewMatchCount.value;
    syncActivePreviewMatch(true);
    return;
  }

  if (sourceMatches.value.length < 1) {
    return;
  }

  activeSourceMatchIndex.value = (activeSourceMatchIndex.value + 1) % sourceMatches.value.length;
  syncSourceMatchSelection();
}

function goToPreviousSearchMatch() {
  if (!normalizedSearchQuery.value) {
    return;
  }

  if (searchMode.value === 'preview') {
    if (previewMatchCount.value < 1) {
      return;
    }

    activePreviewMatchIndex.value = (
      activePreviewMatchIndex.value - 1 + previewMatchCount.value
    ) % previewMatchCount.value;
    syncActivePreviewMatch(true);
    return;
  }

  if (sourceMatches.value.length < 1) {
    return;
  }

  activeSourceMatchIndex.value = (
    activeSourceMatchIndex.value - 1 + sourceMatches.value.length
  ) % sourceMatches.value.length;
  syncSourceMatchSelection();
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

  if (filePathMenu.value && event.key === 'Escape') {
    event.preventDefault();
    closeFilePathMenu();
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

onMounted(() => {
  document.addEventListener('keydown', handleDocumentKeydown);
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('selectionchange', scheduleSelectionCopy);
  void focusEditor();
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown);
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('selectionchange', scheduleSelectionCopy);
  clearPendingSelectionCopy();

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
    copyToastTimer = null;
  }
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
    await nextTick();
    await renderMermaidDiagrams();

    if (!searchVisible.value) {
      return;
    }

    await refreshPreviewSearch();
  },
);

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

watch(
  () => normalizedSearchQuery.value,
  () => {
    activeSourceMatchIndex.value = 0;
    activePreviewMatchIndex.value = 0;

    if (!searchVisible.value) {
      return;
    }

    syncSourceMatchSelection();
    void refreshPreviewSearch();
  },
);

watch(
  () => props.content,
  () => {
    if (!searchVisible.value || !normalizedSearchQuery.value) {
      return;
    }

    if (activeSourceMatchIndex.value >= sourceMatches.value.length) {
      activeSourceMatchIndex.value = Math.max(0, sourceMatches.value.length - 1);
    }

    syncSourceMatchSelection();
    void refreshPreviewSearch();
  },
);

watch(
  () => props.viewMode,
  () => {
    if (!searchVisible.value) {
      return;
    }

    syncSourceMatchSelection();
    void refreshPreviewSearch();
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
    :data-appearance-theme="appearanceTheme"
    :style="noteStyle"
    tabindex="-1"
  >
    <div class="note-tab__toolbar">
      <div class="note-tab__meta">
        <div class="note-tab__meta-copy">
          <button
            class="note-tab__file-path-button"
            type="button"
            :title="`${filePath || noteLocationLabel}\nClick to copy path from project root\nRight-click for more options`"
            aria-label="Copy note path"
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
            :title="`Find in note ${SHORTCUTS.noteSearch.display}`"
            aria-label="Find in note"
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
          title="Open file [Ctrl+O]"
          aria-label="Open file"
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
          Keep current
        </button>
      </div>
    </div>

    <div v-if="searchVisible" class="note-tab__search">
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
          title="Previous match [Shift+Enter]"
          @click="goToPreviousSearchMatch"
        >
          ↑
        </button>

        <button
          class="note-tab__search-action"
          type="button"
          :disabled="activeMatchCount < 1"
          title="Next match [Enter]"
          @click="goToNextSearchMatch"
        >
          ↓
        </button>

        <button
          class="note-tab__search-action"
          type="button"
          :title="`Close find ${SHORTCUTS.noteSearch.display}`"
          aria-label="Close find"
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
          :placeholder="`Find in this note ${SHORTCUTS.noteSearch.display}`"
          @keydown="handleSearchKeydown"
        >
      </label>
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
          @select="scheduleSelectionCopy"
          @pointerup="scheduleSelectionCopy"
          @keyup="scheduleSelectionCopy"
        />
      </div>

      <div
        ref="previewRef"
        class="note-tab__preview"
        :class="{ 'note-tab__preview--hidden': viewMode === 'source' }"
        @pointerdown="focusHotkeySurface"
        @change="handlePreviewChange"
        @click="handlePreviewClick"
      >
        <article class="note-tab__markdown" v-html="renderedMarkdown" />
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
      aria-label="Copy note path"
    >
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        @click="handleCopyFullPathMenuClick"
      >
        Copy full path
      </button>
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        :disabled="!projectRelativePathLabel"
        @click="handleCopyProjectRelativePathMenuClick"
      >
        Copy path from project root
      </button>
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        :disabled="!filePath"
        @click="handleRevealInAllFilesMenuClick"
      >
        Reveal in All files
      </button>
      <button
        class="note-tab__path-menu-item"
        type="button"
        role="menuitem"
        @click="handleCopyFileNameMenuClick"
      >
        Copy file name
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.note-tab {
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
  --code-token-comment: #6f879c;
  --code-token-string: #8dd8a6;
  --code-token-number: #f1c27a;
  --code-token-keyword: #8dc7ff;
  --code-token-variable: #f7a8ff;
  --code-token-property: #7ee0d0;
  --code-token-tag: #ffb37f;
  --code-token-punctuation: rgba(226, 234, 242, 0.82);
  --code-token-invalid: #ff9e97;
  position: relative;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 10px;
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
  background: var(--note-tab-input-bg);
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
  background: var(--note-tab-preview-bg);
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
  list-style: none;
  margin-left: -1.2em;
}

.note-tab__markdown :deep(.task-list-item input[type='checkbox']) {
  cursor: pointer;
  margin-right: 0.42em;
  accent-color: #66b9f6;
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

.note-tab__path-menu {
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

.note-tab__path-menu-item {
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
.note-tab__path-menu-item:focus-visible {
  background: rgba(36, 51, 66, 0.92);
  outline: none;
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
