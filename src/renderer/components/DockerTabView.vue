<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  DockerContainerInfo,
  DockerImageInfo,
  DockerTabActiveView,
} from '../../shared/bridgegit';

interface Props {
  active: boolean;
  activeView: DockerTabActiveView;
  expandedGroupIds: string[];
  projectRoot: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:active-view': [view: DockerTabActiveView];
  'update:expanded-group-ids': [groupIds: string[]];
  'open-logs': [containerId: string, containerName: string];
}>();

const REFRESH_INTERVAL_MS = 3_000;

const containers = ref<DockerContainerInfo[]>([]);
const images = ref<DockerImageInfo[]>([]);
const loading = ref(false);
const lastError = ref<string | null>(null);
const dockerAvailable = ref<boolean | null>(null);
const composeBusy = ref<'up' | 'down' | 'restart' | null>(null);
const containerBusyId = ref<string | null>(null);
const containerGroupBusyId = ref<string | null>(null);
const imageBusyId = ref<string | null>(null);
const hasComposeFile = ref(false);
let refreshTimer: number | null = null;
const STANDALONE_GROUP_ID = '__standalone__';

const composeProjects = computed(() => {
  const groups = new Map<string, DockerContainerInfo[]>();
  const standalone: DockerContainerInfo[] = [];

  for (const container of containers.value) {
    if (container.compose) {
      const groupId = container.compose.project;
      const existing = groups.get(groupId);
      if (existing) {
        existing.push(container);
      } else {
        groups.set(groupId, [container]);
      }
    } else {
      standalone.push(container);
    }
  }

  return {
    groups: Array.from(groups.entries()).map(([project, items]) => ({ project, items })),
    standalone,
  };
});

const totalContainers = computed(() => containers.value.length);
const runningContainers = computed(() => containers.value.filter((c) => c.state === 'running').length);

function getContainerGroupState(groupContainers: DockerContainerInfo[]) {
  const totalCount = groupContainers.length;
  const runningCount = groupContainers.filter((container) => container.state === 'running').length;

  if (runningCount === totalCount && totalCount > 0) {
    return {
      tone: 'running' as const,
      label: 'running',
      title: `All ${totalCount} containers are running`,
    };
  }

  if (runningCount === 0) {
    return {
      tone: 'stopped' as const,
      label: 'stopped',
      title: totalCount === 1 ? 'Container is stopped' : `All ${totalCount} containers are stopped`,
    };
  }

  return {
    tone: 'mixed' as const,
    label: `${runningCount}/${totalCount} running`,
    title: `${runningCount} of ${totalCount} containers are running`,
  };
}

function isContainerGroupExpanded(groupId: string) {
  return props.expandedGroupIds.includes(groupId);
}

function toggleContainerGroup(groupId: string) {
  emit(
    'update:expanded-group-ids',
    isContainerGroupExpanded(groupId)
      ? props.expandedGroupIds.filter((id) => id !== groupId)
      : [...props.expandedGroupIds, groupId],
  );
}

async function loadAvailability() {
  try {
    dockerAvailable.value = await window.bridgegit?.docker.available() ?? false;
  } catch {
    dockerAvailable.value = false;
  }
}

async function refreshData(silent = false) {
  if (!window.bridgegit?.docker || dockerAvailable.value === false) {
    return;
  }

  if (!silent) {
    loading.value = true;
  }

  try {
    if (props.activeView === 'containers') {
      containers.value = await window.bridgegit.docker.containers();
    } else {
      images.value = await window.bridgegit.docker.images();
    }
    lastError.value = null;
  } catch (error) {
    lastError.value = formatError(error);
  } finally {
    loading.value = false;
  }
}

async function checkComposeFile() {
  if (!props.projectRoot || !window.bridgegit?.git) {
    hasComposeFile.value = false;
    return;
  }

  try {
    const entries = await window.bridgegit.git.listDirectory(props.projectRoot, '');
    hasComposeFile.value = entries.some((entry) =>
      entry.kind === 'file' && /^(docker-)?compose\.ya?ml$/i.test(entry.name)
    );
  } catch {
    hasComposeFile.value = false;
  }
}

