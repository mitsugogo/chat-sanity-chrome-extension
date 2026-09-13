import type { FilterCategory } from '../types';
import type {
  ExactFeedbackResult,
  FeedbackEntry,
  FeedbackExactMemory,
} from './types';
import { FILTER_CATEGORIES } from './types';

const MIN_EXACT_CONFIDENCE = 0.6;

/** Keeps a content-script-friendly snapshot of exact feedback aggregates. */
export class FeedbackLearner {
  private readonly memories = new Map<string, FeedbackExactMemory>();

  hydrate(memories: FeedbackExactMemory[]): void {
    this.memories.clear();
    for (const memory of memories) this.observeMemory(memory);
  }

  observeMemory(memory: FeedbackExactMemory): void {
    this.memories.set(memory.normalizedText, structuredClone(memory));
  }

  lookupExact(normalizedText: string): ExactFeedbackResult | null {
    return resolveExactFeedback(this.memories.get(normalizedText));
  }

  clear(): void {
    this.memories.clear();
  }
}

export function addToExactMemory(
  current: FeedbackExactMemory | undefined,
  entry: FeedbackEntry,
): FeedbackExactMemory {
  const categoryCounts = { ...(current?.categoryCounts ?? {}) };
  categoryCounts[entry.correctCategory] =
    (categoryCounts[entry.correctCategory] ?? 0) + 1;
  return {
    normalizedText: entry.normalizedText,
    categoryCounts,
    sampleCount: (current?.sampleCount ?? 0) + 1,
    updatedAt: entry.createdAt,
  };
}

/**
 * Reject ties and weak majorities so a conflicting correction never overrides
 * the normal rule pipeline. One unanimous record is usable but deliberately
 * produces only a conservative display score in `exactFeedbackScore`.
 */
export function resolveExactFeedback(
  memory: FeedbackExactMemory | undefined,
): ExactFeedbackResult | null {
  if (!memory || memory.sampleCount < 1) return null;
  let winner: FilterCategory | undefined;
  let winnerCount = 0;
  let hasTie = false;
  let countedSamples = 0;

  for (const category of FILTER_CATEGORIES) {
    const count = memory.categoryCounts[category] ?? 0;
    countedSamples += count;
    if (count > winnerCount) {
      winner = category;
      winnerCount = count;
      hasTie = false;
    } else if (count > 0 && count === winnerCount) {
      hasTie = true;
    }
  }

  const sampleCount = Math.max(memory.sampleCount, countedSamples);
  if (!winner || hasTie || sampleCount === 0) return null;
  const confidence = round(winnerCount / sampleCount);
  if (confidence < MIN_EXACT_CONFIDENCE) return null;
  return { category: winner, confidence, sampleCount };
}

/** Score used only for an exact, user-confirmed full-text match. */
export function exactFeedbackScore(result: ExactFeedbackResult): number {
  const evidenceBonus = Math.min(
    0.25,
    Math.max(0, result.sampleCount - 1) * 0.1,
  );
  const consensusBonus = Math.min(
    0.05,
    Math.max(0, result.confidence - 0.6) * 0.125,
  );
  return round(Math.min(0.9, 0.6 + evidenceBonus + consensusBonus));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
