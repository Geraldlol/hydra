import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import type { AuthorityClassification } from "./authority";
import type { CliProfile } from "./cli";

export type CapabilityProfileId =
  | "safeDiscussion"
  | "nativeDiscussion"
  | "nativeBuild"
  | "nativeReview"
  | "fullNative"
  | "elevated"
  | "custom";

export type ConfigurableCapabilityProfileId = Exclude<CapabilityProfileId, "elevated">;

export type CapabilityWarningLevel = "safe" | "workspaceWrite" | "fullNative" | "custom";

export interface CapabilityProfilePreset {
  id: ConfigurableCapabilityProfileId;
  label: string;
  detail: string;
  expectedAuthority: AuthorityClassification["level"];
  warningLevel: CapabilityWarningLevel;
  readsStdin: boolean;
}

export interface CapabilityProfile {
  id: CapabilityProfileId;
  label: string;
  detail: string;
  command?: string;
  args?: string[];
  cwd?: string;
  readsStdin?: boolean;
  expectedAuthority?: AuthorityClassification["level"];
  warningLevel?: CapabilityWarningLevel;
}

const PRESETS: Record<ConfigurableCapabilityProfileId, CapabilityProfilePreset> = {
  safeDiscussion: {
    id: "safeDiscussion",
    label: "Safe Discussion",
    detail: "Read-only native discussion.",
    expectedAuthority: "readOnly",
    warningLevel: "safe",
    readsStdin: true,
  },
  nativeDiscussion: {
    id: "nativeDiscussion",
    label: "Native Discussion",
    detail: "Discussion with workspace-write native CLI capabilities.",
    expectedAuthority: "workspaceWrite",
    warningLevel: "workspaceWrite",
    readsStdin: true,
  },
  nativeBuild: {
    id: "nativeBuild",
    label: "Native Build",
    detail: "Build profile with workspace-write authority.",
    expectedAuthority: "workspaceWrite",
    warningLevel: "workspaceWrite",
    readsStdin: true,
  },
  nativeReview: {
    id: "nativeReview",
    label: "Native Review",
    detail: "Review profile intended for read-only diff inspection.",
    expectedAuthority: "readOnly",
    warningLevel: "safe",
    readsStdin: true,
  },
  fullNative: {
    id: "fullNative",
    label: "Full Native",
    detail: "Full native CLI authority with sandbox bypass or equivalent permissions.",
    expectedAuthority: "fullNative",
    warningLevel: "fullNative",
    readsStdin: true,
  },
  custom: {
    id: "custom",
    label: "Custom",
    detail: "Use the raw hydraRoom.*ExecArgs* setting.",
    expectedAuthority: "unknown",
    warningLevel: "custom",
    readsStdin: true,
  },
};

export function profileSettingKey(agent: AgentId, profile: CliProfile): string {
  const phase = profile[0].toUpperCase() + profile.slice(1);
  return `${agent}${phase}Profile`;
}

export function configurableCapabilityProfiles(): CapabilityProfilePreset[] {
  return [
    PRESETS.safeDiscussion,
    PRESETS.nativeDiscussion,
    PRESETS.nativeBuild,
    PRESETS.nativeReview,
    PRESETS.fullNative,
    PRESETS.custom,
  ];
}

export function capabilityProfilePreset(id: CapabilityProfileId): CapabilityProfilePreset | undefined {
  return id === "elevated" ? undefined : PRESETS[id];
}

export function capabilityProfileShortLabel(id: ConfigurableCapabilityProfileId): string {
  switch (id) {
    case "safeDiscussion":
      return "safe";
    case "nativeDiscussion":
      return "native";
    case "nativeBuild":
      return "build";
    case "nativeReview":
      return "review";
    case "fullNative":
      return "full";
    case "custom":
      return "custom";
  }
}

export function isConfigurableCapabilityProfileId(value: unknown): value is ConfigurableCapabilityProfileId {
  return typeof value === "string" && value in PRESETS;
}

export function argsForCapabilityProfile(agent: AgentId, profile: ConfigurableCapabilityProfileId): string[] | undefined {
  if (profile === "custom") return undefined;
  if (agent === "codex") return codexArgsForProfile(profile);
  return claudeArgsForProfile(profile);
}

