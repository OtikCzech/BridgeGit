<script setup lang="ts">
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from '@codemirror/language';
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  type CodeNavigationRequest,
  type CodeNavigationTarget,
  type GitTextSearchMatch,
  normalizeNoteFontSize,
  type ResolvedEditorTheme,
  type ThemeVariant,
  type WorkspaceEditorCursorState,
  type WorkspaceExternalFileChangeState,
} from '../../shared/bridgegit';
import {
  CODE_EDITOR_LARGE_FILE_CHAR_LIMIT,
  getCodeEditorLanguageExtension,
  getCodeEditorLanguageLabel,
  getCodeEditorThemeExtension,
  isCodeEditorLargeFile,
} from '../codemirror/codeEditor';
import {
  readClipboardText as readSharedClipboardText,
  writeClipboardText as writeSharedClipboardText,
} from '../clipboard';
import {
  clearCodeNavigationCaches,
  filterCodeReferenceSearchMatches,
  getCodeNavigationSymbolAtOffset,
  resolveCodeNavigationAtOffset,
  resolveCodeNavigationResolutionAtOffset,
} from '../navigation/codeNavigation';
import { useClipboardHistoryTarget } from '../composables/useClipboardHistoryTarget';
import { SHORTCUTS, matchesShortcut, shortcutBindingsRevision } from '../shortcuts';

interface Props {
  active: boolean;
  busy: boolean;
  content: string;
  externalChange: WorkspaceExternalFileChangeState | null;
  filePath: string;
  isDirty: boolean;
  fontSize: number;
  projectRoot: string | null;
  navigationRequest: CodeNavigationRequest | null;
  editorTheme: ResolvedEditorTheme;
  themeVariant: ThemeVariant;
  cursor?: WorkspaceEditorCursorState;
}

const props = defineProps<Props>();
const shortcutBindingsVersion = shortcutBindingsRevision;

const emit = defineEmits<{
  'dismiss-external-change': [];
  'focus-next-tab': [];
  'focus-previous-tab': [];
  'open-file': [];
  'open-navigation-target': [target: CodeNavigationTarget];
  'reveal-in-all-files': [];
  'reload-from-disk': [];
  'save-file': [];
  'save-file-as': [];
  'update:content': [content: string];
  'update:cursor': [cursor: WorkspaceEditorCursorState];
  'update:font-size': [fontSize: number];
}>();

const rootRef = ref<HTMLElement | null>(null);
const editorRootRef = ref<HTMLElement | null>(null);
const copyToast = ref<string | null>(null);
const filePathMenu = ref<{ x: number; y: number } | null>(null);
const referencesQuery = ref<string | null>(null);
const referencesMatches = ref<GitTextSearchMatch[]>([]);
const referencesSearchBusy = ref(false);
const referencesSearchError = ref<string | null>(null);
const PATH_LABEL_MAX_LENGTH = 54;
const FILE_PATH_MENU_WIDTH = 220;
const FILE_PATH_MENU_HEIGHT = 168;

const editableCompartment = new Compartment();
const languageCompartment = new Compartment();
const modeCompartment = new Compartment();
const themeCompartment = new Compartment();
const linkHoverEffect = StateEffect.define<{ from: number; to: number } | null>();
const linkHoverMark = Decoration.mark({ class: 'code-tab__link-hover' });
const linkHoverField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    const mappedValue = value.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(linkHoverEffect)) {
        const hoverRange = effect.value;
        return hoverRange ? Decoration.set([linkHoverMark.range(hoverRange.from, hoverRange.to)]) : Decoration.none;
      }
    }

    return mappedValue;
  },
  provide: (field) => EditorView.decorations.from(field),
});

let editorView: EditorView | null = null;
let suppressContentSync = false;
let copyToastTimer: number | null = null;
let copySelectionTimer: number | null = null;
let lastCopiedSelection: string | null = null;
let selectionPointerActive = false;
let selectionCopyPendingAfterPointer = false;
let selectionKeyboardActive = false;
let selectionCopyPendingAfterKeyboard = false;
let selectionKeyboardMode: 'range' | 'select-all' | null = null;
let linkHoverRequestId = 0;
let modifierPressed = false;
let referencesSearchToken = 0;

const filePathLabel = computed(() => truncatePathStart(props.filePath, PATH_LABEL_MAX_LENGTH));
const codeStyle = computed(() => ({
  '--code-tab-font-size-px': String(normalizeNoteFontSize(props.fontSize)),
}));
const lineCount = computed(() => (
  props.content.length ? props.content.split('\n').length : 1
));
const characterCount = computed(() => props.content.length.toLocaleString());
const isLargeFile = computed(() => isCodeEditorLargeFile(props.content));
const languageLabel = computed(() => getCodeEditorLanguageLabel(props.filePath));
const hoveredLinkRange = ref<{ from: number; to: number; filePath: string } | null>(null);
const lastPointerCoords = ref<{ x: number; y: number } | null>(null);
const fileNameLabel = computed(() => (
  props.filePath.split(/[\\/]/).at(-1)?.trim() || props.filePath
));
const projectRelativePathLabel = computed(() => resolveProjectRelativePath(props.filePath, props.projectRoot));
const isPointerLinkActive = computed(() => Boolean(hoveredLinkRange.value));
const hasReferencesPanel = computed(() => (
  referencesSearchBusy.value
  || Boolean(referencesSearchError.value)
  || Boolean(referencesQuery.value)
));
const referencesCountLabel = computed(() => {
  const count = referencesMatches.value.length;
  return `${count} ${count === 1 ? 'match' : 'matches'}`;
});
const externalChangeCopy = computed(() => {
  if (props.externalChange === 'unavailable') {
    return {
      title: 'File is no longer available on disk.',
      body: props.isDirty
        ? 'Reload is unavailable until the file becomes readable again. Saving now would overwrite your local copy later.'
        : 'The editor is showing the last loaded version. Reload becomes available once the file is readable again.',
      actionLabel: null,
    };
  }

  if (props.externalChange === 'session-dirty') {
    return {
      title: 'This tab restored unsaved session changes.',
      body: 'The editor content differs from the file currently saved on disk. Reload to discard the restored version, or keep working and save when ready.',
      actionLabel: 'Refresh from disk',
    };
  }

  return {
    title: props.isDirty
      ? 'File changed on disk.'
      : 'A newer version of this file is available.',
    body: props.isDirty
      ? 'Reload will replace your current unsaved edits with the version from disk.'
      : 'Reload this tab to sync it with the latest file content from disk.',
    actionLabel: 'Refresh from disk',
  };
});

