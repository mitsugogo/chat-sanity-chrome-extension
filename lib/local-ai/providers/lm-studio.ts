import { classifyWithLmStudio, listModels } from '../../lm-studio';
import type { LmClassificationItem, LmClassificationResult } from '../../types';
import type { LocalAiAvailability, LocalAiProvider } from '../types';

export interface LmStudioProviderOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
  responseFormat: 'json_schema' | 'json_object' | 'text';
}

export class LmStudioProvider implements LocalAiProvider {
  readonly id = 'lm-studio' as const;
  readonly maxBatchSize = 20;

  constructor(private readonly options: LmStudioProviderOptions) {}

  async getAvailability(): Promise<LocalAiAvailability> {
    if (!this.options.model) return 'unavailable';
    try {
      await listModels(this.options.endpoint);
      return 'available';
    } catch {
      return 'unavailable';
    }
  }

  classify(
    items: LmClassificationItem[],
    options?: { signal?: AbortSignal },
  ): Promise<LmClassificationResult[]> {
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }
    return classifyWithLmStudio(
      this.options.endpoint,
      this.options.model,
      items,
      this.options.timeoutMs,
      this.options.responseFormat,
      options?.signal,
    );
  }
}
