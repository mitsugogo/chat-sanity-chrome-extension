import type { FilterCategory } from './types';

const CATEGORY_IMPACT: Partial<Record<FilterCategory, number>> = {
  complaint: 0.5,
  backseat: 1,
  meta_conflict: 1,
  blame: 2,
  personal_attack: 3,
  abuse: 3,
  comparison: 1.5,
};

export class ConflictScoreTracker {
  private score = 0;
  private updatedAt: number | undefined;

  get(timestamp: number): number {
    this.decay(timestamp);
    return Math.min(1, this.score / 6);
  }

  observe(category: FilterCategory, risk: number, timestamp: number): void {
    this.decay(timestamp);
    const impact = CATEGORY_IMPACT[category] ?? 0;
    this.score = Math.min(
      6,
      this.score + impact * Math.max(0, Math.min(1, risk)),
    );
    this.updatedAt = timestamp;
  }

  clear(): void {
    this.score = 0;
    this.updatedAt = undefined;
  }

  private decay(timestamp: number): void {
    if (this.updatedAt === undefined) {
      this.updatedAt = timestamp;
      return;
    }
    const elapsed = timestamp - this.updatedAt;
    if (elapsed <= 0) {
      if (elapsed < -60_000) this.clear();
      return;
    }
    // Half-life of roughly 45 seconds; score is local session state only.
    this.score *= Math.exp(-elapsed / 65_000);
    this.updatedAt = timestamp;
  }
}

export interface AuthorRiskMessage {
  text: string;
  timestamp: number;
  risk: number;
}

/** A tiny global context window used only as an LLM hint. */
export class RecentRiskHistory {
  private readonly messages: AuthorRiskMessage[] = [];

  recent(timestamp: number, limit = 3): string[] {
    this.prune(timestamp);
    return this.messages.slice(-limit).map((item) => item.text);
  }

  observe(text: string, timestamp: number, risk: number): void {
    if (!text || risk < 0.35) return;
    this.prune(timestamp);
    this.messages.push({ text, timestamp, risk });
    if (this.messages.length > 20)
      this.messages.splice(0, this.messages.length - 20);
  }

  clear(): void {
    this.messages.length = 0;
  }

  private prune(timestamp: number): void {
    if (this.messages.some((item) => item.timestamp > timestamp)) {
      this.messages.length = 0;
      return;
    }
    const cutoff = timestamp - 60_000;
    while (this.messages[0] && this.messages[0].timestamp < cutoff)
      this.messages.shift();
  }
}

export class AuthorHistory {
  private readonly authors = new Map<string, AuthorRiskMessage[]>();

  recent(author: string, timestamp: number, limit = 3): string[] {
    if (!author) return [];
    const state = this.authors.get(author);
    if (!state) return [];
    const recent = state.filter(
      (item) =>
        item.timestamp >= timestamp - 60_000 && item.timestamp <= timestamp,
    );
    if (recent.length !== state.length) this.authors.set(author, recent);
    return recent
      .filter((item) => item.risk >= 0.35)
      .slice(-limit)
      .map((item) => item.text);
  }

  observe(author: string, text: string, timestamp: number, risk: number): void {
    if (!author) return;
    const recent =
      this.authors
        .get(author)
        ?.filter(
          (item) =>
            item.timestamp >= timestamp - 60_000 && item.timestamp <= timestamp,
        ) ?? [];
    recent.push({ text, timestamp, risk });
    this.authors.delete(author);
    this.authors.set(author, recent.slice(-8));
    while (this.authors.size > 1000)
      this.authors.delete(this.authors.keys().next().value ?? '');
  }

  clear(): void {
    this.authors.clear();
  }
}
