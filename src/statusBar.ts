export interface HydraStatusBarSnapshot {
  workspaceReady: boolean;
  phaseLabel: string;
  transport: "oneShot" | "terminalBridge";
  workQueueCount: number;
  canStop: boolean;
  verificationRunning: boolean;
  autopilotRunning: boolean;
}

export interface HydraStatusBarRender {
  text: string;
  tooltip: string;
  attention: "none" | "warning";
}

export function renderHydraStatusBar(snapshot: HydraStatusBarSnapshot): HydraStatusBarRender {
  const transport = snapshot.transport === "terminalBridge" ? "terminal bridge" : "one-shot";
  const details = [
    `Phase: ${snapshot.phaseLabel}`,
    `Transport: ${transport}`,
    `Work Queue: ${snapshot.workQueueCount}`,
    "Click to open Hydra Command Center.",
  ];

  if (!snapshot.workspaceReady) {
    return {
      text: "$(warning) Hydra setup",
      tooltip: ["Hydra needs a workspace folder.", ...details].join("\n"),
      attention: "warning",
    };
  }

  if (snapshot.autopilotRunning) {
    return {
      text: "$(sync~spin) Hydra auto",
      tooltip: ["Hydra Autopilot is checking the room.", ...details].join("\n"),
      attention: "none",
    };
  }

  if (snapshot.verificationRunning) {
    return {
      text: "$(sync~spin) Hydra verify",
      tooltip: ["Hydra verification is running.", ...details].join("\n"),
      attention: "none",
    };
  }

  if (snapshot.canStop) {
    return {
      text: "$(sync~spin) Hydra running",
      tooltip: ["Hydra has an active turn. Click for recovery and room actions.", ...details].join("\n"),
      attention: "none",
    };
  }

  if (snapshot.workQueueCount > 0) {
    return {
      text: `$(warning) Hydra ${snapshot.workQueueCount}`,
      tooltip: [`Hydra has ${snapshot.workQueueCount} work queue item${snapshot.workQueueCount === 1 ? "" : "s"}.`, ...details].join("\n"),
      attention: "warning",
    };
  }

  return {
    text: "$(hubot) Hydra",
    tooltip: ["Hydra is ready.", ...details].join("\n"),
    attention: "none",
  };
}
