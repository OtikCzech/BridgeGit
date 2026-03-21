<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { RecentRepoEntry } from '../../shared/bridgegit';

interface Props {
  repoPath: string | null;
  recentRepos: RecentRepoEntry[];
  projectTitlesByContext: Record<string, string>;
  isBusy?: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  open: [];
  select: [path: string];
}>();

const rootRef = ref<HTMLElement | null>(null);
const isMenuOpen = ref(false);
const filter = ref('');

const filteredRepos = computed(() => {
  const searchTerm = filter.value.trim().toLowerCase();
  const orderedRepos = [...props.recentRepos].sort(
    (left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt),
  );

  if (!searchTerm) {
    return orderedRepos;
  }

  return orderedRepos.filter((repo) => {
    const displayName = props.projectTitlesByContext[repo.path]?.trim() || repo.name;
    const haystack = `${displayName} ${repo.name} ${repo.path}`.toLowerCase();
    return haystack.includes(searchTerm);
  });
});

function toggleMenu() {
  isMenuOpen.value = !isMenuOpen.value;

  if (!isMenuOpen.value) {
    filter.value = '';
  }
}

function closeMenu() {
  isMenuOpen.value = false;
  filter.value = '';
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!rootRef.value?.contains(event.target as Node | null)) {
    closeMenu();
  }
}

function handleEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeMenu();
  }
}

function handleSelect(path: string) {
  emit('select', path);
  closeMenu();
}

function formatLastUsed(lastUsedAt: string): string {
  const deltaMs = Date.now() - Date.parse(lastUsedAt);
  const deltaMinutes = Math.round(deltaMs / 60000);
  const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (Math.abs(deltaMinutes) < 60) {
    return relativeTime.format(-deltaMinutes, 'minute');
  }

  const deltaHours = Math.round(deltaMinutes / 60);

  if (Math.abs(deltaHours) < 24) {
    return relativeTime.format(-deltaHours, 'hour');
  }

  const deltaDays = Math.round(deltaHours / 24);

  if (Math.abs(deltaDays) < 10) {
    return relativeTime.format(-deltaDays, 'day');
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(lastUsedAt));
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleEscape);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleEscape);
});
</script>

<template>
  <div ref="rootRef" class="repo-picker">
    <div class="repo-picker__row">
      <button
        class="repo-picker__path-button"
        type="button"
        :title="repoPath ?? 'Choose or reopen a repository'"
        :aria-expanded="isMenuOpen"
        aria-haspopup="dialog"
        @click="toggleMenu"
      >
        <span class="repo-picker__path">
          {{ repoPath ?? 'Choose or reopen a repository' }}
        </span>
        <span class="repo-picker__chevron" aria-hidden="true">▾</span>
      </button>

      <button
        class="repo-picker__icon-button"
        type="button"
        :disabled="isBusy"
        title="Open repository folder"
        aria-label="Open repository folder"
        @click="$emit('open')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.182a2.25 2.25 0 0 1 1.59.659l1.068 1.068a.75.75 0 0 0 .53.22H18A2.25 2.25 0 0 1 20.25 8.7v8.55A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Zm3.31 4.5a.75.75 0 0 0 0 1.5h4.19l-1.72 1.72a.75.75 0 1 0 1.06 1.06l3-3a.75.75 0 0 0 0-1.06l-3-3a.75.75 0 1 0-1.06 1.06l1.72 1.72H7.06Z"
          />
        </svg>
      </button>
    </div>

    <section v-if="isMenuOpen" class="repo-picker__menu" role="dialog" aria-label="Recent repositories">
      <div class="repo-picker__search-shell">
        <input
          v-model="filter"
          class="repo-picker__search"
          type="search"
          placeholder="Filter repositories"
          autocomplete="off"
        />
      </div>

      <div v-if="filteredRepos.length" class="repo-picker__list">
        <button
          v-for="repo in filteredRepos"
          :key="repo.path"
          class="repo-picker__repo"
          :class="{ 'repo-picker__repo--active': repo.path === repoPath }"
          type="button"
          :title="repo.path"
          @click="handleSelect(repo.path)"
        >
          <span class="repo-picker__repo-name">{{ projectTitlesByContext[repo.path]?.trim() || repo.name }}</span>
          <span class="repo-picker__repo-path">{{ repo.path }}</span>
          <span class="repo-picker__repo-meta">{{ formatLastUsed(repo.lastUsedAt) }}</span>
        </button>
      </div>

      <div v-else class="repo-picker__empty">
        No repositories match the current filter.
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.repo-picker {
  position: relative;
  min-width: 0;
}

.repo-picker__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.repo-picker__path-button,
.repo-picker__icon-button {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(16, 23, 31, 0.92);
  color: var(--text-primary);
}

.repo-picker__path-button {
  min-width: 0;
  justify-content: space-between;
  gap: 8px;
  padding: 0.6rem 0.75rem;
}

.repo-picker__icon-button {
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
}

.repo-picker__icon-button svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.repo-picker__path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  direction: rtl;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  unicode-bidi: plaintext;
}

.repo-picker__chevron {
  color: var(--text-dim);
  font-size: 0.78rem;
  flex: 0 0 auto;
}

.repo-picker__menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 40;
  display: grid;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background:
    linear-gradient(160deg, rgba(69, 151, 250, 0.08), transparent 34%),
    rgba(10, 14, 19, 0.98);
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.34);
}

.repo-picker__search-shell {
  display: grid;
}

.repo-picker__search {
  width: 100%;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(8, 12, 17, 0.92);
  color: var(--text-primary);
}

.repo-picker__list {
  display: grid;
  gap: 6px;
  max-height: 260px;
  overflow: auto;
}

.repo-picker__repo {
  display: grid;
  gap: 3px;
  justify-items: start;
  padding: 0.7rem 0.8rem;
  border: 1px solid transparent;
  border-radius: 12px;
  background: rgba(17, 23, 31, 0.9);
  color: var(--text-primary);
  text-align: left;
}

.repo-picker__repo--active,
.repo-picker__repo:hover {
  border-color: rgba(110, 197, 255, 0.24);
  background: rgba(24, 33, 43, 0.96);
}

.repo-picker__repo-name {
  font-weight: 700;
}

.repo-picker__repo-path {
  width: 100%;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.76rem;
  direction: rtl;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  unicode-bidi: plaintext;
}

.repo-picker__repo-meta,
.repo-picker__empty {
  color: var(--text-dim);
  font-size: 0.74rem;
}

.repo-picker__empty {
  padding: 0.5rem 0.2rem;
}

.repo-picker__icon-button:disabled {
  opacity: 0.58;
}
</style>
