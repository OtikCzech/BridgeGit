<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { GitCommitRef, GitLogEntry } from '../../shared/bridgegit';
import { SHORTCUTS } from '../shortcuts';

interface Props {
  commits: GitLogEntry[];
  selectedHash: string | null;
  matchedHashes?: string[];
  fill?: boolean;
}

interface LaneTransition {
  color: string;
  colorKey: string;
  from: number;
  to: number;
}

interface ParentConnection {
  laneIndex: number;
  color: string;
  colorKey: string;
}

interface LaneState {
  hash: string;
  colorKey: string;
}

interface GraphRow {
  commit: GitLogEntry;
  laneIndex: number;
  laneColorKey: string;
  laneColor: string;
  hasIncomingLine: boolean;
  parentConnections: ParentConnection[];
  passThroughTransitions: LaneTransition[];
  visibleLaneCount: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  select: [hash: string];
  'open-diff': [hash: string];
}>();

const listRef = ref<HTMLOListElement | null>(null);

const ROW_HEIGHT = 42;
const ROW_CENTER_Y = 21;
const GRAPH_OVERFLOW_Y = 7;
const GRAPH_TOP_Y = -GRAPH_OVERFLOW_Y;
const GRAPH_BOTTOM_Y = ROW_HEIGHT + GRAPH_OVERFLOW_Y;
const GRAPH_VIEWBOX_Y = GRAPH_TOP_Y;
const GRAPH_VIEWBOX_HEIGHT = ROW_HEIGHT + GRAPH_OVERFLOW_Y * 2;
const GRAPH_PADDING_X = 12;
const LANE_GAP = 14;
const lanePalette = [
  '#7bd0ff',
  '#ffb066',
  '#6fe0a5',
  '#d4a1ff',
  '#ff8f84',
  '#80f0ff',
  '#f4d35e',
  '#8fd36d',
  '#ff9ac7',
  '#8aa8ff',
  '#f7936f',
  '#7ce3c8',
];

const dateFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function getLaneX(index: number): number {
  return GRAPH_PADDING_X + index * LANE_GAP;
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function normalizeRemoteBranchName(name: string): string {
  const slashIndex = name.indexOf('/');

  if (slashIndex === -1) {
    return name;
  }

  return name.slice(slashIndex + 1);
}

function getRefPriority(ref: GitCommitRef): number {
  if (ref.kind === 'local-branch' && ref.current) {
    return 0;
  }

  if (ref.kind === 'local-branch') {
    return 1;
  }

  if (ref.kind === 'remote-branch') {
    return 2;
  }

  if (ref.kind === 'head') {
    return 3;
  }

  if (ref.kind === 'tag') {
    return 4;
  }

  return 5;
}

function sortRefs(refs: GitCommitRef[]): GitCommitRef[] {
  return [...refs].sort((left, right) => {
    const priorityDelta = getRefPriority(left) - getRefPriority(right);

    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }

    return left.shortName.localeCompare(right.shortName);
  });
}

function getRefColorKey(ref: GitCommitRef, refs: GitCommitRef[]): string | null {
  if (ref.kind === 'local-branch') {
    return `branch:${ref.shortName}`;
  }

  if (ref.kind === 'remote-branch') {
    return `branch:${normalizeRemoteBranchName(ref.shortName)}`;
  }

  if (ref.kind === 'head') {
    const branchRef = sortRefs(refs).find((item) => (
      item.kind === 'local-branch' || item.kind === 'remote-branch'
    ));

    return branchRef ? getRefColorKey(branchRef, refs) : 'head:HEAD';
  }

  if (ref.kind === 'tag') {
    return `tag:${ref.shortName}`;
  }

  if (ref.kind === 'other') {
    return `ref:${ref.shortName}`;
  }

  return null;
}

function createColorKeyMap(commits: GitLogEntry[]): Map<string, string> {
  const colorMap = new Map<string, string>();

  for (const commit of commits) {
    for (const ref of sortRefs(commit.refs)) {
      const colorKey = getRefColorKey(ref, commit.refs);

      if (!colorKey || colorMap.has(colorKey)) {
        continue;
      }

      colorMap.set(colorKey, lanePalette[colorMap.size % lanePalette.length] ?? lanePalette[0]);
    }
  }

  return colorMap;
}

