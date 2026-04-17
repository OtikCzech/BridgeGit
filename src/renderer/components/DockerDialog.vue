<script setup lang="ts">
import type { DockerTabActiveView } from '../../shared/bridgegit';
import DockerTabView from './DockerTabView.vue';

interface Props {
  modelValue: boolean;
  activeView: DockerTabActiveView;
  expandedGroupIds: string[];
  projectRoot: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'update:active-view': [view: DockerTabActiveView];
  'update:expanded-group-ids': [groupIds: string[]];
  'open-logs': [containerId: string, containerName: string];
}>();

function closeDialog() {
  emit('update:modelValue', false);
}
</script>

<template>
  <div
    v-if="modelValue"
    class="docker-dialog"
    @click.self="closeDialog"
  >
    <section
      class="docker-dialog__panel"
      role="dialog"
      aria-modal="true"
      aria-label="Docker"
    >
      <header class="docker-dialog__header">
        <div class="docker-dialog__heading">
          <h2 class="docker-dialog__title">Docker</h2>
        </div>

        <button
          type="button"
          class="docker-dialog__close"
          aria-label="Close Docker dialog"
          @click="closeDialog"
        >
          ×
        </button>
      </header>

      <div class="docker-dialog__body">
        <DockerTabView
          :active="modelValue"
          :active-view="props.activeView"
          :expanded-group-ids="props.expandedGroupIds"
          :project-root="projectRoot"
          @update:active-view="emit('update:active-view', $event)"
          @update:expanded-group-ids="emit('update:expanded-group-ids', $event)"
          @open-logs="(containerId, containerName) => emit('open-logs', containerId, containerName)"
        />
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.docker-dialog {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 18px;
  background: rgba(4, 7, 11, 0.72);
  backdrop-filter: blur(10px);
}

.docker-dialog__panel {
  width: min(1480px, 100%);
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid rgba(108, 124, 148, 0.2);
  border-radius: 18px;
  overflow: hidden;
  background: rgba(10, 14, 19, 0.96);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

.docker-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid rgba(108, 124, 148, 0.14);
  background: rgba(14, 19, 25, 0.98);
}

.docker-dialog__heading {
  min-width: 0;
}

.docker-dialog__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.35rem;
  line-height: 1.15;
}

.docker-dialog__close {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border: 1px solid rgba(108, 124, 148, 0.2);
  border-radius: 10px;
  background: rgba(17, 23, 31, 0.9);
  color: var(--text-primary);
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
}

.docker-dialog__close:hover {
  border-color: rgba(110, 197, 255, 0.28);
  background: rgba(24, 33, 43, 0.92);
}

.docker-dialog__body {
  min-height: 0;
}

@media (max-width: 900px) {
  .docker-dialog {
    padding: 10px;
  }

  .docker-dialog__panel {
    border-radius: 14px;
  }

  .docker-dialog__header {
    padding: 12px 14px;
  }
}
</style>
