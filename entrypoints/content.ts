import { browser } from 'wxt/browser';
import '../styles/content.css';
import { ClassificationBatchQueue } from '../lib/batch-queue';
import {
  AuthorHistory,
  ConflictScoreTracker,
  RecentRiskHistory,
} from '../lib/context';
import {
  mergeAiResult,
  createFilterEngine,
  type FilterContext,
} from '../lib/filter/engine';
import { normalizeText } from '../lib/filter/normalize';
import { SessionRuleLearner } from '../lib/filter/session-learning';
import { CATEGORY_LABELS } from '../lib/settings';
import { loadSettings, subscribeSettings } from '../lib/storage';
import type {
  DiagnosticEntry,
  ChatMessage,
  LmClassificationItem,
  FilterResult,
  LmClassificationResult,
  RuntimeMessage,
  RuntimeResponse,
  SessionSummary,
} from '../lib/types';
import {
  CHAT_ITEM_SELECTOR,
  chatMessageSignature,
  findChatItems,
  parseChatMessage,
} from '../lib/youtube/adapter';
import { ChatProcessingTracker } from '../lib/youtube/processing-tracker';
import {
  renderPending,
  renderResult,
  resetRenderedItem,
} from '../lib/youtube/renderer';

const CLASSIFICATION_CACHE_TTL_MS = 10 * 60_000;

