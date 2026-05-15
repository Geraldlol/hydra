import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureFile } from "./fileQueue";

const OBJECTIVE_HEADER = "# Hydra Room Objective";

export async function ensureObjectiveFile(filePath: string): Promise<void> {
  await ensureFile(filePath, `${OBJECTIVE_HEADER}\n\n`);
}

export async function readObjective(filePath: string): Promise<string> {
  try {
    return parseObjective(await fs.readFile(filePath, "utf8"));
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
      "Not set. If the user has not provided a concrete task in the bounded transcript, ask for one narrow objective.",
    ].join("\n");
  }
  return ["--- Pinned room objective ---", trimmed].join("\n");
}
