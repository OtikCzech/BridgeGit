<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type {
  AppAppearance,
  EditorTheme,
  ResolvedEditorTheme,
  WorkspaceTabDefaults,
  PanelLayout,
  ProjectSettingsFormData,
  TerminalCommandPreset,
  TerminalCommandStep,
  WorktreeDetectionInterval,
  WorkspaceIndicatorVisibilitySettings,
} from '../../shared/bridgegit';
import {
  MAX_NOTE_FONT_SIZE,
  MAX_SHELL_FONT_SIZE,
  MIN_NOTE_FONT_SIZE,
  MIN_SHELL_FONT_SIZE,
  normalizeNoteFontSize,
  normalizeShellFontSize,
} from '../../shared/bridgegit';
import { SETTINGS_SHORTCUT_GROUPS, formatCommandSlotShortcut } from '../shortcuts';
import { playNotificationBeep } from '../utils/notification-audio';

type SettingsSectionId = 'general' | 'shortcuts' | 'commands' | 'layout';

interface Props {
  modelValue: boolean;
  projectTitle: string;
  contentLayout: PanelLayout['contentLayout'];
  appAppearance: AppAppearance;
  editorTheme: EditorTheme;
  workspacePanelFontSize: number;
  workspaceIndicatorVisibility: WorkspaceIndicatorVisibilitySettings;
  workspaceTabDefaults: WorkspaceTabDefaults;
  worktreeDetectionIntervalMs: WorktreeDetectionInterval;
  soundNotificationsEnabled: boolean;
  terminalCommandPresets: TerminalCommandPreset[];
}

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  copy: string;
}

interface WorktreeDetectionIntervalOption {
  value: WorktreeDetectionInterval;
  label: string;
  copy: string;
}

interface ThemeOption<TValue extends string> {
  value: TValue;
  label: string;
  copy: string;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'general',
    label: 'General',
    copy: 'Project level identity and shared defaults.',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    copy: 'Current keyboard bindings available in the app.',
  },
  {
    id: 'commands',
    label: 'Commands',
    copy: 'Reusable shell presets for terminal automation.',
  },
  {
    id: 'layout',
    label: 'Layout',
    copy: 'Preferred arrangement for diff and shell panels.',
  },
];

const WORKTREE_DETECTION_INTERVAL_OPTIONS: WorktreeDetectionIntervalOption[] = [
  { value: null, label: 'Off', copy: 'Only check when you refresh the repository manually.' },
  { value: 60_000, label: '1 minute', copy: 'Frequent background checks while the window stays visible.' },
  { value: 180_000, label: '3 minutes', copy: 'Balanced default for occasional worktree creation.' },
  { value: 300_000, label: '5 minutes', copy: 'Lighter background polling for long-running sessions.' },
  { value: 900_000, label: '15 minutes', copy: 'Minimal automatic checks with manual refresh as the main trigger.' },
];

const APP_APPEARANCE_OPTIONS: ThemeOption<AppAppearance>[] = [
  { value: 'bridgegit-dark', label: 'BridgeGit Dark', copy: 'Current default look across the whole app.' },
  { value: 'bridgegit-light', label: 'BridgeGit Light', copy: 'Lighter workspace for brighter environments.' },
  { value: 'github-dark', label: 'GitHub Dark', copy: 'Cool neutral dark palette inspired by GitHub surfaces.' },
  { value: 'github-light', label: 'GitHub Light', copy: 'Clean light palette with GitHub-style contrast and borders.' },
  { value: 'nord', label: 'Nord', copy: 'Soft dark palette with colder accents across the whole app.' },
];

const EDITOR_THEME_OPTIONS: ThemeOption<EditorTheme>[] = [
  { value: 'follow-app', label: 'Follow app', copy: 'Keep code tabs aligned with the selected app appearance.' },
  { value: 'bridgegit-dark', label: 'BridgeGit Dark', copy: 'Always keep the editor on the current dark palette.' },
  { value: 'bridgegit-light', label: 'BridgeGit Light', copy: 'Always keep the editor on the lighter palette.' },
  { value: 'github-dark', label: 'GitHub Dark', copy: 'Neutral dark editor palette with GitHub-style contrast.' },
  { value: 'github-light', label: 'GitHub Light', copy: 'Clean light editor palette inspired by GitHub.' },
  { value: 'nord', label: 'Nord', copy: 'Cool dark editor palette with softer blues and lower glare.' },
];

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  save: [value: ProjectSettingsFormData];
}>();

const activeSection = ref<SettingsSectionId>('general');
const draftTitle = ref(props.projectTitle);
const draftContentLayout = ref<PanelLayout['contentLayout']>(props.contentLayout);
const draftAppAppearance = ref<AppAppearance>(props.appAppearance);
const draftEditorTheme = ref<EditorTheme>(props.editorTheme);
const draftWorkspacePanelFontSize = ref(normalizeNoteFontSize(props.workspacePanelFontSize));
const draftWorkspaceIndicatorVisibility = ref<WorkspaceIndicatorVisibilitySettings>({ ...props.workspaceIndicatorVisibility });
const draftWorkspaceTabDefaults = ref<WorkspaceTabDefaults>({ ...props.workspaceTabDefaults });
const draftWorktreeDetectionIntervalMs = ref<string>(serializeWorktreeDetectionInterval(props.worktreeDetectionIntervalMs));
const draftSoundNotificationsEnabled = ref(props.soundNotificationsEnabled);
const draftCommandPresets = ref<TerminalCommandPreset[]>(cloneTerminalCommandPresets(props.terminalCommandPresets));
const expandedCommandPresetId = ref<string | null>(props.terminalCommandPresets[0]?.id ?? null);
const WORKSPACE_TAB_FONT_SIZE_MIN = Math.max(MIN_SHELL_FONT_SIZE, MIN_NOTE_FONT_SIZE);
const WORKSPACE_TAB_FONT_SIZE_MAX = Math.min(MAX_SHELL_FONT_SIZE, MAX_NOTE_FONT_SIZE);
const WORKSPACE_PANEL_FONT_SIZE_MIN = MIN_NOTE_FONT_SIZE;
const WORKSPACE_PANEL_FONT_SIZE_MAX = MAX_NOTE_FONT_SIZE;

function cloneTerminalCommandStep(step: TerminalCommandStep): TerminalCommandStep {
  return { ...step };
}

