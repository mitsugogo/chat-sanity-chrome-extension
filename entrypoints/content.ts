import { browser } from 'wxt/browser';
import '../styles/content.css';
import { ClassificationBatchQueue } from '../lib/batch-queue';
import { actionForScore, createFilterEngine } from '../lib/filter/engine';
import { normalizeText } from '../lib/filter/normalize';
import { CATEGORY_LABELS } from '../lib/settings';
import { loadSettings, subscribeSettings } from '../lib/storage';
import type {
  DiagnosticEntry,
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
    const diagnostics: DiagnosticEntry[] = [];
    const cache = new Map<string, LmClassificationResult>();
    let evaluate = createFilterEngine();

    const publishSummary = () => {
      void browser.runtime
        .sendMessage({
          type: 'session:update',
          summary,
        } satisfies RuntimeMessage)
        .catch(() => undefined);
    };

    const updateSummary = (next: SessionSummary) => {
      summary = next;
      publishSummary();
    };

    const classify = async (items: Array<{ id: string; text: string }>) => {
      const response = (await browser.runtime.sendMessage({
        type: 'lm:classify',
        endpoint: settings.lmStudio.endpoint,
        model: settings.lmStudio.model,
        items,
        timeoutMs: Math.max(settings.lmStudio.timeoutMs * 4, 2_000),
      } satisfies RuntimeMessage)) as RuntimeResponse;
      if (!response.ok || !('results' in response)) {
        throw new Error(
          response.ok ? '分類結果がありません。' : response.error,
        );
      }
      updateSummary({ ...summary, lmStudio: 'connected' });
      return response.results;
    };

    let queue = new ClassificationBatchQueue(
      classify,
      settings.lmStudio.batchWindowMs,
      settings.lmStudio.batchSize,
    );

    const remember = (entry: DiagnosticEntry) => {
      diagnostics.push(entry);
      if (diagnostics.length > 100) diagnostics.shift();
      if (entry.action === 'hide')
        updateSummary({ ...summary, hidden: summary.hidden + 1 });
      if (entry.action === 'blur')
        updateSummary({ ...summary, blurred: summary.blurred + 1 });
    };

    const applyAiResult = (
      element: HTMLElement,
      base: FilterResult,
      ai: LmClassificationResult,
      text: string,
    ) => {
      const profile = settings.profiles[settings.activePreset];
      const action = actionForScore(ai.score, profile.thresholds);
      const result: FilterResult = {
        score: ai.score,
        categories: [ai.category],
        reasons: [
          `LM Studio: ${ai.category === 'safe' ? '安全' : (CATEGORY_LABELS[ai.category as keyof typeof CATEGORY_LABELS] ?? ai.category)}`,
        ],
        action,
        needsAi: false,
      };
      const diagnostic: DiagnosticEntry = {
        id: ai.id,
        text,
        category: ai.category,
        score: ai.score,
        action,
        reasons: result.reasons,
        source: 'lm-studio',
        timestamp: Date.now(),
      };
      renderResult(element, result, diagnostic);
      remember(diagnostic);
      return base;
    };

    const processItem = (element: HTMLElement) => {
      const message = parseChatMessage(element);
      if (!message) return;
      const token = processing.begin(element, chatMessageSignature(message));
      if (!token) return;
      const base = evaluate(message, settings);
      const normalized = normalizeText(message.text);

      if (!base.needsAi || !settings.lmStudio.model) {
        renderResult(element, base);
        remember({
          id: message.id,
          text: message.text,
          category: base.categories[0] ?? 'safe',
          score: base.score,
          action: base.action,
          reasons: base.reasons,
          source: settings.lmStudio.enabled ? 'fallback' : 'rules',
          timestamp: message.timestamp,
        });
        return;
      }

      const cached = cache.get(normalized);
      if (cached) {
        applyAiResult(
          element,
          base,
          { ...cached, id: message.id },
          message.text,
        );
        return;
      }

      renderPending(element);
      let settled = false;
      const fallbackTimer = window.setTimeout(() => {
        if (settled || !processing.isCurrent(token)) return;
        renderResult(element, base);
      }, settings.lmStudio.timeoutMs);

      void queue
        .enqueue({ id: message.id, text: normalized })
        .then((ai) => {
          settled = true;
          clearTimeout(fallbackTimer);
          if (!processing.isCurrent(token)) return;
          cache.set(normalized, ai);
          if (cache.size > 500) cache.delete(cache.keys().next().value ?? '');
          applyAiResult(element, base, ai, message.text);
        })
        .catch(() => {
          settled = true;
          clearTimeout(fallbackTimer);
          if (!processing.isCurrent(token)) return;
          updateSummary({ ...summary, lmStudio: 'unavailable' });
          renderResult(element, base);
          remember({
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
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    publishSummary();

    const unsubscribe = subscribeSettings((next) => {
      settings = next;
      updateSummary({
        active: true,
        hidden: 0,
        blurred: 0,
        lmStudio: next.lmStudio.enabled ? 'unavailable' : 'disabled',
      });
      queue = new ClassificationBatchQueue(
        classify,
        next.lmStudio.batchWindowMs,
        next.lmStudio.batchSize,
      );
      processing.reset();
      evaluate = createFilterEngine();
      document
        .querySelectorAll<HTMLElement>(CHAT_ITEM_SELECTOR)
        .forEach((item) => {
          resetRenderedItem(item);
          processItem(item);
        });
    });

    ctx.onInvalidated(() => {
      observer.disconnect();
      unsubscribe();
      void browser.runtime
        .sendMessage({ type: 'session:remove' } satisfies RuntimeMessage)
        .catch(() => undefined);
    });
  },
});