export default defineContentScript({
  matches: [
    'https://www.youtube.com/live_chat*',
    'https://www.youtube.com/live_chat_replay*',
  ],
  allFrames: true,
  cssInjectionMode: 'manifest',
  async main(ctx) {
    let settings = await loadSettings();
    let summary: SessionSummary = {
      active: true,
      hidden: 0,
      blurred: 0,
      lmStudio: settings.lmStudio.enabled ? 'unavailable' : 'disabled',
    };
    const processing = new ChatProcessingTracker();
    const cache = new Map<
      string,
      { result: LmClassificationResult; expiresAt: number }
    >();
    const learner = new SessionRuleLearner();
    const conflict = new ConflictScoreTracker();
    const authorHistory = new AuthorHistory();
    const recentRisk = new RecentRiskHistory();
    let evaluate = createFilterEngine();

    const publishSummary = () => {
      void sendRuntimeMessage({
        type: 'session:update',
        summary,
      }).catch(() => undefined);
    };

    const updateSummary = (next: SessionSummary) => {
      summary = next;
      publishSummary();
    };

    const createQueue = () => {
      const aiSettings = { ...settings.lmStudio };
      const classify = async (items: LmClassificationItem[]) => {
        const response = (await browser.runtime.sendMessage({
          type: 'lm:classify',
          endpoint: aiSettings.endpoint,
          model: aiSettings.model,
          items,
          timeoutMs: aiSettings.requestTimeoutMs,
          responseFormat: aiSettings.responseFormat,
        } satisfies RuntimeMessage)) as RuntimeResponse;
        if (!response.ok || !('results' in response)) {
          throw new Error(
            response.ok ? '分類結果がありません。' : response.error,
          );
        }
        return response.results;
      };
      return new ClassificationBatchQueue(
        classify,
        aiSettings.batchWindowMs,
        aiSettings.batchSize,
      );
    };
    let queue = createQueue();

    const remember = (
      message: ChatMessage,
      normalized: string,
      entry: DiagnosticEntry,
    ) => {
      if (settings.debugMode && entry.action !== 'allow') {
        void sendRuntimeMessage({ type: 'debug:add', entry }).catch(
          () => undefined,
        );
      }
      const category = entry.category;
      conflict.observe(category, entry.score, message.timestamp);
      const author = message.authorExternalChannelId ?? message.author;
      authorHistory.observe(author, normalized, message.timestamp, entry.score);
      recentRisk.observe(normalized, message.timestamp, entry.score);
      if (entry.action === 'hide')
        updateSummary({ ...summary, hidden: summary.hidden + 1 });
      if (entry.action === 'blur')
        updateSummary({ ...summary, blurred: summary.blurred + 1 });
    };

    const applyAiResult = (
      element: HTMLElement,
      base: FilterResult,
      ai: LmClassificationResult,
      message: ChatMessage,
      record: (entry: DiagnosticEntry) => void,
      context: FilterContext,
    ) => {
      const result = mergeAiResult(base, ai, settings, context);
      const { action, score } = result;
      const category = result.categories[0] ?? 'safe';
      result.reasons = [
        ...result.reasons,
        `LM Studio: ${category === 'safe' ? '安全' : category === 'spam' ? 'スパム' : category === 'unknown' ? '判定不能' : CATEGORY_LABELS[category]}`,
      ];
      const diagnostic: DiagnosticEntry = {
        id: message.id,
        text: message.text,
        category,
        score,
        action,
        reasons: result.reasons,
        source: 'lm-studio',
        timestamp: message.timestamp,
      };
      renderResult(element, result, diagnostic, settings.debugMode);
      record(diagnostic);
    };

    const processItem = (element: HTMLElement) => {
      const message = parseChatMessage(element);
      if (!message) return;
      const token = processing.begin(element, chatMessageSignature(message));
      if (!token) return;
      const normalized = normalizeText(message.text);
      const author = message.authorExternalChannelId ?? message.author;
      const context = {
        conflictLevel: conflict.get(message.timestamp),
        sameAuthorRecent: authorHistory.recent(author, message.timestamp),
        recentRiskyMessages: recentRisk.recent(message.timestamp),
      };
      const base = evaluate(
        message,
        settings,
        learner.lookup(normalized),
        context,
      );
      let recordedEntry: DiagnosticEntry | undefined;
      const record = (entry: DiagnosticEntry) => {
        if (!recordedEntry) {
          recordedEntry = entry;
          remember(message, normalized, entry);
          return;
        }
        const previous = recordedEntry;
        recordedEntry = entry;
        if (settings.debugMode) {
          // DebugHistoryStore treats the message ID as an upsert key. An
          // allow entry also removes a previous fallback entry.
          void sendRuntimeMessage({ type: 'debug:add', entry }).catch(
            () => undefined,
          );
        }
        if (previous.action !== entry.action) {
          updateSummary({
            ...summary,
            hidden:
              summary.hidden -
              (previous.action === 'hide' ? 1 : 0) +
              (entry.action === 'hide' ? 1 : 0),
            blurred:
              summary.blurred -
              (previous.action === 'blur' ? 1 : 0) +
              (entry.action === 'blur' ? 1 : 0),
          });
        }
      };

      if (!base.needsAi || !settings.lmStudio.model) {
        renderResult(element, base, undefined, settings.debugMode);
        record({
          id: message.id,
          text: message.text,
          category: base.categories[0] ?? 'safe',
          score: base.score,
          action: base.action,
          reasons: base.reasons,
          source: base.needsAi ? 'fallback' : 'rules',
          timestamp: message.timestamp,
        });
        return;
      }

      const now = Date.now();
      const cachedEntry = cache.get(normalized);
      if (cachedEntry && cachedEntry.expiresAt <= now) {
        cache.delete(normalized);
      }
      const cached =
        cachedEntry && cachedEntry.expiresAt > now
          ? cachedEntry.result
          : undefined;
      if (cached) {
        updateSummary({ ...summary, lmStudio: 'connected' });
        applyAiResult(
          element,
          base,
          { ...cached, id: message.id },
          message,
          record,
          context,
        );
        return;
      }

      renderPending(element, settings.debugMode);
      let settled = false;
      const fallbackTimer = window.setTimeout(() => {
        if (settled || !processing.isCurrent(token)) return;
        const fallbackEntry: DiagnosticEntry = {
          id: message.id,
          text: message.text,
          category: base.categories[0] ?? 'safe',
          score: base.score,
          action: base.action,
          reasons: [...base.reasons, 'AI判定待機中のためルール結果を表示'],
          source: 'fallback',
          timestamp: message.timestamp,
        };
        renderResult(element, base, fallbackEntry, settings.debugMode, true);
        record(fallbackEntry);
      }, settings.lmStudio.timeoutMs);

      void queue
        .enqueue({
          id: crypto.randomUUID(),
          text: normalized,
          sameAuthorRecent: context.sameAuthorRecent,
          recentRiskyMessages: context.recentRiskyMessages,
          conflictLevel: context.conflictLevel,
        })
        .then((ai) => {
          settled = true;
          clearTimeout(fallbackTimer);
          if (!processing.isCurrent(token)) return;
          updateSummary({ ...summary, lmStudio: 'connected' });
          if (settings.lmStudio.sessionLearning)
            learner.observe(normalized, ai);
          cache.set(normalized, {
            result: ai,
            expiresAt: Date.now() + CLASSIFICATION_CACHE_TTL_MS,
          });
          if (cache.size > 500) cache.delete(cache.keys().next().value ?? '');
          applyAiResult(element, base, ai, message, record, context);
        })
        .catch(() => {
          settled = true;
          clearTimeout(fallbackTimer);
          if (!processing.isCurrent(token)) return;
          updateSummary({ ...summary, lmStudio: 'unavailable' });
          renderResult(element, base, undefined, settings.debugMode);
          record({
            id: message.id,
            text: message.text,
            category: base.categories[0] ?? 'safe',
            score: base.score,
            action: base.action,
            reasons: [
              ...base.reasons,
              'LM Studioへ接続できないためルール判定を使用',
            ],
            source: 'fallback',
            timestamp: message.timestamp,
          });
        });
    };

    const scan = (node: Node) => {
      for (const item of findChatItems(node)) processItem(item);
    };

    const root = document.querySelector('#items') ?? document.documentElement;
    scan(root);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        scan(mutation.target);
        for (const node of mutation.addedNodes) scan(node);
      }
    });
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    publishSummary();

    const unsubscribe = subscribeSettings((next) => {
      processing.reset();
      queue.dispose();
      cache.clear();
      learner.clear();
      conflict.clear();
      authorHistory.clear();
      recentRisk.clear();
      void sendRuntimeMessage({ type: 'debug:clear-frame' }).catch(
        () => undefined,
      );
      settings = next;
      updateSummary({
        active: true,
        hidden: 0,
        blurred: 0,
        lmStudio: next.lmStudio.enabled ? 'unavailable' : 'disabled',
      });
      queue = createQueue();
      evaluate = createFilterEngine();
      document
        .querySelectorAll<HTMLElement>(CHAT_ITEM_SELECTOR)
        .forEach((item) => {
          resetRenderedItem(item);
          processItem(item);
        });
    });

    ctx.onInvalidated(() => {
      processing.reset();
      queue.dispose();
      cache.clear();
      learner.clear();
      conflict.clear();
      authorHistory.clear();
      recentRisk.clear();
      observer.disconnect();
      unsubscribe();
      void sendRuntimeMessage({ type: 'session:remove' }).catch(
        () => undefined,
      );
    });
  },
});

function sendRuntimeMessage(message: RuntimeMessage): Promise<unknown> {
  try {
    return Promise.resolve(browser.runtime.sendMessage(message));
  } catch (error) {
    return Promise.reject(error);
  }
}
