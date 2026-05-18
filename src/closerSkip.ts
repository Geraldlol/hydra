import { decisionHasNoUserBlockers, parseDecisionPacket } from "./decisions";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export interface CloserSkipMeta {
  agent: AgentId;
  phase?: Phase;
  sourceMessageTimestamp: string;
}

export function shouldAutoSkipCloserOnAgreement(text: string, meta: CloserSkipMeta): boolean {
  if (!/^\s*Agree:/i.test(text)) return false;
  return decisionHasNoUserBlockers(parseDecisionPacket(text, meta));
}
