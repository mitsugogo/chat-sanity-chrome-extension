import type {
  CategorySettings,
  ConfigurableCategory,
  FilterMode,
  PresetId,
  LmStudioSettings,
  FlowChatSettings,
  PresetProfile,
  SettingsV1,
} from './types';

export const CATEGORY_LABELS: Record<ConfigurableCategory, string> = {
  backseat: '指示・指示厨',
  blame: '責任追及・戦犯扱い',
  personal_attack: '人格・能力攻撃',
  comparison: '比較・対立煽り',
  meta_conflict: '自治・コメント欄の喧嘩',
  complaint: '不満・愚痴',
  pigeon: '鳩・別視点',
  spoiler: 'ネタバレ',
  abuse: '暴言・攻撃',
  instruction: '指示',
  concern: '杞憂',
};

/** Categories shown in the options page. Legacy aliases stay loadable but are
 * intentionally not shown as duplicate controls. */
export const CONFIGURABLE_CATEGORY_KEYS = [
  'backseat',
  'blame',
  'personal_attack',
  'comparison',
  'meta_conflict',
  'complaint',
  'pigeon',
  'spoiler',
] as const satisfies readonly ConfigurableCategory[];

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

const category = (
  enabled: boolean,
  weight: number,
  mode: FilterMode = 'threshold',
) => ({ enabled, weight, mode });

const profile = (categories: PresetProfile['categories']): PresetProfile => ({
  categories,
  thresholds: { dim: 0.5, blur: 0.75, hide: 0.9 },
  hideSpam: true,
});

