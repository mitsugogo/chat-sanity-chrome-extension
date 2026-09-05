import type {
  ConfigurableCategory,
  PresetId,
  PresetProfile,
  SettingsV1,
} from './types';

export const CATEGORY_LABELS: Record<ConfigurableCategory, string> = {
  abuse: '暴言・攻撃',
  instruction: '指示',
  pigeon: '鳩',
  comparison: '対立煽り',
  concern: '杞憂',
  spoiler: 'ネタバレ',
};

export const PRESET_LABELS: Record<PresetId, string> = {
  normal: '通常',
  event: '箱ゲー',
  peace: '完全平和',
};

export const PRESET_DESCRIPTIONS: Record<PresetId, string> = {
  normal: '暴言・攻撃と連投スパムを中心に抑えます',
  event: '指示・鳩・対立煽り・杞憂を強めに抑えます',
  peace: 'ネタバレを含むすべてのカテゴリを抑えます',
};

const category = (enabled: boolean, weight: number) => ({ enabled, weight });

const profile = (categories: PresetProfile['categories']): PresetProfile => ({
  categories,
  thresholds: { dim: 0.5, blur: 0.75, hide: 0.9 },
  hideSpam: true,
});

export const DEFAULT_SETTINGS: SettingsV1 = {
  schemaVersion: 1,
  enabled: true,
  activePreset: 'event',
  profiles: {
    normal: profile({
      abuse: category(true, 1),
      instruction: category(false, 0.8),
      pigeon: category(false, 0.8),
      comparison: category(false, 0.8),
      concern: category(false, 0.7),
      spoiler: category(false, 0.8),
    }),
    event: profile({
      abuse: category(true, 1),
      instruction: category(true, 1),
      pigeon: category(true, 0.95),
      comparison: category(true, 0.95),
      concern: category(true, 0.8),
      spoiler: category(false, 0.8),
    }),
    peace: profile({
      abuse: category(true, 1),
      instruction: category(true, 1),
      pigeon: category(true, 1),
      comparison: category(true, 1),
      concern: category(true, 1),
      spoiler: category(true, 1),
    }),
  },
  blockedWords: [],
  allowedWords: [],
  lmStudio: {
    enabled: false,
    endpoint: 'http://127.0.0.1:1234',
    model: '',
    mode: 'uncertain',
    uncertainMin: 0.35,
    uncertainMax: 0.8,
    batchWindowMs: 200,
    batchSize: 20,
    timeoutMs: 500,
  },
};

const cloneDefaults = (): SettingsV1 => structuredClone(DEFAULT_SETTINGS);

export function normalizeSettings(value: unknown): SettingsV1 {
  if (!value || typeof value !== 'object') return cloneDefaults();
  const partial = value as Partial<SettingsV1>;
  if (partial.schemaVersion !== 1) return cloneDefaults();

  return {
    ...cloneDefaults(),
    ...partial,
    profiles: {
      normal: mergeProfile(
        partial.profiles?.normal,
        DEFAULT_SETTINGS.profiles.normal,
      ),
      event: mergeProfile(
        partial.profiles?.event,
        DEFAULT_SETTINGS.profiles.event,
      ),
      peace: mergeProfile(
        partial.profiles?.peace,
        DEFAULT_SETTINGS.profiles.peace,
      ),
    },
    lmStudio: { ...DEFAULT_SETTINGS.lmStudio, ...partial.lmStudio },
    blockedWords: cleanWords(partial.blockedWords),
    allowedWords: cleanWords(partial.allowedWords),
  };
}

function mergeProfile(
  value: PresetProfile | undefined,
  fallback: PresetProfile,
): PresetProfile {
  if (!value) return structuredClone(fallback);
  const categories = { ...fallback.categories };
  for (const key of Object.keys(categories) as ConfigurableCategory[]) {
    categories[key] = {
      ...fallback.categories[key],
      ...value.categories?.[key],
    };
  }
  return {
    ...fallback,
    ...value,
    categories,
    thresholds: { ...fallback.thresholds, ...value.thresholds },
  };
}

export function cleanWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, 500);
}