function getColorForKey(colorMap: Map<string, string>, colorKey: string): string {
  return colorMap.get(colorKey)
    ?? lanePalette[hashString(colorKey) % lanePalette.length]
    ?? lanePalette[0];
}

function toAlpha(color: string, alpha: number): string {
  const normalized = color.replace('#', '');

  if (normalized.length !== 6) {
    return color;
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getCommitColorKey(commit: GitLogEntry): string | null {
  const branchRef = sortRefs(commit.refs).find((ref) => {
    const colorKey = getRefColorKey(ref, commit.refs);
    return Boolean(colorKey?.startsWith('branch:'));
  });

  if (branchRef) {
    return getRefColorKey(branchRef, commit.refs);
  }

  const fallbackRef = sortRefs(commit.refs).find((ref) => getRefColorKey(ref, commit.refs));
  return fallbackRef ? getRefColorKey(fallbackRef, commit.refs) : null;
}

function getRefStyle(ref: GitCommitRef, refs: GitCommitRef[]) {
  const colorKey = getRefColorKey(ref, refs) ?? `${ref.kind}:${ref.shortName}`;
  const color = getColorForKey(colorKeyMap.value, colorKey);
  const isPersistentRef = ref.kind === 'head' || ref.shortName === 'HEAD' || ref.shortName.endsWith('/HEAD');
  const isDimmed = !isPersistentRef
    && selectedColorKey.value !== null
    && selectedColorKey.value !== colorKey;

  return {
    borderColor: toAlpha(color, isDimmed ? 0.14 : 0.34),
    backgroundColor: toAlpha(color, isDimmed ? 0.08 : 0.16),
    color: isDimmed ? toAlpha(color, 0.5) : color,
  };
}

function getDisplayedGraphColor(color: string, colorKey: string): string {
  if (!selectedColorKey.value || selectedColorKey.value === colorKey) {
    return color;
  }

  return toAlpha(color, 0.26);
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return value;
  }

  return dateFormatter.format(new Date(parsed));
}

function refKindLabel(ref: GitCommitRef): string {
  switch (ref.kind) {
    case 'head':
      return 'HEAD';
    case 'local-branch':
      return ref.current ? 'Current branch' : 'Local branch';
    case 'remote-branch':
      return 'Remote branch';
    case 'tag':
      return 'Tag';
    default:
      return 'Ref';
  }
}

function buildGraphRows(commits: GitLogEntry[]): GraphRow[] {
  const activeLanes: LaneState[] = [];
  const colorMap = colorKeyMap.value;

  return commits.map((commit) => {
    let laneIndex = activeLanes.findIndex((lane) => lane.hash === commit.hash);
    const laneWasActive = laneIndex !== -1;

    if (laneIndex === -1) {
      laneIndex = activeLanes.length;
      activeLanes.push({
        hash: commit.hash,
        colorKey: getCommitColorKey(commit) ?? `commit:${commit.hash}`,
      });
    }

    const preferredColorKey = getCommitColorKey(commit);

    if (preferredColorKey) {
      activeLanes[laneIndex] = {
        ...activeLanes[laneIndex],
        colorKey: preferredColorKey,
      };
    }

    const currentLanes = [...activeLanes];
    const currentLane = currentLanes[laneIndex];
    const nextLanes = [...currentLanes];
    nextLanes.splice(laneIndex, 1);

    const uniqueParentHashes = commit.parentHashes.filter((hash, index, source) => (
      source.indexOf(hash) === index
    ));
    const [firstParent, ...otherParents] = uniqueParentHashes;

    if (firstParent && !nextLanes.some((lane) => lane.hash === firstParent)) {
      nextLanes.splice(laneIndex, 0, {
        hash: firstParent,
        colorKey: currentLane.colorKey,
      });
    }

    for (const [offset, parentHash] of otherParents.entries()) {
      if (nextLanes.some((lane) => lane.hash === parentHash)) {
        continue;
      }

      nextLanes.splice(Math.min(laneIndex + offset + 1, nextLanes.length), 0, {
        hash: parentHash,
        colorKey: `commit:${parentHash}`,
      });
    }

    const passThroughTransitions = currentLanes
      .map((lane, currentIndex) => {
        if (lane.hash === commit.hash) {
          return null;
        }

        const nextIndex = nextLanes.findIndex((nextLane) => nextLane.hash === lane.hash);

        return {
          color: getColorForKey(colorMap, lane.colorKey),
          colorKey: lane.colorKey,
          from: currentIndex,
          to: nextIndex === -1 ? currentIndex : nextIndex,
        };
      })
      .filter((transition): transition is LaneTransition => Boolean(transition));

    const row: GraphRow = {
      commit,
      laneIndex,
      laneColorKey: currentLane.colorKey,
      laneColor: getColorForKey(colorMap, currentLane.colorKey),
      hasIncomingLine: laneWasActive,
      parentConnections: uniqueParentHashes
        .map((hash) => {
          const nextLaneIndex = nextLanes.findIndex((lane) => lane.hash === hash);

          if (nextLaneIndex < 0) {
            return null;
          }

          return {
            laneIndex: nextLaneIndex,
            color: getColorForKey(colorMap, currentLane.colorKey),
            colorKey: currentLane.colorKey,
          };
        })
        .filter((connection): connection is ParentConnection => Boolean(connection)),
      passThroughTransitions,
      visibleLaneCount: Math.max(currentLanes.length, nextLanes.length, laneIndex + 1),
    };

    activeLanes.splice(0, activeLanes.length, ...nextLanes);

    return row;
  });
}

const colorKeyMap = computed(() => createColorKeyMap(props.commits));
const rows = computed(() => buildGraphRows(props.commits));
const selectedColorKey = computed(() => (
  rows.value.find((row) => row.commit.hash === props.selectedHash)?.laneColorKey ?? null
));
const maxLaneCount = computed(() => (
  rows.value.reduce((maxValue, row) => Math.max(maxValue, row.visibleLaneCount), 1)
));
const graphWidth = computed(() => (
  Math.max(54, GRAPH_PADDING_X * 2 + (maxLaneCount.value - 1) * LANE_GAP + 10)
));
const selectedCommit = computed(() => (
  props.commits.find((commit) => commit.hash === props.selectedHash)
  ?? props.commits[0]
  ?? null
));
const matchedHashSet = computed(() => new Set(props.matchedHashes ?? []));

async function scrollSelectedIntoView() {
  if (!props.selectedHash || !listRef.value) {
    return;
  }

  await nextTick();

  const selector = `[data-commit-hash="${props.selectedHash}"]`;
  const selectedRow = listRef.value.querySelector<HTMLElement>(selector);
  selectedRow?.scrollIntoView({
    block: 'center',
    inline: 'nearest',
    behavior: 'smooth',
  });
}

watch(
  () => props.selectedHash,
  () => {
    void scrollSelectedIntoView();
  },
  { immediate: true },
);
</script>

<template>
  <section class="git-history" :class="{ 'git-history--fill': fill }">
    <header class="git-history__header">
      <div class="git-history__title-row">
        <div class="git-history__title-main">
          <span class="git-history__label">History</span>

          <div v-if="selectedCommit" class="git-history__selection-inline">
            <span class="git-history__selection-hash">{{ selectedCommit.shortHash }}</span>
            <span class="git-history__selection-message">{{ selectedCommit.message }}</span>
          </div>
        </div>

        <div class="git-history__title-actions">
          <button
            v-if="selectedCommit"
            class="git-history__open-diff"
            type="button"
            :title="`Open selected commit diff ${SHORTCUTS.commitOpenDiff.display}`"
            @click="emit('open-diff', selectedCommit.hash)"
          >
            Open Diff
          </button>

          <span class="git-history__count">{{ commits.length.toLocaleString() }}</span>
        </div>
      </div>

      <div v-if="selectedCommit" class="git-history__selection">
        <span class="git-history__selection-meta">
          {{ selectedCommit.authorName }} · {{ formatDate(selectedCommit.date) }}
        </span>
      </div>
    </header>

    <div v-if="!commits.length" class="git-history__empty">
      No commits yet.
    </div>

    <ol ref="listRef" v-else class="git-history__list">
      <li
        v-for="row in rows"
        :key="row.commit.hash"
        class="git-history__item"
      >
        <button
          class="git-history__row"
          :class="{
            'git-history__row--selected': row.commit.hash === selectedHash,
            'git-history__row--matched': matchedHashSet.has(row.commit.hash),
          }"
          :data-commit-hash="row.commit.hash"
          type="button"
          @click="emit('select', row.commit.hash)"
          @dblclick="emit('open-diff', row.commit.hash)"
        >
          <svg
            class="git-history__graph"
            :viewBox="`0 ${GRAPH_VIEWBOX_Y} ${graphWidth} ${GRAPH_VIEWBOX_HEIGHT}`"
            :style="{
              width: `${graphWidth}px`,
              height: `${GRAPH_VIEWBOX_HEIGHT}px`,
              marginBlock: `-${GRAPH_OVERFLOW_Y}px`,
            }"
            aria-hidden="true"
          >
            <line
              v-for="transition in row.passThroughTransitions"
              :key="`${row.commit.hash}:${transition.from}:${transition.to}`"
              class="git-history__line"
              :x1="getLaneX(transition.from)"
              :y1="GRAPH_TOP_Y"
              :x2="getLaneX(transition.to)"
              :y2="GRAPH_BOTTOM_Y"
              :stroke="getDisplayedGraphColor(transition.color, transition.colorKey)"
            />

            <line
              v-if="row.hasIncomingLine"
              class="git-history__line"
              :x1="getLaneX(row.laneIndex)"
              :y1="GRAPH_TOP_Y"
              :x2="getLaneX(row.laneIndex)"
              :y2="ROW_CENTER_Y"
              :stroke="getDisplayedGraphColor(row.laneColor, row.laneColorKey)"
            />

            <line
              v-for="connection in row.parentConnections"
              :key="`${row.commit.hash}:parent:${connection.laneIndex}`"
              class="git-history__line"
              :x1="getLaneX(row.laneIndex)"
              :y1="ROW_CENTER_Y"
              :x2="getLaneX(connection.laneIndex)"
              :y2="GRAPH_BOTTOM_Y"
              :stroke="getDisplayedGraphColor(connection.color, connection.colorKey)"
            />

            <circle
              class="git-history__node"
              :cx="getLaneX(row.laneIndex)"
              :cy="ROW_CENTER_Y"
              r="4.6"
              :fill="getDisplayedGraphColor(row.laneColor, row.laneColorKey)"
            />
          </svg>

          <div class="git-history__content">
            <div class="git-history__primary">
              <div class="git-history__main">
                <span class="git-history__hash">{{ row.commit.shortHash }}</span>
                <span class="git-history__message">{{ row.commit.message }}</span>
              </div>

              <div v-if="row.commit.refs.length" class="git-history__refs">
                <span
                  v-for="ref in sortRefs(row.commit.refs)"
                  :key="`${row.commit.hash}:${ref.name}`"
                  class="git-history__ref"
                  :class="`git-history__ref--${ref.kind}`"
                  :title="`${refKindLabel(ref)}: ${ref.shortName}`"
                  :style="getRefStyle(ref, row.commit.refs)"
                >
                  {{ ref.shortName }}
                </span>
              </div>
            </div>

            <div class="git-history__meta-column">
              <span>{{ row.commit.authorName }}</span>
              <span>{{ formatDate(row.commit.date) }}</span>
            </div>
          </div>
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped lang="scss">
.git-history {
  display: grid;
  gap: 10px;
}

