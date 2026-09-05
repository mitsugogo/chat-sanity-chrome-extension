import type { FilterResult, SettingsV1 } from '../types';
import { isLocalAiConfigured } from '../settings';
import { matchAuditSignals } from './audit-signals';

const FREQUENCY_WINDOW_MS = 10_000;
const RATE_WINDOW_MS = 60_000;
const NOVELTY_BOOST = 0.07;
const CONFLICT_BOOST = 0.1;
const MAX_PROBABILITY = 0.5;
const MAX_TRACKED_MESSAGES = 1_000;

export interface AuditDecision {
  eligible: boolean;
  shouldAudit: boolean;
  probability: number;
  randomValue?: number;
  reasons: string[];
}

export interface AuditEvaluationInput {
  normalized: string;
  base: FilterResult;
  settings: SettingsV1;
  conflictLevel?: number;
  now?: number;
}

export class MessageFrequencyTracker {
  private readonly entries = new Map<string, number[]>();

  constructor(private readonly windowMs = FREQUENCY_WINDOW_MS) {}

  observeAndCount(normalizedText: string, now: number): number {
    const cutoff = now - this.windowMs;
    const recent = (this.entries.get(normalizedText) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    recent.push(now);
    this.entries.delete(normalizedText);
    this.entries.set(normalizedText, recent);
    this.compact(cutoff);
    return recent.length;
  }

  clear(): void {
    this.entries.clear();
  }

  private compact(cutoff: number): void {
    if (this.entries.size <= MAX_TRACKED_MESSAGES) return;
    for (const [text, timestamps] of this.entries) {
      if ((timestamps.at(-1) ?? 0) <= cutoff) this.entries.delete(text);
    }
    while (this.entries.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export class AuditSampler {
  private readonly frequency = new MessageFrequencyTracker();
  private auditTimestamps: number[] = [];
  private pending = 0;

  constructor(private readonly random: () => number = Math.random) {}

  isEligible(input: AuditEvaluationInput): boolean {
    const { base, settings, normalized } = input;
    return (
      settings.enabled &&
      isLocalAiConfigured(settings) &&
      settings.lmStudio.zeroScoreAudit.enabled &&
      Boolean(normalized) &&
      base.ruleDisposition === 'unmatched' &&
      base.score === 0
    );
  }

  evaluate(input: AuditEvaluationInput): AuditDecision {
    if (!this.isEligible(input)) {
      return {
        eligible: false,
        shouldAudit: false,
        probability: 0,
        reasons: [],
      };
    }

    const now = input.now ?? Date.now();
    const recentCount = this.frequency.observeAndCount(input.normalized, now);
    const signals = matchAuditSignals(input.normalized);
    let probability = input.settings.lmStudio.zeroScoreAudit.baseProbability;
    const reasons = ['ルール未一致'];

    if (recentCount === 1) {
      probability += NOVELTY_BOOST;
      reasons.push('直近で初めての本文');
    }
    for (const signal of signals) {
      probability += signal.boost;
      reasons.push(signal.reason);
    }
    if ((input.conflictLevel ?? 0) > 0.5) {
      probability += CONFLICT_BOOST;
      reasons.push('チャット全体の対立度が高い');
    }
    if (recentCount >= 5) {
      probability *= 0.25;
      reasons.push('同文が短時間に頻出');
    }
    probability = Math.min(MAX_PROBABILITY, Math.max(0, probability));

    this.auditTimestamps = this.auditTimestamps.filter(
      (timestamp) => timestamp > now - RATE_WINDOW_MS,
    );
    if (
      this.auditTimestamps.length >=
        input.settings.lmStudio.zeroScoreAudit.maxPerMinute ||
      this.pending >= input.settings.lmStudio.zeroScoreAudit.maxPending
    ) {
      return {
        eligible: true,
        shouldAudit: false,
        probability,
        reasons: [...reasons, '監査の負荷上限に到達'],
      };
    }

    const randomValue = this.random();
    const shouldAudit = randomValue < probability;
    if (shouldAudit) {
      this.auditTimestamps.push(now);
      this.pending += 1;
    }
    return {
      eligible: true,
      shouldAudit,
      probability,
      randomValue,
      reasons,
    };
  }

  complete(): void {
    this.pending = Math.max(0, this.pending - 1);
  }

  clear(): void {
    this.frequency.clear();
    this.auditTimestamps = [];
    this.pending = 0;
  }
}
