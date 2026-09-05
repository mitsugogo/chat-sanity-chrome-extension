import type {
  FilterCategory,
  LmClassificationItem,
  LmClassificationResult,
} from '../types';

const ALLOWED_CATEGORIES = new Set<string>([
  'safe',
  'backseat',
  'blame',
  'personal_attack',
  'comparison',
  'meta_conflict',
  'complaint',
  'spam',
  'unknown',
  'abuse',
  'instruction',
  'pigeon',
  'concern',
  'spoiler',
]);

const CATEGORY_ALIASES: Record<string, FilterCategory> = {
  abuse: 'personal_attack',
  instruction: 'backseat',
  concern: 'complaint',
};

export function validateResults(
  value: unknown,
  items: LmClassificationItem[],
  providerLabel = 'ローカルAI',
): LmClassificationResult[] {
  if (!Array.isArray(value))
    throw new Error(`${providerLabel}の応答形式が不正です。`);
  const expectedIds = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const results: LmClassificationResult[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object')
      throw new Error(`${providerLabel}の分類結果が不正です。`);
    const candidate = item as Record<string, unknown>;
    const rawCategory = candidate.category;
    const legacyOnly =
      candidate.action === undefined &&
      candidate.confidence === undefined &&
      typeof candidate.score === 'number';
    if (
      typeof candidate.id !== 'string' ||
      !expectedIds.has(candidate.id) ||
      seen.has(candidate.id) ||
      typeof rawCategory !== 'string' ||
      !ALLOWED_CATEGORIES.has(rawCategory)
    ) {
      throw new Error(`${providerLabel}の分類結果が不正です。`);
    }
    const score = legacyOnly ? candidate.score : candidate.confidence;
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    )
      throw new Error(`${providerLabel}の分類結果が不正です。`);
    const category = legacyOnly
      ? (rawCategory as FilterCategory)
      : (CATEGORY_ALIASES[rawCategory] ?? (rawCategory as FilterCategory));
    const action =
      candidate.action === undefined
        ? score >= 0.5
          ? 'blur'
          : 'allow'
        : candidate.action;
    if (action !== 'allow' && action !== 'blur')
      throw new Error(`${providerLabel}の分類結果が不正です。`);
    seen.add(candidate.id);
    results.push(
      legacyOnly
        ? { id: candidate.id, category, score }
        : {
            id: candidate.id,
            category,
            action:
              category === 'safe' || category === 'unknown' ? 'allow' : action,
            confidence: score,
          },
    );
  }
  if (seen.size !== expectedIds.size)
    throw new Error(`${providerLabel}の分類結果が不足しています。`);
  return results;
}
