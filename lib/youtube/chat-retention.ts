export const MAX_VISIBLE_CHAT_ITEMS = 500;

const CHAT_LIST_ITEM_TAG = /^yt-live-chat-[\w-]+-renderer$/;

export function trimChatItems(
  container: Element | null,
  limit = MAX_VISIBLE_CHAT_ITEMS,
): number {
  if (!container || limit < 1) return 0;

  const items = Array.from(container.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && CHAT_LIST_ITEM_TAG.test(child.localName),
  );
  const excess = Math.max(0, items.length - limit);
  for (let index = 0; index < excess; index += 1) {
    items[index]?.remove();
  }
  return excess;
}
