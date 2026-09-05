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

export class ChromeBuiltInAiProvider implements LocalAiProvider {
  readonly id = 'chrome-built-in' as const;
  readonly maxBatchSize = CHROME_BUILT_IN_MAX_BATCH_SIZE;
  private baseSession: LanguageModelSessionLike | undefined;
  private baseSessionPromise: Promise<LanguageModelSessionLike> | undefined;

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
    const { signal, cleanup } = timeoutSignal(this.timeoutMs, options?.signal);
    let session: LanguageModelSessionLike | undefined;
    try {
      const base = await this.ensureBaseSession();
      session = await base.clone({ signal });
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
      cleanup();
    }
  }

  dispose(): void {
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
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
  };
}