function truncatePathStart(pathValue: string, maxLength: number) {
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

function resolveProjectRelativePath(filePath: string, projectRoot: string | null) {
  if (!projectRoot) {
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
    return fileNameLabel.value;
  }

  const comparablePrefix = `${comparableProjectRoot}/`;

  if (!comparableFilePath.startsWith(comparablePrefix)) {
    return null;
  }

  return normalizedFilePath.slice(normalizedProjectRoot.length + 1);
}

function applyHoveredLinkDecoration(range: { from: number; to: number } | null) {
  if (!editorView) {
    return;
  }

  editorView.dispatch({
    effects: linkHoverEffect.of(range),
  });
}

function clearHoveredLink() {
  hoveredLinkRange.value = null;
  applyHoveredLinkDecoration(null);
}

async function inspectNavigableFile(filePath: string) {
  if (!window.bridgegit?.notes) {
    return null;
  }

  return window.bridgegit.notes.inspectFile(filePath);
}

async function updateHoveredLinkFromCoords(coords: { x: number; y: number } | null) {
  if (!editorView || !coords || !props.active || !modifierPressed) {
    clearHoveredLink();
    return;
  }

  const position = editorView.posAtCoords(coords);

  if (position === null) {
    clearHoveredLink();
    return;
  }

  const requestId = ++linkHoverRequestId;
  const navigationHit = await resolveCodeNavigationAtOffset({
    filePath: props.filePath,
    projectRoot: props.projectRoot,
    content: props.content,
    offset: position,
    inspectFile: inspectNavigableFile,
  });

  if (requestId !== linkHoverRequestId) {
    return;
  }

  if (!navigationHit) {
    clearHoveredLink();
    return;
  }

  const nextRange = {
    from: navigationHit.from,
    to: navigationHit.to,
    filePath: navigationHit.target.filePath,
  };
  hoveredLinkRange.value = nextRange;
  applyHoveredLinkDecoration({ from: nextRange.from, to: nextRange.to });
}

function revealNavigationTarget(target: CodeNavigationTarget) {
  if (!editorView || target.filePath !== props.filePath || !target.line) {
    return false;
  }

  const line = Math.max(1, Math.min(target.line, editorView.state.doc.lines));
  const lineInfo = editorView.state.doc.line(line);
  const lineColumn = Math.max(1, target.column ?? 1);
  const anchor = Math.min(lineInfo.to, lineInfo.from + lineColumn - 1);

  editorView.dispatch({
    selection: { anchor },
    scrollIntoView: true,
  });
  focusEditor({ preventScroll: true });
  return true;
}

async function openLinkedFileAtPosition(position: number | null) {
  if (!editorView || position === null) {
    return false;
  }

  const navigationResolution = await resolveCodeNavigationResolutionAtOffset({
    filePath: props.filePath,
    projectRoot: props.projectRoot,
    content: props.content,
    offset: position,
    inspectFile: inspectNavigableFile,
  });

  if (!navigationResolution) {
    return false;
  }

  if (navigationResolution.kind === 'definition' && navigationResolution.name) {
    await findReferencesForSymbol(
      {
        name: navigationResolution.name,
        from: navigationResolution.from,
      },
      navigationResolution.target,
    );
    return true;
  }

  if (revealNavigationTarget(navigationResolution.target)) {
    return true;
  }

  emit('open-navigation-target', navigationResolution.target);
  return true;
}

function focusEditor(options: FocusOptions = {}) {
  if (!props.active) {
    return;
  }

  editorView?.focus();

  if (options.preventScroll) {
    editorView?.contentDOM.scrollIntoView({ block: 'nearest' });
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

async function writeClipboard(text: string) {
  await writeSharedClipboardText(text);
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
  await copyFilePathText(props.filePath, 'Path copied');
}

async function copyFileName() {
  await copyFilePathText(fileNameLabel.value, 'Name copied');
}

async function copyProjectRelativePath() {
  if (!projectRelativePathLabel.value) {
    showCopyToast('Project root not available');
    return;
  }

  await copyFilePathText(projectRelativePathLabel.value, 'Project path copied');
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

async function handleCopyFileNameMenuClick() {
  closeFilePathMenu();
  await copyFileName();
}

async function handleCopyProjectRelativePathMenuClick() {
  closeFilePathMenu();
  await copyProjectRelativePath();
}

function handleRevealInAllFilesMenuClick() {
  closeFilePathMenu();
  emit('reveal-in-all-files');
}

function buildTargetFromOffset(filePath: string, content: string, offset: number): CodeNavigationTarget {
  const clampedOffset = Math.max(0, Math.min(offset, content.length));
  const before = content.slice(0, clampedOffset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n');
  const column = clampedOffset - (lineStart < 0 ? 0 : lineStart + 1) + 1;

  return {
    filePath,
    line,
    column,
  };
}

function normalizeReferenceText(text: string) {
  return text.replace(/\t/g, '  ').trim() || '(empty line)';
}

function closeReferencesPanel() {
  referencesSearchToken += 1;
  referencesQuery.value = null;
  referencesMatches.value = [];
  referencesSearchError.value = null;
  referencesSearchBusy.value = false;
}

function dismissReferencesPanel() {
  if (!hasReferencesPanel.value) {
    return;
  }

  closeReferencesPanel();
}

async function openReferenceMatch(match: GitTextSearchMatch) {
  const target: CodeNavigationTarget = {
    filePath: match.filePath,
    line: match.line,
    column: match.column,
  };

  if (revealNavigationTarget(target)) {
    return;
  }

  emit('open-navigation-target', target);
}

async function findReferencesForSymbol(
  symbol: { name: string; from: number },
  currentTarget?: CodeNavigationTarget | null,
) {
  if (!props.projectRoot || !window.bridgegit?.git) {
    showCopyToast('Project search is unavailable');
    return;
  }

  const requestToken = ++referencesSearchToken;
  referencesQuery.value = symbol.name;
  referencesMatches.value = [];
  referencesSearchError.value = null;
  referencesSearchBusy.value = true;

  try {
    const matches = await window.bridgegit.git.searchText(props.projectRoot, symbol.name, 200, { wholeWord: true });

    if (requestToken !== referencesSearchToken) {
      return;
    }

    const filteredMatches = await filterCodeReferenceSearchMatches({
      matches,
      inspectFile: inspectNavigableFile,
    });

    if (requestToken !== referencesSearchToken) {
      return;
    }

    referencesMatches.value = filteredMatches
      .filter((match) => {
        if (!currentTarget?.line) {
          return true;
        }

        return !(
          normalizePathForComparison(match.filePath) === normalizePathForComparison(currentTarget.filePath)
          && match.line === currentTarget.line
          && match.column === currentTarget.column
        );
      })
      .sort((left, right) => {
        const sameFileLeft = normalizePathForComparison(left.filePath) === normalizePathForComparison(props.filePath);
        const sameFileRight = normalizePathForComparison(right.filePath) === normalizePathForComparison(props.filePath);

        if (sameFileLeft !== sameFileRight) {
          return sameFileLeft ? -1 : 1;
        }

        const pathCompare = left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' });

        if (pathCompare !== 0) {
          return pathCompare;
        }

        if (left.line !== right.line) {
          return left.line - right.line;
        }

        return left.column - right.column;
      });
  } catch (error) {
    if (requestToken !== referencesSearchToken) {
      return;
    }

    referencesSearchError.value = error instanceof Error ? error.message : 'Failed to search references.';
  } finally {
    if (requestToken === referencesSearchToken) {
      referencesSearchBusy.value = false;
    }
  }
}

async function findReferencesAtCursor() {
  if (!editorView) {
    return;
  }

  const cursorOffset = editorView.state.selection.main.head;
  const symbol = getCodeNavigationSymbolAtOffset(props.content, cursorOffset);

  if (!symbol) {
    showCopyToast('Place the cursor on a symbol first');
    return;
  }

  await findReferencesForSymbol(symbol, buildTargetFromOffset(props.filePath, props.content, symbol.from));
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (event.button === 0 && rootRef.value?.contains(event.target as Node | null)) {
    selectionPointerActive = true;
    selectionCopyPendingAfterPointer = false;
  }

  if (!filePathMenu.value) {
    return;
  }

  const target = event.target as HTMLElement | null;

  if (target?.closest('.code-tab__path-menu, .code-tab__file-path-button')) {
    return;
  }

  closeFilePathMenu();
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

function clearPendingSelectionCopy() {
  if (copySelectionTimer) {
    window.clearTimeout(copySelectionTimer);
    copySelectionTimer = null;
  }
}

function getSelectedCodeText(view: EditorView | null = editorView) {
  if (!view || !props.active) {
    return null;
  }

  const selection = view.state.selection.main;

  if (selection.empty) {
    return null;
  }

  return view.state.sliceDoc(selection.from, selection.to);
}

function scheduleSelectionCopy(view: EditorView | null = editorView) {
  if (selectionKeyboardActive) {
    selectionCopyPendingAfterKeyboard = true;
    return;
  }

  if (selectionPointerActive) {
    selectionCopyPendingAfterPointer = true;
    return;
  }

  const selection = getSelectedCodeText(view);

  if (!selection) {
    lastCopiedSelection = null;
    clearPendingSelectionCopy();
    return;
  }

  clearPendingSelectionCopy();
  copySelectionTimer = window.setTimeout(async () => {
    const currentSelection = getSelectedCodeText(view);

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

async function pasteClipboardIntoEditor(view: EditorView, eventText?: string | null) {
  const clipboardText = await readSharedClipboardText({
    eventText,
    preferPreviousDistinctOf: getSelectedCodeText(view),
  });

  if (!clipboardText) {
    return;
  }

  insertTextIntoEditor(view, clipboardText);
}

function insertTextIntoEditor(view: EditorView, text: string) {
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

useClipboardHistoryTarget({
  isTargetActive: () => props.active && Boolean(editorView),
  insertText: (text) => {
    if (!editorView) {
      return;
    }

    insertTextIntoEditor(editorView, text);
  },
});

const CURSOR_EMIT_DEBOUNCE_MS = 250;
let cursorEmitTimer: number | null = null;

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

  const anchor = Math.min(Math.max(0, Math.floor(cursor.anchor)), docLength);
  const head = Math.min(Math.max(0, Math.floor(cursor.head)), docLength);
  return EditorSelection.single(anchor, head);
}

function handleEditorUpdate(update: ViewUpdate) {
  if (update.selectionSet) {
    scheduleSelectionCopy(update.view);
  }

  if (suppressContentSync) {
    return;
  }

  if (update.docChanged) {
    dismissReferencesPanel();
    const nextContent = update.state.doc.toString();

    if (nextContent !== props.content) {
      emit('update:content', nextContent);
    }
  }

  if (update.selectionSet) {
    scheduleCursorEmit();
  }
}

function buildModeExtensions(largeFile: boolean) {
  if (largeFile) {
    return [];
  }

  return [
    bracketMatching(),
    foldGutter(),
    highlightActiveLine(),
    indentOnInput(),
  ];
}

function buildEditableExtensions() {
  return [
    EditorState.readOnly.of(props.busy),
    EditorView.editable.of(!props.busy),
  ];
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
      lineNumbers(),
      drawSelection(),
      history(),
      highlightActiveLineGutter(),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      linkHoverField,
      EditorView.contentAttributes.of({
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      }),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (event.button === 0 && !event.ctrlKey && !event.metaKey) {
            dismissReferencesPanel();
            return false;
          }

          if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) {
            return false;
          }

          const position = view.posAtCoords({ x: event.clientX, y: event.clientY });

          if (position === null) {
            return false;
          }

          if (!hoveredLinkRange.value || position < hoveredLinkRange.value.from || position > hoveredLinkRange.value.to) {
            return false;
          }

          event.preventDefault();
          event.stopPropagation();
          void openLinkedFileAtPosition(position);
          return true;
        },
        mousemove: (event) => {
          lastPointerCoords.value = { x: event.clientX, y: event.clientY };
          void updateHoveredLinkFromCoords(lastPointerCoords.value);
          return false;
        },
        mouseleave: () => {
          lastPointerCoords.value = null;
          clearHoveredLink();
          return false;
        },
        contextmenu: (event, view) => {
          event.preventDefault();
          event.stopPropagation();
          void pasteClipboardIntoEditor(view);
          return true;
        },
        paste: (event, view) => {
          event.preventDefault();
          event.stopPropagation();
          void pasteClipboardIntoEditor(view, event.clipboardData?.getData('text/plain') ?? '');
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        handleEditorUpdate(update);
      }),
      editableCompartment.of(buildEditableExtensions()),
      languageCompartment.of(getCodeEditorLanguageExtension(props.filePath, isLargeFile.value)),
      modeCompartment.of(buildModeExtensions(isLargeFile.value)),
      themeCompartment.of(getCodeEditorThemeExtension(props.editorTheme)),
    ],
  });

  editorView = new EditorView({
    state,
    parent: editorRootRef.value,
  });

  if (props.cursor) {
    editorView.dispatch({
      effects: EditorView.scrollIntoView(editorView.state.selection.main, { y: 'center' }),
    });
  }

  if (props.active) {
    void nextTick(() => {
      focusEditor({ preventScroll: true });
    });
  }
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
    changes: {
      from: 0,
      to: currentContent.length,
      insert: nextContent,
    },
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
      languageCompartment.reconfigure(getCodeEditorLanguageExtension(props.filePath, isLargeFile.value)),
      modeCompartment.reconfigure(buildModeExtensions(isLargeFile.value)),
      themeCompartment.reconfigure(getCodeEditorThemeExtension(props.editorTheme)),
    ],
  });
}

