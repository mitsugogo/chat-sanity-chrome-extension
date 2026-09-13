import { feedbackEntriesToJsonl, isFeedbackEntry } from './export';
import { addToExactMemory, resolveExactFeedback } from './learner';
import { summarizeFeedback, updateRuleFeedbackStats } from './rule-stats';
import type {
  ExactFeedbackResult,
  FeedbackEntry,
  FeedbackExactMemory,
  FeedbackSummary,
  RuleFeedbackStats,
} from './types';
import { cloneFeedbackEntry, isFeedbackExactMemory } from './types';

const DATABASE_NAME = 'chat-sanity-feedback';
const DATABASE_VERSION = 1;
const FEEDBACK_STORE = 'feedback';
const EXACT_MEMORY_STORE = 'exactMemory';
const RULE_STATS_STORE = 'ruleStats';

export interface FeedbackStore {
  add(entry: FeedbackEntry): Promise<{
    exactMemory: FeedbackExactMemory;
    feedbackStats: RuleFeedbackStats[];
  }>;
  list(): Promise<FeedbackEntry[]>;
  listExactMemories(): Promise<FeedbackExactMemory[]>;
  lookupExact(normalizedText: string): Promise<ExactFeedbackResult | null>;
  listRuleStats(): Promise<RuleFeedbackStats[]>;
  summary(): Promise<FeedbackSummary>;
  exportJsonl(): Promise<string>;
  clear(): Promise<void>;
}

/**
 * IndexedDB-backed durable feedback repository. It lives in the extension
 * origin (through the Service Worker), never in chrome.storage.sync.
 */
