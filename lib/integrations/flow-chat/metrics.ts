import type { FlowChatMetricsSnapshot } from '../../types';

const EMPTY_METRICS: FlowChatMetricsSnapshot = {
  received: 0,
  classified: 0,
  excluded: 0,
  allowed: 0,
  cacheHits: 0,
  timeouts: 0,
  errors: 0,
  averageLatency: 0,
  maxLatency: 0,
};

export class FlowChatMetrics {
  private values = { ...EMPTY_METRICS };
  private latencyTotal = 0;
  private latencySamples = 0;

  received(): void {
    this.values.received += 1;
  }

  classified(): void {
    this.values.classified += 1;
  }

  finalized(excluded: boolean, latencyMs: number): void {
    if (excluded) this.values.excluded += 1;
    else this.values.allowed += 1;
    const safeLatency = Math.max(0, Number.isFinite(latencyMs) ? latencyMs : 0);
    this.latencyTotal += safeLatency;
    this.latencySamples += 1;
    this.values.averageLatency = this.latencyTotal / this.latencySamples;
    this.values.maxLatency = Math.max(this.values.maxLatency, safeLatency);
  }

  cacheHit(): void {
    this.values.cacheHits += 1;
  }

  timeout(): void {
    this.values.timeouts += 1;
  }

  error(): void {
    this.values.errors += 1;
  }

  snapshot(): FlowChatMetricsSnapshot {
    return { ...this.values };
  }

  clear(): void {
    this.values = { ...EMPTY_METRICS };
    this.latencyTotal = 0;
    this.latencySamples = 0;
  }
}

export class FlowChatMetricsStore {
  private frames = new Map<string, FlowChatMetricsSnapshot>();

  update(tabId: number, frameId: number, snapshot: FlowChatMetricsSnapshot) {
    this.frames.set(`${tabId}:${frameId}`, { ...snapshot });
  }

  clearFrame(tabId: number, frameId: number): void {
    this.frames.delete(`${tabId}:${frameId}`);
  }

  clearTab(tabId: number): void {
    for (const key of this.frames.keys()) {
      if (key.startsWith(`${tabId}:`)) this.frames.delete(key);
    }
  }

  clear(): void {
    this.frames.clear();
  }

  aggregate(): FlowChatMetricsSnapshot {
    const result = { ...EMPTY_METRICS };
    let latencyTotal = 0;
    let latencyWeight = 0;
    for (const metrics of this.frames.values()) {
      result.received += metrics.received;
      result.classified += metrics.classified;
      result.excluded += metrics.excluded;
      result.allowed += metrics.allowed;
      result.cacheHits += metrics.cacheHits;
      result.timeouts += metrics.timeouts;
      result.errors += metrics.errors;
      result.maxLatency = Math.max(result.maxLatency, metrics.maxLatency);
      if (metrics.received > 0) {
        latencyTotal += metrics.averageLatency * metrics.received;
        latencyWeight += metrics.received;
      }
    }
    result.averageLatency =
      latencyWeight > 0 ? latencyTotal / latencyWeight : 0;
    return result;
  }
}

export function emptyFlowChatMetrics(): FlowChatMetricsSnapshot {
  return { ...EMPTY_METRICS };
}
