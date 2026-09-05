import type { ChatMessage } from '../types';
import {
  detectCurrentUser,
  isSelfChatElement,
  readElementData,
  readStringProperty,
} from './current-user';

export const CHAT_ITEM_SELECTOR = [
  'yt-live-chat-text-message-renderer',
  'yt-live-chat-paid-message-renderer',
  'yt-live-chat-membership-item-renderer',
].join(',');

export function findChatItems(node: Node): HTMLElement[] {
  const element =
    node instanceof HTMLElement ? node : (node.parentElement ?? undefined);
  if (!element) return [];

  const items = new Set<HTMLElement>();
  const closest = element.closest<HTMLElement>(CHAT_ITEM_SELECTOR);
  if (closest) items.add(closest);
  if (element.matches(CHAT_ITEM_SELECTOR)) items.add(element);
  for (const item of element.querySelectorAll<HTMLElement>(
    CHAT_ITEM_SELECTOR,
  )) {
    items.add(item);
  }
  return Array.from(items);
}

export function chatMessageSignature(message: ChatMessage): string {
  return JSON.stringify([
    message.id,
    message.authorExternalChannelId,
    message.author,
    message.text,
    message.isOwner,
    message.isModerator,
    message.isMember,
    message.isPaidMessage,
    Boolean(message.isStampOnly),
    Boolean(message.isSelf),
  ]);
}

export function parseChatMessage(element: HTMLElement): ChatMessage | null {
  const messageNode = element.querySelector<HTMLElement>('#message');
  const authorNode = element.querySelector<HTMLElement>('#author-name');
  const { text, isStampOnly } = extractMessageContent(messageNode);
  if (!text && !isStampOnly) return null;

  const author = authorNode?.textContent?.trim() ?? '';
  const badges = element.querySelector('#chat-badges');
  const id =
    element.getAttribute('id') ||
    element.getAttribute('data-id') ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const authorExternalChannelId =
    firstAttribute(
      element,
      authorNode,
      'data-author-id',
      'data-channel-id',
      'data-author-external-channel-id',
    ) ??
    readStringProperty(readElementData(element), 'authorExternalChannelId');
  const currentUser = detectCurrentUser(element.ownerDocument ?? document);
  const isSelf = isSelfChatElement(
    element,
    authorExternalChannelId,
    currentUser,
  );

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
    ...(isStampOnly ? { isStampOnly: true } : {}),
    ...(isSelf ? { isSelf: true } : {}),
    ...(authorExternalChannelId ? { authorExternalChannelId } : {}),
  };
}

function extractMessageContent(messageNode: HTMLElement | null): {
  text: string;
  isStampOnly: boolean;
} {
  if (!messageNode) return { text: '', isStampOnly: false };
  const text = messageNode.textContent?.trim() ?? '';
  const images = messageNode.querySelectorAll<HTMLImageElement>('img');
  if (images.length === 0) return { text, isStampOnly: false };

  // Custom emoji / membership stamp nodes often have no textContent.
  // Walk text and alt labels in DOM order so mixed messages keep both.
  const parts: string[] = [];
  let hasText = false;
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent?.trim();
      if (value) {
        hasText = true;
        parts.push(value);
      }
      return;
    }
    if (node instanceof HTMLImageElement) {
      const value = node.alt.trim();
      if (value) parts.push(value);
      return;
    }
    node.childNodes.forEach(visit);
  };
  visit(messageNode);
  return {
    text: parts.join(' ').trim(),
    isStampOnly: !hasText,
  };
}

function firstAttribute(
  element: HTMLElement,
  authorNode: HTMLElement | null,
  ...names: string[]
): string | undefined {
  for (const node of [element, authorNode]) {
    if (!node) continue;
    for (const name of names) {
      const value = node.getAttribute(name)?.trim();
      if (value) return value;
    }
  }
  return undefined;
}
