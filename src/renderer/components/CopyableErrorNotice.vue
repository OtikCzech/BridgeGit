<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

interface Props {
  message: string;
  detail?: string | null;
}

const props = defineProps<Props>();
const copyToast = ref<string | null>(null);

let copyToastTimer: number | null = null;

const normalizedMessage = computed(() => props.message.trim());
const normalizedDetail = computed(() => props.detail?.trim() || null);
const textToCopy = computed(() => {
  if (normalizedDetail.value && normalizedDetail.value !== normalizedMessage.value) {
    return `${normalizedMessage.value}\n${normalizedDetail.value}`;
  }

  return normalizedDetail.value ?? normalizedMessage.value;
});
const titleText = computed(() => {
  const baseDetail = normalizedDetail.value && normalizedDetail.value !== normalizedMessage.value
    ? normalizedDetail.value
    : normalizedMessage.value;

  return `${baseDetail}\n\nKlikni pro zkopírování chyby.`;
});

function showCopyToast(message: string) {
  copyToast.value = message;

  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
  }

  copyToastTimer = window.setTimeout(() => {
    copyToast.value = null;
    copyToastTimer = null;
  }, 1600);
}

async function writeClipboardText(text: string) {
  if (window.bridgegit?.clipboard) {
    await Promise.resolve(window.bridgegit.clipboard.writeText(text));
    return;
  }

  await navigator.clipboard.writeText(text);
}

async function copyError() {
  const nextText = textToCopy.value;

  if (!nextText) {
    return;
  }

  try {
    await writeClipboardText(nextText);
    showCopyToast('Copied');
  } catch {
    showCopyToast('Copy failed');
  }
}

onBeforeUnmount(() => {
  if (copyToastTimer) {
    window.clearTimeout(copyToastTimer);
    copyToastTimer = null;
  }
});
</script>

<template>
  <button
    type="button"
    class="copyable-error-notice"
    :title="titleText"
    @click="void copyError()"
  >
    <span>{{ message }}</span>
    <transition name="copyable-error-notice-toast">
      <span v-if="copyToast" class="copyable-error-notice__toast">
        {{ copyToast }}
      </span>
    </transition>
  </button>
</template>

<style scoped lang="scss">
.copyable-error-notice {
  position: relative;
  display: block;
  border: none;
  appearance: none;
  font: inherit;
  text-align: inherit;
  color: inherit;
  background: none;
  cursor: copy;
}

.copyable-error-notice:hover {
  filter: brightness(1.04);
}

.copyable-error-notice:focus-visible {
  outline: 2px solid var(--accent-strong);
  outline-offset: 2px;
}

.copyable-error-notice__toast {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 1;
  padding: 0.18rem 0.42rem;
  border-radius: 999px;
  background: rgba(8, 12, 17, 0.96);
  color: #f3f7fb;
  font-size: 0.68rem;
  line-height: 1.2;
  pointer-events: none;
}

.copyable-error-notice-toast-enter-active,
.copyable-error-notice-toast-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.copyable-error-notice-toast-enter-from,
.copyable-error-notice-toast-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
