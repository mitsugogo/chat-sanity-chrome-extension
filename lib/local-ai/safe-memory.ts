import type {
  LmClassificationItem,
  LmClassificationResult,
  LocalAiProviderId,
} from '../types';
import type { LocalAiClassification } from './types';

export const AI_SAFE_MEMORY_PORT_NAME = 'chat-sanity-ai-safe-memory';
export const AI_SAFE_MEMORY_STORAGE_KEY = 'local-ai-safe-memory-v1';
export const AI_SAFE_MEMORY_MAX_ENTRIES = 1_000;

const SHA256_FINGERPRINT = /^[0-9a-f]{64}$/u;

interface StoredSafeMemoryEntry {
  fingerprint: string;
  providerId: LocalAiProviderId;
  action: 'allow';
  confidence?: number;
  score?: number;
  learnedAt: number;
}

interface StoredSafeMemory {
  version: 1;
  entries: StoredSafeMemoryEntry[];
}

export interface SafeMemoryStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type AiSafeMemoryPortMessage =
  | { kind: 'replace'; fingerprints: string[] }
  | { kind: 'update'; fingerprint: string };

export function isAiSafeMemoryPortMessage(
  value: unknown,
): value is AiSafeMemoryPortMessage {
  if (!isRecord(value)) return false;
  if (value.kind === 'update')
    return (
      typeof value.fingerprint === 'string' &&
      SHA256_FINGERPRINT.test(value.fingerprint)
    );
  return (
    value.kind === 'replace' &&
    Array.isArray(value.fingerprints) &&
    value.fingerprints.every(
      (fingerprint) =>
        typeof fingerprint === 'string' && SHA256_FINGERPRINT.test(fingerprint),
    )
  );
}

export async function fingerprintText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export class PersistentAiSafeMemory {
  private entriesPromise:
    Promise<Map<string, StoredSafeMemoryEntry>> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: SafeMemoryStorageArea,
    private readonly createFingerprint = fingerprintText,
    private readonly maxEntries = AI_SAFE_MEMORY_MAX_ENTRIES,
  ) {}

  async listFingerprints(): Promise<string[]> {
    await this.writeQueue;
    return Array.from((await this.entries()).keys());
  }

  async lookup(normalizedText: string): Promise<LmClassificationResult | null> {
    if (!normalizedText) return null;
    const fingerprint = await this.createFingerprint(normalizedText);
    await this.writeQueue;
    const entry = (await this.entries()).get(fingerprint);
    if (!entry) return null;
    return {
      id: '',
      category: 'safe',
      action: 'allow',
      confidence: entry.confidence ?? entry.score ?? 0,
      ...(typeof entry.score === 'number' ? { score: entry.score } : {}),
      providerId: entry.providerId,
      safeMemoryHit: true,
    };
  }

  async remember(
    normalizedText: string,
    result: LmClassificationResult,
    providerId: LocalAiProviderId,
    learnedAt = Date.now(),
  ): Promise<string | null> {
    if (!normalizedText || result.category !== 'safe') return null;
    const fingerprint = await this.createFingerprint(normalizedText);
    const operation = this.writeQueue.then(async () => {
      const entries = await this.entries();
      entries.delete(fingerprint);
      entries.set(fingerprint, {
        fingerprint,
        providerId,
        action: 'allow',
        ...(isProbability(result.confidence)
          ? { confidence: result.confidence }
          : {}),
        ...(isProbability(result.score) ? { score: result.score } : {}),
        learnedAt,
      });
      while (entries.size > Math.max(1, this.maxEntries)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      await this.storage.set({
        [AI_SAFE_MEMORY_STORAGE_KEY]: {
          version: 1,
          entries: Array.from(entries.values()),
        } satisfies StoredSafeMemory,
      });
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return fingerprint;
  }

  private entries(): Promise<Map<string, StoredSafeMemoryEntry>> {
    this.entriesPromise ??= this.loadEntries();
    return this.entriesPromise;
  }

  private async loadEntries(): Promise<Map<string, StoredSafeMemoryEntry>> {
    const stored = await this.storage.get(AI_SAFE_MEMORY_STORAGE_KEY);
    const value = stored[AI_SAFE_MEMORY_STORAGE_KEY];
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.entries)
    )
      return new Map();
    const entries = value.entries.filter(isStoredSafeMemoryEntry);
    entries.sort((left, right) => left.learnedAt - right.learnedAt);
    return new Map(
      entries
        .slice(-Math.max(1, this.maxEntries))
        .map((entry) => [entry.fingerprint, entry]),
    );
  }
}

export async function classifyWithSafeMemory(
  items: LmClassificationItem[],
  memory: PersistentAiSafeMemory,
  classify: (items: LmClassificationItem[]) => Promise<LocalAiClassification>,
  onRemember?: (fingerprint: string) => void,
): Promise<LocalAiClassification> {
  const remembered = await Promise.all(
    items.map((item) => memory.lookup(item.text).catch(() => null)),
  );
  const missing = items.filter((_, index) => !remembered[index]);
  let classification: LocalAiClassification | undefined;
  if (missing.length > 0) classification = await classify(missing);

  const providerId =
    classification?.providerId ??
    remembered.find(
      (result): result is LmClassificationResult => result !== null,
    )?.providerId;
  if (!providerId) throw new Error('ローカルAI分類結果がありません。');

  const classifiedById = new Map(
    (classification?.results ?? []).map((result) => [result.id, result]),
  );
  const results = items.map((item, index) => {
    const hit = remembered[index];
    if (hit) return { ...hit, id: item.id };
    const result = classifiedById.get(item.id);
    if (!result) throw new Error('ローカルAI分類結果が不足しています。');
    return {
      ...result,
      ...(classification ? { providerId: classification.providerId } : {}),
    };
  });

  await Promise.allSettled(
    missing.map(async (item) => {
      const result = classifiedById.get(item.id);
      if (!result || result.category !== 'safe' || !classification) return;
      const fingerprint = await memory.remember(
        item.text,
        result,
        classification.providerId,
      );
      if (fingerprint) onRemember?.(fingerprint);
    }),
  );

  return {
    providerId,
    results,
    latencyMs: classification?.latencyMs ?? 0,
  };
}

function isStoredSafeMemoryEntry(
  value: unknown,
): value is StoredSafeMemoryEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.fingerprint === 'string' &&
    SHA256_FINGERPRINT.test(value.fingerprint) &&
    (value.providerId === 'chrome-built-in' ||
      value.providerId === 'lm-studio') &&
    value.action === 'allow' &&
    (value.confidence === undefined || isProbability(value.confidence)) &&
    (value.score === undefined || isProbability(value.score)) &&
    typeof value.learnedAt === 'number' &&
    Number.isFinite(value.learnedAt)
  );
}

function isProbability(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
