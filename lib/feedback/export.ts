import type { DiagnosticSource, FilterAction } from '../types';
import type { FeedbackEntry, FeedbackJudgement } from './types';
import { FILTER_CATEGORIES } from './types';

const FILTER_ACTIONS: readonly FilterAction[] = [
  'allow',
  'dim',
  'blur',
  'hide',
];
const JUDGEMENTS: readonly FeedbackJudgement[] = [
  'correct',
  'incorrect',
  'missed',
];
const SOURCES: readonly DiagnosticSource[] = [
  'rules',
  'local-ai',
  'human-feedback',
  'fallback',
];

/** Serializes one feedback record per line; JSON escaping preserves newlines. */
export function feedbackEntriesToJsonl(entries: FeedbackEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

/** Parses an exported dataset for callers that later choose to add import UI. */
export function parseFeedbackJsonl(value: string): FeedbackEntry[] {
  const entries: FeedbackEntry[] = [];
  const lines = value.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${index + 1}行目のJSONを読み取れません。`);
    }
    if (!isFeedbackEntry(parsed))
      throw new Error(`${index + 1}行目はフィードバック形式ではありません。`);
    entries.push(parsed);
  }
  return entries;
}

export function isFeedbackEntry(value: unknown): value is FeedbackEntry {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isOptionalString(value.messageId) &&
    isString(value.text) &&
    isString(value.normalizedText) &&
    isCategory(value.predictedCategory) &&
    isFiniteNumber(value.predictedScore) &&
    isAction(value.predictedAction) &&
    isCategory(value.correctCategory) &&
    isJudgement(value.judgement) &&
    isSource(value.source) &&
    isStringArray(value.ruleIds) &&
    isStringArray(value.features) &&
    isOptionalFiniteNumber(value.contextAdjustment) &&
    isOptionalString(value.aiProvider) &&
    isOptionalString(value.aiReason) &&
    isOptionalFiniteNumber(value.aiConfidence) &&
    isOptionalFiniteNumber(value.conflictLevel) &&
    isOptionalFiniteNumber(value.classifierPromptVersion) &&
    isFiniteNumber(value.createdAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isCategory(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    FILTER_CATEGORIES.some((category) => category === value)
  );
}

function isAction(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    FILTER_ACTIONS.some((action) => action === value)
  );
}

function isJudgement(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    JUDGEMENTS.some((judgement) => judgement === value)
  );
}

function isSource(value: unknown): boolean {
  return (
    typeof value === 'string' && SOURCES.some((source) => source === value)
  );
}
