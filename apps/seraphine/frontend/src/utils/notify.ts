/**
 * Send a native notification. Uses Tauri plugin in desktop build,
 * falls back to Web Notification API in browser.
 */
export async function notify(title: string, body: string): Promise<void> {
  try {
    // Try Tauri native notification first
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({ title, body });
  } catch {
    // Fallback to Web Notification API
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }
}
