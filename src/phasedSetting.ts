// Helpers for "phased" Hydra settings — values that can be either a single
// string (applied to every phase) OR an object with `discussion` / `build` /
// `review` keys (per-phase overrides). hydraRoom.claudeModel,
// hydraRoom.codexModel, hydraRoom.claudeEffort, and hydraRoom.codexReasoning
// all share this shape and used to have near-identical helper copies on
// the HydraRoomPanel class.

export type PhaseScope = "all" | "discussion" | "build" | "review";

/**
 * Resolve the value to use during a specific phase. Differs from
 * phasedSettingForScope: when the setting is a single string, this returns
 * that string for any phase (the "applies globally" interpretation the
 * dispatcher needs), whereas phasedSettingForScope gates strings to
 * scope === "all" (the chooser's "is there a specific override?"
 * interpretation).
 */
export function effectivePhasedSetting(
  raw: unknown,
  phase: "discussion" | "build" | "review",
): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const entry = (raw as Record<string, unknown>)[phase];
    if (typeof entry === "string") return entry.trim();
  }
  return "";
}

/** Resolve a numeric phased setting, using fallback when the phase is unset or invalid. */
export function effectivePhasedNumberSetting(
  raw: unknown,
  phase: "discussion" | "build" | "review",
  fallback: number,
): number {
  const parseNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };

  const global = parseNumber(raw);
  if (global !== undefined) return global;
  if (raw && typeof raw === "object") {
    const entry = parseNumber((raw as Record<string, unknown>)[phase]);
    if (entry !== undefined) return entry;
  }
  return fallback;
}

/** Resolve the configured value for a specific scope; "" if unset. */
export function phasedSettingForScope(raw: unknown, scope: PhaseScope): string {
  if (typeof raw === "string") return scope === "all" ? raw.trim() : "";
  if (raw && typeof raw === "object" && scope !== "all") {
    const v = (raw as Record<string, unknown>)[scope];
    return typeof v === "string" ? v.trim() : "";
  }
  return "";
}

/**
 * Compute the next setting value when the user picks `value` for `scope`.
 *
 * - "all" scope collapses to a single string.
 * - Per-phase scope always produces an object. If the previous value was a
 *   string, it's broadcast to all three phases first so the un-touched
 *   phases keep that value when one is changed.
 * - Empty `value` clears the override for that scope. If every phase ends
 *   up empty, the result collapses back to "" so the setting clears
 *   cleanly in the settings UI.
 */
export function applyPhasedSettingChange(
  current: unknown,
  scope: PhaseScope,
  value: string,
): unknown {
  if (scope === "all") return value;
  let next: Record<string, string> = {};
  if (typeof current === "string" && current.trim()) {
    next = { discussion: current.trim(), build: current.trim(), review: current.trim() };
  } else if (current && typeof current === "object") {
    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      if (typeof v === "string") next[k] = v;
    }
  }
  if (value) next[scope] = value;
  else delete next[scope];
  if (Object.values(next).every((v) => !v)) return "";
  return next;
}

export interface SummaryOptions {
  /** Returned when nothing is configured. */
  fallback?: string;
  /** Separator between per-phase entries when phases differ. Defaults to "/". */
  separator?: string;
}

/**
 * Compact one-line summary for the rail chip.
 *
 *   ""              → fallback
 *   "sonnet"        → "sonnet"
 *   { all same }    → that value
 *   { d≠b≠r }       → "d=X/b=Y/r=Z" (with the chosen separator)
 */
export function summarizePhasedSetting(raw: unknown, options: SummaryOptions = {}): string {
  const fallback = options.fallback ?? "";
  const separator = options.separator ?? "/";
  if (typeof raw === "string") return raw.trim() || fallback;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const d = typeof obj.discussion === "string" ? obj.discussion.trim() : "";
    const b = typeof obj.build === "string" ? obj.build.trim() : "";
    const r = typeof obj.review === "string" ? obj.review.trim() : "";
    if (!d && !b && !r) return fallback;
    if (d && d === b && d === r) return d;
    const parts: string[] = [];
    if (d) parts.push(`d=${d}`);
    if (b) parts.push(`b=${b}`);
    if (r) parts.push(`r=${r}`);
    return parts.join(separator);
  }
  return fallback;
}

/**
 * Human-readable "currently: …" label used in the chooser placeholder text.
 *
 *   undefined / ""  → "currently: <defaultLabel>"
 *   "sonnet"        → "currently: sonnet"
 *   { d: "high" }   → "currently: d=high"
 *   { d: "high", b: "low" } → "currently: d=high, b=low"
 */
export function describePhasedSettingCurrent(raw: unknown, defaultLabel = "CLI default"): string {
  if (typeof raw === "string" && raw.trim()) return `currently: ${raw.trim()}`;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ["discussion", "build", "review"]) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) parts.push(`${k[0]}=${v.trim()}`);
    }
    if (parts.length) return `currently: ${parts.join(", ")}`;
  }
  return `currently: ${defaultLabel}`;
}
