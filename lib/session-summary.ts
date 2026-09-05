import type { SessionSummary } from './types';

export interface StoredSessionSummary {
  tabId: number;
  frameId: number;
  summary: SessionSummary;
  updatedAt: number;
}

export type LmStudioStatus = SessionSummary['lmStudio'];

export function aggregateSessionSummaries(
  sessions: StoredSessionSummary[],
  lmStudio: LmStudioStatus,
): SessionSummary {
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
  };
}