function cloneTerminalCommandPresets(presets: TerminalCommandPreset[]): TerminalCommandPreset[] {
  return presets.map((preset) => ({
    ...preset,
    steps: preset.steps.map((step) => cloneTerminalCommandStep(step)),
  }));
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildWriteStep(): TerminalCommandStep {
  return {
    id: createId('command-step'),
    type: 'write',
    value: '',
    submit: true,
  };
}

function buildWaitStep(): TerminalCommandStep {
  return {
    id: createId('command-step'),
    type: 'wait-for-prompt',
    pattern: '^.+[>#\\$]\\s?$',
  };
}

function buildDelayStep(): TerminalCommandStep {
  return {
    id: createId('command-step'),
    type: 'delay',
    delayMs: 600,
  };
}

function createStepByType(type: TerminalCommandStep['type']): TerminalCommandStep {
  if (type === 'delay') {
    return buildDelayStep();
  }

  if (type === 'wait-for-prompt') {
    return buildWaitStep();
  }

  return buildWriteStep();
}

function findNextShortcutSlot(): number | null {
  const usedSlots = new Set(
    draftCommandPresets.value
      .map((preset) => preset.shortcutSlot)
      .filter((slot): slot is number => slot !== null),
  );

  for (let slot = 1; slot <= 9; slot += 1) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  return null;
}

function buildCommandPreset(): TerminalCommandPreset {
  return {
    id: createId('command'),
    name: `Command ${draftCommandPresets.value.length + 1}`,
    target: 'active-tab',
    shortcutSlot: findNextShortcutSlot(),
    steps: [buildWriteStep()],
  };
}

function resetDraft() {
  draftTitle.value = props.projectTitle;
  draftContentLayout.value = props.contentLayout;
  draftAppAppearance.value = props.appAppearance;
  draftEditorTheme.value = props.editorTheme;
  draftWorkspacePanelFontSize.value = normalizeNoteFontSize(props.workspacePanelFontSize);
  draftWorkspaceIndicatorVisibility.value = { ...props.workspaceIndicatorVisibility };
  draftWorkspaceTabDefaults.value = { ...props.workspaceTabDefaults };
  draftWorktreeDetectionIntervalMs.value = serializeWorktreeDetectionInterval(props.worktreeDetectionIntervalMs);
  draftSoundNotificationsEnabled.value = props.soundNotificationsEnabled;
  draftCommandPresets.value = cloneTerminalCommandPresets(props.terminalCommandPresets);
  expandedCommandPresetId.value = props.terminalCommandPresets[0]?.id ?? null;
  activeSection.value = 'general';
}

function serializeWorktreeDetectionInterval(intervalMs: WorktreeDetectionInterval): string {
  return intervalMs === null ? 'off' : `${intervalMs}`;
}

function parseWorktreeDetectionInterval(value: string): WorktreeDetectionInterval {
  switch (value) {
    case 'off':
      return null;
    case '60000':
      return 60_000;
    case '180000':
      return 180_000;
    case '300000':
      return 300_000;
    case '900000':
      return 900_000;
    default:
      return 180_000;
  }
}

const workspaceTabPreviewStyle = computed(() => ({
  '--settings-preview-font-size-px': String(draftWorkspacePanelFontSize.value),
  '--settings-preview-scale': `calc(${draftWorkspacePanelFontSize.value} / 12)`,
}));
const workspaceTabsPreviewStyle = computed(() => ({
  '--settings-preview-font-size-px': String(draftUnifiedWorkspaceTabFontSize.value),
  '--settings-preview-scale': `calc(${draftUnifiedWorkspaceTabFontSize.value} / 12)`,
}));
const resolvedPreviewEditorTheme = computed<ResolvedEditorTheme>(() => (
  draftEditorTheme.value === 'follow-app' ? draftAppAppearance.value : draftEditorTheme.value
));

const draftUnifiedWorkspaceTabFontSize = computed({
  get() {
    const normalizedValue = Number.isFinite(draftWorkspaceTabDefaults.value.noteFontSize)
      ? Math.round(draftWorkspaceTabDefaults.value.noteFontSize)
      : props.workspaceTabDefaults.noteFontSize;

    return Math.min(WORKSPACE_TAB_FONT_SIZE_MAX, Math.max(WORKSPACE_TAB_FONT_SIZE_MIN, normalizedValue));
  },
  set(value: number) {
    const normalizedValue = Math.min(
      WORKSPACE_TAB_FONT_SIZE_MAX,
      Math.max(
        WORKSPACE_TAB_FONT_SIZE_MIN,
        Number.isFinite(value) ? Math.round(value) : props.workspaceTabDefaults.noteFontSize,
      ),
    );

    draftWorkspaceTabDefaults.value = {
      ...draftWorkspaceTabDefaults.value,
      shellFontSize: normalizeShellFontSize(normalizedValue),
      noteFontSize: normalizeNoteFontSize(normalizedValue),
    };
  },
});

watch(
  () => props.projectTitle,
  (value) => {
    if (!props.modelValue) {
      draftTitle.value = value;
    }
  },
);

watch(
  () => props.contentLayout,
  (value) => {
    if (!props.modelValue) {
      draftContentLayout.value = value;
    }
  },
);

watch(
  () => props.appAppearance,
  (value) => {
    if (!props.modelValue) {
      draftAppAppearance.value = value;
    }
  },
);

watch(
  () => props.editorTheme,
  (value) => {
    if (!props.modelValue) {
      draftEditorTheme.value = value;
    }
  },
);

watch(
  () => props.workspacePanelFontSize,
  (value) => {
    if (!props.modelValue) {
      draftWorkspacePanelFontSize.value = normalizeNoteFontSize(value);
    }
  },
);

watch(
  () => props.workspaceIndicatorVisibility,
  (value) => {
    if (!props.modelValue) {
      draftWorkspaceIndicatorVisibility.value = { ...value };
    }
  },
  { deep: true },
);

watch(
  () => props.workspaceTabDefaults,
  (value) => {
    if (!props.modelValue) {
      draftWorkspaceTabDefaults.value = { ...value };
    }
  },
  { deep: true },
);

watch(
  () => props.worktreeDetectionIntervalMs,
  (value) => {
    if (!props.modelValue) {
      draftWorktreeDetectionIntervalMs.value = serializeWorktreeDetectionInterval(value);
    }
  },
);

watch(
  () => props.soundNotificationsEnabled,
  (value) => {
    if (!props.modelValue) {
      draftSoundNotificationsEnabled.value = value;
    }
  },
);

watch(
  () => props.terminalCommandPresets,
  (value) => {
    if (!props.modelValue) {
      draftCommandPresets.value = cloneTerminalCommandPresets(value);
    }
  },
  { deep: true },
);

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      resetDraft();
    }
  },
);

function closeDialog() {
  emit('update:modelValue', false);
}

async function previewNotificationSound() {
  await playNotificationBeep();
}

function handleSubmit() {
  emit('save', {
    projectTitle: draftTitle.value.trim(),
    contentLayout: draftContentLayout.value,
    appAppearance: draftAppAppearance.value,
    editorTheme: draftEditorTheme.value,
    workspacePanelFontSize: normalizeNoteFontSize(draftWorkspacePanelFontSize.value),
    workspaceIndicatorVisibility: { ...draftWorkspaceIndicatorVisibility.value },
    workspaceTabDefaults: {
      shellFontSize: normalizeShellFontSize(draftWorkspaceTabDefaults.value.shellFontSize),
      noteFontSize: normalizeNoteFontSize(draftWorkspaceTabDefaults.value.noteFontSize),
    },
    worktreeDetectionIntervalMs: parseWorktreeDetectionInterval(draftWorktreeDetectionIntervalMs.value),
    soundNotificationsEnabled: draftSoundNotificationsEnabled.value,
    terminalCommandPresets: cloneTerminalCommandPresets(draftCommandPresets.value),
  });
}

function normalizeDraftWorkspacePanelFontSize() {
  draftWorkspacePanelFontSize.value = normalizeNoteFontSize(draftWorkspacePanelFontSize.value);
}

function normalizeDraftWorkspaceTabFontSize() {
  draftUnifiedWorkspaceTabFontSize.value = draftUnifiedWorkspaceTabFontSize.value;
}

function addCommandPreset() {
  const nextPreset = buildCommandPreset();
  draftCommandPresets.value = [...draftCommandPresets.value, nextPreset];
  expandedCommandPresetId.value = nextPreset.id;
  activeSection.value = 'commands';
}

function removeCommandPreset(presetId: string) {
  draftCommandPresets.value = draftCommandPresets.value.filter((preset) => preset.id !== presetId);

  if (expandedCommandPresetId.value === presetId) {
    expandedCommandPresetId.value = draftCommandPresets.value[0]?.id ?? null;
  }
}

function addStep(presetId: string, type: TerminalCommandStep['type']) {
  const preset = draftCommandPresets.value.find((item) => item.id === presetId);

  if (!preset) {
    return;
  }

  preset.steps.push(createStepByType(type));
}

function removeStep(presetId: string, stepId: string) {
  const preset = draftCommandPresets.value.find((item) => item.id === presetId);

  if (!preset || preset.steps.length <= 1) {
    return;
  }

  preset.steps = preset.steps.filter((step) => step.id !== stepId);
}

function updateStepType(presetId: string, stepId: string, type: TerminalCommandStep['type']) {
  const preset = draftCommandPresets.value.find((item) => item.id === presetId);

  if (!preset) {
    return;
  }

  const nextStep = createStepByType(type);
  nextStep.id = stepId;
  preset.steps = preset.steps.map((step) => (step.id === stepId ? nextStep : step));
}

function toggleCommandPreset(presetId: string) {
  expandedCommandPresetId.value = expandedCommandPresetId.value === presetId ? null : presetId;
}

function formatPresetTarget(target: TerminalCommandPreset['target']): string {
  return target === 'new-tab' ? 'New shell tab' : 'Active shell tab';
}

</script>

