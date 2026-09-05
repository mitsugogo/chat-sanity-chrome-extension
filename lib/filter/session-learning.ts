import type { FilterCategory, LmClassificationResult } from '../types';

const HIGH_CONFIDENCE_SCORE = 0.85;
const SAFE_SCORE = 0.34;
const MAX_ENTRIES = 500;
const MIN_PHRASE_LENGTH = 6;
const MAX_PHRASE_LENGTH = 60;

interface LearnedResult {
  category: FilterCategory;
  score: number;
}

interface PhraseCandidate extends LearnedResult {
  texts: Set<string>;
  conflicted: boolean;
  standaloneConfirmed: boolean;
  promoted: boolean;
}

/**
 * AI判定をページを開いている間だけ再利用する。
 * 保存先を持たないため、再読み込み・タブ終了後には学習内容も消える。
 */
export class SessionRuleLearner {
  private readonly exact = new Map<string, LearnedResult>();
  private readonly phrases = new Map<string, PhraseCandidate>();
  private readonly safeVetoes = new Map<string, true>();

  observe(text: string, ai: LmClassificationResult): void {
    const phrases = splitPhrases(text);

    const score = scoreFromAi(ai);
    if (
      ai.category === 'safe' &&
      (ai.action === 'allow' ||
        (ai.score !== undefined && score !== null && score <= SAFE_SCORE))
    ) {
      this.exact.delete(text);
      this.setLru(this.safeVetoes, text, true);
      for (const phrase of phrases) {
        this.phrases.delete(phrase);
        this.setLru(this.safeVetoes, phrase, true);
      }
      return;
    }

    if (
      ai.category === 'safe' ||
      ai.category === 'spam' ||
      ai.category === 'hidden_user' ||
      ai.category === 'unknown' ||
      score === null ||
      score < HIGH_CONFIDENCE_SCORE ||
      (ai.action !== undefined && ai.action !== 'blur')
    ) {
      return;
    }

    this.setLru(this.exact, text, {
      category: ai.category,
      score,
    });

    for (const phrase of phrases) {
      if (this.safeVetoes.has(phrase)) continue;
      this.observePhrase(phrase, text, ai);
    }
  }

  lookup(text: string): LmClassificationResult | null {
    const phrases = splitPhrases(text);
    if (
      this.safeVetoes.has(text) ||
      phrases.some((phrase) => this.safeVetoes.has(phrase))
    ) {
      return null;
    }

    const exact = this.exact.get(text);
    if (exact) {
      this.touch(this.exact, text, exact);
      return toLookupResult(exact);
    }

    for (const phrase of phrases) {
      const candidate = this.phrases.get(phrase);
      if (!candidate?.promoted || candidate.conflicted) continue;
      this.touch(this.phrases, phrase, candidate);
      return toLookupResult(candidate);
    }
    return null;
  }

  clear(): void {
    this.exact.clear();
    this.phrases.clear();
    this.safeVetoes.clear();
  }

  private observePhrase(
    phrase: string,
    text: string,
    ai: LmClassificationResult,
  ): void {
    const score = scoreFromAi(ai);
    if (score === null) return;
    const current = this.phrases.get(phrase);
    if (!current) {
      this.setLru(this.phrases, phrase, {
        category: ai.category,
        score,
        texts: new Set([text]),
        conflicted: false,
        standaloneConfirmed: phrase === text,
        promoted: false,
      });
      return;
    }

    if (current.category !== ai.category) {
      current.conflicted = true;
      current.promoted = false;
      current.texts.clear();
      this.touch(this.phrases, phrase, current);
      return;
    }

    if (!current.conflicted) {
      if (current.texts.size < 3) current.texts.add(text);
      if (phrase === text) current.standaloneConfirmed = true;
      // 最も弱い高確信値を採用し、節の一般化で強さを過大評価しない。
      current.score = Math.min(current.score, score);
      if (current.texts.size >= 3 && current.standaloneConfirmed) {
        current.promoted = true;
      }
    }
    this.touch(this.phrases, phrase, current);
  }

  private setLru<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  private touch<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
  }
}

function splitPhrases(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[.!?！？。\r\n]+/u)
        .map((phrase) => phrase.trim())
        .filter(
          (phrase) =>
            phrase.length >= MIN_PHRASE_LENGTH &&
            phrase.length <= MAX_PHRASE_LENGTH,
        ),
    ),
  );
}

function toLookupResult(result: LearnedResult): LmClassificationResult {
  return {
    id: '',
    category: result.category,
    action: 'blur',
    confidence: result.score,
    score: result.score,
  };
}

function scoreFromAi(ai: LmClassificationResult): number | null {
  const value = ai.score ?? ai.confidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}
