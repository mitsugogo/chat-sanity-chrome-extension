import type {
  ChatMessage,
  FilterCategory,
  FilterAction,
  FilterResult,
  AiRequestReason,
  LmClassificationResult,
  SettingsV1,
} from '../types';
import { CATEGORY_LABELS } from '../settings';
import { normalizeText } from './normalize';
import { isObviouslySafe } from './obvious-safe';
import { prefilter } from './prefilter';
import { matchRules } from './rules';
import { SpamDetector } from './spam';
import { extractFeatures } from './features';

export interface FilterContext {
  conflictLevel?: number;
  categoryConflict?: Partial<Record<FilterCategory, number>>;
  sameAuthorRecent?: string[];
  recentRiskyMessages?: string[];
  /** Optional stream participant names; never forwarded to LM Studio. */
  targetNames?: string[];
}

export function actionForScore(
  score: number,
  thresholds: { dim: number; blur: number; hide: number },
): FilterAction {
  if (score >= thresholds.hide) return 'hide';
  if (score >= thresholds.blur) return 'blur';
  if (score >= thresholds.dim) return 'dim';
  return 'allow';
}

export function createFilterEngine() {
  const spamDetector = new SpamDetector();

  return (
    message: ChatMessage,
    settings: SettingsV1,
    learned?: LmClassificationResult | null,
    context?: FilterContext,
  ): FilterResult => {
    const profile = settings.profiles[settings.activePreset];
    const text = normalizeText(message.text);

    if (!settings.enabled || message.isOwner || message.isModerator || !text) {
      return result(0, [], ['フィルター対象外'], 'allow', false, 'excluded');
    }

    if (
      settings.allowedWords.some(
        (word) =>
          normalizeText(word).length > 0 && text.includes(normalizeText(word)),
      )
    ) {
      return result(
        0,
        ['safe'],
        ['許可する語句に一致'],
        'allow',
        false,
        'explicit-safe',
      );
    }

    if (
      settings.blockedWords.some(
        (word) =>
          normalizeText(word).length > 0 && text.includes(normalizeText(word)),
      )
    ) {
      return result(
        1,
        ['personal_attack'],
        ['ブロックする語句に一致'],
        'hide',
        false,
        'matched',
      );
    }

    if (isObviouslySafe(text)) {
      return result(
        0,
        ['safe'],
        ['明らかなリアクション'],
        'allow',
        false,
        'explicit-safe',
      );
    }

    const candidates = prefilter(text);
    const ruleMatches = matchRules(text, context?.targetNames);
    if (
      settings.lmStudio.enabled &&
      settings.lmStudio.sessionLearning &&
      learned &&
      learned.category !== 'safe' &&
      learned.category !== 'spam' &&
      learned.category !== 'unknown'
    ) {
      ruleMatches.push({
        category: learned.category,
        score: scoreFromAi(learned) ?? 0,
        reason: '閲覧中のAI判定から昇格した一時ルール',
        ruleId: 'SESSION_LEARNED_001',
        feature: 'session-learning',
      });
    }
    const matches = ruleMatches.filter(
      (match) => profile.categories[match.category].enabled,
    );
    let score = 0;
    const categories: FilterResult['categories'] = [];
    const categoryScores: Partial<Record<FilterCategory, number>> = {};
    const ruleIds: string[] = [];
    const features: string[] = [];
    const reasons: string[] =
      candidates.type === 'suspicious' ? [...candidates.reasons] : [];

    for (const match of matches) {
      const weighted = match.score * profile.categories[match.category].weight;
      score = Math.max(score, weighted);
      categoryScores[match.category] = Math.max(
        categoryScores[match.category] ?? 0,
        weighted,
      );
      if (match.ruleId && !ruleIds.includes(match.ruleId))
        ruleIds.push(match.ruleId);
      if (match.feature && !features.includes(match.feature))
        features.push(match.feature);
      if (!categories.includes(match.category)) categories.push(match.category);
      if (!reasons.includes(match.reason)) reasons.push(match.reason);
    }

    const extracted = extractFeatures(text, context?.targetNames);
    for (const feature of [
      extracted.safeContext.feature,
      extracted.question.feature,
      extracted.metaConflict.aggressive
        ? 'aggressive-meta-conflict'
        : extracted.metaConflict.peacekeeping
          ? 'peacekeeping-meta-conflict'
          : undefined,
    ]) {
      if (feature && !features.includes(feature)) features.push(feature);
    }

    const safeAdjusted = applySafeContextModifier(
      score,
      categories,
      extracted.safeContext.matched,
      reasons,
    );
    score = safeAdjusted.score;
    const adjusted = applyContextModifier(score, categories, context, reasons);
    score = adjusted.score;

    if (profile.hideSpam) {
      const spamScore = spamDetector.evaluate(
        message.authorExternalChannelId ?? message.author,
        text,
        message.timestamp,
        score,
      );
      if (spamScore > score) score = spamScore;
      if (spamScore > 0) {
        categories.push('spam');
        categoryScores.spam = Math.max(categoryScores.spam ?? 0, spamScore);
        ruleIds.push('SPAM_DETECTOR_001');
        features.push('repetition-or-emoji-spam');
        reasons.push('短時間の連投または大量の絵文字');
      }
    }

    score = clamp(score);
    const action = actionForResult(score, categories, profile);
    const needsAi =
      settings.lmStudio.enabled &&
      score >= settings.lmStudio.uncertainMin &&
      score <= settings.lmStudio.uncertainMax;
    const finalReasons =
      categories.length === 0
        ? ['ルールに一致しませんでした']
        : reasons.length > 0
          ? reasons
          : ['ルールに一致しませんでした'];

    return result(
      score,
      categories.length > 0 ? categories : ['safe'],
      finalReasons,
      action,
      needsAi,
      ruleMatches.length > 0 || categories.includes('spam')
        ? 'matched'
        : 'unmatched',
      {
        confidence: clamp(score),
        categoryScores,
        ruleIds,
        features,
        contextAdjustment: safeAdjusted.adjustment + adjusted.adjustment,
      },
    );
  };
}