<template>
  <teleport to="body">
    <div
      v-if="modelValue"
      class="settings-dialog"
      :data-dialog-appearance="draftAppAppearance"
      role="presentation"
      @click.self="closeDialog"
    >
      <section
        class="settings-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
      >
        <header class="settings-dialog__header">
          <div>
            <p class="settings-dialog__eyebrow">Settings</p>
            <h2 class="settings-dialog__title">Project settings</h2>
          </div>

          <button
            class="settings-dialog__close"
            type="button"
            aria-label="Close settings"
            @click="closeDialog"
          >
            ×
          </button>
        </header>

        <form class="settings-dialog__form" @submit.prevent="handleSubmit">
          <aside class="settings-dialog__sidebar" aria-label="Settings sections">
            <button
              v-for="section in SETTINGS_SECTIONS"
              :key="section.id"
              class="settings-dialog__nav-item"
              :class="{ 'settings-dialog__nav-item--active': section.id === activeSection }"
              type="button"
              @click="activeSection = section.id"
            >
              <span class="settings-dialog__nav-label">{{ section.label }}</span>
              <span class="settings-dialog__nav-copy">{{ section.copy }}</span>
            </button>
          </aside>

          <div class="settings-dialog__content">
            <section v-show="activeSection === 'general'" class="settings-dialog__section">
              <header class="settings-dialog__section-header">
                <div>
                  <p class="settings-dialog__section-eyebrow">General</p>
                  <h3 class="settings-dialog__section-title">Project identity</h3>
                </div>
                <p class="settings-dialog__section-copy">
                  Local metadata used by the repository panel and settings.
                </p>
              </header>

              <label class="settings-dialog__field">
                <span class="settings-dialog__label">Displayed title</span>
                <input
                  v-model="draftTitle"
                  class="settings-dialog__input"
                  type="text"
                  name="projectTitle"
                  maxlength="64"
                  autocomplete="off"
                  placeholder="BridgeGit"
                >
              </label>

              <div class="settings-dialog__checkbox settings-dialog__checkbox--card">
                <label class="settings-dialog__checkbox-toggle">
                  <input v-model="draftSoundNotificationsEnabled" type="checkbox">
                  <span class="settings-dialog__checkbox-content">
                    <span class="settings-dialog__checkbox-title">Sound notifications</span>
                    <span class="settings-dialog__checkbox-copy">
                      Play a short beep when shell activity finishes while the terminal is not focused.
                    </span>
                  </span>
                </label>

                <button
                  class="settings-dialog__button settings-dialog__button--ghost settings-dialog__checkbox-preview"
                  type="button"
                  title="Play notification sound"
                  @click="previewNotificationSound"
                >
                  Play
                </button>
              </div>

              <div class="settings-dialog__hint-card settings-dialog__hint-card--inline">
                <span class="settings-dialog__hint-label">Workspace dots</span>
                <div class="settings-dialog__checkbox-list">
                  <label class="settings-dialog__checkbox">
                    <input v-model="draftWorkspaceIndicatorVisibility.repo" type="checkbox">
                    <span>Repository dot</span>
                  </label>
                  <label class="settings-dialog__checkbox">
                    <input v-model="draftWorkspaceIndicatorVisibility.activity" type="checkbox">
                    <span>Activity dot</span>
                  </label>
                  <label class="settings-dialog__checkbox">
                    <input v-model="draftWorkspaceIndicatorVisibility.attention" type="checkbox">
                    <span>Attention dot</span>
                  </label>
                </div>
              </div>

              <div class="settings-dialog__hint-card">
                <span class="settings-dialog__hint-label">Behavior</span>
                <div class="settings-dialog__field">
                  <span class="settings-dialog__label">Worktree detection</span>
                  <select v-model="draftWorktreeDetectionIntervalMs" class="settings-dialog__select">
                    <option
                      v-for="option in WORKTREE_DETECTION_INTERVAL_OPTIONS"
                      :key="option.label"
                      :value="serializeWorktreeDetectionInterval(option.value)"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </div>
                <p class="settings-dialog__hint-copy">
                  {{ WORKTREE_DETECTION_INTERVAL_OPTIONS.find((option) => (
                    serializeWorktreeDetectionInterval(option.value) === draftWorktreeDetectionIntervalMs
                  ))?.copy }}
                </p>
                <p class="settings-dialog__hint-copy">
                  Leave the title empty to follow the current repository name automatically.
                </p>
              </div>
            </section>

            <section
              v-show="activeSection === 'shortcuts'"
              class="settings-dialog__section settings-dialog__section--shortcuts"
            >
              <header class="settings-dialog__section-header">
                <div>
                  <p class="settings-dialog__section-eyebrow">Shortcuts</p>
                  <h3 class="settings-dialog__section-title">Keyboard shortcuts</h3>
                </div>
                <p class="settings-dialog__section-copy">
                  Current global bindings available in the app.
                </p>
              </header>

              <div class="settings-dialog__hint-card settings-dialog__hint-card--inline">
                <span class="settings-dialog__hint-label">Mouse zoom</span>
                <p class="settings-dialog__hint-copy">
                  Hold <code>Ctrl</code> and use the mouse wheel over shell, note, code, or the workspace sidebar to change font size.
                </p>
              </div>

              <div class="settings-dialog__shortcut-groups">
                <section
                  v-for="group in SETTINGS_SHORTCUT_GROUPS"
                  :key="group.id"
                  class="settings-dialog__shortcut-group"
                >
                  <p class="settings-dialog__shortcut-group-title">
                    {{ group.label }}
                  </p>

                  <div class="settings-dialog__shortcut-list">
                    <div
                      v-for="shortcut in group.shortcuts"
                      :key="shortcut.id"
                      class="settings-dialog__shortcut"
                    >
                      <span class="settings-dialog__shortcut-label">{{ shortcut.label }}</span>
                      <code class="settings-dialog__shortcut-keys">{{ shortcut.display }}</code>
                    </div>
                  </div>
                </section>
              </div>
            </section>

            <section
              v-show="activeSection === 'commands'"
              class="settings-dialog__section settings-dialog__section--commands"
            >
              <header class="settings-dialog__section-header">
                <div>
                  <p class="settings-dialog__section-eyebrow">Commands</p>
                  <h3 class="settings-dialog__section-title">Terminal presets</h3>
                </div>
                <p class="settings-dialog__section-copy">
                  Build reusable shell sequences with write, wait and delay steps.
                </p>
              </header>

              <div class="settings-dialog__section-actions">
                <p class="settings-dialog__section-note">
                  Assign a slot like <code>[Ctrl+Alt+1]</code> to run a preset instantly.
                </p>
                <button class="settings-dialog__button settings-dialog__button--secondary" type="button" @click="addCommandPreset">
                  Add preset
                </button>
              </div>

              <div v-if="!draftCommandPresets.length" class="settings-dialog__empty">
                <p class="settings-dialog__empty-title">No presets yet</p>
                <p class="settings-dialog__empty-copy">
                  Add your first preset for flows like <code>wsl</code>, wait for prompt, then <code>codex --continue</code>.
                </p>
              </div>

              <div v-else class="settings-dialog__command-list">
                <article
                  v-for="preset in draftCommandPresets"
                  :key="preset.id"
                  class="settings-dialog__command-card"
                  :class="{ 'settings-dialog__command-card--expanded': expandedCommandPresetId === preset.id }"
                >
                  <div class="settings-dialog__command-shell">
                    <button
                      class="settings-dialog__command-summary"
                      type="button"
                      :aria-expanded="expandedCommandPresetId === preset.id"
                      @click="toggleCommandPreset(preset.id)"
                    >
                      <span class="settings-dialog__command-summary-copy">
                        <span class="settings-dialog__command-summary-title">
                          {{ preset.name.trim() || `Command ${draftCommandPresets.indexOf(preset) + 1}` }}
                        </span>
                        <span class="settings-dialog__command-summary-meta">
                          {{ formatPresetTarget(preset.target) }} ·
                          {{ preset.steps.length }} {{ preset.steps.length === 1 ? 'step' : 'steps' }} ·
                          {{ preset.shortcutSlot ? formatCommandSlotShortcut(preset.shortcutSlot) : 'No shortcut' }}
                        </span>
                      </span>
                      <span
                        class="settings-dialog__command-chevron"
                        :class="{ 'settings-dialog__command-chevron--expanded': expandedCommandPresetId === preset.id }"
                        aria-hidden="true"
                      >
                        <svg viewBox="0 0 24 24">
                          <path
                            d="M6.47 8.97a.75.75 0 0 1 1.06 0L12 13.44l4.47-4.47a.75.75 0 1 1 1.06 1.06l-5 5a.75.75 0 0 1-1.06 0l-5-5a.75.75 0 0 1 0-1.06Z"
                          />
                        </svg>
                      </span>
                    </button>

                    <button
                      class="settings-dialog__icon-button settings-dialog__icon-button--danger"
                      type="button"
                      aria-label="Remove preset"
                      @click="removeCommandPreset(preset.id)"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M9 3.75A1.75 1.75 0 0 0 7.25 5.5v.25H4.5a.75.75 0 0 0 0 1.5h.76l.72 10.13A2.75 2.75 0 0 0 8.72 20h6.56a2.75 2.75 0 0 0 2.74-2.62l.72-10.13h.76a.75.75 0 0 0 0-1.5h-2.75V5.5A1.75 1.75 0 0 0 15 3.75H9Zm6.25 2H8.75V5.5c0-.14.11-.25.25-.25h6c.14 0 .25.11.25.25v.25Zm-6.47 3a.75.75 0 0 1 .75.7l.25 6a.75.75 0 0 1-1.5.1l-.25-6a.75.75 0 0 1 .7-.8h.05Zm6.44.8a.75.75 0 0 0-1.5-.1l-.25 6a.75.75 0 0 0 1.5.1l.25-6Zm-3.97-.8a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 .75-.75Z"
                        />
                      </svg>
                    </button>
                  </div>

                  <div v-show="expandedCommandPresetId === preset.id" class="settings-dialog__command-body">
                    <label class="settings-dialog__field">
                      <span class="settings-dialog__label">Preset name</span>
                      <input
                        v-model="preset.name"
                        class="settings-dialog__input"
                        type="text"
                        maxlength="48"
                        autocomplete="off"
                        placeholder="WSL continue"
                      >
                    </label>

                    <div class="settings-dialog__grid">
                      <label class="settings-dialog__field">
                        <span class="settings-dialog__label">Run target</span>
                        <select v-model="preset.target" class="settings-dialog__select">
                          <option value="active-tab">Active shell tab</option>
                          <option value="new-tab">New shell tab</option>
                        </select>
                      </label>

                      <label class="settings-dialog__field">
                        <span class="settings-dialog__label">Reserved shortcut</span>
                        <select v-model="preset.shortcutSlot" class="settings-dialog__select">
                          <option :value="null">No shortcut</option>
                          <option v-for="slot in 9" :key="slot" :value="slot">
                            {{ formatCommandSlotShortcut(slot) }}
                          </option>
                        </select>
                      </label>
                    </div>

                    <div class="settings-dialog__steps">
                      <div
                        v-for="(step, stepIndex) in preset.steps"
                        :key="step.id"
                        class="settings-dialog__step"
                      >
                        <div class="settings-dialog__step-header">
                          <div class="settings-dialog__step-title-row">
                            <span class="settings-dialog__step-index">Step {{ stepIndex + 1 }}</span>
                            <select
                              class="settings-dialog__select settings-dialog__select--compact settings-dialog__step-select"
                              :value="step.type"
                              @change="updateStepType(
                                preset.id,
                                step.id,
                                ($event.target as HTMLSelectElement).value as TerminalCommandStep['type'],
                              )"
                            >
                              <option value="write">Write</option>
                              <option value="wait-for-prompt">Wait</option>
                              <option value="delay">Delay</option>
                            </select>
                          </div>

                          <div class="settings-dialog__step-actions">
                            <button
                              class="settings-dialog__icon-button settings-dialog__icon-button--danger"
                              type="button"
                              :disabled="preset.steps.length <= 1"
                              :aria-label="`Remove step ${stepIndex + 1}`"
                              :title="`Remove step ${stepIndex + 1}`"
                              @click="removeStep(preset.id, step.id)"
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path
                                  d="M9 3.75A1.75 1.75 0 0 0 7.25 5.5v.25H4.5a.75.75 0 0 0 0 1.5h.76l.72 10.13A2.75 2.75 0 0 0 8.72 20h6.56a2.75 2.75 0 0 0 2.74-2.62l.72-10.13h.76a.75.75 0 0 0 0-1.5h-2.75V5.5A1.75 1.75 0 0 0 15 3.75H9Zm6.25 2H8.75V5.5c0-.14.11-.25.25-.25h6c.14 0 .25.11.25.25v.25Zm-6.47 3a.75.75 0 0 1 .75.7l.25 6a.75.75 0 0 1-1.5.1l-.25-6a.75.75 0 0 1 .7-.8h.05Zm6.44.8a.75.75 0 0 0-1.5-.1l-.25 6a.75.75 0 0 0 1.5.1l.25-6Zm-3.97-.8a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 .75-.75Z"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>

                        <template v-if="step.type === 'write'">
                          <label class="settings-dialog__field">
                            <span class="settings-dialog__label">Text to send</span>
                            <textarea
                              v-model="step.value"
                              class="settings-dialog__textarea"
                              rows="3"
                              placeholder="codex --continue"
                            />
                          </label>

                          <label class="settings-dialog__checkbox">
                            <input v-model="step.submit" type="checkbox">
                            <span>Submit step with [Enter]</span>
                          </label>
                        </template>

                        <template v-else-if="step.type === 'wait-for-prompt'">
                          <label class="settings-dialog__field">
                            <span class="settings-dialog__label">Prompt pattern</span>
                            <input
                              v-model="step.pattern"
                              class="settings-dialog__input"
                              type="text"
                              autocomplete="off"
                              placeholder="^.+[>#\\$]\\s?$"
                            >
                          </label>

                          <p class="settings-dialog__step-copy">
                            Use a regular expression that matches the shell prompt before the next step runs.
                          </p>
                        </template>

                        <template v-else>
                          <label class="settings-dialog__field">
                            <span class="settings-dialog__label">Delay in milliseconds</span>
                            <input
                              v-model.number="step.delayMs"
                              class="settings-dialog__input"
                              type="number"
                              min="50"
                              max="60000"
                              step="50"
                            >
                          </label>

                          <p class="settings-dialog__step-copy">
                            Use delay only when prompt detection is not reliable enough.
                          </p>
                        </template>
                      </div>
                    </div>

                    <div class="settings-dialog__step-toolbar">
                      <button class="settings-dialog__button settings-dialog__button--ghost" type="button" @click="addStep(preset.id, 'write')">
                        Add write
                      </button>
                      <button class="settings-dialog__button settings-dialog__button--ghost" type="button" @click="addStep(preset.id, 'wait-for-prompt')">
                        Add wait
                      </button>
                      <button class="settings-dialog__button settings-dialog__button--ghost" type="button" @click="addStep(preset.id, 'delay')">
                        Add delay
                      </button>
                    </div>
                  </div>
                </article>
              </div>
            </section>

            <section v-show="activeSection === 'layout'" class="settings-dialog__section">
              <header class="settings-dialog__section-header">
                <div>
                  <p class="settings-dialog__section-eyebrow">Layout</p>
                  <h3 class="settings-dialog__section-title">Diff and shell arrangement</h3>
                </div>
                <p class="settings-dialog__section-copy">
                  Choose the preferred split used by the right side workspace.
                </p>
              </header>

              <div class="settings-dialog__layout-options">
                <label
                  class="settings-dialog__layout-card"
                  :class="{ 'settings-dialog__layout-card--active': draftContentLayout === 'stacked' }"
                >
                  <input v-model="draftContentLayout" type="radio" value="stacked">
                  <span class="settings-dialog__layout-title">Stacked</span>
                  <span class="settings-dialog__layout-copy">Diff above shell, best for narrow windows.</span>
                </label>

                <label
                  class="settings-dialog__layout-card"
                  :class="{ 'settings-dialog__layout-card--active': draftContentLayout === 'side-by-side' }"
                >
                  <input v-model="draftContentLayout" type="radio" value="side-by-side">
                  <span class="settings-dialog__layout-title">Side by side</span>
                  <span class="settings-dialog__layout-copy">Diff next to shell, best for wider screens.</span>
                </label>
              </div>

              <div class="settings-dialog__grid">
                <div class="settings-dialog__hint-card">
                  <span class="settings-dialog__hint-label">Application</span>
                  <div class="settings-dialog__field">
                    <span class="settings-dialog__label">Appearance</span>
                    <select v-model="draftAppAppearance" class="settings-dialog__select">
                      <option
                        v-for="option in APP_APPEARANCE_OPTIONS"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                    </select>
                  </div>
                  <p class="settings-dialog__hint-copy">
                    {{ APP_APPEARANCE_OPTIONS.find((option) => option.value === draftAppAppearance)?.copy }}
                  </p>
                  <div
                    class="settings-dialog__preview-card settings-dialog__preview-card--theme"
                    :data-preview-appearance="draftAppAppearance"
                    :data-preview-editor-theme="resolvedPreviewEditorTheme"
                  >
                    <div class="settings-dialog__preview-header">
                      <span class="settings-dialog__preview-eyebrow">Theme preview</span>
                      <span class="settings-dialog__preview-meta">
                        {{ draftEditorTheme === 'follow-app' ? 'Editor follows app' : 'Editor override' }}
                      </span>
                    </div>
                    <div class="settings-dialog__theme-preview">
                      <div class="settings-dialog__theme-preview-tabs">
                        <span class="settings-dialog__theme-tab settings-dialog__theme-tab--active">Notes</span>
                        <span class="settings-dialog__theme-tab">Shell</span>
                        <span class="settings-dialog__theme-tab">Code</span>
                      </div>
                      <div class="settings-dialog__theme-preview-actions">
                        <span class="settings-dialog__theme-button settings-dialog__theme-button--icon">+</span>
                        <span class="settings-dialog__theme-button settings-dialog__theme-button--icon">⚙</span>
                        <span class="settings-dialog__theme-button settings-dialog__theme-button--active">Save</span>
                      </div>
                      <div class="settings-dialog__theme-preview-editor">
                        <span class="settings-dialog__theme-preview-line settings-dialog__theme-preview-line--keyword">const</span>
                        <span class="settings-dialog__theme-preview-line settings-dialog__theme-preview-line--text"> bridge = </span>
                        <span class="settings-dialog__theme-preview-line settings-dialog__theme-preview-line--string">'ready'</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="settings-dialog__hint-card">
                  <span class="settings-dialog__hint-label">Editor</span>
                  <div class="settings-dialog__field">
                    <span class="settings-dialog__label">Code tab theme</span>
                    <select v-model="draftEditorTheme" class="settings-dialog__select">
                      <option
                        v-for="option in EDITOR_THEME_OPTIONS"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                    </select>
                  </div>
                  <p class="settings-dialog__hint-copy">
                    {{ EDITOR_THEME_OPTIONS.find((option) => option.value === draftEditorTheme)?.copy }}
                  </p>
                </div>
              </div>

              <div class="settings-dialog__hint-card">
                <span class="settings-dialog__hint-label">New tabs</span>
                <label class="settings-dialog__field">
                  <span class="settings-dialog__label">Default font size for shell, note and code</span>
                  <input
                    v-model.number="draftUnifiedWorkspaceTabFontSize"
                    class="settings-dialog__input"
                    type="number"
                    :min="WORKSPACE_TAB_FONT_SIZE_MIN"
                    :max="WORKSPACE_TAB_FONT_SIZE_MAX"
                    step="1"
                    @blur="normalizeDraftWorkspaceTabFontSize"
                  >
                </label>
                <div
                  class="settings-dialog__preview-card"
                  :style="workspaceTabsPreviewStyle"
                  :data-preview-appearance="draftAppAppearance"
                  :data-preview-editor-theme="resolvedPreviewEditorTheme"
                >
                  <div class="settings-dialog__preview-header">
                    <span class="settings-dialog__preview-eyebrow">Preview</span>
                    <span class="settings-dialog__preview-meta">{{ draftUnifiedWorkspaceTabFontSize }} px</span>
                  </div>
                  <div class="settings-dialog__preview-surface settings-dialog__preview-surface--stacked">
                    <span class="settings-dialog__preview-label">Shell · Note · Code</span>
                    <code class="settings-dialog__preview-code">$ git status</code>
                    <code class="settings-dialog__preview-code"># Release checklist</code>
                    <code class="settings-dialog__preview-code">const bridge = 'ready';</code>
                  </div>
                </div>
                <p class="settings-dialog__hint-copy">
                  Used for newly created shell, note and code tabs. Existing tabs keep their current zoom from <code>Ctrl + wheel</code>.
                </p>
              </div>

              <div class="settings-dialog__hint-card">
                <span class="settings-dialog__hint-label">Workspace panel</span>
                <label class="settings-dialog__field">
                  <span class="settings-dialog__label">Workspace panel font size</span>
                  <input
                    v-model.number="draftWorkspacePanelFontSize"
                    class="settings-dialog__input"
                    type="number"
                    :min="WORKSPACE_PANEL_FONT_SIZE_MIN"
                    :max="WORKSPACE_PANEL_FONT_SIZE_MAX"
                    step="1"
                    @blur="normalizeDraftWorkspacePanelFontSize"
                  >
                </label>
                <div
                  class="settings-dialog__preview-card"
                  :style="workspaceTabPreviewStyle"
                  :data-preview-appearance="draftAppAppearance"
                >
                  <div class="settings-dialog__preview-header">
                    <span class="settings-dialog__preview-eyebrow">Preview</span>
                    <span class="settings-dialog__preview-meta">{{ draftWorkspacePanelFontSize }} px</span>
                  </div>
                  <div class="settings-dialog__preview-surface settings-dialog__preview-surface--stacked">
                    <span class="settings-dialog__preview-label">Repository · Workspaces · Files</span>
                    <code class="settings-dialog__preview-code">BridgeGit</code>
                    <code class="settings-dialog__preview-code">feature/editor-theme · 3 / 1 / 0</code>
                    <code class="settings-dialog__preview-code">src/renderer/components/RepoPanel.vue</code>
                  </div>
                </div>
                <p class="settings-dialog__hint-copy">
                  Controls the left repository/workspace panel. You can also adjust it directly with <code>Ctrl + wheel</code> over the sidebar.
                </p>
              </div>
            </section>
          </div>

          <footer class="settings-dialog__actions">
            <button class="settings-dialog__button settings-dialog__button--ghost" type="button" @click="closeDialog">
              Cancel
            </button>
            <button class="settings-dialog__button settings-dialog__button--primary" type="submit">
              Save
            </button>
          </footer>
        </form>
      </section>
    </div>
  </teleport>
