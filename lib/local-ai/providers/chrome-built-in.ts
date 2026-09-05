import type { LmClassificationItem, LmClassificationResult } from '../../types';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  createClassificationInput,
  createClassificationSchema,
} from '../prompt';
import type { LocalAiAvailability, LocalAiProvider } from '../types';
import { validateResults } from '../validation';

interface LanguageModelSessionLike {
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSessionLike>;
  prompt(
    input: string,
    options?: {
      responseConstraint?: object;
      omitResponseConstraintInput?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<string>;
  destroy(): void;
}

interface LanguageModelApiLike {
  availability(options: typeof MODEL_OPTIONS): Promise<string>;
  create(
    options: typeof MODEL_OPTIONS & {
      initialPrompts?: Array<{ role: 'system'; content: string }>;
      signal?: AbortSignal;
      monitor?: (monitor: {
        addEventListener(
          type: 'downloadprogress',
          listener: (event: { loaded: number; total?: number }) => void,
        ): void;
      }) => void;
    },
  ): Promise<LanguageModelSessionLike>;
}

export const CHROME_BUILT_IN_MAX_BATCH_SIZE = 8;
export const MODEL_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
} as const;

function languageModelApi(): LanguageModelApiLike | undefined {
  return (
    globalThis as typeof globalThis & { LanguageModel?: LanguageModelApiLike }
  ).LanguageModel;
}

export async function getChromeBuiltInAvailability(): Promise<LocalAiAvailability> {
  const api = languageModelApi();
  if (!api) return 'unavailable';
  try {
    const availability = await api.availability(MODEL_OPTIONS);
    if (availability === 'available' || availability === 'readily')
      return 'available';
    if (availability === 'downloadable' || availability === 'after-download')
      return 'downloadable';
    if (availability === 'downloading') return 'downloading';
    if (availability === 'unavailable') return 'unavailable';
    return 'error';
  } catch {
    return 'error';
  }
}

export async function prepareChromeBuiltInAi(
  onProgress?: (progress: number) => void,
): Promise<void> {
  const api = languageModelApi();
  if (!api) throw new Error('このChromeでは内蔵AIを利用できません。');
  const availability = await getChromeBuiltInAvailability();
  if (availability === 'unavailable' || availability === 'error') {
    throw new Error('この端末ではChrome内蔵AIを準備できません。');
  }
  const session = await api.create({
    ...MODEL_OPTIONS,
    initialPrompts: [{ role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT }],
    monitor(monitor) {
      monitor.addEventListener('downloadprogress', (event) => {
        const ratio =
          event.total && event.total > 0
            ? event.loaded / event.total
            : event.loaded;
        onProgress?.(Math.round(Math.min(1, Math.max(0, ratio)) * 100));
      });
    },
  });
  session.destroy();
  onProgress?.(100);
}

const TIMEOUT_MESSAGE = 'Chrome内蔵AIの応答がタイムアウトしました。';
const ABORTED_MESSAGE = 'Chrome内蔵AIの実行が中断されました。';

export class ChromeBuiltInAiProvider implements LocalAiProvider {
  readonly id = 'chrome-built-in' as const;
  readonly maxBatchSize = CHROME_BUILT_IN_MAX_BATCH_SIZE;
  private baseSession: LanguageModelSessionLike | undefined;
  private baseSessionPromise: Promise<LanguageModelSessionLike> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly timeoutMs = 10_000) {}

  getAvailability(): Promise<LocalAiAvailability> {
    return getChromeBuiltInAvailability();
  }

  async classify(
    items: LmClassificationItem[],
    options?: { signal?: AbortSignal },
  ): Promise<LmClassificationResult[]> {
    if (items.length === 0 || items.length > this.maxBatchSize) {
      throw new Error(
        `Chrome内蔵AIの分類バッチは1〜${this.maxBatchSize}件です。`,
      );
    }
    if ((await this.getAvailability()) !== 'available') {
      throw new Error('Chrome内蔵AIはまだ利用可能ではありません。');
    }
    return this.enqueue(() => this.classifyExclusive(items, options));
  }

  dispose(): void {
    this.resetBaseSession();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async classifyExclusive(
    items: LmClassificationItem[],
    options?: { signal?: AbortSignal },
  ): Promise<LmClassificationResult[]> {
    const { signal, cleanup } = timeoutSignal(this.timeoutMs, options?.signal);
    try {
      try {
        return await this.classifyWithSession(items, signal);
      } catch (error) {
        if (
          !options?.signal?.aborted &&
          !signal.aborted &&
          isRetryableSessionError(error)
        ) {
          this.resetBaseSession();
          return await this.classifyWithSession(items, signal);
        }
        throw error;
      }
    } catch (error) {
      throw toChromeAiError(error, signal.aborted && !options?.signal?.aborted);
    } finally {
      cleanup();
    }
  }

  private async classifyWithSession(
    items: LmClassificationItem[],
    signal: AbortSignal,
  ): Promise<LmClassificationResult[]> {
    let session: LanguageModelSessionLike | undefined;
    try {
      throwIfAborted(signal);
      const base = await this.ensureBaseSession();
      throwIfAborted(signal);
      // clone({ signal }) は abort で session ごと destroy され、
      // Prompt API が "signal is aborted without reason" を返す。
      session = await base.clone();
      throwIfAborted(signal);
      const raw = await session.prompt(createClassificationInput(items), {
        responseConstraint: createClassificationSchema(items.length),
        omitResponseConstraintInput: true,
        signal,
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Chrome内蔵AIの応答JSONを解析できません。');
      }
      if (!parsed || typeof parsed !== 'object' || !('results' in parsed)) {
        throw new Error('Chrome内蔵AIの応答形式が不正です。');
      }
      return validateResults(
        (parsed as { results: unknown }).results,
        items,
        'Chrome内蔵AI',
      );
    } finally {
      session?.destroy();
    }
  }

  private resetBaseSession(): void {
    this.baseSession?.destroy();
    this.baseSession = undefined;
    const pending = this.baseSessionPromise;
    this.baseSessionPromise = undefined;
    if (pending)
      void pending.then(
        (session) => session.destroy(),
        () => undefined,
      );
  }

  private async ensureBaseSession(): Promise<LanguageModelSessionLike> {
    if (this.baseSession) return this.baseSession;
    if (this.baseSessionPromise) return this.baseSessionPromise;
    const api = languageModelApi();
    if (!api) throw new Error('Chrome内蔵AI APIが見つかりません。');
    this.baseSessionPromise = api.create({
      ...MODEL_OPTIONS,
      initialPrompts: [
        { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
      ],
    });
    try {
      this.baseSession = await this.baseSessionPromise;
      return this.baseSession;
    } finally {
      this.baseSessionPromise = undefined;
    }
  }
}

function timeoutSignal(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  const timeoutReason = new Error(TIMEOUT_MESSAGE);
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(TIMEOUT_MESSAGE);
}

function toChromeAiError(error: unknown, timedOut: boolean): Error {
  if (timedOut) return new Error(TIMEOUT_MESSAGE);
  if (isRetryableSessionError(error)) return new Error(ABORTED_MESSAGE);
  return error instanceof Error
    ? error
    : new Error('Chrome内蔵AIの分類に失敗しました。');
}

function isRetryableSessionError(error: unknown): boolean {
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'InvalidStateError')
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'InvalidStateError') {
    return true;
  }
  return /signal is aborted without reason|The request was cancelled|The request has been aborted|session has been destroyed/i.test(
    error.message,
  );
}
