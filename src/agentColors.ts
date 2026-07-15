import type { AgentDefinition } from "./agentAdapter";

export const HEAD_COLOR_COUNT = 8;

/** Assign a 1-based head-ramp slot to any definition missing an explicit one. */
export function assignColorIndexes(defs: AgentDefinition[]): AgentDefinition[] {
  return defs.map((def, i) => ({ ...def, colorIndex: def.colorIndex ?? (i % HEAD_COLOR_COUNT) + 1 }));
}
