export type FilterCategory =
  | 'safe'
  | 'abuse'
  | 'instruction'
  | 'pigeon'
  | 'comparison'
  | 'concern'
  | 'spoiler'
  | 'spam';

export type ConfigurableCategory = Exclude<FilterCategory, 'safe' | 'spam'>;
export type FilterAction = 'allow' | 'dim' | 'blur' | 'hide';
export type PresetId = 'normal' | 'event' | 'peace';

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  isOwner: boolean;
  isModerator: boolean;
  isMember: boolean;
  isPaidMessage: boolean;
  timestamp: number;
}

export interface FilterResult {
  score: number;
  categories: FilterCategory[];
  reasons: string[];
  action: FilterAction;
  needsAi: boolean;
}

export interface Thresholds {
  dim: number;
  blur: number;
  hide: number;
}

export interface CategorySettings {
  enabled: boolean;
  weight: number;
}

export interface PresetProfile {
  categories: Record<ConfigurableCategory, CategorySettings>;
  thresholds: Thresholds;
  hideSpam: boolean;
}

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
}

export interface SettingsV1 {
  schemaVersion: 1;
  enabled: boolean;
  activePreset: PresetId;
  profiles: Record<PresetId, PresetProfile>;
  blockedWords: string[];
  allowedWords: string[];
  lmStudio: LmStudioSettings;
}

export interface DiagnosticEntry {
  id: string;
  text: string;
  category: FilterCategory;
  score: number;
  action: FilterAction;
  reasons: string[];
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
}

export interface LmClassificationResult {
  id: string;
  category: FilterCategory;
  score: number;
}

export type RuntimeMessage =
  | { type: 'session:get-summary'; tabId: number }
  | { type: 'session:update'; summary: SessionSummary }
  | { type: 'session:remove' }
  | { type: 'lm:list-models'; endpoint: string }
  | {
      type: 'lm:classify';
      endpoint: string;
      model: string;
      items: LmClassificationItem[];
      timeoutMs: number;
    };

export type RuntimeResponse =
  | { ok: true }
  | { ok: true; summary: SessionSummary }
  | { ok: true; models: string[] }
  | { ok: true; results: LmClassificationResult[] }
  | { ok: false; error: string };
