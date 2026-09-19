import { browser } from 'wxt/browser';
import '../styles/content.css';
import {
  AiQueueFallbackError,
  ClassificationBatchQueue,
} from '../lib/batch-queue';
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
import { FeedbackLearner } from '../lib/feedback/learner';
import {
  createFeedbackEntry,
  FEEDBACK_MEMORY_PORT_NAME,
  isFeedbackMemoryPortMessage,
  type FeedbackJudgement,
} from '../lib/feedback/types';
import { CATEGORY_LABELS } from '../lib/settings';
import { isLocalAiConfigured } from '../lib/settings';
import { CLASSIFIER_PROMPT_VERSION } from '../lib/local-ai/prompt';
import { resolveLocalAiLoadPolicy } from '../lib/local-ai/load-policy';
import {
  AI_SAFE_MEMORY_PORT_NAME,
  fingerprintText,
  isAiSafeMemoryPortMessage,
} from '../lib/local-ai/safe-memory';
import { loadSettings, saveSettings, subscribeSettings } from '../lib/storage';
import { addHiddenUser } from '../lib/user-lists';
import { AuthorRestrictionTracker } from '../lib/filter/author-restriction';
import { isChannelId } from '../lib/youtube/current-user';
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
  SettingsV1,
} from '../lib/types';
import {
  CHAT_ITEM_SELECTOR,
  chatMessageSignature,
  findChatItems,
  parseChatMessage,
} from '../lib/youtube/adapter';
import { ChatProcessingTracker } from '../lib/youtube/processing-tracker';
import {
  clearModeratorSticky,
  refreshLatestModeratorSticky,
  renderModeratorSticky,
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
const AI_QUEUE_SKIP_LABELS = {
  overloaded: '混雑',
  expired: '期限切れ',
  disposed: '設定変更',
} as const;

export default defineContentScript({
  matches: [
    'https://www.youtube.com/live_chat*',
    'https://www.youtube.com/live_chat_replay*',
  ],
  allFrames: true,
  runAt: 'document_start',
  cssInjectionMode: 'manifest',
  async main(ctx) {
    const [initialSettings, feedbackResponse, safeMemoryResponse] =
      await Promise.all([
        loadSettings(),
        sendRuntimeMessage({ type: 'feedback:exact-list' }).catch(
          () => undefined,
        ),
        sendRuntimeMessage({ type: 'safe-memory:list' }).catch(() => undefined),
      ]);
    let settings = initialSettings;
    const feedbackLearner = new FeedbackLearner();
    const feedbackSnapshot = feedbackResponse as RuntimeResponse | undefined;
    if (feedbackSnapshot?.ok && 'exactMemories' in feedbackSnapshot)
      feedbackLearner.hydrate(feedbackSnapshot.exactMemories);
    const safeFingerprints = new Set<string>();
    const safeMemorySnapshot = safeMemoryResponse as
      RuntimeResponse | undefined;
    if (safeMemorySnapshot?.ok && 'safeFingerprints' in safeMemorySnapshot) {
      for (const fingerprint of safeMemorySnapshot.safeFingerprints)
        safeFingerprints.add(fingerprint);
    }
    let feedbackPort: ReturnType<typeof browser.runtime.connect> | undefined;
    let safeMemoryPort: ReturnType<typeof browser.runtime.connect> | undefined;
    let feedbackPortDisposed = false;
    const connectFeedbackMemory = () => {
      if (
        feedbackPortDisposed ||
        feedbackPort ||
        typeof browser.runtime.connect !== 'function'
      )
        return;
      try {
        const port = browser.runtime.connect({
          name: FEEDBACK_MEMORY_PORT_NAME,
        });
        feedbackPort = port;
        port.onMessage.addListener((message: unknown) => {
          if (!isFeedbackMemoryPortMessage(message)) return;
          if (message.kind === 'replace')
            feedbackLearner.hydrate(message.memories);
          else if (message.kind === 'update')
            feedbackLearner.observeMemory(message.memory);
          else feedbackLearner.clear();
        });
        port.onDisconnect.addListener(() => {
          if (feedbackPort !== port) return;
          feedbackPort = undefined;
          if (!feedbackPortDisposed)
            window.setTimeout(connectFeedbackMemory, 1_000);
        });
      } catch {
        // The initial snapshot above keeps filtering available if the worker is
        // restarting or extension messaging has already been invalidated.
      }
    };
    connectFeedbackMemory();
    const connectSafeMemory = () => {
      if (
        feedbackPortDisposed ||
        safeMemoryPort ||
        typeof browser.runtime.connect !== 'function'
      )
        return;
      try {
        const port = browser.runtime.connect({
          name: AI_SAFE_MEMORY_PORT_NAME,
        });
        safeMemoryPort = port;
        port.onMessage.addListener((message: unknown) => {
          if (!isAiSafeMemoryPortMessage(message)) return;
          if (message.kind === 'replace') {
            safeFingerprints.clear();
            for (const fingerprint of message.fingerprints)
              safeFingerprints.add(fingerprint);
          } else {
            safeFingerprints.add(message.fingerprint);
          }
        });
        port.onDisconnect.addListener(() => {
          if (safeMemoryPort !== port) return;
          safeMemoryPort = undefined;
          if (!feedbackPortDisposed)
            window.setTimeout(connectSafeMemory, 1_000);
        });
      } catch {
        // Initial loading above is sufficient when a worker restart briefly
        // prevents the live update port from connecting.
      }
    };
    connectSafeMemory();
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
    const restriction = new AuthorRestrictionTracker();
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
      const loadPolicy = resolveLocalAiLoadPolicy(settings);
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
          providerId: result.providerId ?? response.providerId,
          latencyMs: result.latencyMs ?? response.latencyMs,
        }));
      };
      return new ClassificationBatchQueue(classify, {
        windowMs: settings.lmStudio.batchWindowMs,
        maxBatchSize: loadPolicy.maxBatchSize,
        maxPendingBatches: loadPolicy.maxPendingBatches,
        maxQueueAgeMs: loadPolicy.maxQueueAgeMs,
      });
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
        (entry.action !== 'allow' ||
          entry.aiReason === 'zero-score-audit' ||
          Boolean(entry.aiSkipReason))
      ) {
        void sendRuntimeMessage({ type: 'debug:add', entry }).catch(
          () => undefined,
        );
      }
      const category = entry.category;
      const author = message.authorExternalChannelId ?? message.author;
      if (category !== 'hidden_user') {
        conflict.observe(category, entry.score, message.timestamp);
        authorHistory.observe(
          author,
          normalized,
          message.timestamp,
          entry.score,
        );
        recentRisk.observe(normalized, message.timestamp, entry.score);
      }
      const becameHabitual = restriction.observe(
        author,
        message.id,
        entry.action,
      );
      const channelId = message.authorExternalChannelId;
      if (becameHabitual && isChannelId(channelId) && !message.isSelf) {
        const next = addHiddenUser(settings, {
          channelId,
          displayName: message.author,
          addedAt: Date.now(),
        });
        if (next.hiddenUsers !== settings.hiddenUsers) {
          void saveSettings(next).catch(() => undefined);
        }
      }
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
      render: (result: FilterResult, entry: DiagnosticEntry) => void,
      context: FilterContext,
      flowDebug: FlowChatDebugInfo | undefined,
      requestReason: AiRequestReason,
      auditDecision?: AuditDecision,
    ) => {
      const result = mergeAiResult(base, ai, settings, context, requestReason);
      const { action, score } = result;
      if (
        settings.flowChat.enabled &&
        score >= resolveFlowChatThreshold(settings)
      )
        flowBridge.excludeFinalized(element);
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
        `${ai.providerId === 'chrome-built-in' ? 'Chrome内蔵AI' : 'LM Studio'}: ${category === 'safe' ? '安全' : category === 'spam' ? 'スパム' : category === 'hidden_user' ? '非表示ユーザー' : category === 'unknown' ? '判定不能' : CATEGORY_LABELS[category]}`,
      ];
      const diagnostic: DiagnosticEntry = {
        id: message.id,
        text: message.text,
        normalizedText: normalizeText(message.text),
        category,
        score,
        action,
        reasons: result.reasons,
        ...(result.ruleIds ? { ruleIds: result.ruleIds } : {}),
        ...(result.features ? { features: result.features } : {}),
        ...(typeof result.contextAdjustment === 'number'
          ? { contextAdjustment: result.contextAdjustment }
          : {}),
        ...(context.sameAuthorRecent && context.sameAuthorRecent.length > 0
          ? { sameAuthorRecent: [...context.sameAuthorRecent] }
          : {}),
        ...(context.recentRiskyMessages &&
        context.recentRiskyMessages.length > 0
          ? { recentRiskyMessages: [...context.recentRiskyMessages] }
          : {}),
        ...(typeof context.conflictLevel === 'number'
          ? { conflictLevel: context.conflictLevel }
          : {}),
        ...(flowDebug ? { flow: flowDebug } : {}),
        source: 'local-ai',
        ...(ai.providerId ? { aiProvider: ai.providerId } : {}),
        aiReason: requestReason,
        ...(typeof ai.latencyMs === 'number'
          ? { aiLatencyMs: ai.latencyMs }
          : {}),
        ...(typeof (ai.confidence ?? ai.score) === 'number'
          ? { aiConfidence: ai.confidence ?? ai.score }
          : {}),
        classifierPromptVersion: CLASSIFIER_PROMPT_VERSION,
        timestamp: message.timestamp,
      };
      render(result, diagnostic);
      record(diagnostic);
    };

    const processItem = async (element: HTMLElement) => {
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
      renderModeratorSticky(
        element,
        settings.enabled &&
          settings.stickyModeratorMessages &&
          message.isModerator,
      );
      const normalized = normalizeText(message.text);
      let persistentAiSafe = false;
      if (normalized && safeFingerprints.size > 0) {
        try {
          persistentAiSafe = safeFingerprints.has(
            await fingerprintText(normalized),
          );
        } catch {
          // Fingerprint lookup is an optimization. Normal rule/AI handling
          // remains available if Web Crypto is unavailable.
        }
      }
      if (!processing.isCurrent(token)) return;
      const author = message.authorExternalChannelId ?? message.author;
      const context = {
        conflictLevel: conflict.get(message.timestamp),
        categoryConflict: conflict.getCategoryLevels(message.timestamp),
        sameAuthorRecent: authorHistory.recent(author, message.timestamp),
        recentRiskyMessages: recentRisk.recent(message.timestamp),
        sessionBoost: restriction.boost(author),
      };
      const submitFeedback = async (
        diagnostic: DiagnosticEntry,
        judgement: FeedbackJudgement,
        correctCategory: DiagnosticEntry['category'],
      ) => {
        const entry = createFeedbackEntry({
          diagnostic,
          normalizedText: diagnostic.normalizedText ?? normalized,
          judgement,
          correctCategory,
          messageId: message.id,
          conflictLevel: context.conflictLevel,
        });
        const response = (await sendRuntimeMessage({
          type: 'feedback:add',
          entry,
        })) as RuntimeResponse;
        if (!response.ok) throw new Error(response.error);
        if ('exactMemory' in response)
          feedbackLearner.observeMemory(response.exactMemory);
      };
      const renderDiagnostic = (
        result: FilterResult,
        diagnostic: DiagnosticEntry,
        aiPending = false,
      ) => {
        if (settings.debugMode) {
          const feedbackHandlers =
            message.isOwner ||
            message.isModerator ||
            message.isSelf ||
            message.isPaidMessage
              ? undefined
              : {
                  onSubmit: (
                    judgement: FeedbackJudgement,
                    correctCategory: DiagnosticEntry['category'],
                  ) => submitFeedback(diagnostic, judgement, correctCategory),
                };
          renderResult(
            element,
            result,
            diagnostic,
            true,
            aiPending,
            feedbackHandlers,
          );
          return;
        }
        renderResult(element, result, diagnostic, false, aiPending);
      };
      let base: FilterResult;
      try {
        base = evaluate(
          message,
          settings,
          learner.lookup(normalized),
          context,
          feedbackLearner.lookupExact(normalized),
          persistentAiSafe,
        );
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
          renderDiagnostic,
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
        const diagnostic: DiagnosticEntry = {
          id: message.id,
          text: message.text,
          normalizedText: normalized,
          category: base.categories[0] ?? 'safe',
          score: base.score,
          action: base.action,
          reasons: base.reasons,
          ...(base.ruleIds ? { ruleIds: base.ruleIds } : {}),
          ...(base.features ? { features: base.features } : {}),
          ...(typeof base.contextAdjustment === 'number'
            ? { contextAdjustment: base.contextAdjustment }
            : {}),
          ...(context.sameAuthorRecent.length > 0
            ? { sameAuthorRecent: [...context.sameAuthorRecent] }
            : {}),
          ...(context.recentRiskyMessages.length > 0
            ? { recentRiskyMessages: [...context.recentRiskyMessages] }
            : {}),
          conflictLevel: context.conflictLevel,
          ...(flowDebug ? { flow: flowDebug } : {}),
          source: base.source ?? (base.needsAi ? 'fallback' : 'rules'),
          classifierPromptVersion: CLASSIFIER_PROMPT_VERSION,
          timestamp: message.timestamp,
        };
        renderDiagnostic(base, diagnostic);
        record(diagnostic);
        return;
      }

      renderPending(element, settings.debugMode);
      let settled = false;
      const fallbackTimer = window.setTimeout(() => {
        if (settled || !processing.isCurrent(token)) return;
        const fallbackEntry: DiagnosticEntry = {
          id: message.id,
          text: message.text,
          normalizedText: normalized,
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
          ...(context.sameAuthorRecent.length > 0
            ? { sameAuthorRecent: [...context.sameAuthorRecent] }
            : {}),
          ...(context.recentRiskyMessages.length > 0
            ? { recentRiskyMessages: [...context.recentRiskyMessages] }
            : {}),
          conflictLevel: context.conflictLevel,
          ...(flowDebug ? { flow: flowDebug } : {}),
          source: 'fallback',
          classifierPromptVersion: CLASSIFIER_PROMPT_VERSION,
          timestamp: message.timestamp,
        };
        renderDiagnostic(base, fallbackEntry, true);
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
          applyAiResult(
            element,
            base,
            ai,
            message,
            record,
            renderDiagnostic,
            context,
            flowDebug,
            requestReason,
            auditDecision,
          );
        })
        .catch((error: unknown) => {
          settled = true;
          clearTimeout(fallbackTimer);
          const queueFallback =
            error instanceof AiQueueFallbackError ? error : undefined;
          if (requestReason === 'zero-score-audit') {
            samplerForRequest.complete();
            if (!queueFallback)
              auditCooldownUntil = Date.now() + AUDIT_FAILURE_COOLDOWN_MS;
          }
          if (!processing.isCurrent(token)) return;
          if (!queueFallback) {
            updateSummary({
              ...summary,
              lmStudio: settings.lmStudio.enabled ? 'unavailable' : 'disabled',
              localAi: { activeProvider: 'rules', status: 'unavailable' },
            });
          }
          const fallbackReason = queueFallback
            ? `AIスキップ: ${AI_QUEUE_SKIP_LABELS[queueFallback.reason]}`
            : `ローカルAIを利用できないためルール判定を使用${error instanceof Error && error.message ? `: ${error.message}` : ''}`;
          const diagnostic: DiagnosticEntry = {
            id: message.id,
            text: message.text,
            normalizedText: normalized,
            category: base.categories[0] ?? 'safe',
            score: base.score,
            action: base.action,
            reasons: [
              ...base.reasons,
              ...(requestReason === 'zero-score-audit'
                ? ['Zero-score Audit', ...(auditDecision?.reasons ?? [])]
                : []),
              fallbackReason,
            ],
            ...(base.ruleIds ? { ruleIds: base.ruleIds } : {}),
            ...(base.features ? { features: base.features } : {}),
            ...(typeof base.contextAdjustment === 'number'
              ? { contextAdjustment: base.contextAdjustment }
              : {}),
            ...(context.sameAuthorRecent.length > 0
              ? { sameAuthorRecent: [...context.sameAuthorRecent] }
              : {}),
            ...(context.recentRiskyMessages.length > 0
              ? { recentRiskyMessages: [...context.recentRiskyMessages] }
              : {}),
            conflictLevel: context.conflictLevel,
            ...(flowDebug ? { flow: flowDebug } : {}),
            source: 'fallback',
            ...(queueFallback ? { aiSkipReason: queueFallback.reason } : {}),
            classifierPromptVersion: CLASSIFIER_PROMPT_VERSION,
            timestamp: message.timestamp,
          };
          renderDiagnostic(base, diagnostic);
          record(diagnostic);
        });
    };

    const scan = async (node: Node) => {
      if (feedbackPortDisposed) return;
      const items = findChatItems(node);
      const itemSet = new Set(items);
      const itemTasks = items.map((item) => processItem(item));
      if (settings.flowChat.enabled && flowBridge.isActive()) {
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
      }
      await Promise.all(itemTasks);
    };

    const root = document.querySelector('#items') ?? document.documentElement;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        void scan(mutation.target);
        for (const node of mutation.addedNodes) void scan(node);
      }
      refreshLatestModeratorSticky();
    });
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    if (settings.flowChat.enabled) flowBridge.activate();
    else flowBridge.deactivate();
    await scan(root);
    publishSummary();

    const unsubscribe = subscribeSettings((next) => {
      const listsOnly = isUserListOnlyChange(settings, next);
      settings = next;
      if (!listsOnly) {
        flowBridge.deactivate();
        flowMetrics.clear();
        flowSignatures = new WeakMap<HTMLElement, string>();
        queue.dispose();
        cache.clear();
        learner.clear();
        conflict.clear();
        authorHistory.clear();
        recentRisk.clear();
        restriction.clear();
        auditSampler.clear();
        auditSampler = new AuditSampler();
        auditCooldownUntil = 0;
        void sendRuntimeMessage({ type: 'debug:clear-frame' }).catch(
          () => undefined,
        );
        void sendRuntimeMessage({ type: 'flow:metrics-clear-frame' }).catch(
          () => undefined,
        );
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
      }
      processing.reset();
      document
        .querySelectorAll<HTMLElement>(CHAT_ITEM_SELECTOR)
        .forEach((item) => {
          resetRenderedItem(item);
        });
      void scan(root);
      publishFlowMetrics();
    });

    ctx.onInvalidated(() => {
      feedbackPortDisposed = true;
      feedbackPort?.disconnect();
      feedbackPort = undefined;
      safeMemoryPort?.disconnect();
      safeMemoryPort = undefined;
      processing.reset();
      queue.dispose();
      cache.clear();
      learner.clear();
      conflict.clear();
      authorHistory.clear();
      recentRisk.clear();
      restriction.clear();
      auditSampler.clear();
      flowBridge.deactivate();
      flowMetrics.clear();
      clearModeratorSticky();
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

function isUserListOnlyChange(previous: SettingsV1, next: SettingsV1): boolean {
  const coreUnchanged =
    JSON.stringify({
      ...previous,
      hiddenUsers: undefined,
      whitelistedUsers: undefined,
    }) ===
    JSON.stringify({
      ...next,
      hiddenUsers: undefined,
      whitelistedUsers: undefined,
    });
  if (!coreUnchanged) return false;
  return (
    JSON.stringify(previous.hiddenUsers) !== JSON.stringify(next.hiddenUsers) ||
    JSON.stringify(previous.whitelistedUsers) !==
      JSON.stringify(next.whitelistedUsers)
  );
}
