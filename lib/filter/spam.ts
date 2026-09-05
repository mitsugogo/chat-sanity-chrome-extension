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