export class IndexedDbFeedbackStore implements FeedbackStore {
  private databasePromise: Promise<IDBDatabase> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly factory: IDBFactory | undefined = getIndexedDbFactory(),
  ) {}

  add(entry: FeedbackEntry): Promise<{
    exactMemory: FeedbackExactMemory;
    feedbackStats: RuleFeedbackStats[];
  }> {
    return this.enqueueWrite(() => this.addNow(entry));
  }

  async list(): Promise<FeedbackEntry[]> {
    const entries = await this.readStore(FEEDBACK_STORE, (store) =>
      requestResult<FeedbackEntry[]>(store.getAll()),
    );
    return entries
      .filter(isFeedbackEntry)
      .map(cloneFeedbackEntry)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async listExactMemories(): Promise<FeedbackExactMemory[]> {
    const memories = await this.readStore(EXACT_MEMORY_STORE, (store) =>
      requestResult<FeedbackExactMemory[]>(store.getAll()),
    );
    return memories
      .filter(isFeedbackExactMemory)
      .map((memory) => structuredClone(memory))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async lookupExact(
    normalizedText: string,
  ): Promise<ExactFeedbackResult | null> {
    if (!normalizedText) return null;
    const memory = await this.getExactMemory(normalizedText);
    return resolveExactFeedback(memory);
  }

  async listRuleStats(): Promise<RuleFeedbackStats[]> {
    const stats = await this.readStore(RULE_STATS_STORE, (store) =>
      requestResult<RuleFeedbackStats[]>(store.getAll()),
    );
    return stats
      .filter(isRuleFeedbackStats)
      .map((stat) => structuredClone(stat))
      .sort(
        (left, right) =>
          right.incorrect - left.incorrect ||
          left.ruleId.localeCompare(right.ruleId),
      );
  }

  async summary(): Promise<FeedbackSummary> {
    return summarizeFeedback(await this.list());
  }

  async exportJsonl(): Promise<string> {
    return feedbackEntriesToJsonl(await this.list());
  }

  clear(): Promise<void> {
    return this.enqueueWrite(async () => {
      const database = await this.database();
      const transaction = database.transaction(
        [FEEDBACK_STORE, EXACT_MEMORY_STORE, RULE_STATS_STORE],
        'readwrite',
      );
      transaction.objectStore(FEEDBACK_STORE).clear();
      transaction.objectStore(EXACT_MEMORY_STORE).clear();
      transaction.objectStore(RULE_STATS_STORE).clear();
      await transactionDone(transaction);
    });
  }

  private async addNow(entry: FeedbackEntry): Promise<{
    exactMemory: FeedbackExactMemory;
    feedbackStats: RuleFeedbackStats[];
  }> {
    const feedback = cloneFeedbackEntry(entry);
    validateFeedbackEntry(feedback);
    const ruleIds = uniqueRuleIds(feedback);
    const [currentMemory, allStats] = await Promise.all([
      this.getExactMemory(feedback.normalizedText),
      this.listRuleStats(),
    ]);
    const nextMemory = addToExactMemory(currentMemory, feedback);
    const statsByRule = new Map(allStats.map((stat) => [stat.ruleId, stat]));
    const nextStats = ruleIds.map((ruleId) =>
      updateRuleFeedbackStats(statsByRule.get(ruleId), feedback, ruleId),
    );

    const database = await this.database();
    const transaction = database.transaction(
      [FEEDBACK_STORE, EXACT_MEMORY_STORE, RULE_STATS_STORE],
      'readwrite',
    );
    transaction.objectStore(FEEDBACK_STORE).add(feedback);
    transaction.objectStore(EXACT_MEMORY_STORE).put(nextMemory);
    const statsStore = transaction.objectStore(RULE_STATS_STORE);
    for (const stat of nextStats) statsStore.put(stat);
    await transactionDone(transaction);
    return {
      exactMemory: structuredClone(nextMemory),
      feedbackStats: nextStats.map((stat) => structuredClone(stat)),
    };
  }

  private async getExactMemory(
    normalizedText: string,
  ): Promise<FeedbackExactMemory | undefined> {
    const value = await this.readStore(EXACT_MEMORY_STORE, (store) =>
      requestResult<FeedbackExactMemory | undefined>(store.get(normalizedText)),
    );
    return isFeedbackExactMemory(value) ? structuredClone(value) : undefined;
  }

  private async readStore<T>(
    name: string,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const database = await this.database();
    const transaction = database.transaction(name, 'readonly');
    const value = await operation(transaction.objectStore(name));
    await transactionDone(transaction);
    return value;
  }

  private database(): Promise<IDBDatabase> {
    if (!this.factory)
      return Promise.reject(
        new Error('この環境ではフィードバック保存を利用できません。'),
      );
    if (!this.databasePromise)
      this.databasePromise = openFeedbackDatabase(this.factory);
    return this.databasePromise;
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** In-memory implementation used by focused tests and isolated consumers. */
export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly entries = new Map<string, FeedbackEntry>();
  private readonly memories = new Map<string, FeedbackExactMemory>();
  private readonly stats = new Map<string, RuleFeedbackStats>();

  async add(entry: FeedbackEntry): Promise<{
    exactMemory: FeedbackExactMemory;
    feedbackStats: RuleFeedbackStats[];
  }> {
    const feedback = cloneFeedbackEntry(entry);
    validateFeedbackEntry(feedback);
    if (this.entries.has(feedback.id))
      throw new Error('同じフィードバックIDは追加できません。');
    this.entries.set(feedback.id, feedback);
    const nextMemory = addToExactMemory(
      this.memories.get(feedback.normalizedText),
      feedback,
    );
    this.memories.set(feedback.normalizedText, nextMemory);
    const feedbackStats = uniqueRuleIds(feedback).map((ruleId) => {
      const next = updateRuleFeedbackStats(
        this.stats.get(ruleId),
        feedback,
        ruleId,
      );
      this.stats.set(ruleId, next);
      return structuredClone(next);
    });
    return { exactMemory: structuredClone(nextMemory), feedbackStats };
  }

  async list(): Promise<FeedbackEntry[]> {
    return Array.from(this.entries.values())
      .map(cloneFeedbackEntry)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async listExactMemories(): Promise<FeedbackExactMemory[]> {
    return Array.from(this.memories.values())
      .map((memory) => structuredClone(memory))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async lookupExact(
    normalizedText: string,
  ): Promise<ExactFeedbackResult | null> {
    return resolveExactFeedback(this.memories.get(normalizedText));
  }

  async listRuleStats(): Promise<RuleFeedbackStats[]> {
    return Array.from(this.stats.values())
      .map((stat) => structuredClone(stat))
      .sort(
        (left, right) =>
          right.incorrect - left.incorrect ||
          left.ruleId.localeCompare(right.ruleId),
      );
  }

  async summary(): Promise<FeedbackSummary> {
    return summarizeFeedback(await this.list());
  }

  async exportJsonl(): Promise<string> {
    return feedbackEntriesToJsonl(await this.list());
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.memories.clear();
    this.stats.clear();
  }
}

function getIndexedDbFactory(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

function openFeedbackDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FEEDBACK_STORE)) {
        const store = database.createObjectStore(FEEDBACK_STORE, {
          keyPath: 'id',
        });
        store.createIndex('normalizedText', 'normalizedText');
        store.createIndex('correctCategory', 'correctCategory');
        store.createIndex('predictedCategory', 'predictedCategory');
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('ruleIds', 'ruleIds', { multiEntry: true });
      }
      if (!database.objectStoreNames.contains(EXACT_MEMORY_STORE))
        database.createObjectStore(EXACT_MEMORY_STORE, {
          keyPath: 'normalizedText',
        });
      if (!database.objectStoreNames.contains(RULE_STATS_STORE))
        database.createObjectStore(RULE_STATS_STORE, { keyPath: 'ruleId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('フィードバックDBを開けません。'));
    request.onblocked = () =>
      reject(new Error('フィードバックDBが他の画面で使用されています。'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDBの操作に失敗しました。'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDBの保存に失敗しました。'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDBの保存を中断しました。'));
  });
}

function uniqueRuleIds(entry: FeedbackEntry): string[] {
  return Array.from(
    new Set(entry.ruleIds.filter((ruleId) => ruleId.length > 0)),
  );
}

function validateFeedbackEntry(entry: FeedbackEntry): void {
  if (!isFeedbackEntry(entry))
    throw new Error('フィードバックの形式が正しくありません。');
  if (!entry.text.trim() || !entry.normalizedText.trim())
    throw new Error('コメント本文が空のため保存できません。');
  if (entry.predictedScore < 0 || entry.predictedScore > 1)
    throw new Error('判定スコアが範囲外です。');
}

function isRuleFeedbackStats(value: unknown): value is RuleFeedbackStats {
  if (!isRecord(value)) return false;
  return (
    typeof value.ruleId === 'string' &&
    isFiniteCount(value.evaluated) &&
    isFiniteCount(value.correct) &&
    isFiniteCount(value.incorrect) &&
    isFiniteCount(value.falsePositive) &&
    isFiniteCount(value.falseNegative) &&
    typeof value.precision === 'number' &&
    Number.isFinite(value.precision) &&
    typeof value.lastUpdatedAt === 'number' &&
    Number.isFinite(value.lastUpdatedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
