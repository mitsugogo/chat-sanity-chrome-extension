import { isObviouslySafe } from './obvious-safe';

interface AuthorActivity {
  posts: Array<{ text: string; timestamp: number; risk: number }>;
}

const WINDOW_MS = 30_000;
const RISK_THRESHOLD = 0.35;

/**
 * Detects repeated risky posts without treating ordinary reactions as spam.
 * The state is intentionally kept only in the current content-script session.
 */
export class SpamDetector {
  private readonly activity = new Map<string, AuthorActivity>();

  evaluate(author: string, text: string, timestamp: number, risk = 0): number {
    if (!author || !text || isObviouslySafe(text) || risk < RISK_THRESHOLD)
      return 0;

    const state = this.activity.get(author) ?? { posts: [] };
    if (state.posts.some((post) => post.timestamp > timestamp))
      state.posts = [];
    const cutoff = timestamp - WINDOW_MS;
    state.posts = state.posts.filter(
      (post) => post.timestamp >= cutoff && post.timestamp <= timestamp,
    );
    state.posts.push({ text, timestamp, risk });
    state.posts = state.posts.slice(-8);
    this.activity.delete(author);
    this.activity.set(author, state);
    if (this.activity.size > 2000) {
      const oldest = this.activity.keys().next().value;
      if (oldest !== undefined) this.activity.delete(oldest);
    }

    const duplicates = state.posts.filter((post) => post.text === text).length;
    if (duplicates >= 3) return 0.92;
    const similar = state.posts.filter(
      (post) => similarity(post.text, text) >= 0.8,
    ).length;
    if (similar >= 3) return 0.92;
    if (state.posts.length >= 6) return 0.82;

    // Emoji-heavy messages are only considered spam when the surrounding text
    // is already risky. Emoji-only reactions return above before this point.
    if ((text.match(/[\p{Extended_Pictographic}]/gu)?.length ?? 0) >= 12)
      return 0.78;
    return 0;
  }

  clear(): void {
    this.activity.clear();
  }
}

/** Small bounded similarity check for risky repeats within one author's window. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLength = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) / maxLength > 0.35) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! +
          (a[leftIndex - 1] === b[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length]! / maxLength;
}