function openSearch() {
  if (!editorView) {
    return;
  }

  focusEditor({ preventScroll: true });
  openSearchPanel(editorView);
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

function handleWheel(event: WheelEvent) {
  if (!props.active || (!event.ctrlKey && !event.metaKey)) {
    return;
  }

  event.preventDefault();
  emit('update:font-size', normalizeNoteFontSize(props.fontSize + (event.deltaY < 0 ? 1 : -1)));
}

function handleDocumentKeydown(event: KeyboardEvent) {
  const nextModifierPressed = event.ctrlKey || event.metaKey;

  if (nextModifierPressed !== modifierPressed) {
    modifierPressed = nextModifierPressed;
    void updateHoveredLinkFromCoords(lastPointerCoords.value);
  }

  if (!props.active) {
    return;
  }

  if (isSelectionRangeKeyboardShortcut(event)) {
    selectionKeyboardActive = true;
    selectionKeyboardMode = 'range';
  } else if (isSelectAllKeyboardShortcut(event)) {
    selectionKeyboardActive = true;
    selectionKeyboardMode = 'select-all';
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

  if (matchesShortcut(event, SHORTCUTS.codeFindReferences)) {
    event.preventDefault();

    if (hasReferencesPanel.value) {
      dismissReferencesPanel();
      focusEditor({ preventScroll: true });
      return;
    }

    void findReferencesAtCursor();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();

    if (event.shiftKey) {
      emit('save-file-as');
      return;
    }

    emit('save-file');
  }
}

function handleDocumentKeyup(event: KeyboardEvent) {
  if (selectionKeyboardActive) {
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

    if (shouldFinalizeRangeSelection || shouldFinalizeSelectAll) {
      selectionKeyboardActive = false;
      selectionKeyboardMode = null;

      if (selectionCopyPendingAfterKeyboard) {
        selectionCopyPendingAfterKeyboard = false;
        scheduleSelectionCopy();
      }
    }
  }

  const nextModifierPressed = event.ctrlKey || event.metaKey;

  if (nextModifierPressed === modifierPressed) {
    return;
  }

  modifierPressed = nextModifierPressed;
  void updateHoveredLinkFromCoords(lastPointerCoords.value);
}

watch(
  () => props.active,
  (nextActive) => {
    if (!nextActive) {
      clearHoveredLink();
      selectionKeyboardActive = false;
      selectionKeyboardMode = null;
      selectionCopyPendingAfterKeyboard = false;
      return;
    }

    void nextTick(() => {
      focusEditor({ preventScroll: true });
    });
  },
  { immediate: true },
);

watch(
  () => props.content,
  (nextContent) => {
    syncEditorContent(nextContent);
    clearHoveredLink();
    clearCodeNavigationCaches();
  },
);

watch(
  [() => props.busy, () => props.filePath, () => props.projectRoot, () => props.editorTheme, isLargeFile],
  () => {
    clearHoveredLink();
    clearCodeNavigationCaches();
    reconfigureEditor();
  },
);

watch(
  [() => props.filePath, () => props.projectRoot],
  () => {
    closeReferencesPanel();
  },
);

watch(
  () => props.navigationRequest,
  (nextNavigationRequest) => {
    if (!nextNavigationRequest) {
      return;
    }

    void nextTick(() => {
      revealNavigationTarget(nextNavigationRequest);
    });
  },
);

const handleFlushEditorState = () => {
  flushCursorEmit();
};

onMounted(() => {
  createEditor();
  document.addEventListener('keydown', handleDocumentKeydown);
  document.addEventListener('keyup', handleDocumentKeyup);
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('pointerup', handleDocumentPointerUp);
  window.addEventListener('bridgegit:flush-editor-state', handleFlushEditorState);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown);
  document.removeEventListener('keyup', handleDocumentKeyup);
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('pointerup', handleDocumentPointerUp);
  window.removeEventListener('bridgegit:flush-editor-state', handleFlushEditorState);
  clearPendingSelectionCopy();

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
    copyToastTimer = null;
  }

  flushCursorEmit();
  editorView?.destroy();
  editorView = null;
});
</script>