export function mergeAiResult(
  base: FilterResult,
  ai: LmClassificationResult,
  settings: SettingsV1,
  context?: FilterContext,
  requestReason: AiRequestReason = 'uncertain-score',
): FilterResult {
  const profile = settings.profiles[settings.activePreset];
  const isEligibleAudit =
    requestReason === 'zero-score-audit' &&
    base.ruleDisposition === 'unmatched' &&
    base.score === 0;
  if (
    (!base.needsAi && !isEligibleAudit) ||
    !settings.enabled ||
    !settings.lmStudio.enabled
  )
    return base;
  if (ai.category === 'unknown')
    return {
      ...base,
      needsAi: false,
      reasons: [...base.reasons, 'LM Studioが判定不能を返しました'],
    };
  if (
    ai.category === 'spam'
      ? !profile.hideSpam
      : ai.category !== 'safe' && !profile.categories[ai.category].enabled
  ) {
    return { ...base, needsAi: false };
  }
  const weight =
    ai.category === 'safe' || ai.category === 'spam'
      ? 1
      : profile.categories[ai.category].weight;
  const aiScore = scoreFromAi(ai);
  if (aiScore === null) return { ...base, needsAi: false };
  let score = clamp(
    ai.category === 'safe' || ai.action === 'allow'
      ? Math.min(aiScore, 0.34)
      : aiScore * weight,
  );
  // Posting-frequency evidence cannot be overturned by a text-only classifier.
  if (base.categories.includes('spam') && base.score > score)
    return { ...base, needsAi: false };
  const reasons = [
    ...base.reasons,
    `LM Studioによる${categoryLabel(ai.category)}判定`,
  ];
  const adjusted = applyContextModifier(score, [ai.category], context, reasons);
  score = clamp(adjusted.score);
  return {
    score,
    categories: [ai.category],
    reasons,
    action: actionForResult(score, [ai.category], profile),
    needsAi: false,
    ruleDisposition: base.ruleDisposition,
    confidence: scoreFromAi(ai) ?? score,
    categoryScores: {
      ...(base.categoryScores ?? {}),
      [ai.category]: score,
    },
    ruleIds: [
      ...(base.ruleIds ?? []),
      ...['LLM_CLASSIFICATION_001'].filter(
        (id) => !(base.ruleIds ?? []).includes(id),
      ),
    ],
    features: [...(base.features ?? []), 'llm-classification'],
    contextAdjustment: (base.contextAdjustment ?? 0) + adjusted.adjustment,
  };
}

