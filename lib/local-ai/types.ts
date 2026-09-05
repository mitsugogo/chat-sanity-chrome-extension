import type {
  LmClassificationItem,
  LmClassificationResult,
  LmResponseFormat,
} from '../types';

export type LocalAiProviderId = 'chrome-built-in' | 'lm-studio';
export type LocalAiMode = 'auto' | 'chrome-built-in' | 'lm-studio' | 'disabled';
export type LocalAiAvailability =
  'available' | 'downloadable' | 'downloading' | 'unavailable' | 'error';

export interface LocalAiProvider {
  readonly id: LocalAiProviderId;
  readonly maxBatchSize: number;
  getAvailability(): Promise<LocalAiAvailability>;
  classify(
    items: LmClassificationItem[],
    options?: { signal?: AbortSignal },
  ): Promise<LmClassificationResult[]>;
  dispose?(): void | Promise<void>;
}

export interface LocalAiResolverSettings {
  mode: LocalAiMode;
  chromeBuiltIn: { enabled: boolean };
  lmStudio: {
    enabled: boolean;
    endpoint: string;
    model: string;
    timeoutMs: number;
    responseFormat: LmResponseFormat;
  };
}

export interface LocalAiClassification {
  providerId: LocalAiProviderId;
  results: LmClassificationResult[];
  latencyMs: number;
}