<template>
  <section
    ref="rootRef"
    class="code-tab"
    :class="{ 'code-tab--link-hovering': isPointerLinkActive }"
    :data-shortcut-bindings-version="shortcutBindingsVersion"
    :data-editor-theme-id="editorTheme"
    :data-editor-theme="themeVariant"
    :style="codeStyle"
    tabindex="-1"
    @wheel="handleWheel"
  >
    <div class="code-tab__toolbar">
      <div class="code-tab__meta">
        <div class="code-tab__meta-copy">
          <button
            class="code-tab__file-path-button"
            type="button"
            :title="`${filePath}\nClick to copy path from project root\nRight-click for more options`"
            aria-label="Copy file path"
            aria-haspopup="menu"
            @click="handleFilePathClick"
            @contextmenu="openFilePathMenu"
          >
            <span class="code-tab__file-path">{{ filePathLabel }}</span>
          </button>
          <button
            class="code-tab__action code-tab__action--inline"
            type="button"
            :disabled="busy"
            title="Find in file [Ctrl+F]"
            aria-label="Find in file"
            @click="openSearch"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.75 4.75a6 6 0 1 0 0 12a6 6 0 0 0 0-12Zm-7.5 6a7.5 7.5 0 1 1 13.12 4.96l3.46 3.45a.75.75 0 1 1-1.06 1.06l-3.45-3.46A7.5 7.5 0 0 1 3.25 10.75Z" />
            </svg>
          </button>
          <button
            class="code-tab__action code-tab__action--inline"
            type="button"
            :disabled="busy"
            :title="`Find references ${SHORTCUTS.codeFindReferences.display}`"
            aria-label="Find references"
            @click="findReferencesAtCursor"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7.75 5.5a2.25 2.25 0 1 1 0 4.5a2.25 2.25 0 0 1 0-4.5Zm8.5 0a2.25 2.25 0 1 1 0 4.5a2.25 2.25 0 0 1 0-4.5Zm-8.5 8.5a2.25 2.25 0 1 1 0 4.5a2.25 2.25 0 0 1 0-4.5Zm1.74-5.44a.75.75 0 0 1 1.02-.3l4.02 2.3a.75.75 0 0 1-.74 1.3l-4.02-2.3a.75.75 0 0 1-.28-1.02Zm0 4.88a.75.75 0 0 1 1.02.28l1.95 3.16a.75.75 0 0 1-1.28.8l-1.95-3.16a.75.75 0 0 1 .26-1.08Zm5.02-1.02a.75.75 0 0 1 1.04-.18l1.93 1.4a.75.75 0 1 1-.88 1.22l-1.92-1.4a.75.75 0 0 1-.17-1.04Z" />
            </svg>
          </button>
        </div>
      </div>

      <div class="code-tab__file-actions">
        <button
          class="code-tab__action"
          type="button"
          :disabled="busy"
          title="Open file"
          aria-label="Open file"
          @click="emit('open-file')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h4.1c.6 0 1.16.24 1.59.66l1.15 1.15c.14.14.33.22.53.22H18A2.25 2.25 0 0 1 20.25 8v8A2.25 2.25 0 0 1 18 18.25H6A2.25 2.25 0 0 1 3.75 16V6Zm2.25-.75a.75.75 0 0 0-.75.75v10c0 .41.34.75.75.75h12a.75.75 0 0 0 .75-.75V8a.75.75 0 0 0-.75-.75h-4.63a2.23 2.23 0 0 1-1.59-.66l-1.15-1.15a.75.75 0 0 0-.53-.22H6Z" />
          </svg>
        </button>

        <button
          class="code-tab__action"
          type="button"
          :disabled="busy"
          title="Save file [Ctrl+S]"
          aria-label="Save file"
          @click="emit('save-file')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5.75 3.75h9.7c.6 0 1.17.24 1.6.66l2.54 2.54c.42.42.66 1 .66 1.6v9.7a2.25 2.25 0 0 1-2.25 2.25H5.75A2.25 2.25 0 0 1 3.5 18V6A2.25 2.25 0 0 1 5.75 3.75Zm0 1.5a.75.75 0 0 0-.75.75v12c0 .41.34.75.75.75H18a.75.75 0 0 0 .75-.75V8.56a.76.76 0 0 0-.22-.53l-2.54-2.53a.75.75 0 0 0-.53-.22h-1.21V9a1.75 1.75 0 0 1-1.75 1.75h-3A1.75 1.75 0 0 1 7.75 9V5.25h-2Zm3.5 0V9a.25.25 0 0 0 .25.25h3A.25.25 0 0 0 12.75 9V5.25h-3.5Zm.5 8.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-4.5Z" />
          </svg>
        </button>

        <button
          class="code-tab__action"
          type="button"
          :disabled="busy"
          title="Save file as [Ctrl+Shift+S]"
          aria-label="Save file as"
          @click="emit('save-file-as')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5.75 3.75h9.7c.6 0 1.17.24 1.6.66l2.54 2.54c.42.42.66 1 .66 1.6v4.2a.75.75 0 0 1-1.5 0v-4.2a.76.76 0 0 0-.22-.53l-2.54-2.53a.75.75 0 0 0-.53-.22h-1.21V9a1.75 1.75 0 0 1-1.75 1.75h-3A1.75 1.75 0 0 1 7.75 9V5.25h-2A.75.75 0 0 0 5 6v12c0 .41.34.75.75.75h5.5a.75.75 0 0 1 0 1.5h-5.5A2.25 2.25 0 0 1 3.5 18V6A2.25 2.25 0 0 1 5.75 3.75Zm3.5 1.5V9a.25.25 0 0 0 .25.25h3A.25.25 0 0 0 12.75 9V5.25h-3.5Zm8.22 8.22a.75.75 0 0 1 1.06 0l2.47 2.47a.75.75 0 0 1 0 1.06l-2.47 2.47a.75.75 0 1 1-1.06-1.06l1.19-1.19h-5.91a.75.75 0 0 1 0-1.5h5.9l-1.18-1.19a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      <div class="code-tab__actions">
        <span class="code-tab__metric">{{ languageLabel }}</span>
        <span
          v-if="isLargeFile"
          class="code-tab__metric code-tab__metric--warning"
          :title="`Syntax highlighting is reduced above ${CODE_EDITOR_LARGE_FILE_CHAR_LIMIT.toLocaleString()} characters.`"
        >
          Large file mode
        </span>
        <span class="code-tab__metric">{{ lineCount.toLocaleString() }} lines</span>
        <span class="code-tab__metric">{{ characterCount }} chars</span>
        <span class="code-tab__metric">{{ fontSize }} px</span>
      </div>
    </div>

    <div v-if="externalChange" class="code-tab__external-change">
      <div class="code-tab__external-copy">
        <strong>{{ externalChangeCopy.title }}</strong>
        <span>{{ externalChangeCopy.body }}</span>
      </div>
      <div class="code-tab__external-actions">
        <button
          v-if="externalChangeCopy.actionLabel"
          class="code-tab__external-button code-tab__external-button--primary"
          type="button"
          :disabled="busy"
          @click="emit('reload-from-disk')"
        >
          {{ externalChangeCopy.actionLabel }}
        </button>
        <button
          class="code-tab__external-button"
          type="button"
          :disabled="busy"
          @click="emit('dismiss-external-change')"
        >
          Keep current
        </button>
      </div>
    </div>

    <div class="code-tab__body">
      <div ref="editorRootRef" class="code-tab__editor" />
      <section v-if="hasReferencesPanel" class="code-tab__references">
        <div class="code-tab__references-header">
          <div class="code-tab__references-copy">
            <strong>
              <template v-if="referencesQuery">References for {{ referencesQuery }}</template>
              <template v-else>References</template>
            </strong>
            <span v-if="referencesSearchBusy">Searching saved project files…</span>
            <span v-else-if="referencesSearchError">{{ referencesSearchError }}</span>
            <span v-else-if="referencesQuery">{{ referencesCountLabel }}</span>
          </div>
          <button
            class="code-tab__references-close"
            type="button"
            aria-label="Close references"
            @click="closeReferencesPanel"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.97 6.97a.75.75 0 0 1 1.06 0L12 10.94l3.97-3.97a.75.75 0 1 1 1.06 1.06L13.06 12l3.97 3.97a.75.75 0 1 1-1.06 1.06L12 13.06l-3.97 3.97a.75.75 0 1 1-1.06-1.06L10.94 12L6.97 8.03a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        <div v-if="!referencesSearchBusy && !referencesSearchError && !referencesMatches.length" class="code-tab__references-empty">
          No references found in saved project files.
        </div>

        <div v-else class="code-tab__references-list">
          <button
            v-for="match in referencesMatches"
            :key="`${match.filePath}:${match.line}:${match.column}`"
            class="code-tab__reference-item"
            type="button"
            @click="openReferenceMatch(match)"
          >
            <span class="code-tab__reference-path">{{ match.path }}</span>
            <span class="code-tab__reference-location">L{{ match.line }}:{{ match.column }}</span>
            <code class="code-tab__reference-text">{{ normalizeReferenceText(match.text) }}</code>
          </button>
        </div>

        <div v-if="isDirty" class="code-tab__references-note">
          References are searched in the version currently saved on disk.
        </div>
      </section>
    </div>

    <div
      v-if="filePathMenu"
      class="code-tab__path-menu"
      :style="{ left: `${filePathMenu.x}px`, top: `${filePathMenu.y}px` }"
      role="menu"
      aria-label="Copy file path"
    >
      <button
        class="code-tab__path-menu-item"
        type="button"
        role="menuitem"
        @click="handleCopyFullPathMenuClick"
      >
        Copy full path
      </button>
      <button
        class="code-tab__path-menu-item"
        type="button"
        role="menuitem"
        :disabled="!projectRelativePathLabel"
        @click="handleCopyProjectRelativePathMenuClick"
      >
        Copy path from project root
      </button>
      <button
        class="code-tab__path-menu-item"
        type="button"
        role="menuitem"
        @click="handleRevealInAllFilesMenuClick"
      >
        Reveal in All files
      </button>
      <button
        class="code-tab__path-menu-item"
        type="button"
        role="menuitem"
        @click="handleCopyFileNameMenuClick"
      >
        Copy file name
      </button>
    </div>

    <transition name="code-tab-toast">
      <div v-if="copyToast" class="code-tab__toast">
        {{ copyToast }}
      </div>
    </transition>
  </section>
