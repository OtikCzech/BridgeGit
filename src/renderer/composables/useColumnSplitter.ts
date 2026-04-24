import { computed, onBeforeUnmount, ref } from 'vue';

interface UseColumnSplitterOptions {
  storageKey?: string;
  axis?: 'x' | 'y';
  defaultRatio?: number;
  minRatio?: number;
  maxRatio?: number;
  splitterPx?: number;
}

const STORAGE_PREFIX = 'bridgegit.splitter.';

export function useColumnSplitter(options: UseColumnSplitterOptions) {
  const axis = options.axis ?? 'x';
  const minRatio = options.minRatio ?? 0.15;
  const maxRatio = options.maxRatio ?? 0.85;
  const defaultRatio = options.defaultRatio ?? 0.5;
  const splitterPx = options.splitterPx ?? 8;
  const storageKey = options.storageKey ? `${STORAGE_PREFIX}${options.storageKey}` : null;

  function clampRatio(value: number): number {
    if (!Number.isFinite(value)) {
      return defaultRatio;
    }
    return Math.min(Math.max(value, minRatio), maxRatio);
  }

  function readStoredRatio(): number {
    try {
      if (!storageKey) {
        return defaultRatio;
      }

      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) {
        return defaultRatio;
      }
      return clampRatio(Number.parseFloat(raw));
    } catch {
      return defaultRatio;
    }
  }

  const ratio = ref(readStoredRatio());
  const containerRef = ref<HTMLElement | null>(null);
  const isDragging = ref(false);

  function persistRatio() {
    try {
      if (!storageKey) {
        return;
      }

      window.localStorage.setItem(storageKey, ratio.value.toFixed(4));
    } catch {
      // localStorage unavailable; ignore.
    }
  }

  function handlePointerMove(event: PointerEvent) {
    const container = containerRef.value;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const extent = axis === 'x' ? rect.width : rect.height;
    const usable = extent - splitterPx;
    if (usable <= 0) {
      return;
    }
    const pointer = axis === 'x' ? event.clientX - rect.left : event.clientY - rect.top;
    ratio.value = clampRatio((pointer - splitterPx / 2) / usable);
  }

  function endDrag() {
    if (!isDragging.value) {
      return;
    }
    isDragging.value = false;
    persistRatio();
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }

  function startDrag(event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    isDragging.value = true;
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function reset() {
    ratio.value = defaultRatio;
    persistRatio();
  }

  const gridTemplate = computed(
    () => `minmax(0, ${ratio.value}fr) ${splitterPx}px minmax(0, ${1 - ratio.value}fr)`,
  );

  onBeforeUnmount(endDrag);

  return {
    ratio,
    isDragging,
    containerRef,
    gridTemplate,
    splitterPx,
    startDrag,
    reset,
  };
}
