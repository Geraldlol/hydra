import * as path from "node:path";
import { atomicWriteFile, ensureFile, readFileHead } from "./fileQueue";

const OBJECTIVE_HEADER = "# Hydra Room Objective";
export const MAX_OBJECTIVE_FILE_BYTES = 64 * 1024;

export async function ensureObjectiveFile(filePath: string): Promise<void> {
  await ensureFile(filePath, `${OBJECTIVE_HEADER}\n\n`);
}

export async function readObjective(filePath: string): Promise<string> {
  try {
    const bounded = await readFileHead(filePath, MAX_OBJECTIVE_FILE_BYTES);
    const objective = parseObjective(bounded.text);
    return bounded.truncated
      ? `${objective}${objective ? "\n\n" : ""}[Objective truncated at ${MAX_OBJECTIVE_FILE_BYTES} bytes]`
      : objective;
  } catch {
    return "";
  }
}

export async function writeObjective(filePath: string, objective: string): Promise<void> {
  // Strip the header from incoming text first. Without this, an objective
  // round-tripped through readObjective \u2192 writeObjective grows by one
  // header copy per cycle if the user typed something starting with
  // "# Hydra Room Objective" or if the parser is ever called twice.
  const sanitized = parseObjective(objective);
  const body = sanitized ? `${sanitized}\n` : "";
  await atomicWriteFile(filePath, `${OBJECTIVE_HEADER}\n\n${body}`);
}

export function parseObjective(text: string): string {
  // Strip BOM and any number of leading "# Hydra Room Objective" lines \u2014
  // a previously-corrupted file may have multiple, and a single non-global
  // strip would leave the second one in place to grow on the next round-trip.
  let cleaned = text.replace(/^\uFEFF/, "");
  while (/^# Hydra Room Objective\s*/i.test(cleaned)) {
    cleaned = cleaned.replace(/^# Hydra Room Objective\s*/i, "");
  }
  return cleaned.trim();
}

export function objectiveAsContext(objective: string): string {
  const trimmed = objective.trim();
  if (!trimmed) {
    return [
      "--- Pinned room objective ---",
      "Not set. If the user has not provided a concrete task in the active transcript, ask for one narrow objective.",
    ].join("\n");
  }
  return ["--- Pinned room objective ---", trimmed].join("\n");
}