function startPolling() {
  stopPolling();
  refreshTimer = window.setInterval(() => {
    refreshData(true);
  }, REFRESH_INTERVAL_MS);
}

function stopPolling() {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

function setActiveView(view: DockerTabActiveView) {
  if (view !== props.activeView) {
    emit('update:active-view', view);
  }
}

async function handleContainerAction(
  container: DockerContainerInfo,
  action: 'start' | 'stop' | 'restart' | 'remove',
) {
  if (!window.bridgegit?.docker) return;

  if (action === 'remove' && !window.confirm(`Remove container "${container.name}"?`)) {
    return;
  }

  containerBusyId.value = container.id;
  try {
    await window.bridgegit.docker.containerAction(container.id, action);
    await refreshData(true);
  } catch (error) {
    lastError.value = formatError(error);
  } finally {
    containerBusyId.value = null;
  }
}

async function handleContainerGroupAction(
  groupId: string,
  groupContainers: DockerContainerInfo[],
  action: 'start' | 'stop' | 'restart',
) {
  if (!window.bridgegit?.docker || groupContainers.length === 0) return;

  const eligibleContainers = groupContainers.filter((container) => {
    if (action === 'start') {
      return container.state !== 'running';
    }

    if (action === 'stop') {
      return container.state === 'running';
    }

    return container.state === 'running';
  });

  if (eligibleContainers.length === 0) {
    return;
  }

  containerGroupBusyId.value = groupId;
  try {
    for (const container of eligibleContainers) {
      await window.bridgegit.docker.containerAction(container.id, action);
    }
    await refreshData(true);
  } catch (error) {
    lastError.value = formatError(error);
  } finally {
    containerGroupBusyId.value = null;
  }
}

async function handleRemoveImage(image: DockerImageInfo) {
  if (!window.bridgegit?.docker) return;

  const label = `${image.repository}:${image.tag}`;
  if (!window.confirm(`Remove image "${label}"?`)) {
    return;
  }

  imageBusyId.value = image.id;
  try {
    await window.bridgegit.docker.removeImage(image.id);
    await refreshData(true);
  } catch (error) {
    lastError.value = formatError(error);
  } finally {
    imageBusyId.value = null;
  }
}

async function handleCompose(action: 'up' | 'down' | 'restart') {
  if (!window.bridgegit?.docker || !props.projectRoot) return;

  composeBusy.value = action;
  try {
    if (action === 'up') {
      await window.bridgegit.docker.composeUp(props.projectRoot);
    } else if (action === 'down') {
      await window.bridgegit.docker.composeDown(props.projectRoot);
    } else {
      await window.bridgegit.docker.composeRestart(props.projectRoot);
    }
    await refreshData(true);
  } catch (error) {
    lastError.value = formatError(error);
  } finally {
    composeBusy.value = null;
  }
}

function handleOpenLogs(container: DockerContainerInfo) {
  emit('open-logs', container.id, container.name);
}

async function handleRetryDetection() {
  if (!window.bridgegit?.docker) return;
  await window.bridgegit.docker.resetBackend();
  dockerAvailable.value = null;
  await loadAvailability();
  if (dockerAvailable.value) {
    await refreshData(false);
  }
}

watch(() => props.active, (isActive) => {
  if (isActive) {
    refreshData(false);
    checkComposeFile();
    startPolling();
  } else {
    stopPolling();
  }
});

watch(() => props.activeView, () => {
  refreshData(false);
});

watch(() => props.projectRoot, () => {
  checkComposeFile();
});

onMounted(async () => {
  await loadAvailability();
  if (props.active) {
    await refreshData(false);
    await checkComposeFile();
    startPolling();
  }
});

onBeforeUnmount(() => {
  stopPolling();
});
</script>

<template>
  <div class="docker-tab" :class="{ 'docker-tab--inactive': !active }">
    <header class="docker-tab__header">
      <div class="docker-tab__view-switch">
        <button
          type="button"
          class="docker-tab__view-tab"
          :class="{ 'docker-tab__view-tab--active': activeView === 'containers' }"
          @click="setActiveView('containers')"
        >
          Containers
          <span v-if="dockerAvailable" class="docker-tab__view-count">
            {{ runningContainers }}/{{ totalContainers }}
          </span>
        </button>
        <button
          type="button"
          class="docker-tab__view-tab"
          :class="{ 'docker-tab__view-tab--active': activeView === 'images' }"
          @click="setActiveView('images')"
        >
          Images
        </button>
      </div>

      <div class="docker-tab__header-actions">
        <button
          type="button"
          class="docker-tab__icon-button"
          :disabled="loading"
          title="Refresh"
          @click="refreshData(false)"
        >
          ↻
        </button>
      </div>
    </header>

    <div v-if="dockerAvailable === false" class="docker-tab__notice docker-tab__notice--warning">
      <p>Docker is not available.</p>
      <p class="docker-tab__notice-hint">Install Docker Desktop or run Docker in WSL.</p>
      <button type="button" class="docker-tab__button" @click="handleRetryDetection">
        Retry detection
      </button>
    </div>

    <div v-else-if="lastError" class="docker-tab__notice docker-tab__notice--error">
      <p>{{ lastError }}</p>
      <button type="button" class="docker-tab__button" @click="refreshData(false)">
        Retry
      </button>
    </div>

    <div v-if="dockerAvailable && activeView === 'containers'" class="docker-tab__content">
      <section
        v-if="hasComposeFile && projectRoot"
        class="docker-tab__compose-bar"
      >
        <span class="docker-tab__compose-label">docker-compose</span>
        <div class="docker-tab__compose-actions">
          <button
            type="button"
            class="docker-tab__button docker-tab__button--primary"
            :disabled="composeBusy !== null"
            @click="handleCompose('up')"
          >
            <span v-if="composeBusy === 'up'">…</span>
            <span v-else>▶ Up</span>
          </button>
          <button
            type="button"
            class="docker-tab__button"
            :disabled="composeBusy !== null"
            @click="handleCompose('restart')"
          >
            <span v-if="composeBusy === 'restart'">…</span>
            <span v-else>♻ Restart</span>
          </button>
          <button
            type="button"
            class="docker-tab__button docker-tab__button--danger"
            :disabled="composeBusy !== null"
            @click="handleCompose('down')"
          >
            <span v-if="composeBusy === 'down'">…</span>
            <span v-else>▼ Down</span>
          </button>
        </div>
      </section>

      <div v-if="containers.length === 0 && !loading" class="docker-tab__empty">
        No containers found.
      </div>

      <div v-else class="docker-tab__table-wrapper">
        <table class="docker-tab__table">
          <thead>
            <tr>
              <th class="docker-tab__col-state"></th>
              <th class="docker-tab__col-name">Name</th>
              <th class="docker-tab__col-image">Image</th>
              <th class="docker-tab__col-status">Status</th>
              <th class="docker-tab__col-ports">Ports</th>
              <th class="docker-tab__col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            <template
              v-for="group in composeProjects.groups"
              :key="`group-${group.project}`"
            >
              <tr class="docker-tab__group-header">
                <td colspan="6">
                  <div class="docker-tab__group-bar">
                    <button
                      type="button"
                      class="docker-tab__group-toggle"
                      :aria-expanded="isContainerGroupExpanded(group.project)"
                      @click="toggleContainerGroup(group.project)"
                    >
                      <span class="docker-tab__group-chevron">
                        {{ isContainerGroupExpanded(group.project) ? '▾' : '▸' }}
                      </span>
                      <span class="docker-tab__group-icon">⛁</span>
                      <span class="docker-tab__group-name">{{ group.project }}</span>
                      <span class="docker-tab__group-count">{{ group.items.length }}</span>
                      <span
                        class="docker-tab__group-state"
                        :class="`docker-tab__group-state--${getContainerGroupState(group.items).tone}`"
                        :title="getContainerGroupState(group.items).title"
                      >
                        {{ getContainerGroupState(group.items).label }}
                      </span>
                    </button>

                    <div class="docker-tab__group-actions">
                      <button
                        type="button"
                        class="docker-tab__icon-button"
                        :disabled="containerGroupBusyId === group.project"
                        title="Start all"
                        @click.stop="handleContainerGroupAction(group.project, group.items, 'start')"
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        class="docker-tab__icon-button"
                        :disabled="containerGroupBusyId === group.project"
                        title="Stop all"
                        @click.stop="handleContainerGroupAction(group.project, group.items, 'stop')"
                      >
                        ⏹
                      </button>
                      <button
                        type="button"
                        class="docker-tab__icon-button"
                        :disabled="containerGroupBusyId === group.project"
                        title="Restart all"
                        @click.stop="handleContainerGroupAction(group.project, group.items, 'restart')"
                      >
                        ♻
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
              <tr
                v-if="isContainerGroupExpanded(group.project)"
                v-for="container in group.items"
                :key="container.id"
                class="docker-tab__row docker-tab__row--grouped"
              >
                <td class="docker-tab__col-state">
                  <span
                    class="docker-tab__state-dot"
                    :class="`docker-tab__state-dot--${container.state}`"
                    :title="container.state"
                  />
                </td>
                <td class="docker-tab__col-name">
                  <span class="docker-tab__name">{{ container.name }}</span>
                  <span v-if="container.compose" class="docker-tab__service">
                    {{ container.compose.service }}
                  </span>
                </td>
                <td class="docker-tab__col-image" :title="container.image">{{ container.image }}</td>
                <td class="docker-tab__col-status">{{ container.status }}</td>
                <td class="docker-tab__col-ports" :title="container.ports">{{ container.ports }}</td>
                <td class="docker-tab__col-actions">
                  <button
                    v-if="container.state === 'running'"
                    type="button"
                    class="docker-tab__icon-button"
                    :disabled="containerBusyId === container.id"
                    title="Stop"
                    @click="handleContainerAction(container, 'stop')"
                  >
                    ⏹
                  </button>
                  <button
                    v-else
                    type="button"
                    class="docker-tab__icon-button"
                    :disabled="containerBusyId === container.id"
                    title="Start"
                    @click="handleContainerAction(container, 'start')"
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    class="docker-tab__icon-button"
                    :disabled="containerBusyId === container.id || container.state !== 'running'"
                    title="Restart"
                    @click="handleContainerAction(container, 'restart')"
                  >
                    ♻
                  </button>
                  <button
                    type="button"
                    class="docker-tab__icon-button"
                    title="Logs"
                    @click="handleOpenLogs(container)"
                  >
                    ☰
                  </button>
                  <button
                    type="button"
                    class="docker-tab__icon-button docker-tab__icon-button--danger"
                    :disabled="containerBusyId === container.id"
                    title="Remove"
                    @click="handleContainerAction(container, 'remove')"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            </template>

            <template v-if="composeProjects.standalone.length > 0">
              <tr class="docker-tab__group-header">
                <td colspan="6">
                  <div class="docker-tab__group-bar">
                    <button
                      type="button"
                      class="docker-tab__group-toggle"
                      :aria-expanded="isContainerGroupExpanded(STANDALONE_GROUP_ID)"
                      @click="toggleContainerGroup(STANDALONE_GROUP_ID)"
                    >
                      <span class="docker-tab__group-chevron">
                        {{ isContainerGroupExpanded(STANDALONE_GROUP_ID) ? '▾' : '▸' }}
                      </span>
                      <span class="docker-tab__group-icon">○</span>
                      <span class="docker-tab__group-name">Standalone</span>
                      <span class="docker-tab__group-count">{{ composeProjects.standalone.length }}</span>
                      <span
                        class="docker-tab__group-state"
                        :class="`docker-tab__group-state--${getContainerGroupState(composeProjects.standalone).tone}`"
                        :title="getContainerGroupState(composeProjects.standalone).title"
                      >
                        {{ getContainerGroupState(composeProjects.standalone).label }}
                      </span>
                    </button>

                    <div class="docker-tab__group-actions">
                      <button
                        type="button"
                        class="docker-tab__icon-button"
                        :disabled="containerGroupBusyId === STANDALONE_GROUP_ID"
                        title="Start all"
                        @click.stop="handleContainerGroupAction(STANDALONE_GROUP_ID, composeProjects.standalone, 'start')"
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        class="docker-tab__icon-button"
                        :disabled="containerGroupBusyId === STANDALONE_GROUP_ID"
                        title="Stop all"
                        @click.stop="handleContainerGroupAction(STANDALONE_GROUP_ID, composeProjects.standalone, 'stop')"
                      >
                        ⏹
                      </button>
                      <button
                        type="button"
                        class="docker-tab__icon-button"
                        :disabled="containerGroupBusyId === STANDALONE_GROUP_ID"
                        title="Restart all"
                        @click.stop="handleContainerGroupAction(STANDALONE_GROUP_ID, composeProjects.standalone, 'restart')"
                      >
                        ♻
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
              <tr
                v-if="isContainerGroupExpanded(STANDALONE_GROUP_ID)"
                v-for="container in composeProjects.standalone"
                :key="container.id"
                class="docker-tab__row docker-tab__row--grouped"
              >
                <td class="docker-tab__col-state">
                  <span
                    class="docker-tab__state-dot"
                    :class="`docker-tab__state-dot--${container.state}`"
                    :title="container.state"
                  />
                </td>
                <td class="docker-tab__col-name">
                  <span class="docker-tab__name">{{ container.name }}</span>
                </td>
                <td class="docker-tab__col-image" :title="container.image">{{ container.image }}</td>
                <td class="docker-tab__col-status">{{ container.status }}</td>
                <td class="docker-tab__col-ports" :title="container.ports">{{ container.ports }}</td>
                <td class="docker-tab__col-actions">
                  <button
                    v-if="container.state === 'running'"
                    type="button"
                    class="docker-tab__icon-button"
                    :disabled="containerBusyId === container.id"
                    title="Stop"
                    @click="handleContainerAction(container, 'stop')"
                  >
                    ⏹
                  </button>
                  <button
                    v-else
                    type="button"
                    class="docker-tab__icon-button"
                    :disabled="containerBusyId === container.id"
                    title="Start"
                    @click="handleContainerAction(container, 'start')"
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    class="docker-tab__icon-button"
                    :disabled="containerBusyId === container.id || container.state !== 'running'"
                    title="Restart"
                    @click="handleContainerAction(container, 'restart')"
                  >
                    ♻
                  </button>
                  <button
                    type="button"
                    class="docker-tab__icon-button"
                    title="Logs"
                    @click="handleOpenLogs(container)"
                  >
                    ☰
                  </button>
                  <button
                    type="button"
                    class="docker-tab__icon-button docker-tab__icon-button--danger"
                    :disabled="containerBusyId === container.id"
                    title="Remove"
                    @click="handleContainerAction(container, 'remove')"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="dockerAvailable && activeView === 'images'" class="docker-tab__content">
      <div v-if="images.length === 0 && !loading" class="docker-tab__empty">
        No images found.
      </div>

      <div v-else class="docker-tab__table-wrapper">
        <table class="docker-tab__table">
          <thead>
            <tr>
              <th class="docker-tab__col-name">Repository</th>
              <th class="docker-tab__col-tag">Tag</th>
              <th class="docker-tab__col-id">ID</th>
              <th class="docker-tab__col-size">Size</th>
              <th class="docker-tab__col-created">Created</th>
              <th class="docker-tab__col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="image in images"
              :key="image.id"
              class="docker-tab__row"
            >
              <td class="docker-tab__col-name" :title="image.repository">{{ image.repository }}</td>
              <td class="docker-tab__col-tag">{{ image.tag }}</td>
              <td class="docker-tab__col-id">{{ image.id }}</td>
              <td class="docker-tab__col-size">{{ image.size }}</td>
              <td class="docker-tab__col-created">{{ image.created }}</td>
              <td class="docker-tab__col-actions">
                <button
                  type="button"
                  class="docker-tab__icon-button docker-tab__icon-button--danger"
                  :disabled="imageBusyId === image.id"
                  title="Remove"
                  @click="handleRemoveImage(image)"
                >
                  ✕
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.docker-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--app-background);
  color: var(--text-primary);
  font-family: var(--font-family-monospace, monospace);
  font-size: 13px;
  overflow: hidden;

  &--inactive {
    pointer-events: none;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    background: var(--panel-background, rgba(0, 0, 0, 0.15));
    flex: 0 0 auto;
  }

  &__view-switch {
    display: flex;
    gap: 4px;
  }

  &__view-tab {
    background: transparent;
    border: none;
    color: var(--text-secondary, rgba(255, 255, 255, 0.6));
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    gap: 6px;

    &:hover {
      background: var(--hover-background, rgba(255, 255, 255, 0.06));
      color: var(--text-primary);
    }

    &--active {
      background: var(--accent-background, rgba(64, 158, 255, 0.15));
      color: var(--text-primary);
    }
  }

  &__view-count {
    font-size: 11px;
    opacity: 0.7;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.08);
  }

  &__header-actions {
    display: flex;
    gap: 4px;
  }

  &__notice {
    margin: 16px;
    padding: 16px;
    border-radius: 6px;
    background: var(--panel-background, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));

    p {
      margin: 0 0 8px 0;
    }

    &--warning {
      border-color: rgba(255, 180, 50, 0.4);
    }

    &--error {
      border-color: rgba(255, 80, 80, 0.4);
      color: var(--text-primary);
    }
  }

  &__notice-hint {
    font-size: 12px;
    opacity: 0.7;
  }

  &__content {
    flex: 1 1 auto;
    overflow: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__compose-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--panel-background, rgba(0, 0, 0, 0.15));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    border-radius: 6px;
    flex: 0 0 auto;
  }

  &__compose-label {
    font-size: 12px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  &__compose-actions {
    display: flex;
    gap: 6px;
  }

  &__empty {
    padding: 32px;
    text-align: center;
    opacity: 0.5;
    font-style: italic;
  }

  &__table-wrapper {
    flex: 1 1 auto;
    overflow: auto;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    border-radius: 6px;
  }

  &__table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;

    th, td {
      padding: 6px 10px;
      text-align: left;
      border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.05));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 0;
    }

    th {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
      background: var(--panel-background, rgba(0, 0, 0, 0.1));
      position: sticky;
      top: 0;
      z-index: 1;
    }
  }

  &__row {
    &:hover {
      background: var(--hover-background, rgba(255, 255, 255, 0.04));
    }
  }

  &__row--grouped .docker-tab__col-state {
    position: relative;
    padding-left: 18px;
  }

  &__row--grouped .docker-tab__col-state::before {
    content: '';
    position: absolute;
    left: 8px;
    top: 50%;
    width: 6px;
    height: 1px;
    background: rgba(148, 163, 184, 0.5);
    transform: translateY(-50%);
  }

  &__row:hover &__col-actions {
    background: var(--hover-background, rgba(255, 255, 255, 0.04));
  }

  &__group-header {
    background: var(--panel-background, rgba(0, 0, 0, 0.2));

    td {
      padding: 8px 10px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.85;
      max-width: none;
      white-space: nowrap;
    }
  }

  &__group-toggle {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;

    &:hover {
      color: var(--text-primary);
    }
  }

  &__group-bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__group-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }

  &__group-chevron {
    width: 14px;
    margin-right: 6px;
    opacity: 0.75;
    text-align: center;
  }

  &__group-icon {
    margin-right: 8px;
    opacity: 0.6;
  }

  &__group-name {
    margin-right: 8px;
  }

  &__group-count {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.08);
    opacity: 0.7;
  }

  &__group-state {
    margin-left: 8px;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10px;
    line-height: 1.2;
    letter-spacing: 0.04em;
    text-transform: none;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(148, 163, 184, 0.12);
    color: rgba(226, 232, 240, 0.88);
  }

  &__group-state--running {
    border-color: rgba(52, 211, 153, 0.26);
    background: rgba(52, 211, 153, 0.12);
    color: rgba(167, 243, 208, 0.94);
  }

  &__group-state--stopped {
    border-color: rgba(148, 163, 184, 0.2);
    background: rgba(71, 85, 105, 0.18);
    color: rgba(203, 213, 225, 0.88);
  }

  &__group-state--mixed {
    border-color: rgba(251, 191, 36, 0.26);
    background: rgba(251, 191, 36, 0.12);
    color: rgba(253, 230, 138, 0.94);
  }

  &__col-state {
    width: 24px;
    max-width: 24px;
    text-align: center;
  }

  &__col-actions {
    width: 154px;
    min-width: 154px;
    max-width: 154px;
    white-space: nowrap;
    text-align: right;
    position: sticky;
    right: 0;
    z-index: 2;
    background: var(--app-background);
  }

  &__col-name {
    width: 24%;
    min-width: 120px;
  }

  &__col-image {
    width: 24%;
    min-width: 140px;
  }

  &__col-status {
    width: 18%;
    min-width: 110px;
  }

  &__col-ports {
    width: 18%;
    min-width: 110px;
  }

  &__col-tag,
  &__col-id,
  &__col-size,
  &__col-created {
    min-width: 72px;
  }

  th.docker-tab__col-actions {
    z-index: 3;
    background: var(--panel-background, rgba(0, 0, 0, 0.1));
  }

  &__state-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-secondary, rgba(255, 255, 255, 0.4));

    &--running {
      background: #4ade80;
      box-shadow: 0 0 6px rgba(74, 222, 128, 0.5);
    }

    &--exited,
    &--dead {
      background: #94a3b8;
    }

    &--paused {
      background: #facc15;
    }

    &--restarting,
    &--created,
    &--removing {
      background: #60a5fa;
    }
  }

  &__name {
    font-weight: 500;
  }

  &__service {
    margin-left: 8px;
    font-size: 11px;
    opacity: 0.6;
  }

  &__button {
    background: var(--button-background, rgba(255, 255, 255, 0.06));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    color: var(--text-primary);
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;

    &:hover:not(:disabled) {
      background: var(--hover-background, rgba(255, 255, 255, 0.1));
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    &--primary {
      background: var(--accent-background, rgba(64, 158, 255, 0.2));
      border-color: var(--accent-color, rgba(64, 158, 255, 0.4));
    }

    &--danger {
      background: rgba(255, 80, 80, 0.15);
      border-color: rgba(255, 80, 80, 0.3);
    }
  }

  &__icon-button {
    background: transparent;
    border: none;
    color: var(--text-secondary, rgba(255, 255, 255, 0.6));
    width: 26px;
    height: 26px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    margin: 0 1px;

    &:hover:not(:disabled) {
      background: var(--hover-background, rgba(255, 255, 255, 0.08));
      color: var(--text-primary);
    }

    &:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    &--danger:hover:not(:disabled) {
      background: rgba(255, 80, 80, 0.15);
      color: #ff8080;
    }
  }
}
</style>
