import type {
  FlowChatDecisionSource,
  FlowChatSettings,
  SettingsV1,
} from '../../types';

/**
 * Flow Chat's public DOM handshake. Keep these names isolated from the
 * classifier so a protocol update can be reviewed independently.
 *
 * The class names are verified against the Flow Chat contract supplied with
 * this integration. A Flow Chat source revision is intentionally not pinned
 * here; recheck the public contract when Flow Chat changes its protocol.
 */
export const FLOW_CHAT_CLASSES = {
  active: 'ylcfr-active',
  filtered: 'ylcfr-filtered-message',
  deleted: 'ylcfr-deleted-message',
} as const;

/** Stay below Flow Chat's approximately one-second wait even on a busy tab. */
export const FLOW_CHAT_DEADLINE_MS = 750;
export const FLOW_CHAT_EXPECTED_WAIT_TIMEOUT_MS = 1_000;

export const FLOW_CHAT_PROTOCOL = {
  activeClass: FLOW_CHAT_CLASSES.active,
  filteredClass: FLOW_CHAT_CLASSES.filtered,
  deletedClass: FLOW_CHAT_CLASSES.deleted,
  expectedWaitTimeoutMs: FLOW_CHAT_EXPECTED_WAIT_TIMEOUT_MS,
} as const;

export const FLOW_CHAT_PROTOCOL_VERSION = 'ylcfr-dom-v1';

export interface FlowChatDecision {
  exclude: boolean;
  score: number;
  threshold?: number;
  source?: FlowChatDecisionSource;
}

export function resolveFlowChatThreshold(
  settings: Pick<SettingsV1, 'activePreset' | 'profiles' | 'flowChat'>,
): number {
  const profile = settings.profiles[settings.activePreset];
  const flowSettings: FlowChatSettings = settings.flowChat;
  if (flowSettings.exclusionLevel === 'hide') return profile.thresholds.hide;
  if (flowSettings.exclusionLevel === 'custom') {
    return clamp(flowSettings.customThreshold ?? profile.thresholds.blur, 0, 1);
  }
  return profile.thresholds.blur;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
