<script setup lang="ts">
type CollapsedPanel = {
  id: 'sidebar' | 'diff' | 'terminal';
  label: string;
  shortcut: string;
};

type TerminalTabIndicator = {
  id: string;
  title: string;
  isActive: boolean;
  hasRecentActivity: boolean;
};

type RepoDockSummary = {
  changed: number;
  untracked: number;
  isClean: boolean;
};

interface Props {
  branch: string;
  repoName: string;
  changedCount: number;
  infoMessage: string;
  contentLayout: 'stacked' | 'side-by-side';
  collapsedPanels: CollapsedPanel[];
  terminalTabIndicators: TerminalTabIndicator[];
  repoDockSummary: RepoDockSummary;
}

defineProps<Props>();

defineEmits<{
  'toggle-layout': [];
  'toggle-panel': [panelId: CollapsedPanel['id']];
}>();
</script>

<template>
  <footer class="status-bar">
    <div class="status-bar__meta">
      <div class="status-bar__item">
        <span class="status-bar__dot" />
        {{ branch }}
      </div>

      <div class="status-bar__item">
        {{ repoName }}
      </div>

      <div class="status-bar__item">
        {{ changedCount }} changed
      </div>

      <div class="status-bar__item status-bar__item--path">
        {{ infoMessage }}
      </div>
    </div>

    <div class="status-bar__dock" aria-label="Collapsed panels">
      <button
        v-for="panel in collapsedPanels"
        :key="panel.id"
        class="status-bar__dock-button"
        type="button"
        :title="`Show ${panel.label} panel ${panel.shortcut}`"
        :aria-label="`Show ${panel.label} panel`"
        @click="$emit('toggle-panel', panel.id)"
      >
        <span
          v-if="panel.id === 'sidebar'"
          class="status-bar__dock-repo"
          :title="repoDockSummary.isClean
            ? 'Working tree is clean'
            : `${repoDockSummary.changed} changed / ${repoDockSummary.untracked} new`"
          aria-hidden="true"
        >
          <span
            class="status-bar__dock-dot"
            :class="{
              'status-bar__dock-dot--clean': repoDockSummary.isClean,
              'status-bar__dock-dot--repo': !repoDockSummary.isClean,
            }"
          />
          <span class="status-bar__dock-count">
            {{ repoDockSummary.changed }} / {{ repoDockSummary.untracked }}
          </span>
        </span>
        <span
          v-if="panel.id === 'terminal'"
          class="status-bar__dock-dots"
          aria-hidden="true"
        >
          <span
            v-for="tab in terminalTabIndicators"
            :key="tab.id"
            class="status-bar__dock-dot"
            :class="{
              'status-bar__dock-dot--current': tab.isActive,
              'status-bar__dock-dot--active': tab.hasRecentActivity,
            }"
            :title="tab.title"
          />
        </span>
        <span>{{ panel.label }}</span>
        <code>{{ panel.shortcut }}</code>
      </button>
    </div>

    <div class="status-bar__actions">
      <button
        class="status-bar__layout-toggle"
        type="button"
        :title="contentLayout === 'stacked' ? 'Switch right pane to side by side' : 'Switch right pane to stacked'"
        @click="$emit('toggle-layout')"
      >
        <span
          class="status-bar__layout-icon"
          :class="`status-bar__layout-icon--${contentLayout}`"
        >
          <span />
          <span />
        </span>
      </button>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.status-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 0.35rem 0.55rem;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: rgba(11, 15, 20, 0.92);
  box-shadow: var(--shadow-panel);
  color: var(--text-muted);
  font-size: 0.76rem;
}

.status-bar__meta {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.status-bar__item {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.status-bar__item--path {
  overflow: hidden;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-bar__dock {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  min-height: 1px;
  justify-self: center;
}

.status-bar__dock-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  margin: 0;
  padding: 0 0.58rem;
  border: 1px solid rgba(110, 197, 255, 0.18);
  border-radius: 10px;
  background: rgba(8, 13, 18, 0.92);
  color: var(--text-primary);
  font: inherit;
  line-height: 1;
  white-space: nowrap;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
}

.status-bar__dock-button code {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.status-bar__dock-dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.status-bar__dock-repo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-bar__dock-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: rgba(108, 124, 148, 0.48);
  flex: 0 0 auto;
}

.status-bar__dock-dot--repo {
  background: #ffb066;
  box-shadow: 0 0 10px rgba(255, 176, 102, 0.32);
}

.status-bar__dock-dot--clean {
  background: rgba(111, 224, 165, 0.72);
  box-shadow: 0 0 0 1px rgba(111, 224, 165, 0.2);
}

.status-bar__dock-dot--current {
  background: rgba(111, 224, 165, 0.72);
  box-shadow: 0 0 0 1px rgba(111, 224, 165, 0.28);
}

.status-bar__dock-dot--active {
  background: #6cb0ff;
  box-shadow: 0 0 12px rgba(108, 176, 255, 0.42);
  animation: status-bar-dock-pulse 1.4s ease-in-out infinite;
}

.status-bar__dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #6fe0a5;
  box-shadow: 0 0 12px rgba(111, 224, 165, 0.5);
}

.status-bar__dock-count {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.status-bar__layout-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: rgba(18, 24, 32, 0.92);
  color: var(--text-primary);
}

.status-bar__actions {
  display: inline-flex;
  justify-self: end;
}

.status-bar__layout-icon {
  display: grid;
  gap: 2px;
  width: 14px;
  height: 12px;
}

.status-bar__layout-icon span {
  border-radius: 2px;
  background: rgba(123, 208, 255, 0.75);
}

.status-bar__layout-icon--stacked {
  grid-template-columns: 1fr;
  grid-template-rows: repeat(2, 1fr);
}

.status-bar__layout-icon--side-by-side {
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: 1fr;
}

@keyframes status-bar-dock-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }

  50% {
    transform: scale(1.14);
    opacity: 0.82;
  }
}

@media (max-width: 860px) {
  .status-bar {
    grid-template-columns: 1fr;
    justify-items: start;
  }

  .status-bar__meta {
    flex-wrap: wrap;
  }

  .status-bar__dock {
    justify-content: flex-start;
    justify-self: start;
  }

  .status-bar__actions {
    justify-self: start;
  }
}
</style>
