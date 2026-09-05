import type { FlowChatDecision } from './constants';
import { FLOW_CHAT_CLASSES, FLOW_CHAT_DEADLINE_MS } from './constants';
import type { FlowChatDecisionSource } from '../../types';

export interface FlowChatBridgeOptions {
  deadlineMs?: number;
  now?: () => number;
  onTimeout?: (element: HTMLElement, elapsedMs: number) => void;
  onError?: (error: unknown, element?: HTMLElement) => void;
}

export interface FlowChatGuard {
  readonly startedAt: number;
  finalize(decision: FlowChatDecision): boolean;
  finalizeAllowed(source?: FlowChatDecisionSource): boolean;
  cancel(): void;
}

interface PendingEntry {
  timer: number;
  startedAt: number;
}

/**
 * Writes only Flow Chat's DOM handshake classes. It never parses comments or
 * decides a score, which keeps the integration replaceable and fail-open.
 */
export class FlowChatBridge {
  private readonly document: Document;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly onTimeout:
    ((element: HTMLElement, elapsedMs: number) => void) | undefined;
  private readonly onError:
    ((error: unknown, element?: HTMLElement) => void) | undefined;
  private active = false;
  private states = new WeakMap<HTMLElement, 'pending' | 'finalized'>();
  private pending = new Map<HTMLElement, PendingEntry>();

  constructor(documentRef: Document, options: FlowChatBridgeOptions = {}) {
    this.document = documentRef;
    this.deadlineMs = Math.max(
      1,
      Math.min(
        900,
        Number.isFinite(options.deadlineMs)
          ? (options.deadlineMs as number)
          : FLOW_CHAT_DEADLINE_MS,
      ),
    );
    this.now = options.now ?? (() => Date.now());
    this.onTimeout = options.onTimeout;
    this.onError = options.onError;
  }

  activate(): boolean {
    const root = this.document.documentElement;
    if (!root) {
      this.active = false;
      return false;
    }
    root.classList.add(FLOW_CHAT_CLASSES.active);
    this.active = true;
    return true;
  }

  deactivate(): void {
    for (const element of Array.from(this.pending.keys())) {
      if (this.isActive()) this.finalizeAllowed(element, 'fail-open');
      else this.forceFinalizeAllowed(element);
    }
    const root = this.document.documentElement;
    root?.classList.remove(FLOW_CHAT_CLASSES.active);
    this.active = false;
  }

  isActive(): boolean {
    return (
      this.active === true &&
      this.document.documentElement?.classList.contains(
        FLOW_CHAT_CLASSES.active,
      ) === true
    );
  }

  begin(element: HTMLElement): FlowChatGuard {
    const startedAt = this.now();
    if (!this.isActive()) {
      return this.noopGuard(startedAt);
    }
    if (this.isFinalized(element)) {
      this.clearPending(element);
      this.states.set(element, 'finalized');
      return this.noopGuard(startedAt);
    }
    if (this.states.get(element) === 'pending') {
      return this.noopGuard(startedAt);
    }

    this.states.set(element, 'pending');
    const timer = window.setTimeout(() => {
      if (this.states.get(element) !== 'pending') return;
      try {
        this.onTimeout?.(
          element,
          Math.max(
            0,
            this.now() - (this.pending.get(element)?.startedAt ?? this.now()),
          ),
        );
      } catch (error) {
        this.reportError(error, element);
      } finally {
        this.finalizeAllowed(element, 'fail-open');
      }
    }, this.deadlineMs);
    this.pending.set(element, { timer, startedAt });

    return {
      startedAt,
      finalize: (decision) => this.finalize(element, decision),
      finalizeAllowed: (source = 'fail-open') =>
        this.finalizeAllowed(element, source),
      cancel: () => this.cancel(element),
    };
  }

  finalize(element: HTMLElement, decision: FlowChatDecision): boolean {
    if (!this.isActive()) {
      return false;
    }
    if (this.isFinalized(element)) {
      this.clearPending(element);
      this.states.set(element, 'finalized');
      return false;
    }
    this.clearPending(element);
    try {
      if (decision.exclude) element.classList.add(FLOW_CHAT_CLASSES.deleted);
      element.classList.add(FLOW_CHAT_CLASSES.filtered);
      this.states.set(element, 'finalized');
      return true;
    } catch (error) {
      this.reportError(error, element);
      // A classList failure must not leave a Flow-observed node pending.
      this.states.set(element, 'finalized');
      return false;
    }
  }

  finalizeAllowed(
    element: HTMLElement,
    _source: FlowChatDecisionSource = 'fail-open',
  ): boolean {
    return this.finalize(element, {
      exclude: false,
      score: 0,
      threshold: 1,
      source: _source,
    });
  }

  finalizeExcluded(
    element: HTMLElement,
    score = 1,
    threshold = 0,
    source: FlowChatDecisionSource = 'rule',
  ): boolean {
    return this.finalize(element, {
      exclude: true,
      score,
      threshold,
      source,
    });
  }

  isFinalized(element: HTMLElement): boolean {
    return (
      this.states.get(element) === 'finalized' ||
      element.classList.contains(FLOW_CHAT_CLASSES.filtered)
    );
  }

  isPending(element: HTMLElement): boolean {
    return this.states.get(element) === 'pending';
  }

  clearElement(element: HTMLElement): void {
    this.clearPending(element);
    this.states.delete(element);
    element.classList.remove(
      FLOW_CHAT_CLASSES.filtered,
      FLOW_CHAT_CLASSES.deleted,
    );
  }

  clearElements(root: ParentNode): void {
    if (root instanceof HTMLElement) this.clearElement(root);
    root
      .querySelectorAll<HTMLElement>(
        `.${FLOW_CHAT_CLASSES.filtered}, .${FLOW_CHAT_CLASSES.deleted}`,
      )
      .forEach((element) => this.clearElement(element));
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  private cancel(element: HTMLElement): void {
    if (this.states.get(element) !== 'pending') return;
    // A cancelled Flow observation still has to be finalized so Flow Chat
    // never waits for a node after the caller abandons classification.
    this.finalizeAllowed(element, 'fail-open');
  }

  private clearPending(element: HTMLElement): void {
    const entry = this.pending.get(element);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    this.pending.delete(element);
  }

  private forceFinalizeAllowed(element: HTMLElement): void {
    this.clearPending(element);
    try {
      element.classList.add(FLOW_CHAT_CLASSES.filtered);
    } catch (error) {
      this.reportError(error, element);
    }
    this.states.set(element, 'finalized');
  }

  private noopGuard(startedAt: number): FlowChatGuard {
    return {
      startedAt,
      finalize: () => false,
      finalizeAllowed: () => false,
      cancel: () => undefined,
    };
  }

  private reportError(error: unknown, element: HTMLElement): void {
    try {
      this.onError?.(error, element);
    } catch {
      // Diagnostics must never prevent the fail-open finalization path.
    }
  }
}