function applyContextModifier(
  initialScore: number,
  categories: FilterResult['categories'],
  context: FilterContext | undefined,
  reasons: string[],
): { score: number; adjustment: number } {
  let score = initialScore;
  let adjustment = 0;
  const isRiskCategory = categories.some(
    (category) =>
      category !== 'safe' && category !== 'spam' && category !== 'unknown',
  );
  if (!isRiskCategory || !context) return { score, adjustment };

  if (
    (context.conflictLevel ?? 0) >= 0.7 &&
    categories.some(
      (category) => category === 'complaint' || category === 'meta_conflict',
    )
  ) {
    const next = Math.min(1, score + 0.05);
    adjustment += next - score;
    score = next;
    if (!reasons.includes('チャット全体の対立度による文脈補正'))
      reasons.push('チャット全体の対立度による文脈補正');
  }

  if (initialScore >= 0.35) {
    const categoryLevel = Math.max(
      ...categories.map(
        (category) => context.categoryConflict?.[category] ?? 0,
      ),
      0,
    );
    if (categoryLevel >= 0.55) {
      const next = Math.min(1, score + 0.04);
      adjustment += next - score;
      score = next;
      if (!reasons.includes('カテゴリ別の直近対立度による文脈補正'))
        reasons.push('カテゴリ別の直近対立度による文脈補正');
    }
  }

  if (initialScore >= 0.35 && (context.sameAuthorRecent?.length ?? 0) >= 2) {
    const next = Math.min(1, score + 0.08);
    adjustment += next - score;
    score = next;
    if (!reasons.includes('同一投稿者の直近リスク投稿による補正'))
      reasons.push('同一投稿者の直近リスク投稿による補正');
  }

  if (initialScore >= 0.35 && (context.recentRiskyMessages?.length ?? 0) >= 3) {
    const next = Math.min(1, score + 0.04);
    adjustment += next - score;
    score = next;
    if (!reasons.includes('直近のリスク投稿による文脈補正'))
      reasons.push('直近のリスク投稿による文脈補正');
  }
  return { score, adjustment };
}

function applySafeContextModifier(
  initialScore: number,
  categories: FilterResult['categories'],
  hasSafeContext: boolean,
  reasons: string[],
): { score: number; adjustment: number } {
  const hasStrongRisk = categories.some(
    (category) =>
      category === 'personal_attack' ||
      category === 'blame' ||
      category === 'spam',
  );
  if (
    !hasSafeContext ||
    hasStrongRisk ||
    initialScore < 0.35 ||
    initialScore > 0.7
  )
    return { score: initialScore, adjustment: 0 };
  const next = Math.max(0, initialScore - 0.04);
  if (!reasons.includes('笑い・疑問形による安全文脈補正'))
    reasons.push('笑い・疑問形による安全文脈補正');
  return { score: next, adjustment: next - initialScore };
}

function categoryLabel(category: FilterCategory): string {
  if (category === 'safe') return '安全';
  if (category === 'spam') return 'スパム';
  if (category === 'unknown') return '判定不能';
  return CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
}

function actionForResult(
  score: number,
  categories: FilterResult['categories'],
  profile: SettingsV1['profiles'][SettingsV1['activePreset']],
): FilterAction {
  if (categories.includes('spam'))
    return actionForScore(score, profile.thresholds);
  const category = categories.find(
    (value) => value !== 'safe' && value !== 'spam' && value !== 'unknown',
  );
  if (category) {
    const mode = profile.categories[category]?.mode;
    if (mode && mode !== 'threshold') return mode;
  }
  return actionForScore(score, profile.thresholds);
}

function scoreFromAi(ai: LmClassificationResult): number | null {
  const value = ai.score ?? ai.confidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function result(
  score: number,
  categories: FilterResult['categories'],
  reasons: string[],
  action: FilterAction,
  needsAi: boolean,
  ruleDisposition: FilterResult['ruleDisposition'],
  metadata?: Pick<
    FilterResult,
    | 'confidence'
    | 'categoryScores'
    | 'ruleIds'
    | 'features'
    | 'contextAdjustment'
  >,
): FilterResult {
  return {
    score,
    categories,
    reasons,
    action,
    needsAi,
    ruleDisposition,
    ...metadata,
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}
