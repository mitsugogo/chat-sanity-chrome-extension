import type {
  ChatMessage,
  FilterCategory,
  FilterAction,
  FilterResult,
  LmClassificationResult,
  SettingsV1,
} from '../types';
import { CATEGORY_LABELS } from '../settings';
import { normalizeText } from './normalize';
import { isObviouslySafe } from './obvious-safe';
import { prefilter } from './prefilter';
import { matchRules } from './rules';
import { SpamDetector } from './spam';

export interface FilterContext {
  conflictLevel?: number;
  sameAuthorRecent?: string[];
  recentRiskyMessages?: string[];
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
      return result(0, [], ['フィルター対象外'], 'allow', false);
    }

    if (
      settings.allowedWords.some(
        (word) =>
          normalizeText(word).length > 0 && text.includes(normalizeText(word)),
      )
    ) {
      return result(0, ['safe'], ['許可する語句に一致'], 'allow', false);
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
      );
    }

    if (isObviouslySafe(text)) {
      return result(0, ['safe'], ['明らかなリアクション'], 'allow', false);
    }

    const hasLearnedRule =
      settings.lmStudio.enabled &&
      settings.lmStudio.sessionLearning &&
      learned !== null &&
      learned !== undefined &&
      learned.category !== 'safe' &&
      learned.category !== 'spam' &&
      learned.category !== 'unknown' &&
      scoreFromAi(learned) !== null;

    const candidates = prefilter(text);
    if (candidates.type === 'safe' && !hasLearnedRule) {
      return result(
        0,
        ['safe'],
        ['リスク候補に一致しませんでした'],
        'allow',
        false,
      );
    }

    const ruleMatches = matchRules(text);
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
      });
    }
    const matches = ruleMatches.filter(
      (match) => profile.categories[match.category].enabled,
    );
    let score = 0;
    const categories: FilterResult['categories'] = [];
    const reasons: string[] =
      candidates.type === 'suspicious' ? [...candidates.reasons] : [];

    for (const match of matches) {
      const weighted = match.score * profile.categories[match.category].weight;
      score = Math.max(score, weighted);
      if (!categories.includes(match.category)) categories.push(match.category);
      if (!reasons.includes(match.reason)) reasons.push(match.reason);
    }

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
    );
  };
}

export function mergeAiResult(
  base: FilterResult,
  ai: LmClassificationResult,
  settings: SettingsV1,
  context?: FilterContext,
): FilterResult {
  const profile = settings.profiles[settings.activePreset];
  if (!base.needsAi || !settings.enabled || !settings.lmStudio.enabled)
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
  };
}

function applyContextModifier(
  initialScore: number,
  categories: FilterResult['categories'],
  context: FilterContext | undefined,
  reasons: string[],
): { score: number } {
  let score = initialScore;
  const isRiskCategory = categories.some(
    (category) =>
      category !== 'safe' && category !== 'spam' && category !== 'unknown',
  );
  if (!isRiskCategory || !context) return { score };

  if (
    (context.conflictLevel ?? 0) >= 0.7 &&
    categories.some(
      (category) => category === 'complaint' || category === 'meta_conflict',
    )
  ) {
    score = Math.min(1, score + 0.05);
    if (!reasons.includes('チャット全体の対立度による文脈補正'))
      reasons.push('チャット全体の対立度による文脈補正');
  }

  if (initialScore >= 0.35 && (context.sameAuthorRecent?.length ?? 0) >= 2) {
    score = Math.min(1, score + 0.08);
    if (!reasons.includes('同一投稿者の直近リスク投稿による補正'))
      reasons.push('同一投稿者の直近リスク投稿による補正');
  }

  if (initialScore >= 0.35 && (context.recentRiskyMessages?.length ?? 0) >= 3) {
    score = Math.min(1, score + 0.04);
    if (!reasons.includes('直近のリスク投稿による文脈補正'))
      reasons.push('直近のリスク投稿による文脈補正');
  }
  return { score };
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
): FilterResult {
  return { score, categories, reasons, action, needsAi };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}
