import type {
  ChatMessage,
  FilterAction,
  FilterResult,
  SettingsV1,
} from '../types';
import { normalizeText } from './normalize';
import { matchRules } from './rules';
import { SpamDetector } from './spam';

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

  return (message: ChatMessage, settings: SettingsV1): FilterResult => {
    const profile = settings.profiles[settings.activePreset];
    const text = normalizeText(message.text);

    if (!settings.enabled || message.isOwner || message.isModerator || !text) {
      return result(0, [], ['フィルター対象外'], 'allow', false);
    }

    if (
      settings.allowedWords.some((word) => text.includes(normalizeText(word)))
    ) {
      return result(0, ['safe'], ['許可する語句に一致'], 'allow', false);
    }

    if (
      settings.blockedWords.some((word) => text.includes(normalizeText(word)))
    ) {
      return result(1, ['abuse'], ['ブロックする語句に一致'], 'hide', false);
    }

    const matches = matchRules(text).filter(
      (match) => profile.categories[match.category].enabled,
    );
    let score = 0;
    const categories: FilterResult['categories'] = [];
    const reasons: string[] = [];

    for (const match of matches) {
      const weighted = match.score * profile.categories[match.category].weight;
      score = Math.max(score, weighted);
      if (!categories.includes(match.category)) categories.push(match.category);
      if (!reasons.includes(match.reason)) reasons.push(match.reason);
    }

    if (profile.hideSpam) {
      const spamScore = spamDetector.evaluate(
        message.author,
        text,
        message.timestamp,
      );
      if (spamScore > score) score = spamScore;
      if (spamScore > 0) {
        categories.push('spam');
        reasons.push('短時間の連投または大量の絵文字');
      }
    }

    score = clamp(score);
    const action = actionForScore(score, profile.thresholds);
    const needsAi =
      settings.lmStudio.enabled &&
      score >= settings.lmStudio.uncertainMin &&
      score <= settings.lmStudio.uncertainMax;

    return result(
      score,
      categories.length > 0 ? categories : ['safe'],
      reasons.length > 0 ? reasons : ['ルールに一致しませんでした'],
      action,
      needsAi,
    );
  };
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
