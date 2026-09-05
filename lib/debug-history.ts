import type { DiagnosticEntry } from './types';

interface StoredDebugEntry {
  tabId: number;
  frameId: number;
  entry: DiagnosticEntry;
}

const MAX_DEBUG_ENTRIES = 200;

export class DebugHistoryStore {
  private entries: StoredDebugEntry[] = [];

  add(tabId: number, frameId: number, entry: DiagnosticEntry): void {
    this.entries = this.entries.filter(
      (item) =>
        item.tabId !== tabId ||
        item.frameId !== frameId ||
        item.entry.id !== entry.id,
    );
    if (entry.action === 'allow') return;
    this.entries.unshift({ tabId, frameId, entry });
    if (this.entries.length > MAX_DEBUG_ENTRIES) {
      this.entries.length = MAX_DEBUG_ENTRIES;
    }
  }

  list(): DiagnosticEntry[] {
    return this.entries.map(({ entry }) => structuredClone(entry));
  }

  clear(): void {
    this.entries = [];
  }

  removeFrame(tabId: number, frameId: number): void {
    this.entries = this.entries.filter(
      (item) => item.tabId !== tabId || item.frameId !== frameId,
    );
  }

  removeTab(tabId: number): void {
    this.entries = this.entries.filter((item) => item.tabId !== tabId);
  }
}
