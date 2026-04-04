export interface ShortcutDefinition {
  id: string;
  label: string;
  display: string;
  key: string;
  keys?: string[];
  codes?: string[];
  alt?: boolean;
  shift?: boolean;
  ctrlOrMeta?: boolean;
  ignoreShift?: boolean;
}

export interface ShortcutGroupDefinition {
  id: string;
  label: string;
  shortcuts: ShortcutDefinition[];
}

export const SHORTCUTS = {
  historyOpen: {
    id: 'history-open',
    label: 'Open git history',
    display: '[Ctrl+H]',
    key: 'h',
    ctrlOrMeta: true,
  },
  historySearch: {
    id: 'history-search',
    label: 'History search',
    display: '[Ctrl+Shift+F]',
    key: 'f',
    shift: true,
    ctrlOrMeta: true,
  },
  panelRepoToggle: {
    id: 'panel-repo-toggle',
    label: 'Toggle repository panel',
    display: '[Ctrl+1]',
    key: '1',
    keys: ['+', '1'],
    codes: ['Digit1'],
    ctrlOrMeta: true,
    ignoreShift: true,
  },
  panelDiffToggle: {
    id: 'panel-diff-toggle',
    label: 'Toggle diff panel',
    display: '[Ctrl+2]',
    key: '2',
    keys: ['ě', '2'],
    codes: ['Digit2'],
    ctrlOrMeta: true,
    ignoreShift: true,
  },
  panelTerminalToggle: {
    id: 'panel-terminal-toggle',
    label: 'Toggle workspace panel',
    display: '[Ctrl+3]',
    key: '3',
    keys: ['š', '3'],
    codes: ['Digit3'],
    ctrlOrMeta: true,
    ignoreShift: true,
  },
  diffPrevious: {
    id: 'diff-previous',
    label: 'Previous diff',
    display: '[Alt+Up]',
    key: 'ArrowUp',
    alt: true,
  },
  diffNext: {
    id: 'diff-next',
    label: 'Next diff',
    display: '[Alt+Down]',
    key: 'ArrowDown',
    alt: true,
  },
  diffStageAndContinue: {
    id: 'diff-stage-and-continue',
    label: 'Stage current and continue',
    display: '[Alt+Enter]',
    key: 'Enter',
    alt: true,
  },
  workspaceNewTabMenu: {
    id: 'workspace-new-tab-menu',
    label: 'Open new tab menu',
    display: '[Ctrl+N]',
    key: 'n',
    ctrlOrMeta: true,
  },
  terminalNewTab: {
    id: 'terminal-new-tab',
    label: 'New shell tab',
    display: '[Ctrl+N, S]',
    key: 'n',
  },
  workspaceNoteTab: {
    id: 'workspace-note-tab',
    label: 'New notes tab',
    display: '[Ctrl+N, N]',
    key: 'n',
  },
  workspaceOpenFile: {
    id: 'workspace-open-file',
    label: 'Open file',
    display: '[Ctrl+N, O]',
    key: 'o',
  },
  workspaceAllTabs: {
    id: 'workspace-all-tabs',
    label: 'Open all tabs list',
    display: '[Ctrl+E]',
    key: 'e',
    ctrlOrMeta: true,
  },
  workspaceQuickOpen: {
    id: 'workspace-quick-open',
    label: 'Quick open file',
    display: '[Ctrl+P]',
    key: 'p',
    ctrlOrMeta: true,
  },
  workspaceFindInFiles: {
    id: 'workspace-find-in-files',
    label: 'Find in files',
    display: '[Ctrl+Shift+F]',
    key: 'f',
    shift: true,
    ctrlOrMeta: true,
  },
  workspaceRevealInAllFiles: {
    id: 'workspace-reveal-in-all-files',
    label: 'Reveal active file in All files',
    display: '[Ctrl+Alt+R]',
    key: 'r',
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitLeft: {
    id: 'editor-pane-split-left',
    label: 'Split or focus editor pane left',
    display: '[Ctrl+Alt+Left]',
    key: 'ArrowLeft',
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitRight: {
    id: 'editor-pane-split-right',
    label: 'Split or focus editor pane right',
    display: '[Ctrl+Alt+Right]',
    key: 'ArrowRight',
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitUp: {
    id: 'editor-pane-split-up',
    label: 'Split or focus editor pane up',
    display: '[Ctrl+Alt+Up]',
    key: 'ArrowUp',
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitDown: {
    id: 'editor-pane-split-down',
    label: 'Split or focus editor pane down',
    display: '[Ctrl+Alt+Down]',
    key: 'ArrowDown',
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseLeft: {
    id: 'editor-pane-close-left',
    label: 'Close editor pane into left pane',
    display: '[Ctrl+Alt+Shift+Left]',
    key: 'ArrowLeft',
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseRight: {
    id: 'editor-pane-close-right',
    label: 'Close editor pane into right pane',
    display: '[Ctrl+Alt+Shift+Right]',
    key: 'ArrowRight',
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseUp: {
    id: 'editor-pane-close-up',
    label: 'Close editor pane into upper pane',
    display: '[Ctrl+Alt+Shift+Up]',
    key: 'ArrowUp',
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseDown: {
    id: 'editor-pane-close-down',
    label: 'Close editor pane into lower pane',
    display: '[Ctrl+Alt+Shift+Down]',
    key: 'ArrowDown',
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  noteViewPrevious: {
    id: 'note-view-previous',
    label: 'Previous notes view mode',
    display: '[Alt+PgUp]',
    key: 'PageUp',
    alt: true,
  },
  noteViewNext: {
    id: 'note-view-next',
    label: 'Next notes view mode',
    display: '[Alt+PgDn]',
    key: 'PageDown',
    alt: true,
  },
  noteSearch: {
    id: 'note-search',
    label: 'Find in note',
    display: '[Ctrl+F]',
    key: 'f',
    ctrlOrMeta: true,
  },
  codeFindReferences: {
    id: 'code-find-references',
    label: 'Find references',
    display: '[Shift+F12]',
    key: 'F12',
    shift: true,
  },
  terminalCloseTab: {
    id: 'terminal-close-tab',
    label: 'Close active shell tab',
    display: '[Ctrl+F4]',
    key: 'F4',
    ctrlOrMeta: true,
  },
  terminalPreviousTab: {
    id: 'terminal-previous-tab',
    label: 'Previous shell tab',
    display: '[Ctrl+PgUp]',
    key: 'PageUp',
    ctrlOrMeta: true,
  },
  terminalNextTab: {
    id: 'terminal-next-tab',
    label: 'Next shell tab',
    display: '[Ctrl+PgDn]',
    key: 'PageDown',
    ctrlOrMeta: true,
  },
  commitOpenDiff: {
    id: 'commit-open-diff',
    label: 'Open selected commit diff',
    display: '[Ctrl+Enter]',
    key: 'Enter',
    ctrlOrMeta: true,
  },
} satisfies Record<string, ShortcutDefinition>;

export const SETTINGS_SHORTCUT_GROUPS: ShortcutGroupDefinition[] = [
  {
    id: 'panel-toggles',
    label: 'Panel toggles',
    shortcuts: [
      SHORTCUTS.panelRepoToggle,
      SHORTCUTS.panelDiffToggle,
      SHORTCUTS.panelTerminalToggle,
    ],
  },
  {
    id: 'workspace-tabs',
    label: 'Workspace tabs',
    shortcuts: [
      SHORTCUTS.workspaceNewTabMenu,
      SHORTCUTS.terminalNewTab,
      SHORTCUTS.workspaceNoteTab,
      SHORTCUTS.workspaceOpenFile,
      SHORTCUTS.workspaceAllTabs,
      SHORTCUTS.workspaceQuickOpen,
      SHORTCUTS.workspaceFindInFiles,
      SHORTCUTS.workspaceRevealInAllFiles,
      SHORTCUTS.editorPaneSplitLeft,
      SHORTCUTS.editorPaneSplitRight,
      SHORTCUTS.editorPaneSplitUp,
      SHORTCUTS.editorPaneSplitDown,
      SHORTCUTS.editorPaneCloseLeft,
      SHORTCUTS.editorPaneCloseRight,
      SHORTCUTS.editorPaneCloseUp,
      SHORTCUTS.editorPaneCloseDown,
      SHORTCUTS.terminalCloseTab,
      SHORTCUTS.terminalPreviousTab,
      SHORTCUTS.terminalNextTab,
    ],
  },
  {
    id: 'code',
    label: 'Code editor',
    shortcuts: [
      SHORTCUTS.codeFindReferences,
    ],
  },
  {
    id: 'notes',
    label: 'Notes',
    shortcuts: [
      SHORTCUTS.noteSearch,
      SHORTCUTS.noteViewPrevious,
      SHORTCUTS.noteViewNext,
    ],
  },
  {
    id: 'git-history',
    label: 'Git history',
    shortcuts: [
      SHORTCUTS.historyOpen,
      SHORTCUTS.commitOpenDiff,
    ],
  },
  {
    id: 'diff-navigation',
    label: 'Diff navigation',
    shortcuts: [
      SHORTCUTS.diffPrevious,
      SHORTCUTS.diffNext,
      SHORTCUTS.diffStageAndContinue,
    ],
  },
] satisfies ShortcutGroupDefinition[];

export const SETTINGS_SHORTCUTS: ShortcutDefinition[] = [
  SHORTCUTS.panelRepoToggle,
  SHORTCUTS.panelDiffToggle,
  SHORTCUTS.panelTerminalToggle,
  SHORTCUTS.workspaceNewTabMenu,
  SHORTCUTS.terminalNewTab,
  SHORTCUTS.workspaceNoteTab,
  SHORTCUTS.workspaceOpenFile,
  SHORTCUTS.workspaceAllTabs,
  SHORTCUTS.workspaceQuickOpen,
  SHORTCUTS.workspaceFindInFiles,
  SHORTCUTS.workspaceRevealInAllFiles,
  SHORTCUTS.editorPaneSplitLeft,
  SHORTCUTS.editorPaneSplitRight,
  SHORTCUTS.editorPaneSplitUp,
  SHORTCUTS.editorPaneSplitDown,
  SHORTCUTS.editorPaneCloseLeft,
  SHORTCUTS.editorPaneCloseRight,
  SHORTCUTS.editorPaneCloseUp,
  SHORTCUTS.editorPaneCloseDown,
  SHORTCUTS.codeFindReferences,
  SHORTCUTS.noteSearch,
  SHORTCUTS.noteViewPrevious,
  SHORTCUTS.noteViewNext,
  SHORTCUTS.terminalCloseTab,
  SHORTCUTS.terminalPreviousTab,
  SHORTCUTS.terminalNextTab,
  SHORTCUTS.historyOpen,
  SHORTCUTS.commitOpenDiff,
  SHORTCUTS.diffPrevious,
  SHORTCUTS.diffNext,
  SHORTCUTS.diffStageAndContinue,
];

export function formatCommandSlotShortcut(slot: number | null): string {
  return slot ? `[Ctrl+Alt+${slot}]` : '';
}

export function matchesCommandSlotShortcut(event: KeyboardEvent, slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
    return false;
  }

  const hasCtrlOrMeta = event.ctrlKey || event.metaKey;

  return (
    hasCtrlOrMeta
    && event.altKey
    && !event.shiftKey
    && (event.code === `Digit${slot}` || event.key === String(slot))
  );
}

export function matchesShortcut(event: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
  const normalizedEventKey = event.key.toLocaleLowerCase();
  const normalizedShortcutKey = shortcut.key.toLocaleLowerCase();
  const expectsCtrlOrMeta = Boolean(shortcut.ctrlOrMeta);
  const hasCtrlOrMeta = event.ctrlKey || event.metaKey;
  const normalizedShortcutKeys = [normalizedShortcutKey, ...(shortcut.keys ?? []).map((key) => key.toLocaleLowerCase())];
  const keyMatches = normalizedShortcutKeys.includes(normalizedEventKey);
  const codeMatches = shortcut.codes?.includes(event.code) ?? false;
  const shiftMatches = shortcut.shift === undefined
    ? (shortcut.ignoreShift ? true : !event.shiftKey)
    : event.shiftKey === shortcut.shift;

  return (
    (keyMatches || codeMatches)
    && event.altKey === Boolean(shortcut.alt)
    && shiftMatches
    && hasCtrlOrMeta === expectsCtrlOrMeta
  );
}
