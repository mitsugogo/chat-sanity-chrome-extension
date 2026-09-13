import { CATEGORY_LABELS } from '../settings';
import {
  FEEDBACK_CATEGORY_CHOICES,
  MISSED_CATEGORY_CHOICES,
  type FeedbackJudgement,
} from '../feedback/types';
import type { DiagnosticEntry, FilterCategory, FilterResult } from '../types';

const MANAGED_CLASSES = [
  'chatsanity-pending',
  'chatsanity-dim',
  'chatsanity-blur',
  'chatsanity-hidden',
  'chatsanity-revealed',
];
const REVEAL_HANDLERS = new WeakMap<HTMLElement, () => void>();
let feedbackControlSequence = 0;

export interface InlineFeedbackHandlers {
  onSubmit: (
    judgement: FeedbackJudgement,
    correctCategory: FilterCategory,
  ) => Promise<void>;
}

export function resetRenderedItem(element: HTMLElement): void {
  element.classList.remove(...MANAGED_CLASSES);
  element.removeAttribute('data-chatsanity-action');
  element.querySelector('.chatsanity-placeholder')?.remove();
  element.querySelector('.chatsanity-debug-score')?.remove();
  element.querySelector('.chatsanity-ai-status')?.remove();
  element.querySelector('.chatsanity-feedback-controls')?.remove();
  const message = element.querySelector<HTMLElement>('#message');
  if (message) clearRevealHandler(message);
  message?.removeAttribute('title');
  message?.removeAttribute('aria-label');
}

export function renderPending(element: HTMLElement, debugMode = false): void {
  resetRenderedItem(element);
  element.classList.add('chatsanity-pending');
  element.setAttribute('data-chatsanity-action', 'pending');
  element.append(createPlaceholder('判定中…', false));
  if (debugMode)
    element.append(createDebugLabel('AI検閲中', 'chatsanity-ai-status'));
}

export function renderResult(
  element: HTMLElement,
  result: FilterResult,
  diagnostic?: DiagnosticEntry,
  debugMode = false,
  aiPending = false,
  feedbackHandlers?: InlineFeedbackHandlers,
): void {
  resetRenderedItem(element);
  element.setAttribute('data-chatsanity-action', result.action);
  if (debugMode) {
    element.append(
      createDebugLabel(result.score.toFixed(2), 'chatsanity-debug-score'),
    );
    if (aiPending)
      element.append(createDebugLabel('AI検閲中', 'chatsanity-ai-status'));
    if (diagnostic && feedbackHandlers)
      element.append(createFeedbackControls(diagnostic, feedbackHandlers));
  }
  if (result.action === 'allow') return;

  if (result.action === 'dim') {
    element.classList.add('chatsanity-dim');
    return;
  }

  if (result.action === 'blur') {
    element.classList.add('chatsanity-blur');
    const message = element.querySelector<HTMLElement>('#message');
    if (message) {
      message.title = 'クリックして一時表示';
      attachRevealHandler(message, () =>
        element.classList.toggle('chatsanity-revealed'),
      );
    }
    return;
  }

  element.classList.add('chatsanity-hidden');
  const category = diagnostic?.category ?? result.categories[0] ?? 'safe';
  const categoryText = categoryLabel(category);
  const reasonText = result.reasons.join('・') || 'フィルタールールに一致';
  const message = element.querySelector<HTMLElement>('#message');
  if (message) {
    message.title = `${categoryText}: ${reasonText}。クリックして一時表示`;
    message.setAttribute(
      'aria-label',
      `${categoryText}として非表示。判定理由: ${reasonText}。クリックして原文を表示`,
    );
    attachRevealHandler(message, () =>
      element.classList.add('chatsanity-revealed'),
    );
  }
}

function attachRevealHandler(message: HTMLElement, reveal: () => void): void {
  clearRevealHandler(message);
  const handler = () => {
    REVEAL_HANDLERS.delete(message);
    reveal();
  };
  REVEAL_HANDLERS.set(message, handler);
  message.addEventListener('click', handler, { once: true });
}

function clearRevealHandler(message: HTMLElement): void {
  const handler = REVEAL_HANDLERS.get(message);
  if (!handler) return;
  message.removeEventListener('click', handler);
  REVEAL_HANDLERS.delete(message);
}

