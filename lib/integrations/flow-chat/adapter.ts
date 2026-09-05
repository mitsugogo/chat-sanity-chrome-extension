/** Stable integration entrypoint; the implementation lives in bridge.ts. */
export {
  FlowChatBridge,
  FlowChatBridge as FlowChatAdapter,
  type FlowChatBridgeOptions,
  type FlowChatGuard,
} from './bridge';
export {
  FLOW_CHAT_CLASSES,
  FLOW_CHAT_DEADLINE_MS,
  FLOW_CHAT_EXPECTED_WAIT_TIMEOUT_MS,
  FLOW_CHAT_PROTOCOL,
  FLOW_CHAT_PROTOCOL_VERSION,
  resolveFlowChatThreshold,
  type FlowChatDecision,
} from './constants';
