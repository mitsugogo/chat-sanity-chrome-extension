import type { SessionSummary } from './types';

export interface StoredSessionSummary {
  tabId: number;
  frameId: number;
  summary: SessionSummary;
  updatedAt: number;
}

export type LmStudioStatus = SessionSummary['lmStudio'];
export type LocalAiStatus = SessionSummary['localAi'];

export function aggregateSessionSummaries(
  sessions: StoredSessionSummary[],
  lmStudio: LmStudioStatus,
  fallbackLocalAi: LocalAiStatus = {
    activeProvider: 'rules',
    status: 'unavailable',
  },
): SessionSummary {
  const localAi =
    [...sessions.map((session) => session.summary.localAi), fallbackLocalAi]
      .filter((value): value is LocalAiStatus => Boolean(value))
      .sort(
        (left, right) => statusRank(right.status) - statusRank(left.status),
      )[0] ?? fallbackLocalAi;
  return {
    active: sessions.some((session) => session.summary.active),
    hidden: sessions.reduce(
      (total, session) => total + session.summary.hidden,
      0,
    ),
    blurred: sessions.reduce(
      (total, session) => total + session.summary.blurred,
      0,
    ),
    lmStudio,
    localAi,
  };
}

function statusRank(status: LocalAiStatus['status']): number {
  if (status === 'ready') return 2;
  if (status === 'downloading') return 1;
  return 0;
}
