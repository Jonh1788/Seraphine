/**
 * `navigator.mediaDevices.devicechange` fan-out with debouncing.
 *
 * Multiple subscribers (Web Audio shared context, VPIO session) need to
 * react when output devices change (AirPods connect/disconnect, headphone
 * swap). The native event fires several times per transition, so we
 * debounce and dispatch once to all listeners.
 */

type DeviceChangeListener = () => void;

const listeners = new Set<DeviceChangeListener>();
let attached = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function attach(): void {
  if (attached) return;
  if (typeof navigator === 'undefined') return;
  const md = (navigator as Navigator).mediaDevices;
  if (!md || typeof md.addEventListener !== 'function') return;
  attached = true;
  md.addEventListener('devicechange', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      console.log(`[deviceChange] event — notifying ${listeners.size} subscriber(s)`);
      for (const cb of listeners) {
        try {
          cb();
        } catch (err) {
          console.warn('[deviceChange] listener failed:', err);
        }
      }
    }, 250);
  });
}

/** Subscribe to debounced devicechange events. Returns unsubscribe. */
export function onDeviceChange(cb: DeviceChangeListener): () => void {
  listeners.add(cb);
  attach();
  return () => {
    listeners.delete(cb);
  };
}