export const DEFAULT_SETTINGS: SettingsV1 = {
  schemaVersion: 1,
  enabled: true,
  debugMode: false,
  activePreset: 'event',
  profiles: {
    normal: profile({
      abuse: category(true, 1),
      instruction: category(false, 0.8),
      pigeon: category(false, 0.8),
      comparison: category(false, 0.8),
      concern: category(false, 0.7),
      spoiler: category(false, 0.8),
      backseat: category(false, 1),
      blame: category(false, 1),
      personal_attack: category(true, 1),
      meta_conflict: category(false, 1),
      complaint: category(true, 0.7, 'allow'),
    }),
    event: profile({
      abuse: category(true, 1),
      instruction: category(true, 1),
      pigeon: category(true, 0.95),
      comparison: category(true, 0.95),
      concern: category(true, 0.8),
      spoiler: category(false, 0.8),
      backseat: category(true, 1),
      blame: category(true, 1),
      personal_attack: category(true, 1),
      meta_conflict: category(true, 1),
      complaint: category(true, 0.7, 'allow'),
    }),
    peace: profile({
      abuse: category(true, 1),
      instruction: category(true, 1),
      pigeon: category(true, 1),
      comparison: category(true, 1),
      concern: category(true, 1),
      spoiler: category(true, 1),
      backseat: category(true, 1),
      blame: category(true, 1),
      personal_attack: category(true, 1),
      meta_conflict: category(true, 1),
      complaint: category(true, 0.8),
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
    requestTimeoutMs: 10_000,
    responseFormat: 'json_schema',
    sessionLearning: true,
    zeroScoreAudit: {
      enabled: true,
      baseProbability: 0.03,
      maxPerMinute: 12,
      maxPending: 20,
    },
  },
  flowChat: {
    enabled: false,
    exclusionLevel: 'blur',
    customThreshold: 0.75,
    useLlmFastPath: false,
  },
  localAiMode: 'auto',
  chromeBuiltIn: {
    enabled: true,
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
    enabled:
      typeof partial.enabled === 'boolean'
        ? partial.enabled
        : DEFAULT_SETTINGS.enabled,
    activePreset: isPresetId(partial.activePreset)
      ? partial.activePreset
      : DEFAULT_SETTINGS.activePreset,
    debugMode:
      typeof partial.debugMode === 'boolean'
        ? partial.debugMode
        : DEFAULT_SETTINGS.debugMode,
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
    lmStudio: normalizeLmStudio(partial.lmStudio),
    localAiMode: isLocalAiMode(partial.localAiMode)
      ? partial.localAiMode
      : DEFAULT_SETTINGS.localAiMode,
    chromeBuiltIn: {
      enabled:
        typeof partial.chromeBuiltIn?.enabled === 'boolean'
          ? partial.chromeBuiltIn.enabled
          : DEFAULT_SETTINGS.chromeBuiltIn.enabled,
    },
    flowChat: normalizeFlowChat(partial.flowChat),
    blockedWords: cleanWords(partial.blockedWords),
    allowedWords: cleanWords(partial.allowedWords),
  };
}

export function normalizeFlowChat(
  value: Partial<FlowChatSettings> | undefined,
): FlowChatSettings {
  const defaults = DEFAULT_SETTINGS.flowChat;
  const supplied =
    value && typeof value === 'object'
      ? value
      : ({} as Partial<FlowChatSettings>);
  return {
    enabled:
      typeof supplied.enabled === 'boolean'
        ? supplied.enabled
        : defaults.enabled,
    exclusionLevel:
      supplied.exclusionLevel === 'hide' ||
      supplied.exclusionLevel === 'custom' ||
      supplied.exclusionLevel === 'blur'
        ? supplied.exclusionLevel
        : defaults.exclusionLevel,
    customThreshold: finiteClamp(
      supplied.customThreshold,
      defaults.customThreshold ?? 0.75,
      0,
      1,
    ),
    useLlmFastPath:
      typeof supplied.useLlmFastPath === 'boolean'
        ? supplied.useLlmFastPath
        : (defaults.useLlmFastPath ?? false),
  };
}

function mergeProfile(
  value: PresetProfile | undefined,
  fallback: PresetProfile,
): PresetProfile {
  if (!value) return structuredClone(fallback);
  const categories = { ...fallback.categories };
  for (const key of Object.keys(categories) as ConfigurableCategory[]) {
    const legacyKey =
      key === 'backseat'
        ? 'instruction'
        : key === 'personal_attack'
          ? 'abuse'
          : key === 'complaint'
            ? 'concern'
            : undefined;
    const suppliedValue =
      value.categories?.[key] ??
      (legacyKey ? value.categories?.[legacyKey] : undefined);
    const supplied = isCategorySettings(suppliedValue)
      ? suppliedValue
      : undefined;
    categories[key] = {
      enabled:
        typeof supplied?.enabled === 'boolean'
          ? supplied.enabled
          : fallback.categories[key].enabled,
      weight: finiteClamp(
        supplied?.weight,
        fallback.categories[key].weight,
        0,
        1,
      ),
      mode: isFilterMode(supplied?.mode)
        ? supplied.mode
        : fallback.categories[key].mode,
    };
  }
  const thresholds = value.thresholds ?? {};
  const dim = finiteClamp(thresholds.dim, fallback.thresholds.dim, 0.05, 0.9);
  const blur = finiteClamp(
    thresholds.blur,
    fallback.thresholds.blur,
    dim,
    0.95,
  );
  return {
    ...fallback,
    ...value,
    categories,
    thresholds: {
      dim,
      blur,
      hide: finiteClamp(
        value.thresholds?.hide,
        fallback.thresholds.hide,
        blur,
        1,
      ),
    },
    hideSpam:
      typeof value.hideSpam === 'boolean' ? value.hideSpam : fallback.hideSpam,
  };
}

function isCategorySettings(
  value: unknown,
): value is Partial<CategorySettings> {
  return Boolean(value && typeof value === 'object');
}

function isFilterMode(value: unknown): value is FilterMode {
  return (
    value === 'threshold' ||
    value === 'allow' ||
    value === 'dim' ||
    value === 'blur' ||
    value === 'hide'
  );
}

function isPresetId(value: unknown): value is PresetId {
  return value === 'normal' || value === 'event' || value === 'peace';
}

function isLocalAiMode(value: unknown): value is SettingsV1['localAiMode'] {
  return (
    value === 'auto' ||
    value === 'chrome-built-in' ||
    value === 'lm-studio' ||
    value === 'disabled'
  );
}

function finiteClamp(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
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

export function normalizeLmStudio(
  value: Partial<LmStudioSettings> | undefined,
): LmStudioSettings {
  const defaults = DEFAULT_SETTINGS.lmStudio;
  const uncertainMin = finiteClamp(
    value?.uncertainMin,
    defaults.uncertainMin,
    0.35,
    0.8,
  );
  return {
    enabled:
      typeof value?.enabled === 'boolean' ? value.enabled : defaults.enabled,
    endpoint:
      typeof value?.endpoint === 'string' ? value.endpoint : defaults.endpoint,
    model: typeof value?.model === 'string' ? value.model : defaults.model,
    mode: 'uncertain',
    sessionLearning:
      typeof value?.sessionLearning === 'boolean'
        ? value.sessionLearning
        : true,
    zeroScoreAudit: {
      enabled:
        typeof value?.zeroScoreAudit?.enabled === 'boolean'
          ? value.zeroScoreAudit.enabled
          : defaults.zeroScoreAudit.enabled,
      baseProbability: finiteClamp(
        value?.zeroScoreAudit?.baseProbability,
        defaults.zeroScoreAudit.baseProbability,
        0,
        0.5,
      ),
      maxPerMinute: Math.floor(
        finiteClamp(
          value?.zeroScoreAudit?.maxPerMinute,
          defaults.zeroScoreAudit.maxPerMinute,
          1,
          60,
        ),
      ),
      maxPending: Math.floor(
        finiteClamp(
          value?.zeroScoreAudit?.maxPending,
          defaults.zeroScoreAudit.maxPending,
          1,
          20,
        ),
      ),
    },
    uncertainMin,
    uncertainMax: finiteClamp(
      value?.uncertainMax,
      defaults.uncertainMax,
      uncertainMin,
      0.8,
    ),
    batchWindowMs: 200,
    batchSize: Math.floor(
      finiteClamp(value?.batchSize, defaults.batchSize, 1, 20),
    ),
    timeoutMs: 500,
    requestTimeoutMs: Math.round(
      finiteClamp(
        value?.requestTimeoutMs,
        defaults.requestTimeoutMs,
        1000,
        60000,
      ),
    ),
    responseFormat:
      value?.responseFormat === 'json_object' ||
      value?.responseFormat === 'text'
        ? value.responseFormat
        : 'json_schema',
  };
}

export function isLocalAiConfigured(settings: SettingsV1): boolean {
  if (settings.localAiMode === 'disabled') return false;
  const chromeEnabled = settings.chromeBuiltIn.enabled;
  const lmEnabled =
    settings.lmStudio.enabled && Boolean(settings.lmStudio.model);
  if (settings.localAiMode === 'chrome-built-in') return chromeEnabled;
  if (settings.localAiMode === 'lm-studio') return lmEnabled;
  return chromeEnabled || lmEnabled;
}