</template>

<style scoped lang="scss">
.settings-dialog {
  --border-strong: rgba(108, 124, 148, 0.24);
  --border-subtle: rgba(108, 124, 148, 0.16);
  --text-primary: #f0f4fb;
  --text-muted: #a8b4c7;
  --text-dim: #6f7d91;
  --dialog-backdrop: rgba(3, 5, 8, 0.58);
  --dialog-panel-bg:
    linear-gradient(145deg, rgba(76, 157, 255, 0.08), transparent 36%),
    rgba(10, 14, 19, 0.98);
  --dialog-sidebar-bg: rgba(8, 12, 17, 0.7);
  --dialog-button-bg: rgba(16, 22, 29, 0.92);
  --shadow-panel: 0 18px 38px rgba(0, 0, 0, 0.32);
  position: fixed;
  inset: 0;
  display: grid;
  align-items: start;
  justify-items: stretch;
  padding: 0;
  background: var(--dialog-backdrop);
  backdrop-filter: blur(8px);
  z-index: 120;
}

.settings-dialog[data-dialog-appearance='bridgegit-light'] {
  --border-strong: rgba(112, 136, 164, 0.22);
  --border-subtle: rgba(112, 136, 164, 0.18);
  --text-primary: #182535;
  --text-muted: #607286;
  --text-dim: #7d8da0;
  --dialog-backdrop: rgba(214, 224, 237, 0.58);
  --dialog-panel-bg:
    linear-gradient(145deg, rgba(88, 154, 225, 0.08), transparent 36%),
    rgba(248, 251, 255, 0.98);
  --dialog-sidebar-bg: rgba(239, 245, 251, 0.92);
  --dialog-button-bg: rgba(236, 242, 249, 0.98);
  --shadow-panel: 0 18px 38px rgba(73, 102, 135, 0.16);
}

