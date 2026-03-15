<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { GitLogEntry } from '../../shared/bridgegit';
import { SHORTCUTS, matchesShortcut } from '../shortcuts';
import GitHistoryGraph from './GitHistoryGraph.vue';

interface Props {
  modelValue: boolean;
  commits: GitLogEntry[];
  currentBranch: string;
  repoPath: string | null;
  isLoading: boolean;
  focusSearchToken?: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'open-diff': [commit: GitLogEntry];
}>();

const selectedCommitHash = ref<string | null>(null);
const searchQuery = ref('');
const activeMatchIndex = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);

function closeDialog() {
  emit('update:modelValue', false);
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function commitMatchesQuery(commit: GitLogEntry, query: string): boolean {
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) {
    return false;
  }

  const haystack = [
    commit.message,
    commit.shortHash,
    commit.hash,
    commit.authorName,
    ...commit.refs.map((ref) => ref.shortName),
  ]
    .join('\n')
    .toLocaleLowerCase();

  return haystack.includes(normalizedQuery);
}

const matchingCommits = computed(() => {
  const query = normalizeSearchValue(searchQuery.value);

  if (!query) {
    return [];
  }

  return props.commits.filter((commit) => commitMatchesQuery(commit, query));
});

const matchingHashes = computed(() => matchingCommits.value.map((commit) => commit.hash));
const selectedCommit = computed(() => (
  props.commits.find((commit) => commit.hash === selectedCommitHash.value) ?? null
));

async function selectMatch(index: number) {
  if (!matchingCommits.value.length) {
    return;
  }

  const normalizedIndex = ((index % matchingCommits.value.length) + matchingCommits.value.length)
    % matchingCommits.value.length;

  activeMatchIndex.value = normalizedIndex;
  selectedCommitHash.value = matchingCommits.value[normalizedIndex]?.hash ?? null;
  await nextTick();
}

function focusSearch() {
  searchInput.value?.focus();
  searchInput.value?.select();
}

function openSelectedCommitDiff() {
  if (!selectedCommit.value) {
    return;
  }

  emit('open-diff', selectedCommit.value);
}

function handleOpenCommitHash(commitHash: string) {
  selectedCommitHash.value = commitHash;
  const commit = props.commits.find((item) => item.hash === commitHash);

  if (!commit) {
    return;
  }

  emit('open-diff', commit);
}

async function selectFirstMatch() {
  if (!matchingCommits.value.length) {
    return;
  }

  await selectMatch(0);
}

async function goToNextMatch() {
  if (!matchingCommits.value.length) {
    return;
  }

  await selectMatch(activeMatchIndex.value + 1);
}

async function goToPreviousMatch() {
  if (!matchingCommits.value.length) {
    return;
  }

  await selectMatch(activeMatchIndex.value - 1);
}

async function handleSearchKeydown(event: KeyboardEvent) {
  if (matchesShortcut(event, SHORTCUTS.commitOpenDiff)) {
    event.preventDefault();
    openSelectedCommitDiff();
    return;
  }

  if (event.key !== 'Enter') {
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }

  event.preventDefault();

  if (event.shiftKey) {
    await goToPreviousMatch();
    return;
  }

  await goToNextMatch();
}

async function handleGlobalKeydown(event: KeyboardEvent) {
  if (!props.modelValue) {
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.commitOpenDiff)) {
    event.preventDefault();
    openSelectedCommitDiff();
    return;
  }

  if (matchesShortcut(event, SHORTCUTS.historySearch)) {
    event.preventDefault();
    focusSearch();
    return;
  }

  if (event.key === 'Enter' && normalizeSearchValue(searchQuery.value)) {
    const target = event.target;

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return;
    }

    event.preventDefault();

    if (event.shiftKey) {
      await goToPreviousMatch();
      return;
    }

    await goToNextMatch();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown, true);
});

watch(
  () => props.commits,
  (nextCommits) => {
    if (!nextCommits.length) {
      selectedCommitHash.value = null;
      return;
    }

    const hasSelection = nextCommits.some((commit) => commit.hash === selectedCommitHash.value);

    if (!hasSelection) {
      selectedCommitHash.value = nextCommits[0]?.hash ?? null;
    }
  },
  { immediate: true },
);

watch(
  matchingCommits,
  async (nextMatches) => {
    if (!nextMatches.length) {
      activeMatchIndex.value = 0;
      return;
    }

    const selectedIndex = nextMatches.findIndex((commit) => commit.hash === selectedCommitHash.value);

    if (selectedIndex >= 0) {
      activeMatchIndex.value = selectedIndex;
      return;
    }

    await selectFirstMatch();
  },
  { immediate: true },
);

watch(
  () => selectedCommitHash.value,
  (nextHash) => {
    if (!nextHash || !matchingCommits.value.length) {
      return;
    }

    const selectedIndex = matchingCommits.value.findIndex((commit) => commit.hash === nextHash);

    if (selectedIndex >= 0) {
      activeMatchIndex.value = selectedIndex;
    }
  },
);

watch(
  () => props.modelValue,
  async (isOpen) => {
    if (!isOpen) {
      return;
    }

    selectedCommitHash.value = props.commits[0]?.hash ?? null;
    await nextTick();
    focusSearch();
  },
);

