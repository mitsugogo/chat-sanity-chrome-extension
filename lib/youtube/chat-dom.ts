// Keep selectors for YouTube's chat list and mode controls in one place.
export const CHAT_DOM = {
  items: 'yt-live-chat-item-list-renderer #items',
  scroller: 'yt-live-chat-item-list-renderer #item-scroller',
  modeMenu: 'yt-live-chat-header-renderer #live-chat-view-selector-sub-menu',
  modeTrigger: '#label[role="button"]',
  modeOptions: 'a[aria-selected]',
  modeName: '.item',
  modeReload: 'yt-reload-continuation',
  // YouTube leaves aria-expanded stale and removes aria-hidden while open.
  openOverlay: '[role="dialog"], tp-yt-iron-dropdown',
  // The live composer currently uses contenteditable="" (also editable).
  input: '[contenteditable]:not([contenteditable="false" i])',
} as const;

export function findChatContainer(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(CHAT_DOM.items);
}
