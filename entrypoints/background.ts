import { browser } from 'wxt/browser';
import { listModels } from '../lib/lm-studio';
import { LocalAiResolver } from '../lib/local-ai/resolver';
import { DebugHistoryStore } from '../lib/debug-history';
import { FlowChatMetricsStore } from '../lib/integrations/flow-chat/metrics';
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
let resolver: LocalAiResolver | undefined;
let resolverFingerprint = '';

async function getResolver(): Promise<LocalAiResolver> {
  const settings = await loadSettings();
  const nextFingerprint = JSON.stringify({
    mode: settings.localAiMode,
    chromeBuiltIn: settings.chromeBuiltIn,
    lmStudio: settings.lmStudio,
  });
  if (!resolver || resolverFingerprint !== nextFingerprint) {
    resolver?.dispose();
    resolver = new LocalAiResolver({
      mode: settings.localAiMode,
      chromeBuiltIn: settings.chromeBuiltIn,
      lmStudio: {
        enabled: settings.lmStudio.enabled,
        endpoint: settings.lmStudio.endpoint,
        model: settings.lmStudio.model,
        timeoutMs: settings.lmStudio.requestTimeoutMs,
        responseFormat: settings.lmStudio.responseFormat,
      },
    });
    resolverFingerprint = nextFingerprint;
  }
  return resolver;
}

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
  const debugHistory = new DebugHistoryStore();
  const flowMetrics = new FlowChatMetricsStore();
  void ensureSettings();

  browser.runtime.onInstalled.addListener(() => {
    void ensureSettings();
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    debugHistory.removeTab(tabId);
    flowMetrics.clearTab(tabId);
    void removeTabSessions(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      debugHistory.removeTab(tabId);
      flowMetrics.clearTab(tabId);
      void removeTabSessions(tabId);
    }
  });

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const request = message as RuntimeMessage;
    if (request.type === 'debug:get') {
      return Promise.resolve<RuntimeResponse>({
        ok: true,
        entries: debugHistory.list(),
        flowMetrics: flowMetrics.aggregate(),
      });
    }

    if (request.type === 'debug:clear') {
      debugHistory.clear();
      flowMetrics.clear();
      return Promise.resolve<RuntimeResponse>({ ok: true });
    }

    if (
      request.type === 'flow:metrics-update' ||
      request.type === 'flow:metrics-clear-frame'
    ) {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (typeof tabId !== 'number' || typeof frameId !== 'number') {
        return Promise.resolve<RuntimeResponse>({
          ok: false,
          error: 'チャットフレームを特定できません。',
        });
      }
      if (request.type === 'flow:metrics-update')
        flowMetrics.update(tabId, frameId, request.metrics);
      else flowMetrics.clearFrame(tabId, frameId);
      return Promise.resolve<RuntimeResponse>({ ok: true });
    }

    if (request.type === 'debug:add' || request.type === 'debug:clear-frame') {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (typeof tabId !== 'number' || typeof frameId !== 'number') {
        return Promise.resolve<RuntimeResponse>({
          ok: false,
          error: 'チャットフレームを特定できません。',
        });
      }
      if (request.type === 'debug:add') {
        debugHistory.add(tabId, frameId, request.entry);
      } else {
        debugHistory.removeFrame(tabId, frameId);
      }
      return Promise.resolve<RuntimeResponse>({ ok: true });
    }
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
      debugHistory.removeFrame(tabId, frameId);
      return removeSession(tabId, frameId).then<RuntimeResponse>(() => ({
        ok: true,
      }));
    }

    if (request.type === 'session:get-summary') {
      return Promise.all([
        getTabSessions(request.tabId),
        getLmStudioStatus(),
        getResolver().then((current) => current.getStatus()),
      ]).then<RuntimeResponse>(([sessions, lmStudio, localAiStatus]) => ({
        ok: true,
        summary: aggregateSessionSummaries(sessions, lmStudio, {
          activeProvider: localAiStatus.providerId ?? 'rules',
          status:
            localAiStatus.availability === 'available'
              ? 'ready'
              : localAiStatus.availability === 'downloading'
                ? 'downloading'
                : 'unavailable',
        }),
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

    if (request.type === 'local-ai:get-status') {
      return getResolver()
        .then((current) => current.getStatus())
        .then<RuntimeResponse>((status) => ({ ok: true, ...status }))
        .catch<RuntimeResponse>(() => ({
          ok: true,
          availability: 'error',
        }));
    }

    if (request.type === 'local-ai:classify') {
      return getResolver()
        .then((current) => current.classify(request.items))
        .then<RuntimeResponse>((classification) => ({
          ok: true,
          ...classification,
        }))
        .catch<RuntimeResponse>((error: unknown) => ({
          ok: false,
          error:
            error instanceof Error ? error.message : '分類に失敗しました。',
        }));
    }

    return undefined;
  });
});
