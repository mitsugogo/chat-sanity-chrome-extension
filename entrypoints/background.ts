import { browser } from 'wxt/browser';
import { listModels } from '../lib/lm-studio';
import { LocalAiResolver } from '../lib/local-ai/resolver';
import {
  AI_SAFE_MEMORY_PORT_NAME,
  classifyWithSafeMemory,
  PersistentAiSafeMemory,
  type AiSafeMemoryPortMessage,
} from '../lib/local-ai/safe-memory';
import { DebugHistoryStore } from '../lib/debug-history';
import { IndexedDbFeedbackStore } from '../lib/feedback/store';
import {
  FEEDBACK_MEMORY_PORT_NAME,
  type FeedbackMemoryPortMessage,
} from '../lib/feedback/types';
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
  const feedbackStore = new IndexedDbFeedbackStore();
  const safeMemory = new PersistentAiSafeMemory(browser.storage.local);
  const feedbackPorts = new Map<
    ReturnType<typeof browser.runtime.connect>,
    FeedbackMemoryPortMessage[] | undefined
  >();
  const safeMemoryPorts = new Map<
    ReturnType<typeof browser.runtime.connect>,
    AiSafeMemoryPortMessage[] | undefined
  >();
  const flowMetrics = new FlowChatMetricsStore();
  void ensureSettings();

  const postFeedbackMemory = (
    port: ReturnType<typeof browser.runtime.connect>,
    message: FeedbackMemoryPortMessage,
  ): boolean => {
    try {
      port.postMessage(message);
      return true;
    } catch {
      feedbackPorts.delete(port);
      return false;
    }
  };

  const publishFeedbackMemory = (message: FeedbackMemoryPortMessage) => {
    for (const [port, pending] of feedbackPorts) {
      if (pending) {
        pending.push(message);
        continue;
      }
      postFeedbackMemory(port, message);
    }
  };

  const publishSafeMemory = (message: AiSafeMemoryPortMessage) => {
    for (const [port, pending] of safeMemoryPorts) {
      if (pending) {
        pending.push(message);
        continue;
      }
      try {
        port.postMessage(message);
      } catch {
        safeMemoryPorts.delete(port);
      }
    }
  };

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === AI_SAFE_MEMORY_PORT_NAME) {
      safeMemoryPorts.set(port, []);
      port.onDisconnect.addListener(() => safeMemoryPorts.delete(port));
      void safeMemory
        .listFingerprints()
        .then((fingerprints) => {
          const pending = safeMemoryPorts.get(port);
          if (!pending) return;
          try {
            port.postMessage({ kind: 'replace', fingerprints });
            safeMemoryPorts.set(port, undefined);
            for (const message of pending) port.postMessage(message);
          } catch {
            safeMemoryPorts.delete(port);
          }
        })
        .catch(() => safeMemoryPorts.delete(port));
      return;
    }
    if (port.name !== FEEDBACK_MEMORY_PORT_NAME) return;
    feedbackPorts.set(port, []);
    port.onDisconnect.addListener(() => feedbackPorts.delete(port));
    void feedbackStore
      .listExactMemories()
      .then((memories) => {
        const pending = feedbackPorts.get(port);
        if (
          !pending ||
          !postFeedbackMemory(port, { kind: 'replace', memories })
        )
          return;
        feedbackPorts.set(port, undefined);
        for (const message of pending) {
          if (!postFeedbackMemory(port, message)) break;
        }
      })
      .catch(() => feedbackPorts.delete(port));
  });

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
    if (request.type === 'feedback:add') {
      return feedbackStore
        .add(request.entry)
        .then<RuntimeResponse>(({ exactMemory, feedbackStats }) => {
          publishFeedbackMemory({ kind: 'update', memory: exactMemory });
          return { ok: true, exactMemory, feedbackStats };
        })
        .catch<RuntimeResponse>((error: unknown) => ({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'フィードバックを保存できませんでした。',
        }));
    }

    if (request.type === 'feedback:list') {
      return feedbackStore
        .list()
        .then<RuntimeResponse>((feedbackEntries) => ({
          ok: true,
          feedbackEntries,
        }))
        .catch<RuntimeResponse>(() => ({
          ok: false,
          error: 'フィードバック一覧を取得できませんでした。',
        }));
    }

    if (request.type === 'feedback:stats') {
      return Promise.all([
        feedbackStore.listRuleStats(),
        feedbackStore.summary(),
      ])
        .then<RuntimeResponse>(([feedbackStats, feedbackSummary]) => ({
          ok: true,
          feedbackStats,
          feedbackSummary,
        }))
        .catch<RuntimeResponse>(() => ({
          ok: false,
          error: 'フィードバック統計を取得できませんでした。',
        }));
    }

    if (request.type === 'feedback:exact-list') {
      return feedbackStore
        .listExactMemories()
        .then<RuntimeResponse>((exactMemories) => ({ ok: true, exactMemories }))
        .catch<RuntimeResponse>(() => ({
          ok: false,
          error: 'フィードバック記憶を取得できませんでした。',
        }));
    }

    if (request.type === 'feedback:lookup-exact') {
      return feedbackStore
        .lookupExact(request.normalizedText)
        .then<RuntimeResponse>((exactFeedback) => ({ ok: true, exactFeedback }))
        .catch<RuntimeResponse>(() => ({
          ok: false,
          error: 'フィードバック記憶を取得できませんでした。',
        }));
    }

    if (request.type === 'feedback:clear') {
      return feedbackStore
        .clear()
        .then<RuntimeResponse>(() => {
          publishFeedbackMemory({ kind: 'clear' });
          return { ok: true };
        })
        .catch<RuntimeResponse>(() => ({
          ok: false,
          error: 'フィードバックを消去できませんでした。',
        }));
    }

    if (request.type === 'feedback:export') {
      return feedbackStore
        .exportJsonl()
        .then<RuntimeResponse>((jsonl) => ({ ok: true, jsonl }))
        .catch<RuntimeResponse>(() => ({
          ok: false,
          error: 'フィードバックをエクスポートできませんでした。',
        }));
    }

    if (request.type === 'safe-memory:list') {
      return safeMemory
        .listFingerprints()
        .then<RuntimeResponse>((safeFingerprints) => ({
          ok: true,
          safeFingerprints,
        }))
        .catch<RuntimeResponse>(() => ({
          ok: false,
          error: 'AIセーフ記憶を取得できませんでした。',
        }));
    }

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
      return classifyWithSafeMemory(
        request.items,
        safeMemory,
        async (items) => (await getResolver()).classify(items),
        (fingerprint) => publishSafeMemory({ kind: 'update', fingerprint }),
      )
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
