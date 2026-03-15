export async function playNotificationBeep(): Promise<boolean> {
  try {
    if (window.bridgegit?.system?.beep) {
      await window.bridgegit.system.beep();
      return true;
    }
  } catch {
    // Beep unavailable.
  }

  return false;
}