watch(
  () => props.focusSearchToken,
  async (nextToken, previousToken) => {
    if (!props.modelValue || !nextToken || nextToken === previousToken) {
      return;
    }

    await nextTick();
    focusSearch();
  },
);
</script>

<template>
  <teleport to="body">
    <div
      v-if="modelValue"
      class="commit-history-dialog"
      role="presentation"
      @click.self="closeDialog"
    >
      <section
        class="commit-history-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Commit history"
      >
        <header class="commit-history-dialog__header">
          <div class="commit-history-dialog__heading">
            <p class="commit-history-dialog__eyebrow">Repository History</p>
            <h2 class="commit-history-dialog__title">All Branches</h2>
            <p class="commit-history-dialog__meta">
              {{ commits.length.toLocaleString() }} commits
              <span v-if="currentBranch">current: {{ currentBranch }}</span>
              <span v-if="repoPath">{{ repoPath }}</span>
            </p>
          </div>

          <button
            class="commit-history-dialog__close"
            type="button"
            aria-label="Close commit history"
            @click="closeDialog"
          >
            ×
          </button>
        </header>

        <div class="commit-history-dialog__search">
          <label class="commit-history-dialog__search-field">
            <span class="commit-history-dialog__search-label">
              Search
              <span
                class="commit-history-dialog__search-shortcut"
                title="Keyboard shortcut"
              >
                {{ SHORTCUTS.historySearch.display }}
              </span>
            </span>
            <input
              ref="searchInput"
              v-model="searchQuery"
              class="commit-history-dialog__search-input"
              type="text"
              placeholder="message, hash, author, branch"
              @keydown="handleSearchKeydown"
            >
          </label>

          <div class="commit-history-dialog__search-meta">
            <span class="commit-history-dialog__search-count">
              <template v-if="searchQuery.trim()">
                <span v-if="matchingCommits.length">
                  {{ activeMatchIndex + 1 }} / {{ matchingCommits.length }}
                </span>
                <span v-else>
                  0 matches
                </span>
              </template>
            </span>

            <button
              class="commit-history-dialog__search-action"
              type="button"
              :disabled="matchingCommits.length < 1"
              title="Previous match [Shift+Enter]"
              @click="goToPreviousMatch"
            >
              ↑
            </button>

            <button
              class="commit-history-dialog__search-action"
              type="button"
              :disabled="matchingCommits.length < 1"
              title="Next match [Enter]"
              @click="goToNextMatch"
            >
              ↓
            </button>
          </div>
        </div>

        <div class="commit-history-dialog__body">
          <div v-if="isLoading && !commits.length" class="commit-history-dialog__loading">
            Loading commits...
          </div>

          <GitHistoryGraph
            v-else
            :commits="commits"
            :matched-hashes="matchingHashes"
            :selected-hash="selectedCommitHash"
            fill
            @select="selectedCommitHash = $event"
            @open-diff="handleOpenCommitHash"
          />
        </div>
      </section>
    </div>
  </teleport>
</template>

<style scoped lang="scss">
.commit-history-dialog {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgba(3, 5, 8, 0.68);
  backdrop-filter: blur(10px);
  z-index: 130;
}

.commit-history-dialog__panel {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 16px;
  width: min(1180px, 100%);
  height: min(860px, calc(100vh - 56px));
  min-height: 520px;
  padding: 18px;
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background:
    linear-gradient(160deg, rgba(69, 151, 250, 0.08), transparent 36%),
    rgba(10, 14, 19, 0.98);
  box-shadow: 0 26px 80px rgba(0, 0, 0, 0.46);
}

.commit-history-dialog__header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
}

.commit-history-dialog__heading {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.commit-history-dialog__eyebrow {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.commit-history-dialog__title {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 1.12rem;
}

.commit-history-dialog__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
  color: var(--text-muted);
  font-size: 0.78rem;
}

.commit-history-dialog__close {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(16, 22, 29, 0.92);
  color: var(--text-primary);
  font-size: 1.15rem;
  line-height: 1;
}

.commit-history-dialog__body {
  display: grid;
  min-height: 0;
  overflow: hidden;
}

.commit-history-dialog__search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.commit-history-dialog__search-field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.commit-history-dialog__search-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.commit-history-dialog__search-shortcut {
  color: inherit;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.04em;
}

.commit-history-dialog__search-input {
  width: 100%;
  min-width: 0;
  padding: 0.7rem 0.82rem;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: rgba(11, 16, 22, 0.92);
  color: var(--text-primary);
  font: inherit;
}

.commit-history-dialog__search-input:focus {
  outline: none;
  border-color: rgba(110, 197, 255, 0.4);
  box-shadow: 0 0 0 1px rgba(110, 197, 255, 0.18);
}

.commit-history-dialog__search-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.commit-history-dialog__search-count {
  min-width: 72px;
  color: var(--text-muted);
  font-size: 0.76rem;
  text-align: right;
  white-space: nowrap;
}

.commit-history-dialog__search-action {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(16, 22, 29, 0.92);
  color: var(--text-primary);
  font-size: 0.96rem;
  line-height: 1;
}

.commit-history-dialog__search-action {
  transition: opacity 120ms ease;
}

.commit-history-dialog__search-action:disabled {
  opacity: 0.4;
}

.commit-history-dialog__loading {
  display: grid;
  place-items: center;
  min-height: 0;
  color: var(--text-muted);
  font-size: 0.84rem;
}
</style>
