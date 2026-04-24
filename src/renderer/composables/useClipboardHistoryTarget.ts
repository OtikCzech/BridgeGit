import { onBeforeUnmount, onMounted } from 'vue';
import {
  CLIPBOARD_HISTORY_CAPTURE_TARGET_EVENT,
  CLIPBOARD_HISTORY_CLEAR_TARGET_EVENT,
  CLIPBOARD_HISTORY_INSERT_EVENT,
} from '../clipboard';

interface ClipboardHistoryInsertDetail {
  handled: boolean;
  text: string;
}

interface UseClipboardHistoryTargetOptions {
  insertText: (text: string) => void;
  isTargetActive: () => boolean;
}

export function useClipboardHistoryTarget(options: UseClipboardHistoryTargetOptions) {
  let armed = false;

  const handleCaptureTarget = () => {
    armed = options.isTargetActive();
  };

  const handleClearTarget = () => {
    armed = false;
  };

  const handleInsert = (event: Event) => {
    const customEvent = event as CustomEvent<ClipboardHistoryInsertDetail>;

    if (customEvent.detail.handled || !armed) {
      return;
    }

    armed = false;
    customEvent.detail.handled = true;
    options.insertText(customEvent.detail.text);
  };

  onMounted(() => {
    window.addEventListener(CLIPBOARD_HISTORY_CAPTURE_TARGET_EVENT, handleCaptureTarget);
    window.addEventListener(CLIPBOARD_HISTORY_CLEAR_TARGET_EVENT, handleClearTarget);
    window.addEventListener(CLIPBOARD_HISTORY_INSERT_EVENT, handleInsert as EventListener);
  });

  onBeforeUnmount(() => {
    window.removeEventListener(CLIPBOARD_HISTORY_CAPTURE_TARGET_EVENT, handleCaptureTarget);
    window.removeEventListener(CLIPBOARD_HISTORY_CLEAR_TARGET_EVENT, handleClearTarget);
    window.removeEventListener(CLIPBOARD_HISTORY_INSERT_EVENT, handleInsert as EventListener);
  });
}