.settings-dialog[data-dialog-appearance='github-dark'] {
  --border-strong: rgba(110, 118, 129, 0.28);
  --border-subtle: rgba(110, 118, 129, 0.2);
  --text-primary: #c9d1d9;
  --text-muted: #8b949e;
  --text-dim: #6e7681;
  --dialog-backdrop: rgba(1, 4, 9, 0.58);
  --dialog-panel-bg:
    linear-gradient(145deg, rgba(56, 139, 253, 0.08), transparent 36%),
    rgba(13, 17, 23, 0.98);
  --dialog-sidebar-bg: rgba(22, 27, 34, 0.9);
  --dialog-button-bg: rgba(33, 38, 45, 0.98);
  --shadow-panel: 0 18px 38px rgba(0, 0, 0, 0.34);
}

.settings-dialog[data-dialog-appearance='github-light'] {
  --border-strong: rgba(208, 215, 222, 0.9);
  --border-subtle: rgba(208, 215, 222, 0.72);
  --text-primary: #24292f;
  --text-muted: #57606a;
  --text-dim: #6e7781;
  --dialog-backdrop: rgba(208, 215, 222, 0.46);
  --dialog-panel-bg:
    linear-gradient(145deg, rgba(9, 105, 218, 0.06), transparent 36%),
    rgba(255, 255, 255, 0.99);
  --dialog-sidebar-bg: rgba(246, 248, 250, 0.96);
  --dialog-button-bg: rgba(246, 248, 250, 0.98);
  --shadow-panel: 0 18px 38px rgba(31, 35, 40, 0.08);
}

