import { CATEGORY_LABELS } from '../settings';
import type { DiagnosticEntry, FilterCategory, FilterResult } from '../types';

const MANAGED_CLASSES = [
  'chatsanity-pending',
  'chatsanity-dim',
  'chatsanity-blur',
  'chatsanity-hidden',
  'chatsanity-revealed',
];
const REVEAL_HANDLERS = new WeakMap<HTMLElement, () => void>();

export function resetRenderedItem(element: HTMLElement): void {
  element.classList.remove(...MANAGED_CLASSES);
  element.removeAttribute('data-chatsanity-action');
  element.querySelector('.chatsanity-placeholder')?.remove();
  element.querySelector('.chatsanity-debug-score')?.remove();
  element.querySelector('.chatsanity-ai-status')?.remove();
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
): void {
  resetRenderedItem(element);
  element.setAttribute('data-chatsanity-action', result.action);
  if (debugMode) {
    element.append(
      createDebugLabel(result.score.toFixed(2), 'chatsanity-debug-score'),
    );
    if (aiPending)
      element.append(createDebugLabel('AI検閲中', 'chatsanity-ai-status'));
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

function categoryLabel(category: FilterCategory): string {
  if (category === 'spam') return 'スパム';
  if (category === 'safe') return 'コメント';
  if (category === 'unknown') return '判定不能';
  return CATEGORY_LABELS[category];
}
