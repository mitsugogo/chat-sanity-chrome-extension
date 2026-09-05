export type FilterCategory =
  | 'safe'
  | 'backseat'
  | 'blame'
  | 'personal_attack'
  | 'meta_conflict'
  | 'complaint'
  | 'abuse'
  | 'instruction'
  | 'pigeon'
  | 'comparison'
  | 'concern'
  | 'spoiler'
  | 'spam'
  | 'hidden_user'
  | 'unknown';

export type ConfigurableCategory = Exclude<
  FilterCategory,
  'safe' | 'spam' | 'hidden_user' | 'unknown'
>;
export type FilterAction = 'allow' | 'dim' | 'blur' | 'hide';
export type RuleDisposition =
  'excluded' | 'explicit-safe' | 'matched' | 'unmatched';
export type AiRequestReason = 'uncertain-score' | 'zero-score-audit';
export type LocalAiProviderId = 'chrome-built-in' | 'lm-studio';
export type LocalAiMode = 'auto' | 'chrome-built-in' | 'lm-studio' | 'disabled';
export type LocalAiAvailability =
  'available' | 'downloadable' | 'downloading' | 'unavailable' | 'error';
export type PresetId = 'normal' | 'event' | 'peace';
export type FilterMode = 'threshold' | 'allow' | 'dim' | 'blur' | 'hide';
export type FlowChatExclusionLevel = 'blur' | 'hide' | 'custom';
export type FlowChatDecisionSource =
  'rule' | 'context' | 'cache' | 'llm-fast' | 'fail-open';

export interface FlowChatSettings {
  enabled: boolean;
  exclusionLevel: FlowChatExclusionLevel;
  customThreshold?: number;
  useLlmFastPath?: boolean;
}

export interface FlowChatDebugInfo {
  integrationEnabled: boolean;
  excluded: boolean;
  threshold: number;
  score: number;
  decisionSource: FlowChatDecisionSource;
  elapsedMs: number;
}

export interface FlowChatMetricsSnapshot {
  received: number;
  classified: number;
  excluded: number;
  allowed: number;
  cacheHits: number;
  timeouts: number;
  errors: number;
  averageLatency: number;
  maxLatency: number;
}

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  isOwner: boolean;
  isModerator: boolean;
  isMember: boolean;
  isPaidMessage: boolean;
  isStampOnly?: boolean;
  isSelf?: boolean;
  timestamp: number;
  authorExternalChannelId?: string;
}

export interface TrackedUser {
  channelId: string;
  displayName: string;
  addedAt: number;
}

export interface FilterResult {
  score: number;
  categories: FilterCategory[];
  reasons: string[];
  action: FilterAction;
  needsAi: boolean;
  ruleDisposition: RuleDisposition;
  /** Rule-only confidence kept separate from the display score for diagnostics. */
  confidence?: number;
  categoryScores?: Partial<Record<FilterCategory, number>>;
  ruleIds?: string[];
  features?: string[];
  contextAdjustment?: number;
}

/** Public shape for consumers that need the rule score without display state. */
export interface RuleClassificationResult {
  category: FilterCategory;
  score: number;
  confidence: number;
}

export interface Thresholds {
  dim: number;
  blur: number;
  hide: number;
}

export interface CategorySettings {
  enabled: boolean;
  weight: number;
  mode: FilterMode;
}

export interface PresetProfile {
  categories: Record<ConfigurableCategory, CategorySettings>;
  thresholds: Thresholds;
  hideSpam: boolean;
}

export type LmResponseFormat = 'json_schema' | 'json_object' | 'text';

export interface LmStudioSettings {
  enabled: boolean;
  endpoint: string;
  model: string;
  mode: 'uncertain';
  uncertainMin: number;
  uncertainMax: number;
  batchWindowMs: number;
  batchSize: number;
  timeoutMs: number;
  requestTimeoutMs: number;
  responseFormat: LmResponseFormat;
  sessionLearning: boolean;
  zeroScoreAudit: {
    enabled: boolean;
    baseProbability: number;
    maxPerMinute: number;
    maxPending: number;
  };
}

export interface SettingsV1 {
  schemaVersion: 1;
  enabled: boolean;
  debugMode: boolean;
  activePreset: PresetId;
  profiles: Record<PresetId, PresetProfile>;
  blockedWords: string[];
  allowedWords: string[];
  hiddenUsers: TrackedUser[];
  whitelistedUsers: TrackedUser[];
  localAiMode: LocalAiMode;
  chromeBuiltIn: {
    enabled: boolean;
  };
  lmStudio: LmStudioSettings;
  flowChat: FlowChatSettings;
}

export interface DiagnosticEntry {
  id: string;
  text: string;
  category: FilterCategory;
  score: number;
  action: FilterAction;
  reasons: string[];
  ruleIds?: string[];
  features?: string[];
  contextAdjustment?: number;
  flow?: FlowChatDebugInfo;
  source: 'rules' | 'local-ai' | 'fallback';
  aiProvider?: LocalAiProviderId;
  aiReason?: AiRequestReason;
  aiLatencyMs?: number;
  timestamp: number;
}

export interface SessionSummary {
  active: boolean;
  hidden: number;
  blurred: number;
  lmStudio: 'disabled' | 'connected' | 'unavailable';
  localAi: {
    activeProvider: LocalAiProviderId | 'rules';
    status: 'ready' | 'downloading' | 'unavailable';
  };
}

export interface LmClassificationItem {
  id: string;
  text: string;
  sameAuthorRecent?: string[];
  recentRiskyMessages?: string[];
  conflictLevel?: number;
}

export interface LmClassificationResult {
  id: string;
  category: FilterCategory;
  action?: 'allow' | 'blur';
  confidence?: number;
  /** Legacy LM Studio response field. New clients should return action/confidence. */
  score?: number;
  providerId?: LocalAiProviderId;
  latencyMs?: number;
}

export type RuntimeMessage =
  | { type: 'session:get-summary'; tabId: number }
  | { type: 'session:update'; summary: SessionSummary }
  | { type: 'session:remove' }
  | { type: 'debug:add'; entry: DiagnosticEntry }
  | { type: 'debug:get' }
  | { type: 'debug:clear' }
  | { type: 'debug:clear-frame' }
  | { type: 'flow:metrics-update'; metrics: FlowChatMetricsSnapshot }
  | { type: 'flow:metrics-clear-frame' }
  | { type: 'lm:list-models'; endpoint: string }
  | {
      type: 'local-ai:classify';
      items: LmClassificationItem[];
    }
  | { type: 'local-ai:get-status' };

export type RuntimeResponse =
  | { ok: true }
  | { ok: true; summary: SessionSummary }
  | { ok: true; models: string[] }
  | {
      ok: true;
      results: LmClassificationResult[];
      providerId: LocalAiProviderId;
      latencyMs: number;
    }
  | {
      ok: true;
      availability: LocalAiAvailability;
      providerId?: LocalAiProviderId;
    }
  | {
      ok: true;
      entries: DiagnosticEntry[];
      flowMetrics?: FlowChatMetricsSnapshot;
    }
  | { ok: false; error: string };