.settings-dialog[data-dialog-appearance='nord'] {
  --border-strong: rgba(129, 161, 193, 0.24);
  --border-subtle: rgba(129, 161, 193, 0.18);
  --text-primary: #d8dee9;
  --text-muted: #a7b3c4;
  --text-dim: #8c9aae;
  --dialog-backdrop: rgba(36, 41, 51, 0.58);
  --dialog-panel-bg:
    linear-gradient(145deg, rgba(136, 192, 208, 0.08), transparent 36%),
    rgba(46, 52, 64, 0.98);
  --dialog-sidebar-bg: rgba(59, 66, 82, 0.9);
  --dialog-button-bg: rgba(67, 76, 94, 0.96);
  --shadow-panel: 0 18px 38px rgba(15, 18, 24, 0.34);
}

.settings-dialog__panel {
  --settings-card-bg: rgba(11, 16, 22, 0.72);
  --settings-card-active-bg: rgba(28, 43, 60, 0.62);
  --settings-input-bg: rgba(10, 14, 20, 0.94);
  --settings-key-bg: rgba(8, 12, 17, 0.88);
  --settings-scrollbar-thumb-bg: rgba(88, 102, 124, 0.44);
  --settings-scrollbar-track-bg: rgba(8, 12, 17, 0.72);
  --settings-button-ghost-bg: rgba(16, 22, 29, 0.92);
  --settings-button-secondary-bg: rgba(24, 39, 57, 0.84);
  --settings-button-secondary-color: #dcecff;
  --settings-button-primary-bg:
    linear-gradient(180deg, rgba(36, 88, 143, 0.95), rgba(25, 58, 95, 0.95));
  --settings-button-primary-color: #f5fbff;
  width: 100%;
  height: 100%;
  max-height: none;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 18px;
  align-content: start;
  min-height: 0;
  padding: 18px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--dialog-panel-bg);
  color-scheme: dark;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.settings-dialog[data-dialog-appearance='bridgegit-light'] .settings-dialog__panel {
  --settings-card-bg: rgba(244, 248, 252, 0.96);
  --settings-card-active-bg: rgba(230, 238, 247, 0.98);
  --settings-input-bg: rgba(255, 255, 255, 0.98);
  --settings-key-bg: rgba(236, 242, 249, 0.98);
  --settings-scrollbar-thumb-bg: rgba(138, 155, 176, 0.42);
  --settings-scrollbar-track-bg: rgba(236, 242, 249, 0.98);
  --settings-button-ghost-bg: rgba(244, 248, 252, 0.98);
  --settings-button-secondary-bg: rgba(230, 238, 247, 0.98);
  --settings-button-secondary-color: #1f3f63;
  --settings-button-primary-bg:
    linear-gradient(180deg, rgba(63, 133, 214, 0.92), rgba(45, 108, 183, 0.94));
  --settings-button-primary-color: #f8fbff;
  color-scheme: light;
}

.settings-dialog[data-dialog-appearance='github-dark'] .settings-dialog__panel {
  --settings-card-bg: rgba(22, 27, 34, 0.9);
  --settings-card-active-bg: rgba(33, 38, 45, 0.98);
  --settings-input-bg: rgba(13, 17, 23, 0.98);
  --settings-key-bg: rgba(13, 17, 23, 0.92);
  --settings-scrollbar-thumb-bg: rgba(110, 118, 129, 0.42);
  --settings-scrollbar-track-bg: rgba(13, 17, 23, 0.82);
  --settings-button-ghost-bg: rgba(33, 38, 45, 0.98);
  --settings-button-secondary-bg: rgba(33, 38, 45, 0.98);
  --settings-button-secondary-color: #c9d1d9;
  --settings-button-primary-bg:
    linear-gradient(180deg, rgba(56, 139, 253, 0.92), rgba(31, 111, 235, 0.94));
  --settings-button-primary-color: #f0f6fc;
  color-scheme: dark;
}

.settings-dialog[data-dialog-appearance='github-light'] .settings-dialog__panel {
  --settings-card-bg: rgba(246, 248, 250, 0.98);
  --settings-card-active-bg: rgba(238, 242, 246, 0.98);
  --settings-input-bg: rgba(255, 255, 255, 0.99);
  --settings-key-bg: rgba(246, 248, 250, 0.98);
  --settings-scrollbar-thumb-bg: rgba(175, 184, 193, 0.72);
  --settings-scrollbar-track-bg: rgba(246, 248, 250, 0.96);
  --settings-button-ghost-bg: rgba(246, 248, 250, 0.98);
  --settings-button-secondary-bg: rgba(238, 242, 246, 0.98);
  --settings-button-secondary-color: #24292f;
  --settings-button-primary-bg:
    linear-gradient(180deg, rgba(9, 105, 218, 0.92), rgba(8, 88, 186, 0.94));
  --settings-button-primary-color: #f6f8fa;
  color-scheme: light;
}

.settings-dialog[data-dialog-appearance='nord'] .settings-dialog__panel {
  --settings-card-bg: rgba(59, 66, 82, 0.92);
  --settings-card-active-bg: rgba(67, 76, 94, 0.98);
  --settings-input-bg: rgba(46, 52, 64, 0.98);
  --settings-key-bg: rgba(46, 52, 64, 0.94);
  --settings-scrollbar-thumb-bg: rgba(129, 161, 193, 0.36);
  --settings-scrollbar-track-bg: rgba(46, 52, 64, 0.82);
  --settings-button-ghost-bg: rgba(67, 76, 94, 0.96);
  --settings-button-secondary-bg: rgba(67, 76, 94, 0.96);
  --settings-button-secondary-color: #d8dee9;
  --settings-button-primary-bg:
    linear-gradient(180deg, rgba(129, 161, 193, 0.92), rgba(94, 129, 172, 0.94));
  --settings-button-primary-color: #eceff4;
  color-scheme: dark;
}

.settings-dialog__header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.settings-dialog__eyebrow,
.settings-dialog__section-eyebrow,
.settings-dialog__hint-label,
.settings-dialog__step-index {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.settings-dialog__title,
.settings-dialog__section-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.08rem;
  font-weight: 700;
}

.settings-dialog__close,
.settings-dialog__icon-button {
  min-width: 32px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--dialog-button-bg);
  color: var(--text-primary);
  font: inherit;
  appearance: none;
  -webkit-appearance: none;
}

.settings-dialog__icon-button--danger {
  border-color: rgba(188, 87, 87, 0.3);
  color: #ffb3ad;
}

.settings-dialog__form {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 18px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.settings-dialog__sidebar {
  grid-row: 1 / -1;
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 8px;
  border: 1px solid rgba(108, 124, 148, 0.14);
  border-radius: 16px;
  background: var(--dialog-sidebar-bg);
  align-self: stretch;
  min-height: 0;
  overflow: auto;
  scrollbar-color: rgba(88, 102, 124, 0.44) rgba(8, 12, 17, 0.72);
}

.settings-dialog__nav-item {
  display: grid;
  gap: 4px;
  padding: 0.9rem 1rem;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
}

.settings-dialog__nav-item--active {
  border-color: rgba(110, 197, 255, 0.24);
  background: var(--settings-card-active-bg);
}

.settings-dialog__nav-label {
  font-size: 0.95rem;
  font-weight: 650;
}

.settings-dialog__nav-copy,
.settings-dialog__section-copy,
.settings-dialog__section-note,
.settings-dialog__hint-copy,
.settings-dialog__step-copy,
.settings-dialog__layout-copy,
.settings-dialog__empty-copy {
  color: var(--text-muted);
  font-size: 0.82rem;
  line-height: 1.45;
}

.settings-dialog__content {
  grid-column: 2;
  display: block;
  min-height: 0;
  overflow: auto;
  padding-right: 6px;
  scrollbar-color: rgba(88, 102, 124, 0.44) rgba(8, 12, 17, 0.72);
}

.settings-dialog__content::-webkit-scrollbar,
.settings-dialog__sidebar::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.settings-dialog__content::-webkit-scrollbar-thumb,
.settings-dialog__sidebar::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: var(--settings-scrollbar-thumb-bg);
  background-clip: padding-box;
}