export function describeConfiguredCapabilityProfile(
  agent: AgentId,
  id: ConfigurableCapabilityProfileId,
  command: string,
  args: string[],
  cwd: string
): CapabilityProfile {
  const preset = PRESETS[id];
  return {
    ...preset,
    command,
    args,
    cwd,
    detail: id === "custom"
      ? `${agent} uses raw native args: ${args.length ? args.join(" ") : "no args"}.`
      : preset.detail,
  };
}

export function describeCapabilityProfile(
  agent: AgentId,
  phase: Phase,
  args: string[],
  authority: AuthorityClassification
): CapabilityProfile {
  if (authority.level === "fullNative") {
    return {
      id: "fullNative",
      label: "Full Native",
      detail: `${agent} is running with full native CLI authority.`,
      expectedAuthority: "fullNative",
      warningLevel: "fullNative",
      readsStdin: readsStdin(args),
    };
  }

  // Authority must drive labelling before phase. A discussion or review call
  // configured with workspace-write authority is an elevated profile, not a
  // "safe" or "review" profile -- surface that honestly while the
  // native args still pass through.
  const isDiscussion = phase === "opener" || phase === "reactor" || phase === "closer" || phase === "parallel";
  if ((isDiscussion || phase === "review") && authority.level === "workspaceWrite") {
    return {
      id: "elevated",
      label: "Elevated (workspace-write during " + phase + ")",
      detail:
        `${agent} ${phase} args grant workspace-write authority -- broader than expected for this phase.`,
      expectedAuthority: "workspaceWrite",
      warningLevel: "workspaceWrite",
      readsStdin: readsStdin(args),
    };
  }

  if (phase === "review") {
    return {
      id: "nativeReview",
      label: "Native Review",
      detail: `${agent} is using the configured native review profile.`,
      expectedAuthority: "readOnly",
      warningLevel: "safe",
      readsStdin: readsStdin(args),
    };
  }

  if (phase === "build") {
    return {
      id: "nativeBuild",
      label: "Native Build",
      detail: `${agent} is using the configured native build profile.`,
      expectedAuthority: "workspaceWrite",
      warningLevel: "workspaceWrite",
      readsStdin: readsStdin(args),
    };
  }

  if (authority.level === "readOnly") {
    return {
      id: "safeDiscussion",
      label: "Safe Discussion",
      detail: `${agent} discussion is classified as read-only.`,
      expectedAuthority: "readOnly",
      warningLevel: "safe",
      readsStdin: readsStdin(args),
    };
  }

  if (authority.level === "workspaceWrite") {
    return {
      id: "nativeDiscussion",
      label: "Native Discussion",
      detail: `${agent} discussion can use workspace-write native CLI capabilities.`,
      expectedAuthority: "workspaceWrite",
      warningLevel: "workspaceWrite",
      readsStdin: readsStdin(args),
    };
  }

  return {
    id: "custom",
    label: "Custom",
    detail: `${agent} args are custom: ${args.length ? args.join(" ") : "no args"}.`,
    expectedAuthority: "unknown",
    warningLevel: "custom",
    readsStdin: readsStdin(args),
  };
}

function codexArgsForProfile(profile: ConfigurableCapabilityProfileId): string[] | undefined {
  switch (profile) {
    case "safeDiscussion":
      return ["exec", "--sandbox", "read-only", "--color", "never", "--cd", "${workspaceFolder}", "-"];
    case "nativeDiscussion":
    case "nativeBuild":
      return [
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "--color",
        "never",
        "--cd",
        "${workspaceFolder}",
        "-",
      ];
    case "nativeReview":
      return ["review", "--uncommitted", "-"];
    case "fullNative":
      return ["exec", "--sandbox", "danger-full-access", "--color", "never", "--cd", "${workspaceFolder}", "-"];
    case "custom":
      return undefined;
  }
}

function claudeArgsForProfile(profile: ConfigurableCapabilityProfileId): string[] | undefined {
  switch (profile) {
    case "safeDiscussion":
    case "nativeReview":
      return ["-p", "--permission-mode", "default", "--add-dir", "${workspaceFolder}"];
    case "nativeDiscussion":
    case "nativeBuild":
      return ["-p", "--permission-mode", "acceptEdits", "--add-dir", "${workspaceFolder}"];
    case "fullNative":
      return ["-p", "--permission-mode", "bypassPermissions", "--add-dir", "${workspaceFolder}"];
    case "custom":
      return undefined;
  }
}

function readsStdin(args: string[]): boolean {
  return args.includes("-") || args.includes("--print") || args.includes("-p");
}