</template>

<style scoped lang="scss">
.code-tab {
  --code-tab-text-primary: var(--text-primary);
  --code-tab-text-muted: var(--text-muted);
  --code-tab-text-dim: var(--text-dim);
  --code-tab-accent-strong: var(--accent-strong);
  --code-tab-action-bg: rgba(14, 20, 27, 0.88);
  --code-tab-action-hover-bg: rgba(24, 33, 43, 0.92);
  --code-tab-warning-text: #ffd099;
  --code-tab-warning-border: rgba(255, 176, 102, 0.24);
  --code-tab-warning-bg: rgba(74, 48, 18, 0.18);
  --code-tab-warning-strong: #ffe1bc;
  --code-tab-warning-muted: rgba(255, 225, 188, 0.82);
  --code-tab-warning-button-bg: rgba(24, 18, 11, 0.76);
  --code-tab-warning-button-primary-bg: rgba(110, 63, 13, 0.6);
  --code-tab-menu-bg: rgba(10, 15, 22, 0.98);
  --code-tab-menu-hover-bg: rgba(36, 51, 66, 0.92);
  --code-tab-toast-bg: rgba(9, 14, 20, 0.96);
  --code-tab-editor-bg: rgba(11, 16, 22, 0.92);
  --code-tab-gutter-bg: rgba(13, 19, 26, 0.92);
  --code-tab-gutter-color: rgba(143, 158, 177, 0.72);
  --code-tab-active-line-bg: rgba(42, 62, 84, 0.16);
  --code-tab-active-gutter-bg: rgba(36, 52, 69, 0.92);
  --code-tab-active-gutter-color: rgba(232, 240, 246, 0.88);
  --code-tab-selection-bg: rgba(59, 130, 246, 0.3);
  --code-tab-fold-bg: rgba(26, 38, 50, 0.88);
  --code-tab-panel-bg: rgba(15, 21, 29, 0.98);
  --code-tab-search-input-bg: rgba(10, 15, 22, 0.96);
  --code-tab-search-button-bg: rgba(20, 28, 39, 0.96);
  --code-tab-search-button-hover-bg: rgba(28, 39, 54, 0.98);
  --code-tab-search-match-bg: rgba(241, 194, 122, 0.2);
  --code-tab-search-match-outline: rgba(241, 194, 122, 0.28);
  --code-token-comment: #6f879c;
  --code-token-string: #8dd8a6;
  --code-token-number: #f1c27a;
  --code-token-keyword: #8dc7ff;
  --code-token-variable: #f7a8ff;
  --code-token-property: #7ee0d0;
  --code-token-tag: #ffb37f;
  --code-token-punctuation: rgba(226, 234, 242, 0.82);
  --code-token-invalid: #ff9e97;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-height: 0;
  height: 100%;
  gap: 8px;
  padding: 10px;
}

