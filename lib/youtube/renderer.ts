import { CATEGORY_LABELS } from '../settings';
import type { DiagnosticEntry, FilterCategory, FilterResult } from '../types';

const MANAGED_CLASSES = [
  'chatsanity-pending',
  'chatsanity-dim',
  'chatsanity-blur',
  'chatsanity-hidden',
  'chatsanity-revealed',
];

export function resetRenderedItem(element: HTMLElement): void {
  element.classList.remove(...MANAGED_CLASSES);
  element.removeAttribute('data-chatsanity-action');
  element.querySelector('.chatsanity-placeholder')?.remove();
  element.querySelector('#message')?.removeAttribute('title');
}

export function renderPending(element: HTMLElement): void {
  resetRenderedItem(element);
  element.classList.add('chatsanity-pending');
  element.setAttribute('data-chatsanity-action', 'pending');
  element.append(createPlaceholder('判定中…', false));
}

export function renderResult(
  element: HTMLElement,
  result: FilterResult,
  diagnostic?: DiagnosticEntry,
): void {
  resetRenderedItem(element);
  element.setAttribute('data-chatsanity-action', result.action);
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
      const reveal = () => element.classList.toggle('chatsanity-revealed');
      message.addEventListener('click', reveal, { once: true });
    }
    return;
  }

  element.classList.add('chatsanity-hidden');
  const category = diagnostic?.category ?? result.categories[0] ?? 'safe';
  const categoryText = categoryLabel(category);
  const reasonText = result.reasons.join('・') || 'フィルタールールに一致';
  const placeholder = createPlaceholder('非表示', true);
  placeholder.title = `${categoryText}: ${reasonText}`;
  placeholder.setAttribute(
    'aria-label',
    `${categoryText}として非表示。クリックして原文と判定理由を表示`,
  );
  placeholder.setAttribute('aria-expanded', 'false');
  placeholder.addEventListener('click', () => {
    const revealed = element.classList.toggle('chatsanity-revealed');
    placeholder.textContent = revealed
      ? `${categoryText}: ${reasonText}（再び隠す）`
      : '非表示';
    placeholder.setAttribute('aria-expanded', String(revealed));
  });
  element.append(placeholder);
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
  return CATEGORY_LABELS[category];
}
