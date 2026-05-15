import * as vscode from "vscode";
import { HydraRoomPanel } from "./panel";
import { AgentId } from "./phases";
import { renderHydraStatusBar, type HydraStatusBarSnapshot } from "./statusBar";

// Command-palette callbacks have no built-in error surface in VS Code:
// async rejections become unhandled and appear in the host log, not in the UI.
// Wrap each async handler so init failures (e.g. no workspace folder open)
// produce a user-visible message, matching the webview-side guard in panel.ts.
function withErrorReporting(fn: () => Promise<void>): () => Promise<void> {
  return () =>
    fn().catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const action = await vscode.window.showErrorMessage(
        `Hydra Room hit an error: ${msg}`,
        "Run Doctor",
      );
      if (action === "Run Doctor") {
        await vscode.commands.executeCommand("hydraRoom.runDoctor");
      }
    });
}

// Same idea but for synchronous handlers — catches a synchronous throw
// from HydraRoomPanel.open (which is sync; its async init runs separately
// behind ready()) and surfaces it as a user-visible error. We still kick
// off the toast asynchronously (awaiting the Thenable) so the user has a
// one-click path into the Doctor when something blew up at command time.
function withSyncErrorReporting(fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void (async () => {
        const action = await vscode.window.showErrorMessage(
          `Hydra Room hit an error: ${msg}`,
          "Run Doctor",
        );
        if (action === "Run Doctor") {
          await vscode.commands.executeCommand("hydraRoom.runDoctor");
        }
      })();
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "Hydra";
  statusBar.command = "hydraRoom.commandCenter";
  const updateStatusBar = (snapshot: HydraStatusBarSnapshot): void => {
    const rendered = renderHydraStatusBar(snapshot);
    statusBar.text = rendered.text;
    statusBar.tooltip = rendered.tooltip;
    statusBar.backgroundColor = rendered.attention === "warning"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    statusBar.show();
  };
  updateStatusBar({
    workspaceReady: !!vscode.workspace.workspaceFolders?.length,
    phaseLabel: "Idle",
    transport: "oneShot",
    workQueueCount: 0,
    canStop: false,
    verificationRunning: false,
    autopilotRunning: false,
  });
  HydraRoomPanel.setStatusBarUpdater(updateStatusBar);

  const openRoom = (): void => {
    HydraRoomPanel.open(context);
  };

  context.subscriptions.push(
    statusBar,
    { dispose: () => HydraRoomPanel.setStatusBarUpdater(undefined) },
    vscode.commands.registerCommand("hydraRoom.start", withSyncErrorReporting(openRoom)),
    vscode.commands.registerCommand("hydraRoom.open", withSyncErrorReporting(openRoom)),
    vscode.commands.registerCommand(
      "hydraRoom.askBoth",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Send Discussion Turn",
          prompt: "Hydra runs a serialized discussion turn, or parallel Codex + Claude replies when the instruction addresses both.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.sendUserMessage(text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.assignBuilder",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const pick = await vscode.window.showQuickPick(
          [
            { label: "Codex", value: "codex" as AgentId },
            { label: "Claude", value: "claude" as AgentId },
          ],
          { title: "Hydra: Assign Builder", placeHolder: "Who should implement?" }
        );
        if (pick) await panel.assignBuilder(pick.value);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.requestReview",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current();
        if (panel) await panel.requestReview();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.runVerification",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.runVerification();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openVerification",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openVerification();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.previewNextPrompt",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.previewNextPrompt();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openLastPrompt",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openLastPrompt();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.acceptDefaultDecision",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.acceptDefaultDecision();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.commandCenter",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.showCommandCenter();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.stop",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current();
        if (panel) await panel.stop();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.insertPromptTemplate",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.insertPromptTemplate();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.chooseModel",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.chooseModel();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.changeCapabilityProfile",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.changeCapabilityProfile();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.refreshCodexModels",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.refreshCodexModels();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.chooseEffort",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.chooseEffort();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.testTelegram",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.sendTestTelegramMessage();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openTranscript",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openTranscript();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.archiveAndClearRoom",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.archiveAndClearRoom();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openDecisions",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openDecisions();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openSessionBrief",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openSessionBrief();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openSupportBundle",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openSupportBundle();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.captureNativeCapabilities",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.captureNativeCapabilities();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.captureNativeDataSnapshot",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.captureNativeDataSnapshot();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openNativeTerminals",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openNativeTerminals();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.nativeAction",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.showNativeActionPicker();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openNativeActions",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openNativeActions();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openAgentCalls",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openAgentCalls();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.openObjective",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.openObjective();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeCodexTerminal",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Codex Terminal",
          prompt: "Send one direct native-terminal instruction to Codex.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.pokeNativeTerminal("codex", text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.runCodexCommand",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Run Codex Native Command",
          prompt: "Native args/subcommand after the configured Codex executable. Examples: doctor, mcp list, features.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.runNativeCliCommand("codex", text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.sendCodexRawTerminalLine",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Send Codex Raw Terminal Line",
          prompt: "Raw PowerShell line for the visible Codex terminal. Use this for interactive native CLI flows.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.sendRawTerminalLine("codex", text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeCodexTerminalWithEditor",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Codex With Editor Context",
          prompt: "Optional instruction. Hydra will attach the active selection, or the active file if nothing is selected.",
          ignoreFocusOut: true,
        });
        if (text !== undefined) await panel.pokeNativeTerminal("codex", text, true);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeCodexTerminalWithDiff",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Codex With Working Tree",
          prompt: "Optional instruction. Hydra will attach the current git diff, including untracked files.",
          ignoreFocusOut: true,
        });
        if (text !== undefined) await panel.pokeNativeTerminal("codex", text, { includeWorkspaceDiff: true });
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeClaudeTerminal",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Claude Terminal",
          prompt: "Send one direct native-terminal instruction to Claude.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.pokeNativeTerminal("claude", text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.runClaudeCommand",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Run Claude Native Command",
          prompt: "Native args/subcommand after the configured Claude executable. Examples: doctor, mcp list, plugin list.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.runNativeCliCommand("claude", text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.sendClaudeRawTerminalLine",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Send Claude Raw Terminal Line",
          prompt: "Raw PowerShell line for the visible Claude terminal. Use this for interactive native CLI flows.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.sendRawTerminalLine("claude", text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeClaudeTerminalWithEditor",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Claude With Editor Context",
          prompt: "Optional instruction. Hydra will attach the active selection, or the active file if nothing is selected.",
          ignoreFocusOut: true,
        });
        if (text !== undefined) await panel.pokeNativeTerminal("claude", text, true);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeClaudeTerminalWithDiff",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Claude With Working Tree",
          prompt: "Optional instruction. Hydra will attach the current git diff, including untracked files.",
          ignoreFocusOut: true,
        });
        if (text !== undefined) await panel.pokeNativeTerminal("claude", text, { includeWorkspaceDiff: true });
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeBothTerminals",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Both Native Terminals",
          prompt: "Send one direct native-terminal instruction to Codex and Claude in parallel.",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) await panel.pokeNativeTerminals(["codex", "claude"], text);
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeBothTerminalsWithEditor",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Both With Editor Context",
          prompt: "Optional instruction. Hydra will attach the active selection, or the active file if nothing is selected.",
          ignoreFocusOut: true,
        });
        if (text !== undefined) await panel.pokeNativeTerminals(["codex", "claude"], text, { includeEditorContext: true });
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.pokeBothTerminalsWithDiff",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        const text = await vscode.window.showInputBox({
          title: "Hydra: Poke Both With Working Tree",
          prompt: "Optional instruction. Hydra will attach the current git diff, including untracked files.",
          ignoreFocusOut: true,
        });
        if (text !== undefined) await panel.pokeNativeTerminals(["codex", "claude"], text, { includeWorkspaceDiff: true });
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.useTerminalBridge",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.useTerminalBridge();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.runTerminalBridgeSelfTest",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.runTerminalBridgeSelfTest();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.showEffectiveAuthority",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.showEffectiveAuthority();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.showTerminalBridgeHealth",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.showTerminalBridgeHealth();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.runDoctor",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.runDoctor();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.autopilotStart",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.runAutopilotStart();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.fixCodexPath",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.fixAgentCommand("codex");
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.fixClaudePath",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.fixAgentCommand("claude");
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.resetStuckTurn",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.resetStuckTurn();
      })
    ),
    vscode.commands.registerCommand(
      "hydraRoom.useOneShotTransport",
      withErrorReporting(async () => {
        const panel = HydraRoomPanel.current() ?? HydraRoomPanel.open(context);
        await panel.useOneShotTransport();
      })
    )
  );
}

export function deactivate(): void {
  // No-op. Panel cleans itself up on dispose.
}
