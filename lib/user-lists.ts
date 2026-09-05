import type { ChatMessage, SettingsV1, TrackedUser } from './types';

export const MAX_TRACKED_USERS = 50;

export function channelIdOf(message: ChatMessage): string | undefined {
  const value = message.authorExternalChannelId?.trim();
  return value || undefined;
}

export function isWhitelistedUser(
  settings: SettingsV1,
  message: ChatMessage,
): boolean {
  if (message.isSelf) return true;
  const channelId = channelIdOf(message);
  return Boolean(
    channelId &&
    settings.whitelistedUsers.some((user) => user.channelId === channelId),
  );
}

export function isHiddenUser(
  settings: SettingsV1,
  message: ChatMessage,
): boolean {
  const channelId = channelIdOf(message);
  if (!channelId || isWhitelistedUser(settings, message)) return false;
  return settings.hiddenUsers.some((user) => user.channelId === channelId);
}

export function addHiddenUser(
  settings: SettingsV1,
  user: TrackedUser,
): SettingsV1 {
  const channelId = user.channelId.trim();
  if (!channelId) return settings;
  if (settings.whitelistedUsers.some((item) => item.channelId === channelId)) {
    return settings;
  }
  if (settings.hiddenUsers.some((item) => item.channelId === channelId)) {
    return settings;
  }
  return {
    ...settings,
    hiddenUsers: [...settings.hiddenUsers, { ...user, channelId }].slice(
      -MAX_TRACKED_USERS,
    ),
  };
}

export function whitelistUser(
  settings: SettingsV1,
  channelId: string,
): SettingsV1 {
  const id = channelId.trim();
  if (!id) return settings;
  const existing =
    settings.hiddenUsers.find((user) => user.channelId === id) ??
    settings.whitelistedUsers.find((user) => user.channelId === id);
  return {
    ...settings,
    hiddenUsers: settings.hiddenUsers.filter((user) => user.channelId !== id),
    whitelistedUsers: existing
      ? [
          ...settings.whitelistedUsers.filter((user) => user.channelId !== id),
          existing,
        ].slice(-MAX_TRACKED_USERS)
      : settings.whitelistedUsers,
  };
}

export function removeHiddenUser(
  settings: SettingsV1,
  channelId: string,
): SettingsV1 {
  return {
    ...settings,
    hiddenUsers: settings.hiddenUsers.filter(
      (user) => user.channelId !== channelId,
    ),
  };
}

export function removeWhitelistedUser(
  settings: SettingsV1,
  channelId: string,
): SettingsV1 {
  return {
    ...settings,
    whitelistedUsers: settings.whitelistedUsers.filter(
      (user) => user.channelId !== channelId,
    ),
  };
}

export function normalizeTrackedUsers(value: unknown): TrackedUser[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const users: TrackedUser[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<TrackedUser>;
    const channelId =
      typeof record.channelId === 'string' ? record.channelId.trim() : '';
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    users.push({
      channelId,
      displayName:
        typeof record.displayName === 'string'
          ? record.displayName.trim().slice(0, 80)
          : '',
      addedAt:
        typeof record.addedAt === 'number' && Number.isFinite(record.addedAt)
          ? record.addedAt
          : 0,
    });
    if (users.length >= MAX_TRACKED_USERS) break;
  }
  return users;
}
