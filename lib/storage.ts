import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';
import type { SettingsV1 } from './types';

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<SettingsV1> {
  const stored = await browser.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: SettingsV1): Promise<void> {
  await browser.storage.sync.set({
    [SETTINGS_KEY]: normalizeSettings(settings),
  });
}

export async function ensureSettings(): Promise<void> {
  const stored = await browser.storage.sync.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await browser.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
}

export function subscribeSettings(
  listener: (settings: SettingsV1) => void,
): () => void {
  const onChanged = (
    changes: Record<string, Browser.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'sync' || !changes[SETTINGS_KEY]) return;
    listener(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
}
