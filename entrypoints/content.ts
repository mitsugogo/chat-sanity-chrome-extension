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
import { AuditSampler, type AuditDecision } from '../lib/filter/audit-sampler';
import { SessionRuleLearner } from '../lib/filter/session-learning';
import { CATEGORY_LABELS } from '../lib/settings';
import { isLocalAiConfigured } from '../lib/settings';
import { CLASSIFIER_PROMPT_VERSION } from '../lib/local-ai/prompt';
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
  FlowChatDebugInfo,
  FlowChatDecisionSource,
  AiRequestReason,
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
import {
  FlowChatBridge,
  type FlowChatGuard,
} from '../lib/integrations/flow-chat/bridge';
import {
  FLOW_CHAT_DEADLINE_MS,
  resolveFlowChatThreshold,
  type FlowChatDecision,
} from '../lib/integrations/flow-chat/constants';
import { FlowChatMetrics } from '../lib/integrations/flow-chat/metrics';

const CLASSIFICATION_CACHE_TTL_MS = 10 * 60_000;
const AUDIT_FAILURE_COOLDOWN_MS = 30_000;

export default defineContentScript({
  matches: [
    'https://www.youtube.com/live_chat*',
    'https://www.youtube.com/live_chat_replay*',
  ],
  allFrames: true,
  runAt: 'document_start',
  cssInjectionMode: 'manifest',
  async main(ctx) {
    let settings = await loadSettings();
    let summary: SessionSummary = {
      active: true,
      hidden: 0,
      blurred: 0,
      lmStudio: settings.lmStudio.enabled ? 'unavailable' : 'disabled',
      localAi: {
        activeProvider: 'rules',
        status: 'unavailable',
      },
    };
    const processing = new ChatProcessingTracker();
    const cache = new Map<
      string,
      { result: LmClassificationResult; expiresAt: number }
    >();
    let lastProviderId: LmClassificationResult['providerId'];
    const learner = new SessionRuleLearner();
    const conflict = new ConflictScoreTracker();
    const authorHistory = new AuthorHistory();
    const recentRisk = new RecentRiskHistory();
    let auditSampler = new AuditSampler();
    let auditCooldownUntil = 0;
    const flowMetrics = new FlowChatMetrics();
    let flowSignatures = new WeakMap<HTMLElement, string>();
    const flowBridge = new FlowChatBridge(document, {
      deadlineMs: FLOW_CHAT_DEADLINE_MS,
      onTimeout: (_element, elapsedMs) => {
        flowMetrics.timeout();
        flowMetrics.finalized(false, elapsedMs);
        publishFlowMetrics();
      },
      onError: () => {
        flowMetrics.error();
        publishFlowMetrics();
      },
    });
    let evaluate = createFilterEngine();

    const publishFlowMetrics = () => {
      if (!settings.debugMode || !settings.flowChat.enabled) return;
      void sendRuntimeMessage({
        type: 'flow:metrics-update',
        metrics: flowMetrics.snapshot(),
      }).catch(() => undefined);
    };

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
          type: 'local-ai:classify',
          items,
        } satisfies RuntimeMessage)) as RuntimeResponse;
        if (
          !response.ok ||
          !('results' in response) ||
          !('providerId' in response)
        ) {
          throw new Error(
            response.ok ? '分類結果がありません。' : response.error,
          );
        }
        return response.results.map((result) => ({
          ...result,
          providerId: response.providerId,
          latencyMs: response.latencyMs,
        }));
      };
      return new ClassificationBatchQueue(
        classify,
        aiSettings.batchWindowMs,
        aiSettings.batchSize,
      );
    };
    let queue = createQueue();

    const finalizeFlow = (
      element: HTMLElement,
      guard: FlowChatGuard | undefined,
      result: FilterResult,
      source: FlowChatDecisionSource,
    ): FlowChatDebugInfo | undefined => {
      if (!guard || !settings.flowChat.enabled) return undefined;
      const threshold = resolveFlowChatThreshold(settings);
      const score = Math.min(1, Math.max(0, result.score));
      const decision: FlowChatDecision = {
        exclude: score >= threshold,
        score,
        threshold,
        source,
      };
      const finalized = guard.finalize(decision);
      const elapsedMs = Math.max(0, Date.now() - guard.startedAt);
      if (finalized) {
        flowMetrics.classified();
        flowMetrics.finalized(decision.exclude, elapsedMs);
        publishFlowMetrics();
      }
      return {
        integrationEnabled: flowBridge.isActive(),
        excluded: decision.exclude,
        threshold,
        score,
        decisionSource: source,
        elapsedMs,
      };
    };

    const finalizeUnsupported = (element: HTMLElement) => {
      if (!settings.flowChat.enabled || !flowBridge.isActive()) return;
      if (element.matches(CHAT_ITEM_SELECTOR)) return;
      if (flowBridge.isFinalized(element) || flowBridge.isPending(element))
        return;
      const startedAt = Date.now();
      const guard = flowBridge.begin(element);
      flowMetrics.received();
      const finalized = guard.finalizeAllowed('fail-open');
      if (finalized) {
        flowMetrics.finalized(false, Date.now() - startedAt);
        publishFlowMetrics();
      }
    };

    const remember = (
      message: ChatMessage,
      normalized: string,
      entry: DiagnosticEntry,
    ) => {
      if (
        settings.debugMode &&
        (entry.action !== 'allow' || entry.aiReason === 'zero-score-audit')
      ) {
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
      flowDebug: FlowChatDebugInfo | undefined,
      requestReason: AiRequestReason,
      auditDecision?: AuditDecision,
    ) => {
      const result = mergeAiResult(base, ai, settings, context, requestReason);
      const { action, score } = result;
      const category = result.categories[0] ?? 'safe';
      const auditReasons =
        requestReason === 'zero-score-audit'
          ? [
              'Zero-score Audit',
              ...(auditDecision?.reasons ?? ['同一本文の監査キャッシュ']),
              ...(auditDecision && auditDecision.probability > 0
                ? [
                    `監査確率: ${auditDecision.probability.toFixed(2)}`,
                    ...(typeof auditDecision.randomValue === 'number'
                      ? [`抽選値: ${auditDecision.randomValue.toFixed(2)}`]
                      : []),
                  ]
                : []),
            ]
          : [];
      result.reasons = [
        ...result.reasons,
        ...auditReasons,
        `${ai.providerId === 'chrome-built-in' ? 'Chrome内蔵AI' : 'LM Studio'}: ${category === 'safe' ? '安全' : category === 'spam' ? 'スパム' : category === 'unknown' ? '判定不能' : CATEGORY_LABELS[category]}`,
      ];
      const diagnostic: DiagnosticEntry = {
        id: message.id,
        text: message.text,
        category,
        score,
        action,
        reasons: result.reasons,
        ...(result.ruleIds ? { ruleIds: result.ruleIds } : {}),
        ...(result.features ? { features: result.features } : {}),
        ...(typeof result.contextAdjustment === 'number'
          ? { contextAdjustment: result.contextAdjustment }
          : {}),
        ...(flowDebug ? { flow: flowDebug } : {}),
        source: 'local-ai',
        ...(ai.providerId ? { aiProvider: ai.providerId } : {}),
        aiReason: requestReason,
        ...(typeof ai.latencyMs === 'number'
          ? { aiLatencyMs: ai.latencyMs }
          : {}),
        timestamp: message.timestamp,
      };
      renderResult(element, result, diagnostic, settings.debugMode);
      record(diagnostic);
    };

    const processItem = (element: HTMLElement) => {
      let flowStarted =
        settings.flowChat.enabled &&
        flowBridge.isActive() &&
        !flowBridge.isFinalized(element) &&
        !flowBridge.isPending(element);
      let flowGuard = flowStarted ? flowBridge.begin(element) : undefined;
      if (flowStarted) flowMetrics.received();

      const finalizeFlowAllowed = () => {
        if (!flowGuard) return;
        const finalized = flowGuard.finalizeAllowed('fail-open');
        if (finalized) {
          flowMetrics.finalized(false, Date.now() - flowGuard.startedAt);
          publishFlowMetrics();
        }
      };

      let message: ChatMessage | null;
      try {
        message = parseChatMessage(element);
      } catch {
        if (flowStarted) {
          flowMetrics.error();
          publishFlowMetrics();
        }
        finalizeFlowAllowed();
        return;
      }
      if (!message) {
        finalizeFlowAllowed();
        return;
      }
      const signature = chatMessageSignature(message);
      const previousFlowSignature = flowSignatures.get(element);
      if (previousFlowSignature && previousFlowSignature !== signature) {
        const wasTracked = flowStarted;
        flowBridge.clearElement(element);
        flowGuard =
          settings.flowChat.enabled && flowBridge.isActive()
            ? flowBridge.begin(element)
            : undefined;
        flowStarted = Boolean(flowGuard);
        if (flowStarted && !wasTracked) flowMetrics.received();
      }
      flowSignatures.set(element, signature);
      const token = processing.begin(element, signature);
      if (!token) {
        finalizeFlowAllowed();
        return;
      }
      const normalized = normalizeText(message.text);
      const author = message.authorExternalChannelId ?? message.author;
      const context = {
        conflictLevel: conflict.get(message.timestamp),
        categoryConflict: conflict.getCategoryLevels(message.timestamp),
        sameAuthorRecent: authorHistory.recent(author, message.timestamp),
        recentRiskyMessages: recentRisk.recent(message.timestamp),
      };
      let base: FilterResult;
      try {
        base = evaluate(message, settings, learner.lookup(normalized), context);
      } catch {
        if (flowStarted) {
          flowMetrics.error();
          publishFlowMetrics();
        }
        finalizeFlowAllowed();
        return;
      }
      let recordedEntry: DiagnosticEntry | undefined;
      let flowDebug: FlowChatDebugInfo | undefined;
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

      const ruleSource: FlowChatDecisionSource =
        typeof base.contextAdjustment === 'number' &&
        base.contextAdjustment !== 0
          ? 'context'
          : 'rule';
      const now = Date.now();
      const auditInput = {
        normalized,
        base,
        settings,
        conflictLevel: context.conflictLevel,
        now,
      };
      const auditEligible = auditSampler.isEligible(auditInput);
      const currentCacheKey = lastProviderId
        ? `${lastProviderId}:${CLASSIFIER_PROMPT_VERSION}:${normalized}`
        : undefined;
      const cachedEntry =
        (base.needsAi || auditEligible) && currentCacheKey
          ? cache.get(currentCacheKey)
          : undefined;
      if (cachedEntry && cachedEntry.expiresAt <= now && currentCacheKey)
        cache.delete(currentCacheKey);
      const cached =
        cachedEntry && cachedEntry.expiresAt > now
          ? cachedEntry.result
          : undefined;
      if (cached) {
        const requestReason: AiRequestReason = base.needsAi
          ? 'uncertain-score'
          : 'zero-score-audit';
        const cachedResult = mergeAiResult(
          base,
          { ...cached, id: message.id },
          settings,
          context,
          requestReason,
        );
        flowDebug = finalizeFlow(element, flowGuard, cachedResult, 'cache');
        if (flowStarted) flowMetrics.cacheHit();
        const providerId = cached.providerId ?? lastProviderId ?? 'lm-studio';
        updateSummary({
          ...summary,
          lmStudio: providerId === 'lm-studio' ? 'connected' : summary.lmStudio,
          localAi: { activeProvider: providerId, status: 'ready' },
        });
        applyAiResult(
          element,
          base,
          { ...cached, id: message.id },
          message,
          record,
          context,
          flowDebug,
          requestReason,
        );
        return;
      }

      flowDebug = finalizeFlow(element, flowGuard, base, ruleSource);

      const auditDecision =
        !base.needsAi && auditEligible && now >= auditCooldownUntil
          ? auditSampler.evaluate(auditInput)
          : undefined;
      const requestReason: AiRequestReason = base.needsAi
        ? 'uncertain-score'
        : 'zero-score-audit';
      const shouldUseLocalAi =
        base.needsAi || Boolean(auditDecision?.shouldAudit);
      const samplerForRequest = auditSampler;

      if (!shouldUseLocalAi || !isLocalAiConfigured(settings)) {
        renderResult(element, base, undefined, settings.debugMode);
        record({
          id: message.id,
          text: message.text,
          category: base.categories[0] ?? 'safe',
          score: base.score,
          action: base.action,
          reasons: base.reasons,
          ...(base.ruleIds ? { ruleIds: base.ruleIds } : {}),
          ...(base.features ? { features: base.features } : {}),
          ...(typeof base.contextAdjustment === 'number'
            ? { contextAdjustment: base.contextAdjustment }
            : {}),
          ...(flowDebug ? { flow: flowDebug } : {}),
          source: base.needsAi ? 'fallback' : 'rules',
          timestamp: message.timestamp,
        });
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
          reasons: [
            ...base.reasons,
            ...(requestReason === 'zero-score-audit'
              ? ['Zero-score Audit', ...(auditDecision?.reasons ?? [])]
              : []),
            'AI判定待機中のためルール結果を表示',
          ],
          ...(base.ruleIds ? { ruleIds: base.ruleIds } : {}),
          ...(base.features ? { features: base.features } : {}),
          ...(typeof base.contextAdjustment === 'number'
            ? { contextAdjustment: base.contextAdjustment }
            : {}),
          ...(flowDebug ? { flow: flowDebug } : {}),
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
          if (requestReason === 'zero-score-audit')
            samplerForRequest.complete();
          if (!processing.isCurrent(token)) return;
          lastProviderId = ai.providerId;
          updateSummary({
            ...summary,
            lmStudio:
              ai.providerId === 'lm-studio' ? 'connected' : summary.lmStudio,
            localAi: {
              activeProvider: ai.providerId ?? 'rules',
              status: 'ready',
            },
          });
          if (
            requestReason === 'uncertain-score' &&
            settings.lmStudio.sessionLearning
          )
            learner.observe(normalized, ai);
          const key = `${ai.providerId ?? 'lm-studio'}:${CLASSIFIER_PROMPT_VERSION}:${normalized}`;
          cache.set(key, {
            result: ai,
            expiresAt: Date.now() + CLASSIFICATION_CACHE_TTL_MS,
          });
          if (cache.size > 500) cache.delete(cache.keys().next().value ?? '');
          // Flow Chat has already received its one-shot decision. Late AI
          // responses update YouTube rendering only.
          applyAiResult(
            element,
            base,
            ai,
            message,
            record,
            context,
            flowDebug,
            requestReason,
            auditDecision,
          );
        })
        .catch((error: unknown) => {
          settled = true;
          clearTimeout(fallbackTimer);
          if (requestReason === 'zero-score-audit') {
            samplerForRequest.complete();
            auditCooldownUntil = Date.now() + AUDIT_FAILURE_COOLDOWN_MS;
          }
          if (!processing.isCurrent(token)) return;
          updateSummary({
            ...summary,
            lmStudio: settings.lmStudio.enabled ? 'unavailable' : 'disabled',
            localAi: { activeProvider: 'rules', status: 'unavailable' },
          });
          renderResult(element, base, undefined, settings.debugMode);
          record({
            id: message.id,
            text: message.text,
            category: base.categories[0] ?? 'safe',
            score: base.score,
            action: base.action,
            reasons: [
              ...base.reasons,
              ...(requestReason === 'zero-score-audit'
                ? ['Zero-score Audit', ...(auditDecision?.reasons ?? [])]
                : []),
              `ローカルAIを利用できないためルール判定を使用${error instanceof Error && error.message ? `: ${error.message}` : ''}`,
            ],
            ...(base.ruleIds ? { ruleIds: base.ruleIds } : {}),
            ...(base.features ? { features: base.features } : {}),
            ...(typeof base.contextAdjustment === 'number'
              ? { contextAdjustment: base.contextAdjustment }
              : {}),
            ...(flowDebug ? { flow: flowDebug } : {}),
            source: 'fallback',
            timestamp: message.timestamp,
          });
        });
    };

    const scan = (node: Node) => {
      const items = findChatItems(node);
      const itemSet = new Set(items);
      for (const item of items) processItem(item);
      if (!settings.flowChat.enabled || !flowBridge.isActive()) return;

      const candidates: HTMLElement[] = [];
      if (node instanceof HTMLElement && node.id === 'items') {
        candidates.push(
          ...Array.from(node.children).filter(
            (child): child is HTMLElement => child instanceof HTMLElement,
          ),
        );
      } else if (
        node instanceof HTMLElement &&
        node.parentElement?.id === 'items'
      ) {
        candidates.push(node);
      }
      for (const candidate of candidates) {
        if (!itemSet.has(candidate)) finalizeUnsupported(candidate);
      }
    };

    const root = document.querySelector('#items') ?? document.documentElement;
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
    if (settings.flowChat.enabled) flowBridge.activate();
    else flowBridge.deactivate();
    scan(root);
    publishSummary();

    const unsubscribe = subscribeSettings((next) => {
      flowBridge.deactivate();
      flowMetrics.clear();
      flowSignatures = new WeakMap<HTMLElement, string>();
      processing.reset();
      queue.dispose();
      cache.clear();
      learner.clear();
      conflict.clear();
      authorHistory.clear();
      recentRisk.clear();
      auditSampler.clear();
      auditSampler = new AuditSampler();
      auditCooldownUntil = 0;
      void sendRuntimeMessage({ type: 'debug:clear-frame' }).catch(
        () => undefined,
      );
      void sendRuntimeMessage({ type: 'flow:metrics-clear-frame' }).catch(
        () => undefined,
      );
      settings = next;
      updateSummary({
        active: true,
        hidden: 0,
        blurred: 0,
        lmStudio: next.lmStudio.enabled ? 'unavailable' : 'disabled',
        localAi: { activeProvider: 'rules', status: 'unavailable' },
      });
      lastProviderId = undefined;
      queue = createQueue();
      evaluate = createFilterEngine();
      if (settings.flowChat.enabled) flowBridge.activate();
      document
        .querySelectorAll<HTMLElement>(CHAT_ITEM_SELECTOR)
        .forEach((item) => {
          resetRenderedItem(item);
          processItem(item);
        });
      scan(root);
      publishFlowMetrics();
    });

    ctx.onInvalidated(() => {
      processing.reset();
      queue.dispose();
      cache.clear();
      learner.clear();
      conflict.clear();
      authorHistory.clear();
      recentRisk.clear();
      auditSampler.clear();
      flowBridge.deactivate();
      flowMetrics.clear();
      observer.disconnect();
      unsubscribe();
      void sendRuntimeMessage({ type: 'flow:metrics-clear-frame' }).catch(
        () => undefined,
      );
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