.code-tab[data-editor-theme='light'] {
  --code-tab-text-primary: #182535;
  --code-tab-text-muted: #607286;
  --code-tab-text-dim: #7d8da0;
  --code-tab-accent-strong: #2d7cd8;
  --code-tab-action-bg: rgba(236, 242, 249, 0.96);
  --code-tab-action-hover-bg: rgba(222, 232, 243, 0.98);
  --code-tab-warning-text: #8a5a18;
  --code-tab-warning-border: rgba(213, 160, 94, 0.34);
  --code-tab-warning-bg: rgba(255, 231, 196, 0.72);
  --code-tab-warning-strong: #774a11;
  --code-tab-warning-muted: rgba(119, 74, 17, 0.8);
  --code-tab-warning-button-bg: rgba(255, 244, 224, 0.96);
  --code-tab-warning-button-primary-bg: rgba(243, 207, 152, 0.92);
  --code-tab-menu-bg: rgba(255, 255, 255, 0.98);
  --code-tab-menu-hover-bg: rgba(228, 238, 248, 0.98);
  --code-tab-toast-bg: rgba(255, 255, 255, 0.98);
  --code-tab-editor-bg: rgba(252, 253, 255, 0.98);
  --code-tab-gutter-bg: rgba(240, 245, 251, 0.98);
  --code-tab-gutter-color: rgba(99, 116, 138, 0.78);
  --code-tab-active-line-bg: rgba(86, 143, 214, 0.1);
  --code-tab-active-gutter-bg: rgba(224, 235, 246, 0.98);
  --code-tab-active-gutter-color: rgba(36, 55, 78, 0.9);
  --code-tab-selection-bg: rgba(74, 139, 232, 0.2);
  --code-tab-fold-bg: rgba(231, 238, 246, 0.98);
  --code-tab-panel-bg: rgba(244, 248, 252, 0.98);
  --code-tab-search-input-bg: rgba(255, 255, 255, 0.98);
  --code-tab-search-button-bg: rgba(236, 242, 249, 0.98);
  --code-tab-search-button-hover-bg: rgba(224, 234, 244, 0.98);
  --code-tab-search-match-bg: rgba(241, 194, 122, 0.3);
  --code-tab-search-match-outline: rgba(195, 142, 62, 0.32);
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

.code-tab[data-editor-theme-id='github-dark'] {
  --code-tab-text-primary: #c9d1d9;
  --code-tab-text-muted: #8b949e;
  --code-tab-text-dim: #7d8590;
  --code-tab-accent-strong: #58a6ff;
  --code-tab-action-bg: #161b22;
  --code-tab-action-hover-bg: #21262d;
  --code-tab-warning-text: #d29922;
  --code-tab-warning-border: rgba(210, 153, 34, 0.26);
  --code-tab-warning-bg: rgba(93, 67, 21, 0.18);
  --code-tab-warning-strong: #f2cc60;
  --code-tab-warning-muted: rgba(242, 204, 96, 0.84);
  --code-tab-warning-button-bg: #21262d;
  --code-tab-warning-button-primary-bg: rgba(56, 139, 253, 0.24);
  --code-tab-menu-bg: #161b22;
  --code-tab-menu-hover-bg: #21262d;
  --code-tab-toast-bg: #161b22;
  --code-tab-editor-bg: #0d1117;
  --code-tab-gutter-bg: #0d1117;
  --code-tab-gutter-color: #6e7681;
  --code-tab-active-line-bg: rgba(56, 139, 253, 0.08);
  --code-tab-active-gutter-bg: #161b22;
  --code-tab-active-gutter-color: #c9d1d9;
  --code-tab-selection-bg: rgba(56, 139, 253, 0.28);
  --code-tab-fold-bg: #21262d;
  --code-tab-panel-bg: #161b22;
  --code-tab-search-input-bg: #0d1117;
  --code-tab-search-button-bg: #21262d;
  --code-tab-search-button-hover-bg: #30363d;
  --code-tab-search-match-bg: rgba(210, 153, 34, 0.2);
  --code-tab-search-match-outline: rgba(210, 153, 34, 0.28);
}

.code-tab[data-editor-theme-id='github-light'] {
  --code-tab-text-primary: #24292f;
  --code-tab-text-muted: #57606a;
  --code-tab-text-dim: #6e7781;
  --code-tab-accent-strong: #0969da;
  --code-tab-action-bg: #f6f8fa;
  --code-tab-action-hover-bg: #eef2f6;
  --code-tab-warning-text: #9a6700;
  --code-tab-warning-border: rgba(191, 135, 0, 0.24);
  --code-tab-warning-bg: rgba(255, 243, 205, 0.72);
  --code-tab-warning-strong: #7d4e00;
  --code-tab-warning-muted: rgba(125, 78, 0, 0.8);
  --code-tab-warning-button-bg: #fff8e1;
  --code-tab-warning-button-primary-bg: rgba(255, 208, 117, 0.72);
  --code-tab-menu-bg: #ffffff;
  --code-tab-menu-hover-bg: #f6f8fa;
  --code-tab-toast-bg: #ffffff;
  --code-tab-editor-bg: #ffffff;
  --code-tab-gutter-bg: #f6f8fa;
  --code-tab-gutter-color: #6e7781;
  --code-tab-active-line-bg: rgba(9, 105, 218, 0.08);
  --code-tab-active-gutter-bg: #eef2f6;
  --code-tab-active-gutter-color: #24292f;
  --code-tab-selection-bg: rgba(9, 105, 218, 0.18);
  --code-tab-fold-bg: #eef2f6;
  --code-tab-panel-bg: #f6f8fa;
  --code-tab-search-input-bg: #ffffff;
  --code-tab-search-button-bg: #f6f8fa;
  --code-tab-search-button-hover-bg: #eef2f6;
  --code-tab-search-match-bg: rgba(191, 135, 0, 0.2);
  --code-tab-search-match-outline: rgba(191, 135, 0, 0.28);
}

.code-tab[data-editor-theme-id='nord'] {
  --code-tab-text-primary: #d8dee9;
  --code-tab-text-muted: #a7b3c4;
  --code-tab-text-dim: #8c9aae;
  --code-tab-accent-strong: #88c0d0;
  --code-tab-action-bg: #3b4252;
  --code-tab-action-hover-bg: #434c5e;
  --code-tab-warning-text: #ebcb8b;
  --code-tab-warning-border: rgba(235, 203, 139, 0.22);
  --code-tab-warning-bg: rgba(94, 82, 48, 0.22);
  --code-tab-warning-strong: #f5d9a2;
  --code-tab-warning-muted: rgba(245, 217, 162, 0.84);
  --code-tab-warning-button-bg: rgba(59, 66, 82, 0.92);
  --code-tab-warning-button-primary-bg: rgba(129, 161, 193, 0.28);
  --code-tab-menu-bg: #2e3440;
  --code-tab-menu-hover-bg: #3b4252;
  --code-tab-toast-bg: #2e3440;
  --code-tab-editor-bg: #2e3440;
  --code-tab-gutter-bg: #2b313b;
  --code-tab-gutter-color: #7d8aa0;
  --code-tab-active-line-bg: rgba(136, 192, 208, 0.08);
  --code-tab-active-gutter-bg: #3b4252;
  --code-tab-active-gutter-color: #e5e9f0;
  --code-tab-selection-bg: rgba(129, 161, 193, 0.24);
  --code-tab-fold-bg: #434c5e;
  --code-tab-panel-bg: #3b4252;
  --code-tab-search-input-bg: #2e3440;
  --code-tab-search-button-bg: #3b4252;
  --code-tab-search-button-hover-bg: #434c5e;
  --code-tab-search-match-bg: rgba(235, 203, 139, 0.18);
  --code-tab-search-match-outline: rgba(235, 203, 139, 0.28);
}

.code-tab:focus {
  outline: none;
}

.code-tab--link-hovering {
  cursor: pointer;
}

.code-tab__toolbar {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 12px;
}

.code-tab__meta {
  display: grid;
  min-width: 0;
  max-width: 28rem;
}

.code-tab__meta-copy {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.code-tab__file-path-button {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: copy;
}

.code-tab__file-path-button:hover .code-tab__file-path,
.code-tab__file-path-button:focus-visible .code-tab__file-path {
  color: var(--code-tab-text-primary);
}

.code-tab__file-path-button:focus-visible {
  outline: none;
}

.code-tab__file-path {
  overflow: hidden;
  color: var(--code-tab-text-muted);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-tab__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  justify-self: end;
  min-width: 0;
}

.code-tab__file-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  grid-column: 2;
  justify-self: center;
}

.code-tab__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--code-tab-action-bg);
  color: var(--code-tab-text-primary);
}

