<script setup lang="ts">
export interface AppConfirmDialogAction {
  id: string;
  label: string;
  tone?: 'default' | 'primary' | 'danger';
}

interface Props {
  modelValue: boolean;
  dialogLabel: string;
  eyebrow: string;
  title: string;
  copy: string;
  actions: AppConfirmDialogAction[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  action: [actionId: string];
}>();

function closeDialog() {
  emit('update:modelValue', false);
}

function handleAction(actionId: string) {
  emit('action', actionId);
}
</script>

<template>
  <div
    v-if="props.modelValue"
    class="app-confirm-dialog__backdrop"
    @click.self="closeDialog"
  >
    <section
      class="app-confirm-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="props.dialogLabel"
      @click.stop
    >
      <span class="app-confirm-dialog__eyebrow">{{ props.eyebrow }}</span>
      <h3 class="app-confirm-dialog__title">{{ props.title }}</h3>
      <p class="app-confirm-dialog__copy">{{ props.copy }}</p>

      <div class="app-confirm-dialog__actions">
        <button
          v-for="action in props.actions"
          :key="action.id"
          class="app-confirm-dialog__button"
          :class="{
            'app-confirm-dialog__button--primary': action.tone === 'primary',
            'app-confirm-dialog__button--danger': action.tone === 'danger',
          }"
          type="button"
          @click="handleAction(action.id)"
        >
          {{ action.label }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.app-confirm-dialog__backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--dialog-backdrop);
  backdrop-filter: blur(3px);
}

.app-confirm-dialog {
  display: grid;
  gap: 12px;
  width: min(460px, 100%);
  padding: 18px;
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background: var(--dialog-panel-bg);
  box-shadow: 0 22px 48px rgba(0, 0, 0, 0.38);
}

.app-confirm-dialog__eyebrow {
  color: var(--text-dim);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.app-confirm-dialog__title {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 1.08rem;
}

.app-confirm-dialog__copy {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.82rem;
  line-height: 1.5;
}

.app-confirm-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.app-confirm-dialog__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 0.82rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--dialog-button-bg);
  color: var(--text-primary);
  font-size: 0.78rem;
  font-weight: 600;
}

.app-confirm-dialog__button--primary {
  border-color: rgba(110, 197, 255, 0.28);
  background: rgba(69, 151, 250, 0.16);
  color: #b9dcff;
}

.app-confirm-dialog__button--danger {
  border-color: rgba(188, 87, 87, 0.24);
  background: rgba(188, 87, 87, 0.14);
  color: #ffb3ad;
}
</style>
