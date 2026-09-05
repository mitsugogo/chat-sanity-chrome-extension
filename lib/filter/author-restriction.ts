import type { FilterAction } from '../types';

export const RESTRICT_BOOST_STEP = 0.12;
export const HABITUAL_RESTRICT_COUNT = 5;
export const HIDDEN_USER_SCORE = 0.95;
const MAX_AUTHORS = 2_000;
const MAX_MESSAGE_ACTIONS = 500;

function isRestricted(action: FilterAction | undefined): boolean {
  return action === 'blur' || action === 'hide';
}

/**
 * Session-only per-author restriction. Blur/hide results raise later scores
 * until the current chat frame leans toward hide.
 */
export class AuthorRestrictionTracker {
  private readonly counts = new Map<string, number>();
  private readonly actions = new Map<string, FilterAction>();

  boost(author: string): number {
    if (!author) return 0;
    return Math.min(1, (this.counts.get(author) ?? 0) * RESTRICT_BOOST_STEP);
  }

  observe(author: string, messageId: string, action: FilterAction): boolean {
    if (!author || !messageId) return false;
    const previous = this.actions.get(messageId);
    if (previous === action) return false;
    this.actions.set(messageId, action);
    if (this.actions.size > MAX_MESSAGE_ACTIONS) {
      const oldest = this.actions.keys().next().value;
      if (oldest !== undefined) this.actions.delete(oldest);
    }

    let count = this.counts.get(author) ?? 0;
    if (isRestricted(previous)) count = Math.max(0, count - 1);
    if (isRestricted(action)) count += 1;
    this.counts.delete(author);
    this.counts.set(author, count);
    if (this.counts.size > MAX_AUTHORS) {
      const oldest = this.counts.keys().next().value;
      if (oldest !== undefined) this.counts.delete(oldest);
    }

    return (
      !isRestricted(previous) &&
      isRestricted(action) &&
      count === HABITUAL_RESTRICT_COUNT
    );
  }

  clear(): void {
    this.counts.clear();
    this.actions.clear();
  }
}