.settings-dialog__content::-webkit-scrollbar-track,
.settings-dialog__sidebar::-webkit-scrollbar-track {
  background: var(--settings-scrollbar-track-bg);
}

.settings-dialog__content::-webkit-scrollbar-corner,
.settings-dialog__sidebar::-webkit-scrollbar-corner {
  background: var(--settings-scrollbar-track-bg);
}

.settings-dialog__section {
  display: grid;
  align-content: start;
  gap: 14px;
}

.settings-dialog__section-header,
.settings-dialog__section-actions,
.settings-dialog__command-shell,
.settings-dialog__step-header,
.settings-dialog__step-title-row,
.settings-dialog__step-actions,
.settings-dialog__actions {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.settings-dialog__field {
  display: grid;
  gap: 6px;
}

.settings-dialog__field--grow {
  flex: 1 1 auto;
}

.settings-dialog__section-note {
  margin: 0;
}

.settings-dialog__label {
  color: var(--text-dim);
  font-size: 0.76rem;
  letter-spacing: 0.04em;
}

.settings-dialog__input,
.settings-dialog__select,
.settings-dialog__textarea {
  width: 100%;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--settings-input-bg);
  color: var(--text-primary);
  font: inherit;
  appearance: none;
  -webkit-appearance: none;
}

.settings-dialog__textarea {
  resize: vertical;
  min-height: 84px;
}

.settings-dialog__select {
  padding-right: 2.35rem;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-dim) 50%),
    linear-gradient(135deg, var(--text-dim) 50%, transparent 50%);
  background-position:
    calc(100% - 16px) calc(50% - 1px),
    calc(100% - 11px) calc(50% - 1px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}

.settings-dialog__select--compact {
  width: auto;
  min-width: 130px;
  padding-right: 2rem;
}

.settings-dialog__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.settings-dialog__hint-card,
.settings-dialog__empty,
.settings-dialog__command-card,
.settings-dialog__step,
.settings-dialog__layout-card {
  border: 1px solid rgba(108, 124, 148, 0.14);
  border-radius: 14px;
  background: var(--settings-card-bg);
}

.settings-dialog__hint-card {
  padding: 0.8rem 0.9rem;
}

.settings-dialog__preview-card {
  --settings-preview-card-bg:
    linear-gradient(180deg, rgba(15, 22, 30, 0.94), rgba(9, 14, 20, 0.98));
  --settings-preview-surface-bg: rgba(8, 12, 17, 0.86);
  --settings-preview-tab-bg: rgba(13, 18, 24, 0.84);
  --settings-preview-tab-active-bg: rgba(21, 29, 39, 0.96);
  --settings-preview-tab-border: rgba(110, 197, 255, 0.36);
  --settings-preview-button-bg: rgba(14, 20, 27, 0.88);
  --settings-preview-button-active-bg: rgba(40, 86, 58, 0.96);
  --settings-preview-button-active-color: #e8fff1;
  --settings-preview-editor-bg: rgba(11, 16, 22, 0.92);
  --settings-preview-editor-keyword: #8dc7ff;
  --settings-preview-editor-string: #8dd8a6;
  --settings-preview-editor-text: var(--text-primary);
  display: grid;
  gap: 8px;
  margin-top: 10px;
  padding: 0.72rem;
  border: 1px solid rgba(108, 124, 148, 0.16);
  border-radius: 12px;
  background: var(--settings-preview-card-bg);
}

.settings-dialog__preview-card[data-preview-appearance='bridgegit-light'] {
  --settings-preview-card-bg:
    linear-gradient(180deg, rgba(250, 252, 255, 0.98), rgba(241, 247, 252, 0.98));
  --settings-preview-surface-bg: rgba(255, 255, 255, 0.96);
  --settings-preview-tab-bg: rgba(236, 242, 249, 0.96);
  --settings-preview-tab-active-bg: rgba(224, 234, 244, 0.98);
  --settings-preview-tab-border: rgba(45, 124, 216, 0.22);
  --settings-preview-button-bg: rgba(236, 242, 249, 0.98);
  --settings-preview-button-active-bg: rgba(208, 233, 216, 0.98);
  --settings-preview-button-active-color: #215235;
  --settings-preview-editor-bg: rgba(252, 253, 255, 0.98);
  --settings-preview-editor-text: #182535;
}

.settings-dialog__preview-card[data-preview-appearance='github-dark'] {
  --settings-preview-card-bg:
    linear-gradient(180deg, rgba(22, 27, 34, 0.98), rgba(13, 17, 23, 0.98));
  --settings-preview-surface-bg: rgba(22, 27, 34, 0.96);
  --settings-preview-tab-bg: rgba(22, 27, 34, 0.96);
  --settings-preview-tab-active-bg: rgba(33, 38, 45, 0.98);
  --settings-preview-tab-border: rgba(56, 139, 253, 0.32);
  --settings-preview-button-bg: rgba(33, 38, 45, 0.98);
  --settings-preview-button-active-bg: rgba(46, 160, 67, 0.24);
  --settings-preview-button-active-color: #c9d1d9;
}

.settings-dialog__preview-card[data-preview-appearance='github-light'] {
  --settings-preview-card-bg:
    linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(246, 248, 250, 0.98));
  --settings-preview-surface-bg: rgba(255, 255, 255, 0.98);
  --settings-preview-tab-bg: rgba(246, 248, 250, 0.98);
  --settings-preview-tab-active-bg: rgba(238, 242, 246, 0.98);
  --settings-preview-tab-border: rgba(9, 105, 218, 0.24);
  --settings-preview-button-bg: rgba(246, 248, 250, 0.98);
  --settings-preview-button-active-bg: rgba(46, 160, 67, 0.16);
  --settings-preview-button-active-color: #116329;
  --settings-preview-editor-text: #24292f;
}

.settings-dialog__preview-card[data-preview-appearance='nord'] {
  --settings-preview-card-bg:
    linear-gradient(180deg, rgba(59, 66, 82, 0.98), rgba(46, 52, 64, 0.98));
  --settings-preview-surface-bg: rgba(59, 66, 82, 0.96);
  --settings-preview-tab-bg: rgba(59, 66, 82, 0.94);
  --settings-preview-tab-active-bg: rgba(67, 76, 94, 0.98);
  --settings-preview-tab-border: rgba(136, 192, 208, 0.28);
  --settings-preview-button-bg: rgba(67, 76, 94, 0.96);
  --settings-preview-button-active-bg: rgba(163, 190, 140, 0.18);
  --settings-preview-button-active-color: #e5e9f0;
}

.settings-dialog__preview-card[data-preview-editor-theme='bridgegit-light'] {
  --settings-preview-editor-bg: rgba(252, 253, 255, 0.98);
  --settings-preview-editor-keyword: #2d7cd8;
  --settings-preview-editor-string: #2f8a5d;
  --settings-preview-editor-text: #182535;
}

.settings-dialog__preview-card[data-preview-editor-theme='github-dark'] {
  --settings-preview-editor-bg: #0d1117;
  --settings-preview-editor-keyword: #ff7b72;
  --settings-preview-editor-string: #a5d6ff;
  --settings-preview-editor-text: #c9d1d9;
}

.settings-dialog__preview-card[data-preview-editor-theme='github-light'] {
  --settings-preview-editor-bg: #ffffff;
  --settings-preview-editor-keyword: #cf222e;
  --settings-preview-editor-string: #0a3069;
  --settings-preview-editor-text: #24292f;
}

.settings-dialog__preview-card[data-preview-editor-theme='nord'] {
  --settings-preview-editor-bg: #2e3440;
  --settings-preview-editor-keyword: #81a1c1;
  --settings-preview-editor-string: #a3be8c;
  --settings-preview-editor-text: #d8dee9;
}

