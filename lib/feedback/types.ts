import type {
  AiRequestReason,
  DiagnosticEntry,
  DiagnosticSource,
  FilterAction,
  FilterCategory,
  LocalAiProviderId,
} from '../types';

export type FeedbackJudgement = 'correct' | 'incorrect' | 'missed';

/** Every category that can be retained in a feedback record. */
export const FILTER_CATEGORIES = [
  'safe',
  'backseat',
  'blame',
  'personal_attack',
  'meta_conflict',
  'complaint',
  'abuse',
  'instruction',
  'pigeon',
  'comparison',
  'concern',
  'spoiler',
  'spam',
  'hidden_user',
  'unknown',
] as const satisfies readonly FilterCategory[];

/** Categories exposed when correcting a prediction in the UI. */
export const FEEDBACK_CATEGORY_CHOICES = FILTER_CATEGORIES.filter(
  (category) => category !== 'hidden_user',
);

/** Categories that can be reported when an allowed comment was missed. */
export const MISSED_CATEGORY_CHOICES = FEEDBACK_CATEGORY_CHOICES.filter(
  (category) => category !== 'safe' && category !== 'unknown',
);

export interface FeedbackEntry {
  id: string;
  messageId?: string;
  text: string;
  normalizedText: string;
  predictedCategory: FilterCategory;
  predictedScore: number;
  predictedAction: FilterAction;
  correctCategory: FilterCategory;
  judgement: FeedbackJudgement;
  source: DiagnosticSource;
  ruleIds: string[];
  features: string[];
  contextAdjustment?: number;
  aiProvider?: LocalAiProviderId;
  aiReason?: AiRequestReason;
  aiConfidence?: number;
  conflictLevel?: number;
  classifierPromptVersion?: number;
  createdAt: number;
}

/** Aggregate kept separately so exact lookup does not scan the full dataset. */
export interface FeedbackExactMemory {
  normalizedText: string;
  categoryCounts: Partial<Record<FilterCategory, number>>;
  sampleCount: number;
  updatedAt: number;
}

export const FEEDBACK_MEMORY_PORT_NAME = 'chat-sanity-feedback-memory';

/** Ephemeral Service Worker-to-content-script synchronization messages. */
export type FeedbackMemoryPortMessage =
  | { kind: 'replace'; memories: FeedbackExactMemory[] }
  | { kind: 'update'; memory: FeedbackExactMemory }
  | { kind: 'clear' };

export interface ExactFeedbackResult {
  category: FilterCategory;
  confidence: number;
  sampleCount: number;
}

export function isFeedbackExactMemory(
  value: unknown,
): value is FeedbackExactMemory {
  if (!isRecord(value)) return false;
  if (
    typeof value.normalizedText !== 'string' ||
    typeof value.sampleCount !== 'number' ||
    !Number.isFinite(value.sampleCount) ||
    value.sampleCount < 0 ||
    !Number.isFinite(value.updatedAt) ||
    !isRecord(value.categoryCounts)
  )
    return false;
  return Object.entries(value.categoryCounts).every(
    ([category, count]) =>
      FILTER_CATEGORIES.some((known) => known === category) &&
      typeof count === 'number' &&
      Number.isFinite(count) &&
      count >= 0,
  );
}

export function isFeedbackMemoryPortMessage(
  value: unknown,
): value is FeedbackMemoryPortMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'clear') return true;
  if (value.kind === 'update') return isFeedbackExactMemory(value.memory);
  return (
    value.kind === 'replace' &&
    Array.isArray(value.memories) &&
    value.memories.every(isFeedbackExactMemory)
  );
}

export interface RuleFeedbackStats {
  ruleId: string;
  evaluated: number;
  correct: number;
  incorrect: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  lastUpdatedAt: number;
}

export interface FeedbackSummary {
  total: number;
  correct: number;
  incorrect: number;
  missed: number;
}

export interface CreateFeedbackEntryInput {
  diagnostic: DiagnosticEntry;
  normalizedText: string;
  judgement: FeedbackJudgement;
  correctCategory: FilterCategory;
  messageId?: string;
  conflictLevel?: number;
  createdAt?: number;
  id?: string;
}

/**
 * Builds the durable record from a diagnostic result without retaining any
 * author identity. Callers provide the normalized text created by the filter.
 */
export function createFeedbackEntry({
  diagnostic,
  normalizedText,
  judgement,
  correctCategory,
  messageId,
  conflictLevel,
  createdAt = Date.now(),
  id = crypto.randomUUID(),
}: CreateFeedbackEntryInput): FeedbackEntry {
  const conflict = conflictLevel ?? diagnostic.conflictLevel;
  return {
    id,
    ...(messageId ? { messageId } : {}),
    text: diagnostic.text,
    normalizedText,
    predictedCategory: diagnostic.category,
    predictedScore: diagnostic.score,
    predictedAction: diagnostic.action,
    correctCategory,
    judgement,
    source: diagnostic.source,
    ruleIds: [...(diagnostic.ruleIds ?? [])],
    features: [...(diagnostic.features ?? [])],
    ...(typeof diagnostic.contextAdjustment === 'number'
      ? { contextAdjustment: diagnostic.contextAdjustment }
      : {}),
    ...(diagnostic.aiProvider ? { aiProvider: diagnostic.aiProvider } : {}),
    ...(diagnostic.aiReason ? { aiReason: diagnostic.aiReason } : {}),
    ...(typeof diagnostic.aiConfidence === 'number'
      ? { aiConfidence: diagnostic.aiConfidence }
      : {}),
    ...(typeof conflict === 'number' ? { conflictLevel: conflict } : {}),
    ...(typeof diagnostic.classifierPromptVersion === 'number'
      ? { classifierPromptVersion: diagnostic.classifierPromptVersion }
      : {}),
    createdAt,
  };
}

/** Drops unknown fields before a feedback record crosses a durable boundary. */
export function cloneFeedbackEntry(entry: FeedbackEntry): FeedbackEntry {
  return {
    id: entry.id,
    ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
    text: entry.text,
    normalizedText: entry.normalizedText,
    predictedCategory: entry.predictedCategory,
    predictedScore: entry.predictedScore,
    predictedAction: entry.predictedAction,
    correctCategory: entry.correctCategory,
    judgement: entry.judgement,
    source: entry.source,
    ruleIds: [...entry.ruleIds],
    features: [...entry.features],
    ...(entry.contextAdjustment !== undefined
      ? { contextAdjustment: entry.contextAdjustment }
      : {}),
    ...(entry.aiProvider !== undefined ? { aiProvider: entry.aiProvider } : {}),
    ...(entry.aiReason !== undefined ? { aiReason: entry.aiReason } : {}),
    ...(entry.aiConfidence !== undefined
      ? { aiConfidence: entry.aiConfidence }
      : {}),
    ...(entry.conflictLevel !== undefined
      ? { conflictLevel: entry.conflictLevel }
      : {}),
    ...(entry.classifierPromptVersion !== undefined
      ? { classifierPromptVersion: entry.classifierPromptVersion }
      : {}),
    createdAt: entry.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
