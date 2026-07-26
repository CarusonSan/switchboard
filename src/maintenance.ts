import { config } from './config.js';
import { dockerProvider } from './provisioning/docker.js';

const INTERVAL_MS = 60_000;

/**
 * Background loops that keep spin-up fast and spin-down automatic:
 * - pre-pull all game images so cold creates never wait on a download
 * - keep the warm pool at its configured size
 * - stop claimed servers that have been idle for IDLE_MINUTES
 */
export function startMaintenance(): void {
  void dockerProvider
    .prePullAll()
    .then(() => dockerProvider.reconcilePool())
    .catch((error) => console.error('[maintenance] startup tasks failed:', error));

  setInterval(() => {
    void dockerProvider.reconcilePool().catch((error) => console.error('[pool]', error));
  }, INTERVAL_MS);

  if (config.IDLE_MINUTES > 0) {
    setInterval(() => {
      void dockerProvider.reapIdle().catch((error) => console.error('[idle]', error));
    }, INTERVAL_MS);
  }
}