function createDebugLabel(label: string, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = label;
  span.setAttribute(
    'aria-label',
    label === 'AI検閲中' ? label : `判定スコア ${label}`,
  );
  return span;
}

function createPlaceholder(
  label: string,
  interactive: boolean,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chatsanity-placeholder';
  button.textContent = label;
  button.disabled = !interactive;
  return button;
}

function createFeedbackControls(
  diagnostic: DiagnosticEntry,
  handlers: InlineFeedbackHandlers,
): HTMLElement {
  const controls = document.createElement('div');
  controls.className = 'chatsanity-feedback-controls';
  controls.setAttribute('aria-label', '判定フィードバック');

  const report = createFeedbackButton('NG');
  report.setAttribute(
    'aria-label',
    diagnostic.category === 'safe' ? '問題コメントとして報告' : '判定を訂正',
  );
  report.title = report.getAttribute('aria-label') ?? '';
  report.addEventListener('click', () => {
    // A category can be deliberately displayed by a preset even though the
    // classifier found a problem. Only a safe prediction is a false-negative
    // candidate; every other category must keep the correction flow.
    if (diagnostic.category === 'safe') {
      showCategoryChooser(
        controls,
        handlers,
        'missed',
        '問題カテゴリ',
        MISSED_CATEGORY_CHOICES,
      );
    } else {
      showCategoryChooser(
        controls,
        handlers,
        'incorrect',
        '本来のカテゴリ',
        FEEDBACK_CATEGORY_CHOICES,
      );
    }
  });
  controls.append(report);
  return controls;
}

function showCategoryChooser(
  controls: HTMLElement,
  handlers: InlineFeedbackHandlers,
  judgement: Extract<FeedbackJudgement, 'incorrect' | 'missed'>,
  legendText: string,
  categories: readonly FilterCategory[],
): void {
  const existing = controls.querySelector('.chatsanity-feedback-chooser');
  if (existing) {
    existing.remove();
    return;
  }
  const chooser = document.createElement('fieldset');
  chooser.className = 'chatsanity-feedback-chooser';
  const legend = document.createElement('legend');
  legend.textContent = legendText;
  chooser.append(legend);

  const name = `chatsanity-feedback-category-${feedbackControlSequence++}`;
  let selectedCategory: FilterCategory | undefined;
  const submit = createFeedbackButton('このカテゴリで記録');
  submit.disabled = true;
  for (const category of categories) {
    const id = `${name}-${category}`;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.id = id;
    input.value = category;
    input.addEventListener('change', () => {
      selectedCategory = category;
      submit.disabled = false;
    });
    const text = document.createElement('span');
    text.textContent = categoryLabel(category);
    label.htmlFor = id;
    label.append(input, text);
    chooser.append(label);
  }
  submit.addEventListener('click', () => {
    if (!selectedCategory) return;
    void submitFeedback(controls, handlers, judgement, selectedCategory);
  });
  chooser.append(submit);
  controls.append(chooser);
}

async function submitFeedback(
  controls: HTMLElement,
  handlers: InlineFeedbackHandlers,
  judgement: FeedbackJudgement,
  correctCategory: FilterCategory,
): Promise<void> {
  const buttons = controls.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    await handlers.onSubmit(judgement, correctCategory);
    controls.replaceChildren();
    const status = document.createElement('span');
    status.className = 'chatsanity-feedback-status';
    status.textContent = '✓';
    status.title = 'フィードバックを記録しました';
    status.setAttribute('aria-label', 'フィードバックを記録しました');
    status.setAttribute('role', 'status');
    controls.append(status);
  } catch {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    let error = controls.querySelector<HTMLElement>(
      '.chatsanity-feedback-error',
    );
    if (!error) {
      error = document.createElement('span');
      error.className = 'chatsanity-feedback-error';
      error.setAttribute('role', 'alert');
      controls.append(error);
    }
    error.textContent = '保存できませんでした。もう一度お試しください。';
  }
}

function createFeedbackButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chatsanity-feedback-button';
  button.textContent = label;
  return button;
}

function categoryLabel(category: FilterCategory): string {
  if (category === 'spam') return 'スパム';
  if (category === 'hidden_user') return '非表示ユーザー';
  if (category === 'safe') return 'コメント';
  if (category === 'unknown') return '判定不能';
  return CATEGORY_LABELS[category];
}
