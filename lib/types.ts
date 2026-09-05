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
  | 'unknown';

export type ConfigurableCategory = Exclude<
  FilterCategory,
  'safe' | 'spam' | 'unknown'
>;
export type FilterAction = 'allow' | 'dim' | 'blur' | 'hide';
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
  timestamp: number;
  authorExternalChannelId?: string;
}

export interface FilterResult {
  score: number;
  categories: FilterCategory[];
  reasons: string[];
  action: FilterAction;
  needsAi: boolean;
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
}

export interface SettingsV1 {
  schemaVersion: 1;
  enabled: boolean;
  debugMode: boolean;
  activePreset: PresetId;
  profiles: Record<PresetId, PresetProfile>;
  blockedWords: string[];
  allowedWords: string[];
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
  source: 'rules' | 'lm-studio' | 'fallback';
  timestamp: number;
}

export interface SessionSummary {
  active: boolean;
  hidden: number;
  blurred: number;
  lmStudio: 'disabled' | 'connected' | 'unavailable';
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
      type: 'lm:classify';
      endpoint: string;
      model: string;
      items: LmClassificationItem[];
      timeoutMs: number;
      responseFormat?: LmResponseFormat;
    };

export type RuntimeResponse =
  | { ok: true }
  | { ok: true; summary: SessionSummary }
  | { ok: true; models: string[] }
  | { ok: true; results: LmClassificationResult[] }
  | {
      ok: true;
      entries: DiagnosticEntry[];
      flowMetrics?: FlowChatMetricsSnapshot;
    }
  | { ok: false; error: string };