.code-tab__action:hover {
  border-color: rgba(110, 197, 255, 0.2);
  background: var(--code-tab-action-hover-bg);
}

.code-tab__action:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.code-tab__action svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.code-tab__action--inline {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
}

.code-tab__metric {
  color: var(--code-tab-text-dim);
  font-size: 0.72rem;
  white-space: nowrap;
}

.code-tab__metric--warning {
  color: var(--code-tab-warning-text);
}

.code-tab__external-change {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--code-tab-warning-border);
  border-radius: 12px;
  background: var(--code-tab-warning-bg);
}

.code-tab__external-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.code-tab__external-copy strong {
  color: var(--code-tab-warning-strong);
  font-size: 0.82rem;
}

.code-tab__external-copy span {
  color: var(--code-tab-warning-muted);
  font-size: 0.76rem;
  line-height: 1.4;
}

.code-tab__external-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.code-tab__external-button {
  padding: 0.45rem 0.72rem;
  border: 1px solid var(--code-tab-warning-border);
  border-radius: 9px;
  background: var(--code-tab-warning-button-bg);
  color: var(--code-tab-text-primary);
  font-size: 0.76rem;
  white-space: nowrap;
}

.code-tab__external-button--primary {
  border-color: rgba(255, 196, 127, 0.32);
  background: var(--code-tab-warning-button-primary-bg);
}

.code-tab__external-button:disabled,
.code-tab__path-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.code-tab__body {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 8px;
  min-height: 0;
}

.code-tab__references {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: var(--code-tab-panel-bg);
}

.code-tab__references-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.code-tab__references-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.code-tab__references-copy strong {
  color: var(--code-tab-text-primary);
  font-size: 0.8rem;
}

.code-tab__references-copy span,
.code-tab__references-note,
.code-tab__references-empty {
  color: var(--code-tab-text-muted);
  font-size: 0.75rem;
  line-height: 1.45;
}