.settings-dialog__preview-card--theme {
  margin-top: 10px;
}

.settings-dialog__preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.settings-dialog__preview-eyebrow,
.settings-dialog__preview-meta,
.settings-dialog__preview-label {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.04em;
}

.settings-dialog__preview-surface {
  display: grid;
  gap: 6px;
  padding: 0.7rem;
  border: 1px solid rgba(108, 124, 148, 0.14);
  border-radius: 10px;
  background: var(--settings-preview-surface-bg);
}

.settings-dialog__preview-surface--stacked {
  gap: 8px;
}

.settings-dialog__preview-code {
  color: var(--settings-preview-editor-text);
  font-family: var(--font-mono), monospace;
  font-size: calc(var(--settings-preview-font-size-px, 14) * 1px);
  white-space: nowrap;
}

.settings-dialog__theme-preview {
  display: grid;
  gap: 8px;
}

.settings-dialog__theme-preview-tabs,
.settings-dialog__theme-preview-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}

.settings-dialog__theme-tab,
.settings-dialog__theme-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0.28rem 0.62rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--settings-preview-button-bg);
  color: var(--text-primary);
  font: 600 0.74rem/1.2 var(--font-mono);
}

.settings-dialog__theme-tab {
  background: var(--settings-preview-tab-bg);
}

.settings-dialog__theme-tab--active {
  border-color: var(--settings-preview-tab-border);
  background: var(--settings-preview-tab-active-bg);
}

.settings-dialog__theme-button--icon {
  width: 28px;
  min-width: 28px;
  padding-inline: 0;
}

.settings-dialog__theme-button--active {
  background: var(--settings-preview-button-active-bg);
  color: var(--settings-preview-button-active-color);
}

.settings-dialog__theme-preview-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  padding: 0.68rem 0.8rem;
  border: 1px solid rgba(108, 124, 148, 0.14);
  border-radius: 10px;
  background: var(--settings-preview-editor-bg);
  font: 600 0.76rem/1.4 var(--font-mono);
}

.settings-dialog__theme-preview-line--keyword {
  color: var(--settings-preview-editor-keyword);
}

.settings-dialog__theme-preview-line--string {
  color: var(--settings-preview-editor-string);
}

.settings-dialog__theme-preview-line--text {
  color: var(--settings-preview-editor-text);
}

.settings-dialog__hint-card--inline {
  flex: 1 1 auto;
}

.settings-dialog__shortcut-groups,
.settings-dialog__shortcut-list,
.settings-dialog__command-list,
.settings-dialog__steps,
.settings-dialog__layout-options {
  display: grid;
  gap: 12px;
}

.settings-dialog__shortcut-groups,
.settings-dialog__shortcut-list,
.settings-dialog__command-list {
  min-height: 0;
  align-content: start;
}

.settings-dialog__shortcut-groups {
  gap: 14px;
}

.settings-dialog__shortcut-group {
  display: grid;
  gap: 6px;
}

.settings-dialog__shortcut-group-title {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.settings-dialog__shortcut-list {
  gap: 0;
}

.settings-dialog__command-list {
  overflow: visible;
  padding-right: 0;
}

.settings-dialog__shortcut {
  display: grid;
  gap: 6px;
  padding: 0.8rem 0;
  border-bottom: 1px solid rgba(108, 124, 148, 0.16);
}

.settings-dialog__shortcut:first-child {
  border-top: 1px solid rgba(108, 124, 148, 0.16);
}

.settings-dialog__shortcut-label {
  color: var(--text-muted);
  font-size: 0.84rem;
}

.settings-dialog__shortcut-keys {
  justify-self: start;
  padding: 0.18rem 0.45rem;
  border: 1px solid rgba(108, 124, 148, 0.18);
  border-radius: 8px;
  background: var(--settings-key-bg);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.74rem;
}

.settings-dialog__empty,
.settings-dialog__command-card {
  padding: 14px;
}

.settings-dialog__command-card {
  display: grid;
  gap: 0;
  padding: 0;
  overflow: hidden;
}

.settings-dialog__command-shell {
  align-items: center;
  padding: 14px;
}

.settings-dialog__command-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 1 1 auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
}

.settings-dialog__command-summary-copy {
  display: grid;
  gap: 4px;
}

.settings-dialog__command-summary-title {
  color: var(--text-primary);
  font-size: 0.95rem;
  font-weight: 650;
}

.settings-dialog__command-summary-meta {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.settings-dialog__command-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--text-dim);
  transition: transform 160ms ease;
}

.settings-dialog__command-chevron svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.settings-dialog__command-chevron--expanded {
  transform: rotate(180deg);
}

.settings-dialog__command-body {
  display: grid;
  gap: 12px;
  padding: 0 14px 14px;
  border-top: 1px solid rgba(108, 124, 148, 0.14);
}

.settings-dialog__empty-title,
.settings-dialog__layout-title {
  color: var(--text-primary);
  font-size: 0.95rem;
  font-weight: 650;
}

.settings-dialog__empty-title,
.settings-dialog__empty-copy,
.settings-dialog__layout-title,
.settings-dialog__layout-copy {
  margin: 0;
}

.settings-dialog__step {
  display: grid;
  gap: 12px;
  padding: 12px;
}

.settings-dialog__checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 0.83rem;
}

.settings-dialog__checkbox--card {
  align-items: start;
  flex-wrap: wrap;
  justify-content: space-between;
  padding: 0.95rem 1rem;
  border: 1px solid rgba(108, 124, 148, 0.14);
  border-radius: 14px;
  background: var(--settings-card-bg);
}

.settings-dialog__checkbox-toggle {
  display: flex;
  align-items: start;
  gap: 8px;
  flex: 1 1 280px;
  min-width: 0;
  cursor: pointer;
}

.settings-dialog__checkbox-preview {
  flex: 0 0 auto;
}

.settings-dialog__checkbox-content {
  display: grid;
  gap: 4px;
}

.settings-dialog__checkbox-title {
  color: var(--text-primary);
  font-weight: 600;
}

.settings-dialog__checkbox-copy {
  color: var(--text-muted);
  line-height: 1.4;
}

.settings-dialog__checkbox-list {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}

.settings-dialog__step-title-row {
  align-items: center;
}

.settings-dialog__step-select {
  min-width: 110px;
}

.settings-dialog__icon-button svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.settings-dialog__step-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.settings-dialog__layout-options {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.settings-dialog__layout-card {
  display: grid;
  gap: 8px;
  padding: 1rem;
  cursor: pointer;
}

.settings-dialog__layout-card--active {
  border-color: rgba(110, 197, 255, 0.24);
  background: var(--settings-card-active-bg);
}

.settings-dialog__layout-card input {
  margin: 0;
}

.settings-dialog__actions {
  grid-column: 2;
  justify-content: flex-end;
  padding-top: 6px;
}

.settings-dialog__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 92px;
  padding: 0.65rem 0.9rem;
  border-radius: 10px;
  font-weight: 600;
  appearance: none;
  -webkit-appearance: none;
}

.settings-dialog__button--ghost {
  border: 1px solid var(--border-subtle);
  background: var(--settings-button-ghost-bg);
  color: var(--text-primary);
}

.settings-dialog__button--secondary {
  border: 1px solid rgba(110, 197, 255, 0.22);
  background: var(--settings-button-secondary-bg);
  color: var(--settings-button-secondary-color);
}

.settings-dialog__button--primary {
  border: 1px solid rgba(110, 197, 255, 0.34);
  background: var(--settings-button-primary-bg);
  color: var(--settings-button-primary-color);
}

code {
  font-family: var(--font-mono);
}

@media (max-width: 940px) {
  .settings-dialog__form {
    grid-template-columns: 1fr;
  }

  .settings-dialog__sidebar {
    grid-row: auto;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .settings-dialog__content,
  .settings-dialog__actions {
    grid-column: auto;
  }
}

@media (max-width: 720px) {
  .settings-dialog__sidebar,
  .settings-dialog__grid,
  .settings-dialog__layout-options {
    grid-template-columns: 1fr;
  }

  .settings-dialog__section-header,
  .settings-dialog__section-actions,
  .settings-dialog__command-header,
  .settings-dialog__step-header,
  .settings-dialog__actions {
    flex-direction: column;
  }

  .settings-dialog__actions {
    align-items: stretch;
  }
}
</style>
