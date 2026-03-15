<script setup lang="ts">
import { html as renderDiffHtml } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import { computed, ref } from 'vue';

interface Props {
  repoPath: string | null;
  viewerMode: 'working-tree' | 'commit';
  title: string;
  titleMeta?: string | null;
  hasTarget: boolean;
  diff: string;
  isLoading: boolean;
  error: string | null;
  changePosition: number;
  changeCount: number;
  canSelectPrevious: boolean;
  canSelectNext: boolean;
  canStageCurrent: boolean;
  stageActionLabel: string;
  canCollapse: boolean;
  collapseShortcutDisplay: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'select-previous': [];
  'select-next': [];
  'stage-current': [];
  'toggle-collapse': [];
}>();

const viewMode = ref<'side-by-side' | 'line-by-line'>('side-by-side');
const isCommitMode = computed(() => props.viewerMode === 'commit');
const isSideBySide = computed(() => viewMode.value === 'side-by-side');
const viewToggleTitle = computed(() => (
  isSideBySide.value ? 'Switch diff to unified view' : 'Switch diff to side by side view'
));
const collapseButtonTitle = computed(() => (
  props.canCollapse
    ? `Collapse diff panel ${props.collapseShortcutDisplay}`
    : 'Diff panel cannot be collapsed while it is the last visible panel'
));

const hasDiff = computed(() => props.diff.includes('diff --git'));
const renderedDiff = computed(() => {
  if (!hasDiff.value) {
    return '';
  }

  return renderDiffHtml(props.diff, {
    colorScheme: ColorSchemeType.DARK,
    drawFileList: false,
    matching: 'lines',
    outputFormat: viewMode.value,
  });
});

function toggleViewMode() {
  viewMode.value = isSideBySide.value ? 'line-by-line' : 'side-by-side';
}
</script>

<template>
  <section class="diff-viewer">
    <header class="diff-viewer__header">
      <div class="diff-viewer__heading">
        <span class="diff-viewer__eyebrow">
          {{ isCommitMode ? 'Commit Diff' : 'Diff Viewer' }}
        </span>
        <h2 class="diff-viewer__title">{{ title }}</h2>
        <p v-if="titleMeta" class="diff-viewer__title-meta">
          {{ titleMeta }}
        </p>
      </div>

      <div v-if="!isCommitMode" class="diff-viewer__navigator">
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
          {{ changeCount ? `${changePosition} / ${changeCount}` : '0 / 0' }}
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

        <button
          class="diff-viewer__stage"
          type="button"
          :disabled="!canStageCurrent"
          @click="emit('stage-current')"
        >
          {{ stageActionLabel }}
        </button>
      </div>

      <div class="diff-viewer__toolbar">
        <button
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
          class="diff-viewer__icon-button"
          type="button"
          :disabled="!canCollapse"
          :title="collapseButtonTitle"
          aria-label="Collapse diff panel"
          @click="emit('toggle-collapse')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.75 11.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H6.75Z" />
          </svg>
        </button>
      </div>
    </header>

    <div v-if="error" class="diff-viewer__meta">
      <span v-if="error" class="diff-viewer__badge diff-viewer__badge--remove">
        {{ error }}
      </span>
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

    <div v-else class="diff-viewer__rendered" v-html="renderedDiff" />
  </section>
</template>

<style scoped lang="scss">
.diff-viewer {
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 16px;
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
  grid-template-columns: minmax(0, 1fr) auto auto;
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
  min-width: 52px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  text-align: center;
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

.diff-viewer__icon-button--view-toggle {
  color: rgba(123, 208, 255, 0.9);
}

.diff-viewer__stage {
  padding: 0.55rem 0.78rem;
  font-size: 0.78rem;
  font-weight: 600;
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

:deep(.d2h-wrapper) {
  color: var(--text-primary);
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
