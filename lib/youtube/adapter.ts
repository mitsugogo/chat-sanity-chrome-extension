import type { ChatMessage } from '../types';

export const CHAT_ITEM_SELECTOR = [
  'yt-live-chat-text-message-renderer',
  'yt-live-chat-paid-message-renderer',
  'yt-live-chat-membership-item-renderer',
].join(',');

export function findChatItems(node: Node): HTMLElement[] {
  const element =
    node instanceof HTMLElement ? node : node.parentElement ?? undefined;
  if (!element) return [];

  const items = new Set<HTMLElement>();
  const closest = element.closest<HTMLElement>(CHAT_ITEM_SELECTOR);
  if (closest) items.add(closest);
  if (element.matches(CHAT_ITEM_SELECTOR)) items.add(element);
  for (const item of element.querySelectorAll<HTMLElement>(CHAT_ITEM_SELECTOR)) {
    items.add(item);
  }
  return Array.from(items);
}

export function chatMessageSignature(message: ChatMessage): string {
  return JSON.stringify([
    message.id,
    message.author,
    message.text,
    message.isOwner,
    message.isModerator,
    message.isMember,
    message.isPaidMessage,
  ]);
}

export function parseChatMessage(element: HTMLElement): ChatMessage | null {
  const messageNode = element.querySelector<HTMLElement>('#message');
  const authorNode = element.querySelector<HTMLElement>('#author-name');
  const text = messageNode?.textContent?.trim() ?? '';
  if (!text) return null;

  const author = authorNode?.textContent?.trim() ?? '';
  const badges = element.querySelector('#chat-badges');
  const id =
    element.getAttribute('id') ||
    element.getAttribute('data-id') ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    id,
    author,
    text,
    isOwner:
      authorNode?.hasAttribute('is-chat-owner') === true ||
      Boolean(badges?.querySelector('[type="owner"]')),
    isModerator:
      authorNode?.hasAttribute('is-moderator') === true ||
      Boolean(badges?.querySelector('[type="moderator"]')),
    isMember:
      authorNode?.hasAttribute('is-member') === true ||
      Boolean(badges?.querySelector('[type="member"]')),
    isPaidMessage: element.matches('yt-live-chat-paid-message-renderer'),
    timestamp: Date.now(),
  };
}
