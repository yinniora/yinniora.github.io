import { hydrateSettings, rememberStartupSettings } from './settings-store.js';
import { resetI18n } from './i18n.js';

// An origin switch has a fresh localStorage cache. Hydrate before mounting so
// the first render uses the shared language, then discard any cached fallback.
export async function prepareStartupSettings({ fetchImpl = fetch, storage } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const settings = await hydrateSettings({
      fetchImpl: (url, options) => fetchImpl(url, { ...options, signal: controller.signal }),
      storage,
      reuseStartup: false,
    });
    rememberStartupSettings(settings);
    return settings;
  } finally {
    clearTimeout(timer);
    resetI18n();
  }
}
