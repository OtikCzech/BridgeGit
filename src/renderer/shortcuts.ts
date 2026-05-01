import { ref } from 'vue';
import type { ShortcutOverride, ShortcutOverrides } from '../shared/bridgegit';

export interface ShortcutDefinition {
  id: string;
  label: string;
  display: string;
  key: string;
  scope?: string;
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

export interface ShortcutConflict {
  signature: string;
  shortcuts: ShortcutDefinition[];
}

const SHORTCUT_SCOPE_GLOBAL = 'global';
const SHORTCUT_SCOPE_HISTORY = 'history-dialog';
const SHORTCUT_SCOPE_CREATION_MENU = 'creation-menu';
const SHORTCUT_SCOPE_NOTE = 'note-tab';
const SHORTCUT_SCOPE_CODE = 'code-tab';
const SHORTCUT_SCOPE_DIFF = 'diff-panel';
const SHORTCUT_SCOPE_REPO_PANEL = 'repo-panel';

const DEFAULT_SHORTCUTS = {
  historyOpen: {
    id: 'history-open',
    label: 'Open git history',
    display: '[Ctrl+H]',
    key: 'h',
    scope: SHORTCUT_SCOPE_GLOBAL,
    ctrlOrMeta: true,
  },
  historySearch: {
    id: 'history-search',
    label: 'Search in history dialog',
    display: '[Ctrl+Shift+F]',
    key: 'f',
    scope: SHORTCUT_SCOPE_HISTORY,
    shift: true,
    ctrlOrMeta: true,
  },
  panelRepoToggle: {
    id: 'panel-repo-toggle',
    label: 'Toggle repository panel',
    display: '[Ctrl+1]',
    key: '1',
    scope: SHORTCUT_SCOPE_GLOBAL,
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
    scope: SHORTCUT_SCOPE_GLOBAL,
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
    scope: SHORTCUT_SCOPE_GLOBAL,
    keys: ['š', '3'],
    codes: ['Digit3'],
    ctrlOrMeta: true,
    ignoreShift: true,
  },
  dockerDialogOpen: {
    id: 'docker-dialog-open',
    label: 'Open Docker dialog',
    display: '[Ctrl+Shift+D]',
    key: 'd',
    scope: SHORTCUT_SCOPE_GLOBAL,
    shift: true,
    ctrlOrMeta: true,
  },
  settingsOpen: {
    id: 'settings-open',
    label: 'Open settings',
    display: '[F1]',
    key: 'F1',
    scope: SHORTCUT_SCOPE_GLOBAL,
  },
  diffPrevious: {
    id: 'diff-previous',
    label: 'Previous diff',
    display: '[Alt+Up]',
    key: 'ArrowUp',
    scope: SHORTCUT_SCOPE_DIFF,
    alt: true,
  },
  diffNext: {
    id: 'diff-next',
    label: 'Next diff',
    display: '[Alt+Down]',
    key: 'ArrowDown',
    scope: SHORTCUT_SCOPE_DIFF,
    alt: true,
  },
  diffStageAndContinue: {
    id: 'diff-stage-and-continue',
    label: 'Stage current and continue',
    display: '[Alt+Enter]',
    key: 'Enter',
    scope: SHORTCUT_SCOPE_DIFF,
    alt: true,
  },
  workspaceNewTabMenu: {
    id: 'workspace-new-tab-menu',
    label: 'Open new tab menu',
    display: '[Ctrl+N]',
    key: 'n',
    scope: SHORTCUT_SCOPE_GLOBAL,
    ctrlOrMeta: true,
  },
  terminalNewTab: {
    id: 'terminal-new-tab',
    label: 'New shell tab',
    display: '[Ctrl+N, S]',
    key: 's',
    scope: SHORTCUT_SCOPE_CREATION_MENU,
  },
  workspaceNoteTab: {
    id: 'workspace-note-tab',
    label: 'New notes tab',
    display: '[Ctrl+N, N]',
    key: 'n',
    scope: SHORTCUT_SCOPE_CREATION_MENU,
  },
  workspaceOpenFile: {
    id: 'workspace-open-file',
    label: 'Open file',
    display: '[Ctrl+N, O]',
    key: 'o',
    scope: SHORTCUT_SCOPE_CREATION_MENU,
  },
  workspaceAllTabs: {
    id: 'workspace-all-tabs',
    label: 'Open all tabs list',
    display: '[Ctrl+E]',
    key: 'e',
    scope: SHORTCUT_SCOPE_GLOBAL,
    ctrlOrMeta: true,
  },
  workspaceQuickOpen: {
    id: 'workspace-quick-open',
    label: 'Quick open file',
    display: '[Ctrl+P]',
    key: 'p',
    scope: SHORTCUT_SCOPE_GLOBAL,
    ctrlOrMeta: true,
  },
  repoPanelFilesFilterFocus: {
    id: 'repo-panel-files-filter-focus',
    label: 'Focus repository file filter',
    display: '[Ctrl+F]',
    key: 'f',
    scope: SHORTCUT_SCOPE_REPO_PANEL,
    ctrlOrMeta: true,
  },
  workspaceFindInFiles: {
    id: 'workspace-find-in-files',
    label: 'Find in files',
    display: '[Ctrl+Shift+F]',
    key: 'f',
    scope: SHORTCUT_SCOPE_GLOBAL,
    shift: true,
    ctrlOrMeta: true,
  },
  workspaceReplaceInFiles: {
    id: 'workspace-replace-in-files',
    label: 'Replace in files',
    display: '[Ctrl+Shift+R]',
    key: 'r',
    scope: SHORTCUT_SCOPE_GLOBAL,
    shift: true,
    ctrlOrMeta: true,
  },
  clipboardHistoryOpen: {
    id: 'clipboard-history-open',
    label: 'Open clipboard history',
    display: '[Ctrl+Shift+H]',
    key: 'h',
    scope: SHORTCUT_SCOPE_GLOBAL,
    shift: true,
    ctrlOrMeta: true,
  },
  workspaceRevealInAllFiles: {
    id: 'workspace-reveal-in-all-files',
    label: 'Reveal active file in All files',
    display: '[Ctrl+Alt+R]',
    key: 'r',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitLeft: {
    id: 'editor-pane-split-left',
    label: 'Split or focus editor pane left',
    display: '[Ctrl+Alt+Left]',
    key: 'ArrowLeft',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitRight: {
    id: 'editor-pane-split-right',
    label: 'Split or focus editor pane right',
    display: '[Ctrl+Alt+Right]',
    key: 'ArrowRight',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitUp: {
    id: 'editor-pane-split-up',
    label: 'Split or focus editor pane up',
    display: '[Ctrl+Alt+Up]',
    key: 'ArrowUp',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneSplitDown: {
    id: 'editor-pane-split-down',
    label: 'Split or focus editor pane down',
    display: '[Ctrl+Alt+Down]',
    key: 'ArrowDown',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseLeft: {
    id: 'editor-pane-close-left',
    label: 'Close editor pane into left pane',
    display: '[Ctrl+Alt+Shift+Left]',
    key: 'ArrowLeft',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseRight: {
    id: 'editor-pane-close-right',
    label: 'Close editor pane into right pane',
    display: '[Ctrl+Alt+Shift+Right]',
    key: 'ArrowRight',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseUp: {
    id: 'editor-pane-close-up',
    label: 'Close editor pane into upper pane',
    display: '[Ctrl+Alt+Shift+Up]',
    key: 'ArrowUp',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  editorPaneCloseDown: {
    id: 'editor-pane-close-down',
    label: 'Close editor pane into lower pane',
    display: '[Ctrl+Alt+Shift+Down]',
    key: 'ArrowDown',
    scope: SHORTCUT_SCOPE_GLOBAL,
    alt: true,
    shift: true,
    ctrlOrMeta: true,
  },
  noteViewPrevious: {
    id: 'note-view-previous',
    label: 'Previous notes view mode',
    display: '[Alt+PgUp]',
    key: 'PageUp',
    scope: SHORTCUT_SCOPE_NOTE,
    alt: true,
  },
  noteViewNext: {
    id: 'note-view-next',
    label: 'Next notes view mode',
    display: '[Alt+PgDn]',
    key: 'PageDown',
    scope: SHORTCUT_SCOPE_NOTE,
    alt: true,
  },
  noteSearch: {
    id: 'note-search',
    label: 'Find in note',
    display: '[Ctrl+F]',
    key: 'f',
    scope: SHORTCUT_SCOPE_NOTE,
    ctrlOrMeta: true,
  },
  codeFindReferences: {
    id: 'code-find-references',
    label: 'Find references',
    display: '[Shift+F12]',
    key: 'F12',
    scope: SHORTCUT_SCOPE_CODE,
    shift: true,
  },
  terminalCloseTab: {
    id: 'terminal-close-tab',
    label: 'Close active shell tab',
    display: '[Ctrl+F4]',
    key: 'F4',
    scope: SHORTCUT_SCOPE_GLOBAL,
    ctrlOrMeta: true,
  },
  terminalPreviousTab: {
    id: 'terminal-previous-tab',
    label: 'Previous shell tab',
    display: '[Ctrl+PgUp]',
    key: 'PageUp',
    scope: SHORTCUT_SCOPE_GLOBAL,
    ctrlOrMeta: true,
  },
  terminalNextTab: {
    id: 'terminal-next-tab',
    label: 'Next shell tab',
    display: '[Ctrl+PgDn]',
    key: 'PageDown',
    scope: SHORTCUT_SCOPE_GLOBAL,
    ctrlOrMeta: true,
  },
  commitOpenDiff: {
    id: 'commit-open-diff',
    label: 'Open selected commit diff',
    display: '[Ctrl+Enter]',
    key: 'Enter',
    scope: SHORTCUT_SCOPE_HISTORY,
    ctrlOrMeta: true,
  },
} satisfies Record<string, ShortcutDefinition>;

type ShortcutRegistry = typeof DEFAULT_SHORTCUTS;
type ShortcutRegistryKey = keyof ShortcutRegistry;

const SHORTCUT_GROUP_BLUEPRINTS: Array<{ id: string; label: string; shortcuts: ShortcutRegistryKey[] }> = [
  {
    id: 'panel-toggles',
    label: 'Panels',
    shortcuts: ['panelRepoToggle', 'panelDiffToggle', 'panelTerminalToggle'],
  },
  {
    id: 'dialogs',
    label: 'Dialogs',
    shortcuts: ['settingsOpen', 'dockerDialogOpen', 'historyOpen'],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    shortcuts: [
      'workspaceNewTabMenu',
      'terminalNewTab',
      'workspaceNoteTab',
      'workspaceOpenFile',
      'workspaceQuickOpen',
      'repoPanelFilesFilterFocus',
      'workspaceAllTabs',
      'terminalCloseTab',
      'terminalPreviousTab',
      'terminalNextTab',
      'workspaceFindInFiles',
      'workspaceReplaceInFiles',
      'clipboardHistoryOpen',
      'workspaceRevealInAllFiles',
    ],
  },
  {
    id: 'editor-panes',
    label: 'Editor panes',
    shortcuts: [
      'editorPaneSplitLeft',
      'editorPaneSplitRight',
      'editorPaneSplitUp',
      'editorPaneSplitDown',
      'editorPaneCloseLeft',
      'editorPaneCloseRight',
      'editorPaneCloseUp',
      'editorPaneCloseDown',
    ],
  },
  {
    id: 'code',
    label: 'Code editor',
    shortcuts: ['codeFindReferences'],
  },
  {
    id: 'notes',
    label: 'Notes',
    shortcuts: ['noteSearch', 'noteViewPrevious', 'noteViewNext'],
  },
  {
    id: 'git-history',
    label: 'Git history',
    shortcuts: ['historySearch', 'commitOpenDiff'],
  },
  {
    id: 'diff-navigation',
    label: 'Diff navigation',
    shortcuts: ['diffPrevious', 'diffNext', 'diffStageAndContinue'],
  },
];

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift']);
const KEY_DISPLAY_LABELS: Record<string, string> = {
  ' ': 'Space',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  Escape: 'Esc',
  PageDown: 'PgDn',
  PageUp: 'PgUp',
};

const DEFAULT_SHORTCUTS_BY_ID = new Map(
  Object.values(DEFAULT_SHORTCUTS).map((shortcut) => [shortcut.id, shortcut] as const),
);

function cloneShortcutDefinition(shortcut: ShortcutDefinition): ShortcutDefinition {
  return {
    ...shortcut,
    keys: shortcut.keys ? [...shortcut.keys] : undefined,
    codes: shortcut.codes ? [...shortcut.codes] : undefined,
  };
}

function cloneShortcutRegistry(shortcuts: ShortcutRegistry): ShortcutRegistry {
  return Object.fromEntries(
    Object.entries(shortcuts).map(([shortcutKey, shortcut]) => [shortcutKey, cloneShortcutDefinition(shortcut)]),
  ) as ShortcutRegistry;
}

function mutateShortcutDefinition(target: ShortcutDefinition, source: ShortcutDefinition) {
  target.id = source.id;
  target.label = source.label;
  target.display = source.display;
  target.key = source.key;
  target.scope = source.scope;
  target.keys = source.keys ? [...source.keys] : undefined;
  target.codes = source.codes ? [...source.codes] : undefined;
  target.alt = source.alt;
  target.shift = source.shift;
  target.ctrlOrMeta = source.ctrlOrMeta;
  target.ignoreShift = source.ignoreShift;
}

function resolveShortcutOverride(shortcut: ShortcutDefinition, override?: ShortcutOverride): ShortcutDefinition {
  if (!override) {
    return cloneShortcutDefinition(shortcut);
  }

  return {
    ...cloneShortcutDefinition(shortcut),
    display: override.display.trim() || shortcut.display,
    key: override.key,
    keys: undefined,
    codes: override.code ? [override.code] : undefined,
    alt: override.alt,
    shift: override.shift,
    ctrlOrMeta: override.ctrlOrMeta,
    ignoreShift: false,
  };
}

function createShortcutRegistry(overrides: ShortcutOverrides = {}): ShortcutRegistry {
  return Object.fromEntries(
    Object.entries(DEFAULT_SHORTCUTS).map(([shortcutKey, shortcut]) => [
      shortcutKey,
      resolveShortcutOverride(shortcut, overrides[shortcut.id]),
    ]),
  ) as ShortcutRegistry;
}

function buildShortcutGroupsFromRegistry(shortcuts: ShortcutRegistry): ShortcutGroupDefinition[] {
  return SHORTCUT_GROUP_BLUEPRINTS.map((group) => ({
    id: group.id,
    label: group.label,
    shortcuts: group.shortcuts.map((shortcutKey) => shortcuts[shortcutKey]),
  }));
}

function formatShortcutKeyLabel(key: string): string {
  if (KEY_DISPLAY_LABELS[key]) {
    return KEY_DISPLAY_LABELS[key];
  }

  return key.length === 1 ? key.toLocaleUpperCase() : key;
}

function buildShortcutDisplayFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];

  if (event.ctrlKey || event.metaKey) {
    parts.push('Ctrl');
  }

  if (event.altKey) {
    parts.push('Alt');
  }

  if (event.shiftKey) {
    parts.push('Shift');
  }

  parts.push(formatShortcutKeyLabel(event.key));

  return `[${parts.join('+')}]`;
}

function collectShortcutBindingSignatures(shortcut: ShortcutDefinition): string[] {
  const signatures = new Set<string>();
  const scopeSignature = shortcut.scope ?? SHORTCUT_SCOPE_GLOBAL;
  const shiftVariants = shortcut.shift === undefined
    ? (shortcut.ignoreShift ? ['noshift', 'shift'] : ['noshift'])
    : [shortcut.shift ? 'shift' : 'noshift'];

  for (const shiftVariant of shiftVariants) {
    const modifierSignature = [
      `scope:${scopeSignature}`,
      shortcut.ctrlOrMeta ? 'ctrlmeta' : 'plain',
      shortcut.alt ? 'alt' : 'noalt',
      shiftVariant,
    ].join('|');

    for (const key of [shortcut.key, ...(shortcut.keys ?? [])]) {
      signatures.add(`${modifierSignature}|key:${key.toLocaleLowerCase()}`);
    }

    for (const code of shortcut.codes ?? []) {
      signatures.add(`${modifierSignature}|code:${code}`);
    }
  }

  return [...signatures];
}

export const SHORTCUTS: ShortcutRegistry = cloneShortcutRegistry(DEFAULT_SHORTCUTS);
export const shortcutBindingsRevision = ref(0);

export const SETTINGS_SHORTCUT_GROUPS: ShortcutGroupDefinition[] = buildShortcutGroupsFromRegistry(SHORTCUTS);
export const SETTINGS_SHORTCUTS: ShortcutDefinition[] = SETTINGS_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);

export function getDefaultShortcutDefinition(shortcutId: string): ShortcutDefinition | null {
  const shortcut = DEFAULT_SHORTCUTS_BY_ID.get(shortcutId);
  return shortcut ? cloneShortcutDefinition(shortcut) : null;
}

export function getResolvedShortcutDefinition(
  shortcutId: string,
  overrides: ShortcutOverrides = {},
): ShortcutDefinition | null {
  const shortcut = DEFAULT_SHORTCUTS_BY_ID.get(shortcutId);
  return shortcut ? resolveShortcutOverride(shortcut, overrides[shortcutId]) : null;
}

export function buildSettingsShortcutGroups(overrides: ShortcutOverrides = {}): ShortcutGroupDefinition[] {
  return buildShortcutGroupsFromRegistry(createShortcutRegistry(overrides));
}

export function findShortcutConflicts(overrides: ShortcutOverrides = {}): ShortcutConflict[] {
  const shortcuts = buildSettingsShortcutGroups(overrides).flatMap((group) => group.shortcuts);
  const shortcutsBySignature = new Map<string, ShortcutDefinition[]>();

  for (const shortcut of shortcuts) {
    for (const signature of collectShortcutBindingSignatures(shortcut)) {
      const currentShortcuts = shortcutsBySignature.get(signature) ?? [];
      currentShortcuts.push(shortcut);
      shortcutsBySignature.set(signature, currentShortcuts);
    }
  }

  return [...shortcutsBySignature.entries()]
    .map(([signature, groupedShortcuts]) => ({
      signature,
      shortcuts: groupedShortcuts,
    }))
    .filter((conflict) => {
      const uniqueShortcutIds = new Set(conflict.shortcuts.map((shortcut) => shortcut.id));
      return uniqueShortcutIds.size > 1;
    });
}

export function captureShortcutOverride(event: KeyboardEvent): ShortcutOverride | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  return {
    key: event.key,
    code: event.code && event.code !== 'Unidentified' ? event.code : undefined,
    display: buildShortcutDisplayFromEvent(event),
    alt: event.altKey || undefined,
    shift: event.shiftKey || undefined,
    ctrlOrMeta: (event.ctrlKey || event.metaKey) || undefined,
  };
}

export function isShortcutOverrideRedundant(shortcutId: string, override: ShortcutOverride): boolean {
  const defaultShortcut = DEFAULT_SHORTCUTS_BY_ID.get(shortcutId);

  if (!defaultShortcut) {
    return false;
  }

  const overrideShortcut = resolveShortcutOverride(defaultShortcut, override);
  const defaultSignatures = new Set(collectShortcutBindingSignatures(defaultShortcut));

  return collectShortcutBindingSignatures(overrideShortcut).every((signature) => defaultSignatures.has(signature));
}

export function applyShortcutOverrides(overrides: ShortcutOverrides = {}) {
  const resolvedShortcuts = createShortcutRegistry(overrides);

  for (const shortcutKey of Object.keys(SHORTCUTS) as ShortcutRegistryKey[]) {
    mutateShortcutDefinition(SHORTCUTS[shortcutKey], resolvedShortcuts[shortcutKey]);
  }

  shortcutBindingsRevision.value += 1;
}

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
