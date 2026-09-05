interface AuthorActivity {
  timestamps: number[];
  recentTexts: string[];
}

export class SpamDetector {
  private readonly activity = new Map<string, AuthorActivity>();

  evaluate(author: string, text: string, timestamp: number): number {
    if (!author) return 0;
    const state = this.activity.get(author) ?? {
      timestamps: [],
      recentTexts: [],
    };
    const cutoff = timestamp - 10_000;
    state.timestamps = state.timestamps.filter((value) => value >= cutoff);
    state.timestamps.push(timestamp);
    state.recentTexts = [...state.recentTexts.slice(-4), text];
    this.activity.set(author, state);

    const duplicates = state.recentTexts.filter(
      (value) => value === text,
    ).length;
    if (duplicates >= 3) return 0.98;
    if (state.timestamps.length >= 6) return 0.86;
    if ((text.match(/[\p{Extended_Pictographic}]/gu)?.length ?? 0) >= 12)
      return 0.82;
    return 0;
  }
}