.git-history--fill {
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.git-history__header {
  display: grid;
  gap: 6px;
}

.git-history__title-row,
.git-history__selection,
.git-history__main,
.git-history__refs {
  display: flex;
  align-items: center;
}

.git-history__title-row,
.git-history__main {
  gap: 10px;
}

.git-history__title-row {
  justify-content: space-between;
}

.git-history__title-main,
.git-history__title-actions,
.git-history__selection-inline {
  display: flex;
  align-items: center;
}

.git-history__title-main {
  gap: 10px;
  min-width: 0;
}

.git-history__title-actions {
  gap: 10px;
  flex: 0 0 auto;
}

.git-history__selection-inline {
  gap: 8px;
  min-width: 0;
}

.git-history__main {
  min-width: 0;
}

.git-history__label {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.git-history__count,
.git-history__selection-hash,
.git-history__hash {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.74rem;
}

.git-history__selection {
  gap: 8px;
  min-width: 0;
}

.git-history__selection-message {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-history__selection-meta {
  gap: 8px;
  min-width: 0;
  color: var(--text-muted);
  font-size: 0.76rem;
}

.git-history__open-diff {
  height: 28px;
  padding: 0 0.72rem;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: rgba(16, 22, 29, 0.92);
  color: var(--text-primary);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.git-history__empty {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.git-history__list {
  display: grid;
  align-content: start;
  gap: 0;
  max-height: 240px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
  scrollbar-color: rgba(88, 102, 124, 0.44) rgba(8, 12, 17, 0.72);
}

.git-history--fill .git-history__list {
  max-height: none;
  min-height: 0;
}

.git-history__list::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.git-history__list::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: rgba(88, 102, 124, 0.44);
  background-clip: padding-box;
}

.git-history__list::-webkit-scrollbar-track,
.git-history__list::-webkit-scrollbar-corner {
  background: rgba(8, 12, 17, 0.72);
}

.git-history__row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 0.48rem 0.42rem;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
}

.git-history__row:hover,
.git-history__row--selected {
  border-color: rgba(110, 197, 255, 0.24);
  background: rgba(23, 31, 41, 0.92);
}

.git-history__row--matched:not(.git-history__row--selected) {
  background: rgba(92, 122, 163, 0.12);
}

.git-history__graph {
  flex: 0 0 auto;
  height: 42px;
}

.git-history__line {
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  opacity: 0.92;
}

.git-history__node {
  stroke: rgba(4, 7, 11, 0.96);
  stroke-width: 1.8;
}

.git-history__content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  overflow: hidden;
  min-width: 0;
  align-items: start;
}

.git-history__primary {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.git-history__message {
  min-width: 0;
  flex: 1 1 0;
  overflow: hidden;
  font-size: 0.82rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-history__hash {
  flex: 0 0 auto;
}

.git-history__meta-column {
  display: grid;
  gap: 2px;
  min-width: 128px;
  justify-items: end;
  color: var(--text-muted);
  font-size: 0.74rem;
  line-height: 1.25;
  white-space: nowrap;
}

.git-history__refs {
  flex-wrap: wrap;
  gap: 6px;
}

.git-history__ref {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.45rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 0.69rem;
  font-weight: 700;
  line-height: 1.2;
}

.git-history__ref--head {
  border-color: rgba(110, 197, 255, 0.32);
  background: rgba(110, 197, 255, 0.16);
  color: #d8f0ff;
}

.git-history__ref--local-branch {
  border-color: rgba(111, 224, 165, 0.28);
  background: rgba(111, 224, 165, 0.14);
  color: #d7f9e5;
}

.git-history__ref--remote-branch {
  border-color: rgba(255, 176, 102, 0.26);
  background: rgba(255, 176, 102, 0.13);
  color: #ffe6ca;
}

.git-history__ref--tag {
  border-color: rgba(212, 161, 255, 0.28);
  background: rgba(212, 161, 255, 0.15);
  color: #f2e3ff;
}

.git-history__ref--other {
  border-color: rgba(127, 142, 164, 0.24);
  background: rgba(127, 142, 164, 0.13);
  color: #d4dce8;
}
</style>
