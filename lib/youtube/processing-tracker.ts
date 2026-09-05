export interface ChatProcessingToken {
  element: HTMLElement;
  signature: string;
  revision: number;
}

export class ChatProcessingTracker {
  private revision = 0;
  private processed = new WeakMap<HTMLElement, string>();

  begin(element: HTMLElement, signature: string): ChatProcessingToken | null {
    if (this.processed.get(element) === signature) return null;
    this.processed.set(element, signature);
    return { element, signature, revision: this.revision };
  }

  isCurrent(token: ChatProcessingToken): boolean {
    return (
      token.revision === this.revision &&
      this.processed.get(token.element) === token.signature
    );
  }

  reset(): void {
    this.revision += 1;
    this.processed = new WeakMap<HTMLElement, string>();
  }
}