.code-tab__references-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--code-tab-action-bg);
  color: var(--code-tab-text-primary);
}

.code-tab__references-close:hover {
  background: var(--code-tab-action-hover-bg);
}

.code-tab__references-close svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.code-tab__references-list {
  display: grid;
  gap: 8px;
  max-height: 14rem;
  overflow: auto;
}

.code-tab__reference-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 10px;
  width: 100%;
  padding: 0.72rem 0.8rem;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--code-tab-action-bg);
  text-align: left;
}

.code-tab__reference-item:hover,
.code-tab__reference-item:focus-visible {
  border-color: rgba(110, 197, 255, 0.2);
  background: var(--code-tab-action-hover-bg);
  outline: none;
}

.code-tab__reference-path {
  overflow: hidden;
  color: var(--code-tab-text-primary);
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-tab__reference-location {
  color: var(--code-tab-text-dim);
  font: 600 0.72rem/1 var(--font-mono);
  white-space: nowrap;
}

.code-tab__reference-text {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--code-tab-text-muted);
  font: 0.75rem/1.4 var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-tab__path-menu {
  position: fixed;
  z-index: 50;
  display: grid;
  min-width: 220px;
  padding: 6px;
  border: 1px solid rgba(108, 124, 148, 0.3);
  border-radius: 12px;
  background: var(--code-tab-menu-bg);
  box-shadow: 0 18px 34px rgba(0, 0, 0, 0.34);
}

.code-tab__path-menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0.58rem 0.72rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--code-tab-text-primary);
  font-size: 0.82rem;
  text-align: left;
}

.code-tab__path-menu-item:hover,
.code-tab__path-menu-item:focus-visible {
  background: var(--code-tab-menu-hover-bg);
  outline: none;
}

.code-tab__toast {
  position: absolute;
  right: 16px;
  bottom: 16px;
  padding: 0.5rem 0.72rem;
  border: 1px solid rgba(108, 124, 148, 0.26);
  border-radius: 10px;
  background: var(--code-tab-toast-bg);
  color: var(--code-tab-text-primary);
  font: 600 0.76rem/1.2 var(--font-mono);
  box-shadow: 0 16px 30px rgba(0, 0, 0, 0.26);
  pointer-events: none;
}

.code-tab-toast-enter-active,
.code-tab-toast-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.code-tab-toast-enter-from,
.code-tab-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.code-tab__editor {
  min-height: 0;
  height: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: var(--code-tab-editor-bg);
  overflow: hidden;
}

.code-tab__editor :deep(.cm-editor) {
  height: 100%;
  background: var(--code-tab-editor-bg);
  color: var(--code-tab-text-primary);
  font-family: var(--font-mono), 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', monospace;
  font-size: calc(var(--code-tab-font-size-px, 14) * 1px);
}

.code-tab__editor :deep(.cm-focused) {
  outline: none;
}

.code-tab__editor :deep(.cm-scroller) {
  overflow: auto;
  font-family: inherit;
  line-height: 1.6;
}

.code-tab__editor :deep(.cm-content),
.code-tab__editor :deep(.cm-gutter) {
  min-height: 100%;
}

.code-tab__editor :deep(.cm-content) {
  padding: 0.95rem 0 1.1rem;
  caret-color: var(--code-tab-accent-strong);
}

.code-tab__editor :deep(.code-tab__link-hover) {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--code-tab-accent-strong);
  text-underline-offset: 0.18em;
}

.code-tab__editor :deep(.cm-line) {
  padding: 0 1rem;
}

.code-tab__editor :deep(.cm-gutters) {
  border-right: 1px solid rgba(108, 124, 148, 0.18);
  background: var(--code-tab-gutter-bg);
  color: var(--code-tab-gutter-color);
}

.code-tab__editor :deep(.cm-gutterElement) {
  padding: 0 0.8rem 0 0.95rem;
}

.code-tab__editor :deep(.cm-activeLine) {
  background: var(--code-tab-active-line-bg);
}

.code-tab__editor :deep(.cm-activeLineGutter) {
  background: var(--code-tab-active-gutter-bg);
  color: var(--code-tab-active-gutter-color);
}

.code-tab__editor :deep(.cm-selectionBackground),
.code-tab__editor :deep(.cm-content ::selection),
.code-tab__editor :deep(.cm-searchMatch.cm-searchMatch-selected) {
  background: var(--code-tab-selection-bg);
}

.code-tab__editor :deep(.cm-cursor) {
  border-left-color: var(--code-tab-accent-strong);
}

.code-tab__editor :deep(.cm-matchingBracket),
.code-tab__editor :deep(.cm-nonmatchingBracket) {
  border-bottom: 1px solid rgba(123, 208, 255, 0.55);
}

.code-tab__editor :deep(.cm-foldPlaceholder) {
  border: 1px solid rgba(108, 124, 148, 0.25);
  border-radius: 5px;
  background: var(--code-tab-fold-bg);
  color: var(--code-tab-text-dim);
}

.code-tab__editor :deep(.cm-selectionMatch) {
  background: rgba(141, 199, 255, 0.14);
}

.code-tab__editor :deep(.cm-panels) {
  border-bottom: 1px solid rgba(108, 124, 148, 0.22);
  background: var(--code-tab-panel-bg);
  color: var(--code-tab-text-primary);
}

.code-tab__editor :deep(.cm-panels-top) {
  border-bottom: 1px solid rgba(108, 124, 148, 0.22);
}

.code-tab__editor :deep(.cm-search) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font: 500 0.78rem/1.35 var(--font-mono);
}

.code-tab__editor :deep(.cm-search label) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.code-tab__editor :deep(.cm-search .cm-textfield) {
  min-width: 12rem;
  border: 1px solid rgba(108, 124, 148, 0.28);
  border-radius: 8px;
  background: var(--code-tab-search-input-bg);
  color: var(--code-tab-text-primary);
  padding: 0.3rem 0.48rem;
}

.code-tab__editor :deep(.cm-search .cm-button) {
  border: 1px solid rgba(108, 124, 148, 0.26);
  border-radius: 8px;
  background: var(--code-tab-search-button-bg);
  color: var(--code-tab-text-primary);
  padding: 0.26rem 0.5rem;
  font: 600 0.74rem/1.2 var(--font-mono);
}

.code-tab__editor :deep(.cm-search .cm-button:hover) {
  border-color: rgba(110, 197, 255, 0.28);
  background: var(--code-tab-search-button-hover-bg);
}

.code-tab__editor :deep(.cm-searchMatch) {
  background: var(--code-tab-search-match-bg);
  outline: 1px solid var(--code-tab-search-match-outline);
}

@media (max-width: 900px) {
  .code-tab__toolbar {
    grid-template-columns: 1fr;
  }

  .code-tab__file-actions {
    grid-column: auto;
    justify-self: start;
  }

  .code-tab__actions {
    justify-self: start;
    flex-wrap: wrap;
  }
}
</style>
