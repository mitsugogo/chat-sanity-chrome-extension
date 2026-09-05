import { browser } from 'wxt/browser';
import { classifyWithLmStudio, listModels } from '../lib/lm-studio';
import {
  aggregateSessionSummaries,
  type LmStudioStatus,
  type StoredSessionSummary,
} from '../lib/session-summary';
import { ensureSettings, loadSettings } from '../lib/storage';
import type {
  RuntimeMessage,
  RuntimeResponse,
  SessionSummary,
} from '../lib/types';

const SESSION_PREFIX = 'session-summary:';

function sessionKey(tabId: number, frameId: number): string {
  return `${SESSION_PREFIX}${tabId}:${frameId}`;
}

async function updateSession(
  tabId: number,
  frameId: number,
  summary: SessionSummary,
): Promise<void> {
  const value: StoredSessionSummary = {
    tabId,
    frameId,
    summary,
    updatedAt: Date.now(),
  };
  await browser.storage.session.set({ [sessionKey(tabId, frameId)]: value });
}

async function removeSession(tabId: number, frameId: number): Promise<void> {
  await browser.storage.session.remove(sessionKey(tabId, frameId));
}

async function removeTabSessions(tabId: number): Promise<void> {
  const stored = await browser.storage.session.get(null);
  const keys = Object.entries(stored)
    .filter(
      ([key, value]) =>
        key.startsWith(SESSION_PREFIX) &&
        isStoredSessionSummary(value) &&
        value.tabId === tabId,
    )
    .map(([key]) => key);
  if (keys.length > 0) await browser.storage.session.remove(keys);
}

async function getTabSessions(tabId: number): Promise<StoredSessionSummary[]> {
  const stored = await browser.storage.session.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(SESSION_PREFIX))
    .map(([, value]) => value)
    .filter(
      (value): value is StoredSessionSummary =>
        isStoredSessionSummary(value) && value.tabId === tabId,
    );
}

function isStoredSessionSummary(value: unknown): value is StoredSessionSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredSessionSummary>;
  return (
    typeof candidate.tabId === 'number' &&
    typeof candidate.frameId === 'number' &&
    typeof candidate.updatedAt === 'number' &&
    typeof candidate.summary?.active === 'boolean' &&
    typeof candidate.summary.hidden === 'number' &&
    typeof candidate.summary.blurred === 'number'
  );
}

async function getLmStudioStatus(): Promise<LmStudioStatus> {
  const settings = await loadSettings();
  if (!settings.lmStudio.enabled) return 'disabled';
  try {
    await listModels(settings.lmStudio.endpoint);
    return 'connected';
  } catch {
    return 'unavailable';
  }
}

export default defineBackground(() => {
  void ensureSettings();

  browser.runtime.onInstalled.addListener(() => {
    void ensureSettings();
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void removeTabSessions(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') void removeTabSessions(tabId);
  });

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const request = message as RuntimeMessage;
    if (request.type === 'session:update') {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (typeof tabId !== 'number' || typeof frameId !== 'number') {
        return Promise.resolve<RuntimeResponse>({
          ok: false,
          error: 'チャットフレームを特定できません。',
        });
      }
      return updateSession(
        tabId,
        frameId,
        request.summary,
      ).then<RuntimeResponse>(() => ({ ok: true }));
    }

    if (request.type === 'session:remove') {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (typeof tabId !== 'number' || typeof frameId !== 'number') {
        return Promise.resolve<RuntimeResponse>({ ok: true });
      }
      return removeSession(tabId, frameId).then<RuntimeResponse>(() => ({
        ok: true,
      }));
    }

    if (request.type === 'session:get-summary') {
      return Promise.all([
        getTabSessions(request.tabId),
        getLmStudioStatus(),
      ]).then<RuntimeResponse>(([sessions, lmStudio]) => ({
        ok: true,
        summary: aggregateSessionSummaries(sessions, lmStudio),
      }));
    }

    if (request.type === 'lm:list-models') {
      return listModels(request.endpoint)
        .then<RuntimeResponse>((models) => ({ ok: true, models }))
        .catch<RuntimeResponse>((error: unknown) => ({
          ok: false,
          error:
            error instanceof Error ? error.message : '接続に失敗しました。',
        }));
    }

    if (request.type === 'lm:classify') {
      return classifyWithLmStudio(
        request.endpoint,
        request.model,
        request.items,
        request.timeoutMs,
      )
        .then<RuntimeResponse>((results) => ({ ok: true, results }))
        .catch<RuntimeResponse>((error: unknown) => ({
          ok: false,
          error:
            error instanceof Error ? error.message : '分類に失敗しました。',
        }));
    }

    return undefined;
  });
});
