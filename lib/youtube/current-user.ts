const CHANNEL_ID_PATTERN = /^UC[\w-]{3,}$/;

export function detectCurrentUser(root: ParentNode = document): {
  channelId?: string;
  name?: string;
} {
  const doc = root instanceof Document ? root : document;
  const channelId =
    readYtcfgChannelId() ??
    readStringProperty(
      readElementData(
        doc.querySelector<HTMLElement>('yt-live-chat-message-input-renderer'),
      ),
      'authorExternalChannelId',
    );
  const name = doc
    .querySelector('yt-live-chat-message-input-renderer #author-name')
    ?.textContent?.trim();
  return {
    ...(isChannelId(channelId) ? { channelId } : {}),
    ...(name ? { name } : {}),
  };
}

export function isSelfChatElement(
  element: HTMLElement,
  authorChannelId?: string,
  currentUser = detectCurrentUser(element.ownerDocument ?? document),
): boolean {
  if (
    currentUser.channelId &&
    authorChannelId &&
    currentUser.channelId === authorChannelId
  ) {
    return true;
  }
  if (element.hasAttribute('is-highlighted')) return true;
  if (
    element.querySelector(
      'yt-live-chat-author-chip[is-highlighted], #author-name[is-highlighted]',
    )
  ) {
    return true;
  }
  if (currentUser.channelId || authorChannelId) return false;
  const authorName = element.querySelector('#author-name')?.textContent?.trim();
  return Boolean(
    currentUser.name && authorName && currentUser.name === authorName,
  );
}

export function isChannelId(value: string | undefined): value is string {
  return Boolean(value && CHANNEL_ID_PATTERN.test(value));
}

export function readElementData(
  element: HTMLElement | null,
): Record<string, unknown> | undefined {
  if (!element || !('data' in element)) return undefined;
  const data = (element as HTMLElement & { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  return data as Record<string, unknown>;
}

export function readStringProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function readYtcfgChannelId(): string | undefined {
  const ytcfg = (
    globalThis as typeof globalThis & {
      ytcfg?: { get?: (key: string) => unknown };
    }
  ).ytcfg;
  for (const key of ['CHANNEL_ID', 'DELEGATED_CHANNEL_ID'] as const) {
    const value = ytcfg?.get?.(key);
    if (typeof value === 'string' && isChannelId(value)) return value;
  }
  return undefined;
}
