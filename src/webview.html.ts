export interface HydraHeadAssets {
  cspSource: string;
  brand: string;
  codex: string;
  claude: string;
  system: string;
  user: string;
}

export function renderHtml(nonce: string, heads: HydraHeadAssets): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${heads.cspSource}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>Hydra Room</title>
  <style>
    :root {
      color-scheme: light dark;
      --panel: var(--vscode-editor-background);
      --panel-alt: var(--vscode-sideBar-background);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --button: var(--vscode-button-background);
      --button-text: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --secondary-button: var(--vscode-button-secondaryBackground);
      --secondary-text: var(--vscode-button-secondaryForeground);
      --secondary-hover: var(--vscode-button-secondaryHoverBackground);
      --input: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --focus: var(--vscode-focusBorder);
      --codex: #4fb3ff;
      --claude: #d19a66;
      --user: #7bd88f;
      --system: var(--muted);
      --warn: var(--vscode-editorWarning-foreground);
      --error: var(--vscode-errorForeground);
      --ok: #7bd88f;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; min-width: 0; }
    body { margin: 0; color: var(--text); background: var(--panel); overflow: hidden; }
    button, textarea, select, input { font: inherit; }
    button {
      min-height: 28px; padding: 4px 10px; border: 1px solid transparent;
      color: var(--button-text); background: var(--button); cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--button-hover); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.secondary,
    .rail-chip,
    .rail-link,
    .palette-meta {
      color: var(--secondary-text);
      background: var(--secondary-button);
      border-color: var(--border);
    }
    button.secondary:hover:not(:disabled),
    .rail-link:hover { background: var(--secondary-hover); }
    button.danger { background: var(--error); color: var(--vscode-button-foreground); }
    button.suggested { outline: 2px solid var(--focus); outline-offset: 1px; }
    .hidden { display: none !important; }

    .app {
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: var(--panel);
    }

    #operationalRail {
      min-height: 54px;
      display: grid;
      grid-template-columns: auto minmax(180px, 0.45fr) minmax(260px, 1fr);
      align-items: center;
      gap: 5px 12px;
      padding: 7px 10px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-alt) 82%, var(--panel));
      overflow: visible;
      font-size: 12px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      flex: none;
    }
    .brand-mark {
      width: 18px; height: 18px; border-radius: 50%;
      border: 1px solid var(--focus);
      overflow: hidden;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--focus); font-size: 11px; font-weight: 700;
    }
    .brand-mark img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .rail-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .rail-primary,
    .rail-secondary {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .rail-primary { flex-wrap: nowrap; }
    .rail-secondary {
      flex-wrap: wrap;
      max-height: 46px;
      overflow: hidden;
      align-content: center;
    }
    .rail-spacer { display: none; }
    .rail-chip,
    .phase-chip,
    .agent-status,
    .authority-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 22px;
      max-width: 180px;
      padding: 2px 7px;
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
    }
    .phase-chip {
      flex: none;
      max-width: 240px;
      color: var(--text);
      border-color: var(--focus);
      font-weight: 650;
      background: color-mix(in srgb, var(--focus) 9%, transparent);
    }
    .agent-status { max-width: 150px; }
    .authority-badge { max-width: 138px; }
    .rail-chip.optional { max-width: 145px; }
    .phase-chip.idle { color: var(--muted); border-color: var(--border); background: transparent; font-weight: 500; }
    .phase-chip.experimental { color: var(--warn); border-color: var(--warn); }
    .agent-status::before,
    .authority-badge::before,
    .rail-chip::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--muted);
      flex: none;
    }
    .agent-status.running::before { background: var(--focus); animation: pulse 1.1s ease-in-out infinite; }
    .agent-status.replied::before,
    .authority-badge.readOnly::before,
    .rail-chip.ok::before { background: var(--ok); }
    .agent-status.error::before,
    .authority-badge.unknown::before,
    .rail-chip.error::before { background: var(--error); }
    .agent-status.codex::before { background: var(--codex); }
    .agent-status.claude::before { background: var(--claude); }
    .authority-badge.workspaceWrite::before { background: var(--focus); }
    .authority-badge.fullNative::before,
    .rail-chip.warn::before { background: var(--warn); }
    .rail-label { color: var(--muted); }
    .rail-value { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
    .rail-objective {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      color: var(--muted);
      overflow: hidden;
    }
    #objectiveText {
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @keyframes pulse { 50% { opacity: 0.38; } }

    #messages {
      overflow: auto;
      padding: 12px 14px 18px;
      scroll-behavior: smooth;
    }
    .empty {
      max-width: 760px;
      color: var(--muted);
      line-height: 1.5;
      margin: 0;
    }
    .phase-mark {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      margin: 6px 0 10px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .phase-mark::after {
      content: "";
      display: block;
      height: 1px;
      background: var(--border);
    }
    .message {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      gap: 12px;
      margin: 0 0 10px;
    }
    .message-time {
      color: var(--muted);
      text-align: right;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      padding-top: 7px;
    }
    .message-card {
      border-left: 3px solid var(--system);
      padding: 7px 10px 9px;
      background: color-mix(in srgb, var(--panel-alt) 68%, transparent);
      border-radius: 4px;
    }
    .message.user .message-card { border-left-color: var(--user); }
    .message.codex .message-card { border-left-color: var(--codex); }
    .message.claude .message-card { border-left-color: var(--claude); }
    .message.error .message-card { border-left-color: var(--error); }
    .message.cancelled .message-card { border-left-color: var(--warn); opacity: 0.86; }
    .message-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 11px;
    }
    .head-art {
      width: 22px; height: 22px;
      border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid currentColor;
      overflow: hidden;
      background: color-mix(in srgb, var(--panel) 70%, transparent);
      font-size: 10px;
      font-weight: 700;
      flex: none;
    }
    .head-art img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .head-art.codex, .speaker.codex { color: var(--codex); }
    .head-art.claude, .speaker.claude { color: var(--claude); }
    .head-art.user, .speaker.user { color: var(--user); }
    .head-art.system, .speaker.system { color: var(--muted); }
    .speaker { color: var(--text); font-weight: 650; text-transform: lowercase; }
    .role-tag { color: var(--muted); font-family: var(--vscode-editor-font-family); }
    .message-status { margin-left: auto; color: var(--muted); }
    .text {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.45;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    .pending .text::after {
      content: "|";
      display: inline-block;
      margin-left: 2px;
      animation: blink 1s steps(1) infinite;
      opacity: 0.7;
    }
    .pending .text:empty::before {
      content: attr(data-placeholder);
      color: var(--muted);
      font-style: italic;
    }
    @keyframes blink { 50% { opacity: 0; } }
    @media (max-width: 720px) {
      .message, .phase-mark { grid-template-columns: 54px minmax(0, 1fr); gap: 8px; }
      .message-time { font-size: 10px; }
      #messages { padding-left: 10px; padding-right: 10px; }
      #operationalRail { grid-template-columns: auto minmax(0, 1fr); }
      .rail-secondary { grid-column: 1 / -1; }
      .rail-objective, .rail-chip.optional, .authority-badge .rail-value { display: none; }
    }

    #composer-region {
      border-top: 1px solid var(--border);
      background: var(--panel-alt);
    }
    .ribbon-stack {
      display: grid;
      position: relative;
    }
    .ribbon-toggle {
      position: absolute;
      top: 5px;
      right: 12px;
      z-index: 2;
      min-height: 23px;
      padding: 2px 8px;
      font-size: 11px;
    }
    .ribbon-minimized-summary {
      display: none;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ribbon-stack.is-minimized {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 31px;
      padding: 4px 12px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-alt) 78%, var(--panel));
    }
    .ribbon-stack.is-minimized > :not(.ribbon-toggle):not(.ribbon-minimized-summary) {
      display: none !important;
    }
    .ribbon-stack.is-minimized .ribbon-toggle {
      position: static;
      flex: none;
    }
    .ribbon-stack.is-minimized .ribbon-minimized-summary {
      display: block;
    }
    .composer-ribbon,
    .objective,
    .setup-strip,
    .verification-strip,
    .native-action-strip,
    .work-queue-strip,
    .decision-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 12px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      background: color-mix(in srgb, var(--panel-alt) 78%, var(--panel));
    }
    .ribbon-stack:not(.is-minimized) .setup-strip,
    .ribbon-stack:not(.is-minimized) .verification-strip,
    .ribbon-stack:not(.is-minimized) .native-action-strip,
    .ribbon-stack:not(.is-minimized) .work-queue-strip,
    .ribbon-stack:not(.is-minimized) .decision-strip {
      padding-right: 96px;
    }
    .objective { display: none; }
    .composer-ribbon strong,
    .setup-strip strong,
    .verification-strip strong,
    .native-action-strip strong,
    .work-queue-strip strong,
    .decision-strip strong {
      color: var(--text);
      font-weight: 650;
    }
    .setup-actions,
    .ribbon-actions,
    .decision-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
    }
    .ribbon-collapse-btn {
      min-height: 22px;
      padding: 1px 7px;
      font-size: 11px;
      flex: none;
    }
    .setup-strip.is-collapsed,
    .verification-strip.is-collapsed,
    .native-action-strip.is-collapsed,
    .work-queue-strip.is-collapsed {
      min-height: 31px;
      padding-top: 4px;
      padding-bottom: 4px;
    }
    .setup-strip.is-collapsed .setup-actions > :not(.ribbon-collapse-btn),
    .verification-strip.is-collapsed .ribbon-actions > :not(.ribbon-collapse-btn),
    .native-action-strip.is-collapsed .ribbon-actions > :not(.ribbon-collapse-btn),
    .work-queue-strip.is-collapsed .ribbon-actions > :not(.ribbon-collapse-btn) {
      display: none !important;
    }
    #setupStrip { background: color-mix(in srgb, var(--warn) 8%, var(--panel-alt)); }
    #verificationStrip.failed { background: color-mix(in srgb, var(--error) 9%, var(--panel-alt)); }
    #decisionStrip {
      display: grid;
      grid-template-columns: minmax(100px, 0.4fr) repeat(4, minmax(110px, 1fr));
      align-items: start;
    }
    #decisionStrip.is-collapsed {
      grid-template-columns: minmax(0, 1fr);
      min-height: 31px;
      padding-top: 4px;
      padding-bottom: 4px;
    }
    #decisionStrip.is-collapsed .decision-field {
      display: none !important;
    }
    .decision-title {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--text);
      font-weight: 650;
    }
    .decision-count { margin-left: 4px; color: var(--muted); font-weight: 400; }
    .risk-chip {
      display: inline-flex; align-items: center; gap: 4px;
      margin-left: 8px; padding: 1px 8px; border-radius: 999px;
      background: color-mix(in srgb, var(--warn) 22%, var(--panel));
      color: var(--warn); border: 1px solid var(--warn);
      font-size: 11px; font-weight: 600;
    }
    .risk-chip::before { content: "!"; font-weight: 700; }
    .decision-field span {
      display: block;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @media (max-width: 880px) {
      #decisionStrip { grid-template-columns: 1fr; }
      .setup-strip,
      .verification-strip,
      .native-action-strip,
      .work-queue-strip { align-items: stretch; flex-direction: column; }
      .setup-actions, .ribbon-actions { justify-content: flex-start; }
    }

    .composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 10px 12px 12px;
    }
    #composerFrame {
      position: relative;
      min-width: 0;
    }
    #composer {
      display: block;
      width: 100%;
      min-height: 78px;
      max-height: 240px;
      resize: vertical;
      padding: 8px 10px 32px;
      border: 1px solid var(--input-border);
      color: var(--text);
      background: var(--input);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.4;
    }
    #composer:focus { border-color: var(--focus); outline: none; }
    #composer:disabled { opacity: 0.5; cursor: not-allowed; }
    #composerToolbar {
      position: absolute;
      left: 7px;
      right: 7px;
      bottom: 5px;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: none;
    }
    #composerToolbar > * { pointer-events: auto; }
    #openerBtn {
      min-height: 22px;
      padding: 1px 7px;
      font-size: 11px;
      color: var(--muted);
      background: color-mix(in srgb, var(--input) 80%, transparent);
      border-color: var(--input-border);
    }
    #composerHint {
      margin-left: auto;
      color: var(--muted);
      font-size: 11px;
    }
    #composerActions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 126px;
    }
    #sendBtn, #stopBtn {
      min-height: 38px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    #stopBtn {
      display: none;
      background: var(--error);
      color: var(--vscode-button-foreground);
      border-color: var(--error);
    }
    .app.in-flight #sendBtn { display: none; }
    .app.in-flight #stopBtn { display: block; }
    .action-bank { display: none; }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding: 44px 16px 16px;
      background: color-mix(in srgb, var(--panel) 62%, transparent);
    }
    .overlay[data-open="true"] { display: flex; }
    #commandCenter,
    .inspector {
      width: min(920px, calc(100vw - 24px));
      max-height: calc(100vh - 72px);
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--panel);
      box-shadow: 0 18px 50px color-mix(in srgb, #000 36%, transparent);
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .palette-input {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid var(--border);
      background: var(--panel-alt);
    }
    #paletteInput {
      min-height: 32px;
      border: 1px solid var(--input-border);
      background: var(--input);
      color: var(--text);
      padding: 5px 8px;
    }
    #paletteInput:focus { border-color: var(--focus); outline: none; }
    #commandList {
      overflow: auto;
      padding: 8px;
    }
    .command-group { margin-bottom: 10px; }
    .command-group h4 {
      margin: 8px 6px 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .command-option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 10px;
      align-items: center;
      padding: 7px 9px;
      border-radius: 4px;
      cursor: pointer;
    }
    .command-option[aria-selected="true"] {
      outline: 1px solid var(--focus);
      background: color-mix(in srgb, var(--focus) 12%, transparent);
    }
    .command-option[aria-disabled="true"] {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .command-name { color: var(--text); font-weight: 600; }
    .command-desc { color: var(--muted); margin-left: 6px; }
    .command-why { color: var(--warn); font-size: 11px; margin-left: 6px; }
    .kbd {
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
    }

    .inspector { display: grid; }
    .insp-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px;
      border-bottom: 1px solid var(--border);
      background: var(--panel-alt);
    }
    .insp-head h3 { margin: 0; font-size: 14px; }
    .insp-head .count { color: var(--muted); }
    .insp-body { overflow: auto; padding: 8px; }
    .panel-view { display: none; min-height: 0; overflow: hidden; }
    #panelOverlay[data-panel="actions"] .panel-view[data-view="actions"],
    #panelOverlay[data-panel="queue"] .panel-view[data-view="queue"],
    #panelOverlay[data-panel="verify"] .panel-view[data-view="verify"],
    #panelOverlay[data-panel="decisions"] .panel-view[data-view="decisions"],
    #panelOverlay[data-panel="term"] .panel-view[data-view="term"] {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .native-action-board,
    .work-queue-board,
    .decision-board,
    .terminal-sessions {
      display: grid;
      gap: 1px;
      color: var(--muted);
      font-size: 12px;
    }
    .native-action-row,
    .work-queue-row,
    .decision-row,
    .terminal-session {
      display: grid;
      grid-template-columns: minmax(90px, 0.32fr) minmax(140px, 0.5fr) minmax(220px, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 7px 8px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-alt) 50%, transparent);
    }
    .native-action-row {
      grid-template-columns: 92px 82px minmax(140px, 0.55fr) minmax(220px, 1fr) auto;
    }
    .work-queue-row {
      grid-template-columns: 92px minmax(160px, 0.55fr) minmax(220px, 1fr) auto;
    }
    .decision-row {
      grid-template-columns: 110px minmax(150px, 1fr) minmax(150px, 1fr) minmax(120px, 0.7fr);
    }
    .terminal-session {
      grid-template-columns: 1fr;
      align-items: stretch;
    }
    .native-action-row span,
    .work-queue-row span,
    .decision-row span,
    .terminal-session span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .native-action-controls,
    .work-queue-controls {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .status.completed,
    .severity.info { color: var(--focus); }
    .status.failed,
    .severity.error { color: var(--error); }
    .status.cancelled,
    .severity.warning { color: var(--warn); }
    select {
      min-height: 28px;
      color: var(--text);
      background: var(--input);
      border: 1px solid var(--input-border);
      padding: 3px 8px;
    }
    @media (max-width: 900px) {
      #operationalRail { grid-template-columns: auto minmax(150px, 1fr); }
      .rail-secondary { grid-column: 1 / -1; }
      .rail-chip.optional, #objectiveLabel { display: none; }
      .native-action-row,
      .work-queue-row,
      .decision-row { grid-template-columns: 1fr; gap: 4px; align-items: stretch; }
      .composer { grid-template-columns: 1fr; }
      #composerActions { flex-direction: row; min-width: 0; flex-wrap: wrap; }
      #sendBtn, #stopBtn { flex: 1 1 140px; }
    }
    @media (max-width: 720px) {
      #operationalRail {
        min-height: 44px;
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
      }
      .brand { display: none; }
      .rail-primary,
      .rail-secondary {
        width: 100%;
        overflow-x: auto;
        flex-wrap: nowrap;
        scrollbar-width: thin;
      }
      .rail-secondary { grid-column: auto; }
      .phase-chip,
      .agent-status,
      .authority-badge,
      .rail-chip {
        flex: 0 0 auto;
        max-width: 180px;
      }
      #composer-region { gap: 6px; padding: 6px; }
      .ribbon-stack { max-height: 34vh; }
      .setup-strip,
      .verification-strip,
      .native-action-strip,
      .work-queue-strip {
        grid-template-columns: 1fr;
        align-items: stretch;
      }
      .setup-actions,
      .ribbon-actions { justify-content: flex-start; }
      #commandCenter,
      .inspector {
        width: calc(100vw - 12px);
        max-height: calc(100vh - 24px);
      }
    }
    @media (max-width: 480px) {
      #messages { padding: 8px; }
      .message,
      .phase-mark {
        grid-template-columns: 1fr;
        gap: 4px;
      }
      .message-time {
        text-align: left;
        padding-top: 0;
      }
      .message-card { padding: 7px 8px; }
      .rail-primary { flex-direction: column; align-items: stretch; overflow-x: visible; }
      .rail-secondary { max-height: 30px; }
      .phase-chip,
      .rail-objective,
      #objectiveText {
        max-width: 100%;
      }
      .ribbon-stack { max-height: 28vh; }
      #composerFrame { min-height: 104px; }
      #composerToolbar { align-items: flex-start; }
      #composerHint { display: none; }
      #composerActions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        width: 100%;
      }
      #sendBtn,
      #stopBtn,
      #commandCenterBtn,
      #nativeActionBtn {
        width: 100%;
      }
      .command-option {
        grid-template-columns: minmax(0, 1fr);
        gap: 4px;
      }
      .command-option .kbd,
      .command-option .palette-meta { justify-self: start; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <div class="app" id="app">
    <header id="operationalRail">
      <div class="brand"><span class="brand-mark"><img src="${heads.brand}" alt=""></span><span>Hydra</span></div>
      <div class="rail-primary">
        <span id="phaseChip" class="phase-chip idle">Idle</span>
        <span class="rail-objective"><span id="objectiveLabel">Objective</span><span id="objectiveText">Not set</span></span>
      </div>
      <div class="rail-secondary">
        <span id="transportChip" class="rail-chip">Safe one-shot</span>
        <span id="codexStatus" class="agent-status codex idle">Codex: idle</span>
        <span id="claudeStatus" class="agent-status claude idle">Claude: idle</span>
        <span id="codexAuthority" class="authority-badge unknown"><span class="rail-value"><strong>Codex</strong> unknown</span></span>
        <span id="claudeAuthority" class="authority-badge unknown"><span class="rail-value"><strong>Claude</strong> unknown</span></span>
        <span id="verificationRail" class="rail-chip optional">verify: none</span>
        <span id="nativeActionRail" class="rail-chip optional">actions: 0</span>
        <span id="workQueueRail" class="rail-chip optional">queue clear</span>
        <span id="decisionRail" class="rail-chip optional">decision: none</span>
        <span id="usageRail" class="rail-chip" title="Session token usage and estimated cost. Costs are estimates using hydraRoom.modelPrices (defaults: Claude Sonnet 4.6, Codex GPT-5 blend).">session: 0 turns</span>
        <span id="modelRail" class="rail-chip" role="button" tabindex="0" title="Click to pick a model for Claude or Codex (Ctrl+Alt+M).">models: CLI default</span>
        <button id="profileBtn" class="secondary rail-link" type="button" title="Change Codex or Claude capability profile">Profiles</button>
      </div>
    </header>

    <main id="messages"><p class="empty">Loading the room...</p></main>

    <section id="composer-region">
      <div class="ribbon-stack" id="ribbonStack">
        <div id="ribbonMinimizedSummary" class="ribbon-minimized-summary">Status ribbons hidden</div>
        <button id="toggleRibbonsBtn" class="secondary ribbon-toggle" type="button" aria-expanded="true">Minimize Panel</button>
        <div class="objective"><strong>Objective</strong><span id="objectiveTextShim">Not set</span></div>
        <div id="setupStrip" class="setup-strip">
          <span><strong>Autopilot</strong> <span id="autopilotText">Not run</span></span>
          <span class="setup-actions">
            <button id="fixCodexBtn" class="secondary hidden" type="button">Fix Codex Path</button>
            <button id="fixClaudeBtn" class="secondary hidden" type="button">Fix Claude Path</button>
            <button id="retryAutopilotBtn" class="secondary" type="button">Retry Autopilot</button>
            <button id="safeModeBtn" class="secondary" type="button">Use Safe Mode</button>
            <button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="setupStrip" aria-expanded="true">Minimize</button>
          </span>
        </div>
        <div id="verificationStrip" class="verification-strip">
          <span><strong>Verification</strong> <span id="verificationText">No verification yet</span></span>
          <span class="ribbon-actions">
            <button id="runVerificationBtn" class="secondary" type="button">Run Verification</button>
            <button id="openVerificationBtn" class="secondary" type="button">Open Verification</button>
            <button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="verificationStrip" aria-expanded="true">Minimize</button>
          </span>
        </div>
        <div id="nativeActionStrip" class="native-action-strip">
          <span><strong>Native Actions</strong> <span id="nativeActionText">No native actions yet</span></span>
          <span class="ribbon-actions">
            <select id="nativeAgentFilter" title="Filter native actions by target">
              <option value="all">All heads</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="both">Both</option>
            </select>
            <select id="nativeStatusFilter" title="Filter native actions by status">
              <option value="all">All statuses</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button id="clearNativeActionsBtn" class="secondary" type="button" title="Clear all native actions currently shown by the filters">Clear Shown</button>
            <button id="openNativeActionsBtn" class="secondary" type="button">Open Actions</button>
            <button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="nativeActionStrip" aria-expanded="true">Minimize</button>
          </span>
        </div>
        <div id="workQueueStrip" class="work-queue-strip">
          <span><strong>Work Queue</strong> <span id="workQueueText">Queue clear</span></span>
          <span class="ribbon-actions"><button id="openWorkQueuePanelBtn" class="secondary" type="button">Open Queue</button><button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="workQueueStrip" aria-expanded="true">Minimize</button></span>
        </div>
        <div id="decisionStrip" class="decision-strip hidden">
          <div class="decision-title">Latest Decision<span id="decisionCount" class="decision-count"></span><span id="decisionRiskChip" class="risk-chip" style="display:none"></span><button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="decisionStrip" aria-expanded="true">Minimize</button></div>
          <div class="decision-field"><strong>Default next action</strong><span id="decisionDefault">None yet</span></div>
          <div class="decision-field"><strong>Recommendation</strong><span id="decisionRecommendation">None yet</span></div>
          <div class="decision-field"><strong>Needs user</strong><span id="decisionNeeded">None</span></div>
          <div class="decision-field"><strong>Blockers</strong><span id="decisionBlockers">None</span><button id="acceptDefaultBtn" class="secondary" type="button">Accept Default</button></div>
        </div>
      </div>

      <footer class="composer">
        <div id="composerFrame">
          <textarea id="composer" placeholder="message - type / for commands, Ctrl+Enter to send"></textarea>
          <div id="composerToolbar">
            <button id="openerBtn" class="secondary" type="button" title="Flip the opener for this turn only" aria-label="Flip opener, currently Codex">Opener: Codex</button>
            <span id="composerHint">Ctrl+Enter send - Shift+Enter newline - Ctrl+K commands</span>
          </div>
        </div>
        <div id="composerActions">
          <button id="sendBtn" type="button">SEND</button>
          <button id="stopBtn" class="danger" type="button">STOP TURN</button>
          <button id="commandCenterBtn" class="secondary" type="button" title="Open Command Center (Ctrl+K)">Commands</button>
          <button id="nativeActionBtn" class="secondary hidden" type="button" title="Choose a direct native terminal action">Native Action...</button>
        </div>

        <div class="action-bank" aria-hidden="true">
          <button id="setObjectiveBtn" class="secondary" type="button">Pin Objective</button>
          <button id="previewPromptBtn" class="secondary" type="button">Preview Prompt</button>
          <button id="openLastPromptBtn" class="secondary" type="button">Open Last Prompt</button>
          <button id="assignCodexBtn" class="secondary hidden" type="button">Assign Builder: Codex</button>
          <button id="assignClaudeBtn" class="secondary hidden" type="button">Assign Builder: Claude</button>
          <button id="reviewBtn" class="secondary hidden" type="button">Request Review</button>
          <button id="handBackBtn" class="secondary hidden" type="button">Hand back to Builder</button>
          <button id="resetTurnBtn" class="secondary hidden" type="button">Reset Turn</button>
          <button id="archiveChatBtn" class="secondary" type="button">Archive Chat</button>
          <button id="nativeTerminalsBtn" class="secondary hidden" type="button">Use Safe One-Shot</button>
          <button id="openNativeTerminalsBtn" class="secondary hidden" type="button">Open Terminals</button>
          <button id="codexCommandBtn" class="secondary hidden" type="button">Codex Command</button>
          <button id="claudeCommandBtn" class="secondary hidden" type="button">Claude Command</button>
          <button id="codexRawLineBtn" class="secondary hidden" type="button">Codex Raw Line</button>
          <button id="claudeRawLineBtn" class="secondary hidden" type="button">Claude Raw Line</button>
          <button id="pokeCodexBtn" class="secondary hidden" type="button">Poke Codex</button>
          <button id="pokeClaudeBtn" class="secondary hidden" type="button">Poke Claude</button>
          <button id="pokeCodexEditorBtn" class="secondary hidden" type="button">Codex + Editor</button>
          <button id="pokeClaudeEditorBtn" class="secondary hidden" type="button">Claude + Editor</button>
          <button id="pokeCodexDiffBtn" class="secondary hidden" type="button">Codex + Diff</button>
          <button id="pokeClaudeDiffBtn" class="secondary hidden" type="button">Claude + Diff</button>
          <button id="pokeBothBtn" class="secondary hidden" type="button">Poke Both</button>
          <button id="pokeBothEditorBtn" class="secondary hidden" type="button">Both + Editor</button>
          <button id="pokeBothDiffBtn" class="secondary hidden" type="button">Both + Diff</button>
          <button id="doctorBtn" class="secondary" type="button">Run Doctor</button>
          <button id="testBridgeBtn" class="secondary hidden" type="button">Test Bridge</button>
          <button id="terminalHealthBtn" class="secondary hidden" type="button">Terminal Health</button>
          <button id="authorityBtn" class="secondary hidden" type="button">Authority</button>
          <button id="openFolderBtn" class="secondary hidden" type="button">Open Folder</button>
          <button id="openSessionBriefBtn" class="secondary" type="button">Session Brief</button>
          <button id="openSupportBundleBtn" class="secondary" type="button">Support Bundle</button>
          <button id="captureNativeCapabilitiesBtn" class="secondary" type="button">Native Snapshot</button>
          <button id="captureNativeDataSnapshotBtn" class="secondary" type="button">Native Data</button>
          <button id="openTranscriptBtn" class="secondary" type="button">Open Transcript</button>
          <button id="archiveClearBtn" class="secondary" type="button">Archive + Clear</button>
          <button id="openDecisionsBtn" class="secondary" type="button">Open Decisions</button>
          <button id="openNativeActionsFooterBtn" class="secondary" type="button">Open Actions</button>
        </div>
      </footer>
    </section>

    <div class="overlay" id="cmdOverlay" data-open="false" aria-hidden="true">
      <div id="commandCenter" role="dialog" aria-label="Command Center">
        <div class="palette-input">
          <span class="brand-mark"><img src="${heads.brand}" alt=""></span>
          <input id="paletteInput" role="combobox" aria-controls="commandList" aria-expanded="true" aria-activedescendant="" placeholder="Search commands" autocomplete="off">
          <span class="kbd">Esc</span>
        </div>
        <div id="commandList" role="listbox" aria-label="Hydra commands"></div>
      </div>
    </div>

    <div class="overlay" id="panelOverlay" data-open="false" data-panel="actions" aria-hidden="true">
      <div class="inspector" role="dialog" aria-label="Inspector">
        <section class="panel-view" data-view="actions">
          <div class="insp-head"><h3>Native Actions</h3><span class="count" id="nativePanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="nativeActionBoard" class="native-action-board hidden"></div></div>
        </section>
        <section class="panel-view" data-view="queue">
          <div class="insp-head"><h3>Work Queue</h3><span class="count" id="queuePanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="workQueueBoard" class="work-queue-board hidden"></div></div>
        </section>
        <section class="panel-view" data-view="verify">
          <div class="insp-head"><h3>Verification</h3><span class="count" id="verifyPanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><pre id="verificationDetails" class="empty">No verification details yet.</pre></div>
        </section>
        <section class="panel-view" data-view="decisions">
          <div class="insp-head"><h3>Decisions</h3><span class="count" id="decisionPanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="decisionBoard" class="decision-board hidden"></div></div>
        </section>
        <section class="panel-view" data-view="term">
          <div class="insp-head"><h3>Terminal Sessions</h3><span class="count" id="terminalPanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="terminalSessions" class="terminal-sessions hidden"></div></div>
        </section>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const webviewState = vscode.getState ? (vscode.getState() || {}) : {};
    const HEAD_ASSETS = ${JSON.stringify({
      codex: heads.codex,
      claude: heads.claude,
      system: heads.system,
      user: heads.user,
    })};
    const app = document.getElementById("app");
    const ribbonStack = document.getElementById("ribbonStack");
    const ribbonMinimizedSummary = document.getElementById("ribbonMinimizedSummary");
    const toggleRibbonsBtn = document.getElementById("toggleRibbonsBtn");
    const messagesEl = document.getElementById("messages");
    const composer = document.getElementById("composer");
    const transportChip = document.getElementById("transportChip");
    const phaseChip = document.getElementById("phaseChip");
    const objectiveText = document.getElementById("objectiveText");
    const objectiveTextShim = document.getElementById("objectiveTextShim");
    const codexStatus = document.getElementById("codexStatus");
    const claudeStatus = document.getElementById("claudeStatus");
    const codexAuthority = document.getElementById("codexAuthority");
    const claudeAuthority = document.getElementById("claudeAuthority");
    const terminalSessions = document.getElementById("terminalSessions");
    const setupStrip = document.getElementById("setupStrip");
    const autopilotText = document.getElementById("autopilotText");
    const decisionStrip = document.getElementById("decisionStrip");
    const decisionCount = document.getElementById("decisionCount");
    const decisionDefault = document.getElementById("decisionDefault");
    const decisionRecommendation = document.getElementById("decisionRecommendation");
    const decisionNeeded = document.getElementById("decisionNeeded");
    const decisionBlockers = document.getElementById("decisionBlockers");
    const decisionBoard = document.getElementById("decisionBoard");
    const acceptDefaultBtn = document.getElementById("acceptDefaultBtn");
    const openerBtn = document.getElementById("openerBtn");
    const commandCenterBtn = document.getElementById("commandCenterBtn");
    const setObjectiveBtn = document.getElementById("setObjectiveBtn");
    const previewPromptBtn = document.getElementById("previewPromptBtn");
    const openLastPromptBtn = document.getElementById("openLastPromptBtn");
    const profileBtn = document.getElementById("profileBtn");
    const nativeActionBtn = document.getElementById("nativeActionBtn");
    const sendBtn = document.getElementById("sendBtn");
    const stopBtn = document.getElementById("stopBtn");
    const archiveChatBtn = document.getElementById("archiveChatBtn");
    const assignCodexBtn = document.getElementById("assignCodexBtn");
    const assignClaudeBtn = document.getElementById("assignClaudeBtn");
    const reviewBtn = document.getElementById("reviewBtn");
    const handBackBtn = document.getElementById("handBackBtn");
    const nativeTerminalsBtn = document.getElementById("nativeTerminalsBtn");
    const openNativeTerminalsBtn = document.getElementById("openNativeTerminalsBtn");
    const codexCommandBtn = document.getElementById("codexCommandBtn");
    const claudeCommandBtn = document.getElementById("claudeCommandBtn");
    const codexRawLineBtn = document.getElementById("codexRawLineBtn");
    const claudeRawLineBtn = document.getElementById("claudeRawLineBtn");
    const pokeCodexBtn = document.getElementById("pokeCodexBtn");
    const pokeClaudeBtn = document.getElementById("pokeClaudeBtn");
    const pokeCodexEditorBtn = document.getElementById("pokeCodexEditorBtn");
    const pokeClaudeEditorBtn = document.getElementById("pokeClaudeEditorBtn");
    const pokeCodexDiffBtn = document.getElementById("pokeCodexDiffBtn");
    const pokeClaudeDiffBtn = document.getElementById("pokeClaudeDiffBtn");
    const pokeBothBtn = document.getElementById("pokeBothBtn");
    const pokeBothEditorBtn = document.getElementById("pokeBothEditorBtn");
    const pokeBothDiffBtn = document.getElementById("pokeBothDiffBtn");
    const testBridgeBtn = document.getElementById("testBridgeBtn");
    const terminalHealthBtn = document.getElementById("terminalHealthBtn");
    const authorityBtn = document.getElementById("authorityBtn");
    const doctorBtn = document.getElementById("doctorBtn");
    const resetTurnBtn = document.getElementById("resetTurnBtn");
    const fixCodexBtn = document.getElementById("fixCodexBtn");
    const fixClaudeBtn = document.getElementById("fixClaudeBtn");
    const retryAutopilotBtn = document.getElementById("retryAutopilotBtn");
    const safeModeBtn = document.getElementById("safeModeBtn");
    const verificationStrip = document.getElementById("verificationStrip");
    const verificationText = document.getElementById("verificationText");
    const verificationRail = document.getElementById("verificationRail");
    const verificationDetails = document.getElementById("verificationDetails");
    const nativeActionText = document.getElementById("nativeActionText");
    const nativeActionRail = document.getElementById("nativeActionRail");
    const nativeActionBoard = document.getElementById("nativeActionBoard");
    const nativeAgentFilter = document.getElementById("nativeAgentFilter");
    const nativeStatusFilter = document.getElementById("nativeStatusFilter");
    const clearNativeActionsBtn = document.getElementById("clearNativeActionsBtn");
    const workQueueText = document.getElementById("workQueueText");
    const workQueueRail = document.getElementById("workQueueRail");
    const workQueueBoard = document.getElementById("workQueueBoard");
    const runVerificationBtn = document.getElementById("runVerificationBtn");
    const openVerificationBtn = document.getElementById("openVerificationBtn");
    const openNativeActionsBtn = document.getElementById("openNativeActionsBtn");
    const openWorkQueuePanelBtn = document.getElementById("openWorkQueuePanelBtn");
    const openFolderBtn = document.getElementById("openFolderBtn");
    const openSessionBriefBtn = document.getElementById("openSessionBriefBtn");
    const openSupportBundleBtn = document.getElementById("openSupportBundleBtn");
    const captureNativeCapabilitiesBtn = document.getElementById("captureNativeCapabilitiesBtn");
    const captureNativeDataSnapshotBtn = document.getElementById("captureNativeDataSnapshotBtn");
    const openTranscriptBtn = document.getElementById("openTranscriptBtn");
    const archiveClearBtn = document.getElementById("archiveClearBtn");
    const openDecisionsBtn = document.getElementById("openDecisionsBtn");
    const openNativeActionsFooterBtn = document.getElementById("openNativeActionsFooterBtn");
    const decisionRail = document.getElementById("decisionRail");
    const usageRail = document.getElementById("usageRail");
    const modelRail = document.getElementById("modelRail");
    if (modelRail) {
      const open = () => vscode.postMessage({ type: "chooseModel" });
      modelRail.addEventListener("click", open);
      modelRail.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    }
    const cmdOverlay = document.getElementById("cmdOverlay");
    const paletteInput = document.getElementById("paletteInput");
    const commandList = document.getElementById("commandList");
    const panelOverlay = document.getElementById("panelOverlay");

    const labels = { user: "human", codex: "codex", claude: "claude", system: "system" };
    let lastMessages = [];
    let lastFilteredNativeActions = [];
    let defaultOpener = "codex";
    let selectedOpener = "codex";
    let hasOpenerOverride = false;
    let transport = "oneShot";
    let lastNativeActions = [];
    let lastState = {};
    let ribbonsMinimized = !!webviewState.ribbonsMinimized;
    let collapsedRibbons = new Set(Array.isArray(webviewState.collapsedRibbons) ? webviewState.collapsedRibbons : []);

    const ACTIONS = [
      { id: "send", group: "Suggested", name: "Send", what: "Start a Hydra turn with the current opener", acc: "Ctrl+Enter", run: () => sendBtn.click(), enabled: () => !sendBtn.disabled },
      { id: "stop", group: "Suggested", name: "Stop Current Turn", what: "Cancel the active agent call", acc: "Esc", run: () => stopBtn.click(), enabled: () => !stopBtn.classList.contains("hidden") && !stopBtn.disabled },
      { id: "pin-objective", group: "Objective", name: "Pin Objective", what: "Use composer text as room objective", run: () => setObjectiveBtn.click(), enabled: () => !setObjectiveBtn.disabled },
      { id: "preview-prompt", group: "Objective", name: "Preview Prompt", what: "Inspect the exact next prompt", run: () => previewPromptBtn.click(), enabled: () => !previewPromptBtn.disabled },
      { id: "open-last-prompt", group: "Objective", name: "Open Last Prompt", what: "Reopen the latest persisted prompt envelope", run: () => openLastPromptBtn.click(), enabled: () => !openLastPromptBtn.disabled },
      { id: "archive-chat", group: "Objective", name: "Archive Chat", what: "Archive transcript and clear room", run: () => archiveChatBtn.click(), enabled: () => !archiveChatBtn.disabled },
      { id: "accept-default", group: "Workflow", name: "Accept Default", what: "Run the latest decision default", run: () => acceptDefaultBtn.click(), enabled: () => !acceptDefaultBtn.disabled },
      { id: "assign-codex", group: "Workflow", name: "Assign Builder: Codex", what: "Let Codex edit files", run: () => assignCodexBtn.click(), enabled: () => !assignCodexBtn.classList.contains("hidden") && !assignCodexBtn.disabled },
      { id: "assign-claude", group: "Workflow", name: "Assign Builder: Claude", what: "Let Claude edit files", run: () => assignClaudeBtn.click(), enabled: () => !assignClaudeBtn.classList.contains("hidden") && !assignClaudeBtn.disabled },
      { id: "request-review", group: "Workflow", name: "Request Review", what: "Ask the non-builder to review the diff", run: () => reviewBtn.click(), enabled: () => !reviewBtn.classList.contains("hidden") && !reviewBtn.disabled },
      { id: "hand-back", group: "Workflow", name: "Hand Back to Builder", what: "Return review feedback to the builder", run: () => handBackBtn.click(), enabled: () => !handBackBtn.classList.contains("hidden") && !handBackBtn.disabled },
      { id: "reset-turn", group: "Workflow", name: "Reset Stuck Turn", what: "Recover from a stuck state", run: () => resetTurnBtn.click(), enabled: () => !resetTurnBtn.classList.contains("hidden") && !resetTurnBtn.disabled },
      { id: "native-action", group: "Terminals", name: "Native Action", what: "Choose a direct native terminal action", run: () => nativeActionBtn.click(), enabled: () => !nativeActionBtn.classList.contains("hidden") && !nativeActionBtn.disabled },
      { id: "toggle-transport", group: "Terminals", name: "Toggle Terminal Bridge", what: "Switch between safe one-shot and terminal bridge", run: () => nativeTerminalsBtn.click(), enabled: () => !nativeTerminalsBtn.disabled },
      { id: "open-terminals", group: "Terminals", name: "Open Native Terminals", what: "Open visible Codex and Claude terminals", run: () => openNativeTerminalsBtn.click(), enabled: () => !openNativeTerminalsBtn.disabled },
      { id: "codex-command", group: "Terminals", name: "Codex Command", what: "Run exact Codex native args from composer", run: () => codexCommandBtn.click(), enabled: () => !codexCommandBtn.disabled },
      { id: "claude-command", group: "Terminals", name: "Claude Command", what: "Run exact Claude native args from composer", run: () => claudeCommandBtn.click(), enabled: () => !claudeCommandBtn.disabled },
      { id: "codex-raw", group: "Terminals", name: "Codex Raw Line", what: "Send composer as raw terminal input", run: () => codexRawLineBtn.click(), enabled: () => !codexRawLineBtn.disabled },
      { id: "claude-raw", group: "Terminals", name: "Claude Raw Line", what: "Send composer as raw terminal input", run: () => claudeRawLineBtn.click(), enabled: () => !claudeRawLineBtn.disabled },
      { id: "poke-codex", group: "Terminals", name: "Poke Codex", what: "Send composer to Codex terminal", run: () => pokeCodexBtn.click(), enabled: () => !pokeCodexBtn.disabled },
      { id: "poke-claude", group: "Terminals", name: "Poke Claude", what: "Send composer to Claude terminal", run: () => pokeClaudeBtn.click(), enabled: () => !pokeClaudeBtn.disabled },
      { id: "poke-both", group: "Terminals", name: "Poke Both", what: "Send composer to both terminals", run: () => pokeBothBtn.click(), enabled: () => !pokeBothBtn.disabled },
      { id: "open-actions", group: "Panels", name: "Open Native Actions Panel", what: "Inspect recent native actions", run: () => openPanel("actions") },
      { id: "open-queue", group: "Panels", name: "Open Work Queue", what: "Inspect queued follow-ups", run: () => openPanel("queue") },
      { id: "open-verify", group: "Panels", name: "Open Verification Details", what: "Inspect verification status", run: () => openPanel("verify") },
      { id: "open-decisions-panel", group: "Panels", name: "Open Decisions Panel", what: "Inspect decision packets", run: () => openPanel("decisions") },
      { id: "open-terminal-panel", group: "Panels", name: "Open Terminal Sessions Panel", what: "Inspect terminal sessions", run: () => openPanel("term") },
      { id: "toggle-ribbons", group: "Panels", name: "Toggle Status Ribbons", what: "Minimize or restore the status ribbons above the composer", run: () => toggleRibbonsBtn.click() },
      { id: "open-objective", group: "Files", name: "Open Objective", what: "Open the pinned room objective file", run: () => vscode.postMessage({ type: "openObjective" }), enabled: () => !lastState.canOpenFolder },
      { id: "open-native-actions-file", group: "Files", name: "Open Native Actions Log", what: "Open durable native action log", run: () => openNativeActionsFooterBtn.click(), enabled: () => !openNativeActionsFooterBtn.disabled },
      { id: "open-agent-calls", group: "Files", name: "Open Agent Call Log", what: "Open native dispatch traces and stderr previews", run: () => vscode.postMessage({ type: "openAgentCalls" }), enabled: () => !lastState.canOpenFolder },
      { id: "open-decisions", group: "Files", name: "Open Decisions", what: "Open decisions log", run: () => openDecisionsBtn.click(), enabled: () => !openDecisionsBtn.disabled },
      { id: "open-verification-file", group: "Files", name: "Open Verification Log", what: "Open the durable verification result log", run: () => openVerificationBtn.click(), enabled: () => !openVerificationBtn.disabled },
      { id: "open-transcript", group: "Files", name: "Open Transcript", what: "Open the Hydra transcript", run: () => openTranscriptBtn.click(), enabled: () => !openTranscriptBtn.disabled },
      { id: "session-brief", group: "Files", name: "Session Brief", what: "Open the current session brief", run: () => openSessionBriefBtn.click(), enabled: () => !openSessionBriefBtn.disabled },
      { id: "choose-model", group: "Settings", name: "Choose Model", what: "Pick Codex or Claude model overrides", run: () => vscode.postMessage({ type: "chooseModel" }), enabled: () => !lastState.canOpenFolder },
      { id: "change-profile", group: "Settings", name: "Change Capability Profile", what: "Pick safe, native build, review, full-native, or custom CLI profiles", run: () => profileBtn.click(), enabled: () => !profileBtn.disabled },
      { id: "fix-codex", group: "Setup", name: "Fix Codex Path", what: "Update the configured Codex CLI command", run: () => fixCodexBtn.click(), enabled: () => !!lastState.needsCodexPath },
      { id: "fix-claude", group: "Setup", name: "Fix Claude Path", what: "Update the configured Claude CLI command", run: () => fixClaudeBtn.click(), enabled: () => !!lastState.needsClaudePath },
      { id: "support-bundle", group: "Diagnostics", name: "Support Bundle", what: "Generate logs and state bundle", run: () => openSupportBundleBtn.click(), enabled: () => !openSupportBundleBtn.disabled },
      { id: "doctor", group: "Diagnostics", name: "Run Doctor", what: "Check Hydra setup", run: () => doctorBtn.click(), enabled: () => !doctorBtn.disabled },
      { id: "retry-auto", group: "Diagnostics", name: "Retry Autopilot", what: "Re-run startup checks", run: () => retryAutopilotBtn.click(), enabled: () => !retryAutopilotBtn.disabled },
      { id: "safe-mode", group: "Diagnostics", name: "Use Safe Mode", what: "Switch to safe one-shot transport", run: () => safeModeBtn.click(), enabled: () => !safeModeBtn.disabled },
      { id: "verification", group: "Diagnostics", name: "Run Verification", what: "Run configured verification", run: () => runVerificationBtn.click(), enabled: () => !runVerificationBtn.disabled },
      { id: "native-snapshot", group: "Diagnostics", name: "Native Snapshot", what: "Capture native capabilities", run: () => captureNativeCapabilitiesBtn.click(), enabled: () => !captureNativeCapabilitiesBtn.disabled },
      { id: "native-data", group: "Diagnostics", name: "Native Data", what: "Capture native data snapshot", run: () => captureNativeDataSnapshotBtn.click(), enabled: () => !captureNativeDataSnapshotBtn.disabled },
      { id: "terminal-health", group: "Diagnostics", name: "Terminal Health", what: "Show terminal bridge health", run: () => terminalHealthBtn.click(), enabled: () => !terminalHealthBtn.disabled },
      { id: "authority", group: "Diagnostics", name: "Authority", what: "Show effective native authority", run: () => authorityBtn.click(), enabled: () => !authorityBtn.disabled },
      { id: "test-bridge", group: "Diagnostics", name: "Test Bridge", what: "Run terminal bridge self-test", run: () => testBridgeBtn.click(), enabled: () => !testBridgeBtn.disabled },
      { id: "open-folder", group: "Diagnostics", name: "Open Folder", what: "Open a workspace folder", run: () => openFolderBtn.click(), enabled: () => !openFolderBtn.disabled }
    ];

    sendBtn.addEventListener("click", () => {
      const text = composer.value.trim();
      if (!text) return composer.focus();
      vscode.postMessage({ type: "send", text, opener: selectedOpener });
      composer.value = "";
      hasOpenerOverride = false;
    });
    openerBtn.addEventListener("click", () => {
      selectedOpener = selectedOpener === "codex" ? "claude" : "codex";
      hasOpenerOverride = selectedOpener !== defaultOpener;
      renderOpenerButton();
    });
    commandCenterBtn.addEventListener("click", () => {
      if (cmdOverlay.dataset.open === "true") closePalette();
      else openPalette();
    });
    toggleRibbonsBtn.addEventListener("click", () => setRibbonsMinimized(!ribbonsMinimized));
    ribbonStack.addEventListener("click", (event) => {
      const button = event.target && event.target.closest ? event.target.closest("[data-ribbon-toggle]") : undefined;
      if (!button) return;
      toggleRibbonCollapsed(button.dataset.ribbonToggle || "");
    });
    setRibbonsMinimized(ribbonsMinimized);
    setObjectiveBtn.addEventListener("click", () => {
      const text = composer.value.trim();
      if (!text) return composer.focus();
      vscode.postMessage({ type: "setObjective", text });
    });
    previewPromptBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "previewNextPrompt", text: composer.value, opener: selectedOpener });
    });
    openLastPromptBtn.addEventListener("click", () => vscode.postMessage({ type: "openLastPrompt" }));
    nativeActionBtn.addEventListener("click", () => vscode.postMessage({ type: "nativeAction", text: composer.value }));
    composer.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !sendBtn.disabled) {
        e.preventDefault();
        sendBtn.click();
      }
      if (e.key === "/" && composer.selectionStart === 0 && composer.selectionEnd === 0 && !composer.value) {
        e.preventDefault();
        openPalette();
      }
    });
    stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    assignCodexBtn.addEventListener("click", () => vscode.postMessage({ type: "assignBuilder", builder: "codex" }));
    assignClaudeBtn.addEventListener("click", () => vscode.postMessage({ type: "assignBuilder", builder: "claude" }));
    reviewBtn.addEventListener("click", () => vscode.postMessage({ type: "requestReview" }));
    acceptDefaultBtn.addEventListener("click", () => vscode.postMessage({ type: "acceptDefaultDecision" }));
    handBackBtn.addEventListener("click", () => vscode.postMessage({ type: "handBack" }));
    nativeTerminalsBtn.addEventListener("click", () => vscode.postMessage({ type: transport === "terminalBridge" ? "useOneShotTransport" : "useTerminalBridge" }));
    openNativeTerminalsBtn.addEventListener("click", () => vscode.postMessage({ type: "openNativeTerminals" }));
    codexCommandBtn.addEventListener("click", () => runNativeCommand("codex"));
    claudeCommandBtn.addEventListener("click", () => runNativeCommand("claude"));
    codexRawLineBtn.addEventListener("click", () => sendRawTerminalLine("codex"));
    claudeRawLineBtn.addEventListener("click", () => sendRawTerminalLine("claude"));
    pokeCodexBtn.addEventListener("click", () => pokeNativeTerminal("codex"));
    pokeClaudeBtn.addEventListener("click", () => pokeNativeTerminal("claude"));
    pokeCodexEditorBtn.addEventListener("click", () => pokeNativeTerminal("codex", true));
    pokeClaudeEditorBtn.addEventListener("click", () => pokeNativeTerminal("claude", true));
    pokeCodexDiffBtn.addEventListener("click", () => pokeNativeTerminal("codex", false, true));
    pokeClaudeDiffBtn.addEventListener("click", () => pokeNativeTerminal("claude", false, true));
    pokeBothBtn.addEventListener("click", () => pokeBothNativeTerminals());
    pokeBothEditorBtn.addEventListener("click", () => pokeBothNativeTerminals(true));
    pokeBothDiffBtn.addEventListener("click", () => pokeBothNativeTerminals(false, true));
    testBridgeBtn.addEventListener("click", () => vscode.postMessage({ type: "runTerminalBridgeSelfTest" }));
    terminalHealthBtn.addEventListener("click", () => vscode.postMessage({ type: "showTerminalBridgeHealth" }));
    authorityBtn.addEventListener("click", () => vscode.postMessage({ type: "showEffectiveAuthority" }));
    profileBtn.addEventListener("click", () => vscode.postMessage({ type: "changeCapabilityProfile" }));
    doctorBtn.addEventListener("click", () => vscode.postMessage({ type: "runDoctor" }));
    resetTurnBtn.addEventListener("click", () => vscode.postMessage({ type: "resetStuckTurn" }));
    archiveChatBtn.addEventListener("click", () => vscode.postMessage({ type: "archiveAndClearRoom" }));
    fixCodexBtn.addEventListener("click", () => vscode.postMessage({ type: "fixCodexPath" }));
    fixClaudeBtn.addEventListener("click", () => vscode.postMessage({ type: "fixClaudePath" }));
    retryAutopilotBtn.addEventListener("click", () => vscode.postMessage({ type: "runAutopilotStart" }));
    safeModeBtn.addEventListener("click", () => vscode.postMessage({ type: "useOneShotTransport" }));
    runVerificationBtn.addEventListener("click", () => vscode.postMessage({ type: "runVerification" }));
    openVerificationBtn.addEventListener("click", () => vscode.postMessage({ type: "openVerification" }));
    openNativeActionsBtn.addEventListener("click", () => openPanel("actions"));
    openWorkQueuePanelBtn.addEventListener("click", () => openPanel("queue"));
    openFolderBtn.addEventListener("click", () => vscode.postMessage({ type: "openWorkspaceFolder" }));
    openSessionBriefBtn.addEventListener("click", () => vscode.postMessage({ type: "openSessionBrief" }));
    openSupportBundleBtn.addEventListener("click", () => vscode.postMessage({ type: "openSupportBundle" }));
    captureNativeCapabilitiesBtn.addEventListener("click", () => vscode.postMessage({ type: "captureNativeCapabilities" }));
    captureNativeDataSnapshotBtn.addEventListener("click", () => vscode.postMessage({ type: "captureNativeDataSnapshot" }));
    openTranscriptBtn.addEventListener("click", () => vscode.postMessage({ type: "openTranscript" }));
    archiveClearBtn.addEventListener("click", () => vscode.postMessage({ type: "archiveAndClearRoom" }));
    openDecisionsBtn.addEventListener("click", () => vscode.postMessage({ type: "openDecisions" }));
    openNativeActionsFooterBtn.addEventListener("click", () => vscode.postMessage({ type: "openNativeActions" }));
    nativeAgentFilter.addEventListener("change", () => renderNativeActions(lastState));
    nativeStatusFilter.addEventListener("change", () => renderNativeActions(lastState));
    clearNativeActionsBtn.addEventListener("click", () => {
      const ids = (lastFilteredNativeActions || []).map((action) => action.id).filter(Boolean);
      if (ids.length > 0) vscode.postMessage({ type: "clearNativeActions", ids });
    });

    workQueueBoard.addEventListener("click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest("button[data-work-action]") : undefined;
      if (!button) return;
      const action = button.dataset.workAction;
      if (action === "acceptDefaultDecision") vscode.postMessage({ type: "acceptDefaultDecision" });
      if (action === "discussVerification") vscode.postMessage({ type: "discussVerification" });
      if (action === "rerunNativeAction") vscode.postMessage({ type: "rerunNativeAction", id: button.dataset.actionId || "" });
      if (action === "dismiss") vscode.postMessage({ type: "dismissWorkQueueItem", id: button.dataset.itemId || "" });
      if (action === "snooze") vscode.postMessage({ type: "snoozeWorkQueueItem", id: button.dataset.itemId || "" });
    });
    nativeActionBoard.addEventListener("click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest("button[data-action-id]") : undefined;
      if (!button) return;
      const id = button.dataset.actionId;
      const action = (lastNativeActions || []).find((item) => item.id === id);
      if (!action) return;
      if (button.dataset.action === "rerun") vscode.postMessage({ type: "rerunNativeAction", id });
      if (button.dataset.action === "fork") {
        composer.value = action.instruction || "";
        composer.focus();
      }
      if (button.dataset.action === "objective") vscode.postMessage({ type: "setObjective", text: action.instruction || "" });
      if (button.dataset.action === "discuss") vscode.postMessage({ type: "send", text: action.instruction || "", opener: selectedOpener });
      if (button.dataset.action === "clear") vscode.postMessage({ type: "clearNativeAction", id });
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "state") renderState(msg);
      else if (msg.type === "chunk") appendChunk(msg.messageId, msg.text);
      else if (msg.type === "replaceMessageText") replaceMessageText(msg.messageId, msg.text);
      else if (msg.type === "setComposerText") {
        if (composer) {
          composer.value = msg.text || "";
          composer.focus();
          if (typeof composer.setSelectionRange === "function") {
            composer.setSelectionRange(composer.value.length, composer.value.length);
          }
        }
      }
    });

    function appendChunk(messageId, text) {
      const el = document.querySelector('[data-mid="' + messageId + '"] .text');
      if (!el) return;
      el.textContent += text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function replaceMessageText(messageId, text) {
      const el = document.querySelector('[data-mid="' + messageId + '"] .text');
      if (el) el.textContent = text;
    }

    function renderState(state) {
      lastState = state;
      lastMessages = state.messages || [];
      transport = state.transport || "oneShot";
      defaultOpener = state.defaultOpener || "codex";
      if (!hasOpenerOverride) selectedOpener = defaultOpener;
      renderTransport();
      phaseChip.textContent = state.phaseLabel || state.phase || "Idle";
      phaseChip.className = "phase-chip" + (state.canSend ? " idle" : "");
      app.classList.toggle("in-flight", !!state.canStop);
      objectiveText.textContent = state.objective || "Not set";
      objectiveText.title = state.objective || "";
      objectiveTextShim.textContent = state.objective || "Not set";
      renderAgentStatuses(state.agentStatuses || {});
      renderAuthorityBadges(state.authoritySummaries || {});
      renderTerminalSessions(state.terminalSessions || [], transport);
      renderAutopilot(state);
      renderVerification(state);
      renderNativeActions(state);
      renderWorkQueue(state);
      renderDecision(state.latestDecision, state.decisionsCount || 0, state.latestDecisionRisky, !!state.latestDecisionAccepted);
      renderDecisionAction(state.decisionAction, !!state.canAcceptDefault, !!state.latestDecisionAccepted, !!state.canStop);
      renderSessionUsage(state.sessionUsage);
      renderModels(state.models, state.efforts);
      renderProfiles(state.capabilityProfiles);
      renderDecisionBoard(state.recentDecisions || []);
      sendBtn.disabled = !state.canSend;
      openerBtn.disabled = !state.canSend;
      previewPromptBtn.disabled = !!state.canOpenFolder;
      openLastPromptBtn.disabled = !!state.canOpenFolder;
      setObjectiveBtn.disabled = !state.canSend;
      nativeActionBtn.classList.toggle("hidden", !!state.canOpenFolder);
      nativeActionBtn.disabled = !state.canPokeNativeTerminals;
      composer.disabled = !state.canSend;
      stopBtn.classList.toggle("hidden", !state.canStop);
      resetTurnBtn.classList.toggle("hidden", !state.canStop);
      assignCodexBtn.classList.toggle("hidden", !state.canAssignBuilder);
      assignClaudeBtn.classList.toggle("hidden", !state.canAssignBuilder);
      reviewBtn.classList.toggle("hidden", !state.canRequestReview);
      handBackBtn.classList.toggle("hidden", !state.canHandBack);
      archiveChatBtn.disabled = !state.canArchiveRoom;
      nativeTerminalsBtn.classList.toggle("hidden", !!state.canOpenFolder);
      openNativeTerminalsBtn.classList.toggle("hidden", !!state.canOpenFolder);
      codexCommandBtn.classList.toggle("hidden", !!state.canOpenFolder);
      claudeCommandBtn.classList.toggle("hidden", !!state.canOpenFolder);
      codexRawLineBtn.classList.toggle("hidden", transport !== "terminalBridge" || !!state.canOpenFolder);
      claudeRawLineBtn.classList.toggle("hidden", transport !== "terminalBridge" || !!state.canOpenFolder);
      pokeCodexBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeClaudeBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeCodexEditorBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeClaudeEditorBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeCodexDiffBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeClaudeDiffBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeBothBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeBothEditorBtn.classList.toggle("hidden", !!state.canOpenFolder);
      pokeBothDiffBtn.classList.toggle("hidden", !!state.canOpenFolder);
      openNativeTerminalsBtn.disabled = !state.canPokeNativeTerminals;
      codexRawLineBtn.disabled = !state.canPokeNativeTerminals;
      claudeRawLineBtn.disabled = !state.canPokeNativeTerminals;
      codexCommandBtn.disabled = !state.canPokeNativeTerminals;
      claudeCommandBtn.disabled = !state.canPokeNativeTerminals;
      pokeCodexBtn.disabled = !state.canPokeNativeTerminals;
      pokeClaudeBtn.disabled = !state.canPokeNativeTerminals;
      pokeCodexEditorBtn.disabled = !state.canPokeNativeTerminals;
      pokeClaudeEditorBtn.disabled = !state.canPokeNativeTerminals;
      pokeCodexDiffBtn.disabled = !state.canPokeNativeTerminals;
      pokeClaudeDiffBtn.disabled = !state.canPokeNativeTerminals;
      pokeBothBtn.disabled = !state.canPokeNativeTerminals;
      pokeBothEditorBtn.disabled = !state.canPokeNativeTerminals;
      pokeBothDiffBtn.disabled = !state.canPokeNativeTerminals;
      testBridgeBtn.classList.toggle("hidden", !!state.canOpenFolder);
      terminalHealthBtn.classList.toggle("hidden", !!state.canOpenFolder);
      authorityBtn.classList.toggle("hidden", !!state.canOpenFolder);
      profileBtn.classList.toggle("hidden", !!state.canOpenFolder);
      doctorBtn.disabled = !!state.canOpenFolder || !!state.canStop;
      retryAutopilotBtn.disabled = !!state.canOpenFolder || !!state.canStop || !!state.autopilotRunning;
      safeModeBtn.disabled = !!state.canOpenFolder || transport === "oneShot";
      runVerificationBtn.disabled = !state.canRunVerification;
      openVerificationBtn.disabled = !!state.canOpenFolder;
      openNativeActionsBtn.disabled = !!state.canOpenFolder;
      captureNativeCapabilitiesBtn.disabled = !!state.canOpenFolder || !!state.canStop;
      captureNativeDataSnapshotBtn.disabled = !!state.canOpenFolder || !!state.canStop;
      openTranscriptBtn.disabled = !!state.canOpenFolder;
      archiveClearBtn.disabled = !state.canArchiveRoom;
      openDecisionsBtn.disabled = !!state.canOpenFolder;
      openNativeActionsFooterBtn.disabled = !!state.canOpenFolder;
      assignCodexBtn.classList.toggle("suggested", state.suggestedBuilder === "codex");
      assignClaudeBtn.classList.toggle("suggested", state.suggestedBuilder === "claude");
      renderOpenerButton();
      renderMessages();
      renderPalette(paletteInput.value || "");
      applyCollapsedRibbons();
      updateRibbonMinimizedSummary(state);
    }

    function setRibbonsMinimized(value) {
      ribbonsMinimized = !!value;
      ribbonStack.classList.toggle("is-minimized", ribbonsMinimized);
      toggleRibbonsBtn.textContent = ribbonsMinimized ? "Restore Panel" : "Minimize Panel";
      toggleRibbonsBtn.title = ribbonsMinimized ? "Restore pinned status panel" : "Minimize pinned status panel";
      toggleRibbonsBtn.setAttribute("aria-expanded", String(!ribbonsMinimized));
      persistWebviewState();
      updateRibbonMinimizedSummary(lastState || {});
    }

    function toggleRibbonCollapsed(id) {
      if (!id) return;
      if (collapsedRibbons.has(id)) collapsedRibbons.delete(id);
      else collapsedRibbons.add(id);
      persistWebviewState();
      applyCollapsedRibbons();
      updateRibbonMinimizedSummary(lastState || {});
    }

    function applyCollapsedRibbons() {
      document.querySelectorAll("[data-ribbon-toggle]").forEach((button) => {
        const id = button.dataset.ribbonToggle || "";
        const el = document.getElementById(id);
        const collapsed = collapsedRibbons.has(id);
        if (el) el.classList.toggle("is-collapsed", collapsed);
        button.textContent = collapsed ? "Restore" : "Minimize";
        button.title = collapsed ? "Restore this pinned strip" : "Minimize this pinned strip";
        button.setAttribute("aria-expanded", String(!collapsed));
      });
    }

    function persistWebviewState(extra) {
      if (!vscode.setState) return;
      const base = Object.assign({}, vscode.getState ? (vscode.getState() || {}) : {});
      vscode.setState(Object.assign(base, {
        ribbonsMinimized,
        collapsedRibbons: Array.from(collapsedRibbons)
      }, extra || {}));
    }

    function updateRibbonMinimizedSummary(state) {
      const ribbonIds = ["setupStrip", "verificationStrip", "nativeActionStrip", "workQueueStrip", "decisionStrip"];
      const hasVisibleRibbon = ribbonIds.some((id) => {
        const el = document.getElementById(id);
        return el && !el.classList.contains("hidden");
      });
      ribbonStack.classList.toggle("has-visible-ribbons", hasVisibleRibbon);
      const parts = [];
      if (state.autopilotRunning || state.autopilotSummary) parts.push("Autopilot: " + (state.autopilotRunning ? "running" : state.autopilotSummary));
      if (state.verificationRunning || state.verificationSummary) parts.push("Verify: " + (state.verificationRunning ? "running" : state.verificationSummary));
      if (state.latestDecision) parts.push("Decision" + (state.decisionsCount ? " " + state.decisionsCount : "") + ": " + (state.latestDecision.defaultNextAction || "ready"));
      if (state.nativeActionsCount) parts.push("Actions: " + state.nativeActionsCount);
      if (state.workQueue && state.workQueue.length) parts.push("Queue: " + state.workQueue.length);
      ribbonMinimizedSummary.textContent = parts.length > 0 ? parts.join(" | ") : "Status ribbons hidden";
      ribbonMinimizedSummary.title = ribbonMinimizedSummary.textContent;
    }

    function renderMessages() {
      if (lastMessages.length === 0) {
        messagesEl.innerHTML = '<p class="empty">The room is quiet. Run Doctor if this is a fresh setup, then type one message below to bring everyone in.</p>';
        return;
      }
      messagesEl.innerHTML = "";
      let lastPhase = "";
      for (const m of lastMessages) {
        if (m.phase && m.phase !== lastPhase) {
          const mark = document.createElement("div");
          mark.className = "phase-mark";
          mark.innerHTML = "<span>" + escapeHtml(m.phase) + "</span>";
          messagesEl.append(mark);
          lastPhase = m.phase;
        }
        const article = document.createElement("article");
        const cls = ["message", m.role || "system"];
        if (m.pending) cls.push("pending");
        if (m.error) cls.push("error");
        if (m.cancelled) cls.push("cancelled");
        article.className = cls.join(" ");
        article.dataset.mid = m.id;

        const time = document.createElement("time");
        time.className = "message-time";
        time.textContent = new Date(m.timestamp).toLocaleTimeString();

        const card = document.createElement("div");
        card.className = "message-card";
        const head = document.createElement("div");
        head.className = "message-head";
        const art = document.createElement("span");
        art.className = "head-art " + (m.role || "system");
        const headSrc = headAsset(m.role);
        if (headSrc) {
          const img = document.createElement("img");
          img.src = headSrc;
          img.alt = "";
          art.append(img);
        } else {
          art.textContent = headGlyph(m.role);
        }
        const speaker = document.createElement("span");
        speaker.className = "speaker " + (m.role || "system");
        speaker.textContent = labels[m.role] || m.role || "system";
        const role = document.createElement("span");
        role.className = "role-tag";
        role.textContent = m.phase || "";
        const status = document.createElement("span");
        status.className = "message-status";
        status.textContent = m.pending ? (m.activity || "running") : "";
        head.append(art, speaker, role, status);

        const text = document.createElement("pre");
        text.className = "text";
        if (m.pending && !m.activity) text.dataset.placeholder = pendingPlaceholder(m);
        text.textContent = m.text || "";
        if (!m.pending || m.text || !m.activity) card.append(head, text);
        else card.append(head);
        article.append(time, card);
        messagesEl.append(article);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderOpenerButton() {
      const label = selectedOpener === "codex" ? "Codex" : "Claude";
      openerBtn.textContent = hasOpenerOverride ? "Opener: " + label + " (this turn)" : "Opener: " + label;
      openerBtn.setAttribute("aria-label", "Flip opener, currently " + label);
      openerBtn.classList.toggle("suggested", hasOpenerOverride);
    }

    function pokeNativeTerminal(agent, includeEditorContext, includeWorkspaceDiff) {
      const text = composer.value.trim();
      if (!text && !includeEditorContext && !includeWorkspaceDiff) return composer.focus();
      vscode.postMessage({ type: "pokeNativeTerminal", agent, text, includeEditorContext: !!includeEditorContext, includeWorkspaceDiff: !!includeWorkspaceDiff });
      composer.value = "";
    }
    function runNativeCommand(agent) {
      const text = composer.value.trim();
      if (!text) return composer.focus();
      vscode.postMessage({ type: "runNativeCommand", agent, text });
      composer.value = "";
    }
    function sendRawTerminalLine(agent) {
      const text = composer.value.trim();
      if (!text) return composer.focus();
      vscode.postMessage({ type: "sendRawTerminalLine", agent, text });
      composer.value = "";
    }
    function pokeBothNativeTerminals(includeEditorContext, includeWorkspaceDiff) {
      const text = composer.value.trim();
      if (!text && !includeEditorContext && !includeWorkspaceDiff) return composer.focus();
      vscode.postMessage({ type: "pokeNativeTerminals", text, includeEditorContext: !!includeEditorContext, includeWorkspaceDiff: !!includeWorkspaceDiff });
      composer.value = "";
    }

    function renderTransport() {
      const terminal = transport === "terminalBridge";
      transportChip.textContent = terminal ? "Terminal bridge" : "Safe one-shot";
      transportChip.className = "rail-chip" + (terminal ? " warn" : " ok");
      nativeTerminalsBtn.textContent = terminal ? "Use Safe One-Shot" : "Use Terminal Bridge";
      nativeTerminalsBtn.title = terminal ? "Switch back to the stable one-shot transport" : "Inject future calls into visible native terminals";
    }
    function renderAgentStatuses(statuses) {
      renderAgentStatus(codexStatus, "Codex", statuses.codex, "codex");
      renderAgentStatus(claudeStatus, "Claude", statuses.claude, "claude");
    }
    function renderAgentStatus(el, label, status, agent) {
      const state = status && status.state ? status.state : "idle";
      const detail = status && status.detail ? status.detail : "Idle";
      el.className = "agent-status " + agent + " " + state;
      el.title = label + ": " + detail;
      el.textContent = label + ": " + compactStatusDetail(detail);
    }
    function renderAuthorityBadges(summaries) {
      renderAuthorityBadge(codexAuthority, "Codex", summaries.codex);
      renderAuthorityBadge(claudeAuthority, "Claude", summaries.claude);
    }
    function renderAuthorityBadge(el, label, summary) {
      const authority = summary && summary.authority ? summary.authority : { level: "unknown", label: "Unknown/custom", detail: "No authority data yet" };
      const profile = summary && summary.profile ? summary.profile : { label: "Custom" };
      el.className = "authority-badge " + (authority.level || "unknown");
      el.title = label + ": " + (authority.label || "Unknown/custom") + " / " + (profile.label || "Custom") + "\\n" + (authority.detail || "") + "\\nProfile: " + (profile.detail || profile.label || "Custom");
      el.innerHTML = '<span class="rail-value"><strong>' + escapeHtml(label) + '</strong> ' + escapeHtml(compactAuthority(authority, profile)) + "</span>";
    }
    function compactStatusDetail(detail) {
      return String(detail || "Idle")
        .replace("running", "")
        .replace("replied", "done")
        .replace("cancelled", "stopped")
        .trim() || "idle";
    }
    function compactAuthority(authority, profile) {
      const level = authority && authority.level ? authority.level : "unknown";
      const profileLabel = profile && profile.label ? profile.label : "Custom";
      if (level === "workspaceWrite") return profileLabel.startsWith("Elevated") ? "write / elevated" : "write";
      if (level === "readOnly") return "read";
      if (level === "fullNative") return "full native";
      return "custom";
    }
    function renderTerminalSessions(sessions, currentTransport) {
      const visible = currentTransport === "terminalBridge" || sessions.some((s) => s.state && s.state !== "idle");
      terminalSessions.classList.toggle("hidden", !visible);
      document.getElementById("terminalPanelCount").textContent = sessions.length + " sessions";
      if (!visible) {
        terminalSessions.innerHTML = '<p class="empty">No active terminal sessions.</p>';
        return;
      }
      const byAgent = new Map(sessions.map((s) => [s.agent, s]));
      terminalSessions.innerHTML = "";
      for (const agent of ["codex", "claude"]) {
        const s = byAgent.get(agent) || { agent, terminalName: agent, state: "idle", detail: "Not opened" };
        const row = document.createElement("section");
        row.className = "terminal-session " + (s.state || "idle");
        row.append(sessionLine("Name", s.terminalName || (agent === "codex" ? "Hydra Codex" : "Hydra Claude")));
        row.append(sessionLine("State", s.state || "idle"));
        row.append(sessionLine("Detail", s.detail || "Idle"));
        row.append(sessionLine("Command", s.currentCommand || "No active command"));
        row.append(sessionLine("Last activity", s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : "none"));
        row.append(sessionLine("Log", s.lastLogPath || "none"));
        if (s.lastError) row.append(sessionLine("Error", s.lastError));
        terminalSessions.append(row);
      }
    }
    function sessionLine(label, value) {
      const line = document.createElement("div");
      line.className = "session-line";
      line.title = value || "";
      const strong = document.createElement("strong");
      strong.textContent = label + ": ";
      const span = document.createElement("span");
      span.textContent = value || "";
      line.append(strong, span);
      return line;
    }
    function renderAutopilot(state) {
      setupStrip.classList.toggle("hidden", !!state.canOpenFolder && !state.autopilotSummary);
      const summary = state.autopilotSummary || "Not run";
      autopilotText.textContent = state.autopilotRunning ? summary + "..." : summary;
      fixCodexBtn.classList.toggle("hidden", !state.needsCodexPath);
      fixClaudeBtn.classList.toggle("hidden", !state.needsClaudePath);
      setupStrip.classList.toggle("hidden", !state.needsCodexPath && !state.needsClaudePath && !state.autopilotRunning && !state.autopilotSummary);
    }
    function renderVerification(state) {
      const text = state.verificationRunning ? "running..." : (state.verificationSummary || "No verification yet");
      verificationText.textContent = text;
      verificationRail.textContent = "verify: " + (state.verificationSummary || (state.verificationRunning ? "running" : "none"));
      verificationRail.className = "rail-chip optional" + (text.toLowerCase().includes("fail") ? " error" : text.toLowerCase().includes("pass") ? " ok" : "");
      verificationStrip.classList.toggle("hidden", !state.verificationRunning && !state.verificationSummary);
      verificationStrip.classList.toggle("failed", text.toLowerCase().includes("fail"));
      verificationDetails.textContent = text;
    }
    function renderNativeActions(state) {
      nativeActionText.textContent = state.nativeActionSummary || "No native actions yet";
      const count = state.nativeActionsCount || 0;
      if (count > 0) nativeActionText.textContent += " (" + count + ")";
      nativeActionRail.textContent = "actions: " + count;
      lastNativeActions = state.recentNativeActions || [];
      const filteredActions = lastNativeActions.filter(matchesNativeActionFilters);
      lastFilteredNativeActions = filteredActions;
      document.getElementById("nativePanelCount").textContent = count + " actions";
      clearNativeActionsBtn.disabled = !state.canClearNativeActions || filteredActions.length === 0;
      nativeActionStrip.classList.toggle("hidden", count === 0);
      nativeActionBoard.classList.toggle("hidden", lastNativeActions.length === 0);
      nativeActionBoard.innerHTML = "";
      if (lastNativeActions.length > 0 && filteredActions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No native actions match the current filters.";
        nativeActionBoard.append(empty);
        return;
      }
      for (const action of filteredActions) {
        const row = document.createElement("div");
        row.className = "native-action-row";
        row.title = action.instruction || "";
        row.append(cell(action.status || "unknown", "status " + (action.status || "failed")));
        row.append(cell(action.timestamp ? new Date(action.timestamp).toLocaleTimeString() : "unknown"));
        row.append(cell(nativeActionTargets(action)));
        row.append(cell(nativeActionInstruction(action)));
        const controls = document.createElement("span");
        controls.className = "native-action-controls";
        controls.append(actionButton("Rerun", "rerun", action.id, !state.canPokeNativeTerminals), actionButton("Fork", "fork", action.id), actionButton("Objective", "objective", action.id, !state.canSend), actionButton("Discuss", "discuss", action.id, !state.canSend), actionButton("Clear", "clear", action.id, !state.canClearNativeActions));
        row.append(controls);
        nativeActionBoard.append(row);
      }
    }
    function actionButton(label, action, id, disabled) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = label;
      button.dataset.action = action;
      button.dataset.actionId = id;
      button.disabled = !!disabled;
      return button;
    }
    function cell(text, className) {
      const span = document.createElement("span");
      if (className) className.split(" ").forEach((c) => span.classList.add(c));
      span.textContent = text || "";
      return span;
    }
    function matchesNativeActionFilters(action) {
      const agentFilter = nativeAgentFilter.value || "all";
      const statusFilter = nativeStatusFilter.value || "all";
      const agents = action.agents || [];
      const agentMatches = agentFilter === "all" || (agentFilter === "both" ? agents.includes("codex") && agents.includes("claude") : agents.includes(agentFilter));
      const statusMatches = statusFilter === "all" || action.status === statusFilter;
      return agentMatches && statusMatches;
    }
    function nativeActionTargets(action) {
      const agents = action.agents || [];
      const names = agents.map((agent) => agent === "codex" ? "Codex" : agent === "claude" ? "Claude" : agent);
      const attachments = [action.includeEditorContext ? "editor" : "", action.includeWorkspaceDiff ? "diff" : ""].filter(Boolean);
      return names.join(" + ") + (attachments.length ? " / " + attachments.join(", ") : "");
    }
    function nativeActionInstruction(action) {
      const text = action.instruction || "";
      if (text.length <= 140) return text;
      return text.slice(0, 137) + "...";
    }
    function renderWorkQueue(state) {
      const items = state.workQueue || [];
      workQueueText.textContent = items.length === 0 ? "Queue clear" : items.length + " open item" + (items.length === 1 ? "" : "s");
      workQueueRail.textContent = items.length === 0 ? "queue clear" : "queue: " + items.length;
      document.getElementById("queuePanelCount").textContent = items.length + " items";
      workQueueStrip.classList.toggle("hidden", items.length === 0);
      workQueueBoard.classList.toggle("hidden", items.length === 0);
      workQueueBoard.innerHTML = "";
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "work-queue-row";
        row.title = item.detail || "";
        row.append(cell(item.kind || "item", "severity " + (item.severity || "info")), cell(item.title || ""), cell(item.detail || ""));
        const controls = document.createElement("span");
        controls.className = "work-queue-controls";
        const action = document.createElement("button");
        action.className = "secondary";
        action.textContent = item.actionLabel || "Open";
        action.dataset.workAction = item.actionType || "";
        if (item.actionId) action.dataset.actionId = item.actionId;
        action.disabled = workQueueActionDisabled(item, state);
        const snooze = document.createElement("button");
        snooze.className = "secondary";
        snooze.textContent = "Snooze";
        snooze.dataset.workAction = "snooze";
        snooze.dataset.itemId = item.id;
        const dismiss = document.createElement("button");
        dismiss.className = "secondary";
        dismiss.textContent = "Dismiss";
        dismiss.dataset.workAction = "dismiss";
        dismiss.dataset.itemId = item.id;
        controls.append(action, snooze, dismiss);
        row.append(controls);
        workQueueBoard.append(row);
      }
    }
    function workQueueActionDisabled(item, state) {
      if (item.actionType === "acceptDefaultDecision") return !state.canAcceptDefault;
      if (item.actionType === "discussVerification") return !state.canSend;
      if (item.actionType === "rerunNativeAction") return !state.canPokeNativeTerminals;
      return true;
    }
    function renderModels(models, efforts) {
      if (!modelRail) return;
      const claudeModel = models && models.claude ? models.claude : "default";
      const codexModel = models && models.codex ? models.codex : "default";
      const claudeEffort = efforts && efforts.claude ? efforts.claude : "";
      const codexEffort = efforts && efforts.codex ? efforts.codex : "";
      const claudePart = claudeEffort ? claudeModel + " @" + claudeEffort : claudeModel;
      const codexPart = codexEffort ? codexModel + " @" + codexEffort : codexModel;
      modelRail.textContent = "C: " + claudePart + " · Cx: " + codexPart;
    }
    function renderProfiles(profiles) {
      if (!profileBtn) return;
      const fallback = { text: "custom/custom/custom", title: "Discussion: Custom, Build: Custom, Review: Custom" };
      const claude = profiles && profiles.claude ? profiles.claude : fallback;
      const codex = profiles && profiles.codex ? profiles.codex : fallback;
      profileBtn.textContent = "profiles: C " + claude.text + " | Cx " + codex.text;
      profileBtn.title = "Change capability profiles. Claude: " + claude.title + ". Codex: " + codex.title + ".";
    }
    function renderSessionUsage(u) {
      if (!usageRail) return;
      if (!u || !u.turns) {
        usageRail.textContent = "session: 0 turns";
        return;
      }
      const total = u.totalTokens || 0;
      const tokenStr = total >= 1000000 ? (total / 1000000).toFixed(1) + "M"
        : total >= 10000 ? (total / 1000).toFixed(0) + "k"
        : total >= 1000 ? (total / 1000).toFixed(1) + "k"
        : String(total);
      const cost = u.costUsd || 0;
      const costStr = cost < 0.01 ? "$" + cost.toFixed(4)
        : cost < 1 ? "$" + cost.toFixed(3)
        : "$" + cost.toFixed(2);
      usageRail.textContent = u.turns + "t · " + tokenStr + " tok · " + costStr;
    }
    function renderDecision(decision, count, risky, accepted) {
      decisionStrip.classList.toggle("hidden", !decision);
      decisionRail.textContent = decision ? "decision: " + (accepted ? "accepted" : decision.decisionNeededFromUser ? "needs user" : "ready") : "decision: none";
      decisionRail.className = "rail-chip optional" + (decision && !accepted && decision.decisionNeededFromUser ? " warn" : accepted ? " ok" : "");
      const riskChip = document.getElementById("decisionRiskChip");
      if (riskChip) {
        if (decision && risky && risky.risky && risky.reasons && risky.reasons.length) {
          riskChip.textContent = "risky: " + risky.reasons.join(", ");
          riskChip.style.display = "";
        } else {
          riskChip.style.display = "none";
        }
      }
      if (!decision) return;
      decisionCount.textContent = count > 0 ? "(" + count + ")" : "";
      decisionDefault.textContent = decision.defaultNextAction || "None";
      decisionRecommendation.textContent = decision.recommendation || "None";
      decisionNeeded.textContent = decision.decisionNeededFromUser || "none";
      decisionBlockers.textContent = decision.blockers || "none";
    }
    function renderDecisionAction(action, canAccept, accepted, running) {
      const label = accepted ? (running ? "Default Running" : "Default Accepted") : action && action.label ? action.label : "Accept Default";
      const detail = accepted ? "The latest decision default has already been accepted." : action && action.detail ? action.detail : "No default action is available";
      acceptDefaultBtn.textContent = label;
      acceptDefaultBtn.title = detail;
      acceptDefaultBtn.disabled = !canAccept;
    }
    function renderDecisionBoard(decisions) {
      document.getElementById("decisionPanelCount").textContent = decisions.length + " decisions";
      decisionBoard.classList.toggle("hidden", decisions.length === 0);
      decisionBoard.innerHTML = "";
      for (const decision of decisions) {
        const row = document.createElement("div");
        row.className = "decision-row";
        row.append(cell((labels[decision.agent] || decision.agent) + (decision.phase ? " / " + decision.phase : "")), cell("Next: " + (decision.defaultNextAction || "none")), cell("Needs: " + (decision.decisionNeededFromUser || "none")), cell("Blockers: " + (decision.blockers || "none")));
        decisionBoard.append(row);
      }
    }
    function pendingPlaceholder(message) {
      const speaker = labels[message.role] || message.role || "Agent";
      if (message.phase === "opener") return speaker + " is starting the opener...";
      if (message.phase === "reactor") return speaker + " is reading and reacting...";
      if (message.phase === "closer") return speaker + " is closing the loop...";
      if (message.phase === "parallel") return speaker + " is running an independent pass...";
      if (message.phase === "build") return speaker + " is starting the build...";
      if (message.phase === "review") return speaker + " is reviewing the diff...";
      return speaker + " is starting...";
    }

    function openPalette() {
      cmdOverlay.dataset.open = "true";
      cmdOverlay.setAttribute("aria-hidden", "false");
      renderPalette("");
      setTimeout(() => {
        paletteInput.value = "";
        paletteInput.focus();
      }, 0);
    }
    function closePalette() {
      cmdOverlay.dataset.open = "false";
      cmdOverlay.setAttribute("aria-hidden", "true");
      paletteInput.setAttribute("aria-activedescendant", "");
      commandCenterBtn.focus();
    }
    function openPanel(panel) {
      panelOverlay.dataset.panel = panel;
      panelOverlay.dataset.open = "true";
      panelOverlay.setAttribute("aria-hidden", "false");
    }
    function closePanel() {
      panelOverlay.dataset.open = "false";
      panelOverlay.setAttribute("aria-hidden", "true");
      commandCenterBtn.focus();
    }
    cmdOverlay.addEventListener("click", (event) => {
      if (event.target === cmdOverlay) closePalette();
    });
    panelOverlay.addEventListener("click", (event) => {
      if (event.target === panelOverlay || (event.target.classList && event.target.classList.contains("close"))) closePanel();
    });
    paletteInput.addEventListener("input", () => renderPalette(paletteInput.value));
    commandList.addEventListener("click", (event) => {
      const option = event.target.closest ? event.target.closest(".command-option") : undefined;
      if (!option || option.getAttribute("aria-disabled") === "true") return;
      selectOption(option.id);
      activateSelection();
    });
    document.addEventListener("keydown", (event) => {
      const paletteOpen = cmdOverlay.dataset.open === "true";
      const panelOpen = panelOverlay.dataset.open === "true";
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        paletteOpen ? closePalette() : openPalette();
        return;
      }
      if (event.key === "Escape") {
        if (panelOpen) { closePanel(); return; }
        if (paletteOpen) { closePalette(); return; }
      }
      if (!paletteOpen) return;
      if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(1); }
      if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1); }
      if (event.key === "Enter") { event.preventDefault(); activateSelection(); }
    });
    function renderPalette(query) {
      const q = (query || "").trim();
      commandList.innerHTML = "";
      const groups = new Map();
      const sorted = ACTIONS.filter((action) => fuzzyMatch(q, action.name + " " + action.what + " " + action.group));
      const suggested = sorted.filter((action) => isSuggested(action));
      if (!q && suggested.length) groups.set("Suggested", suggested.slice(0, 5));
      for (const action of sorted) {
        if (!q && suggested.slice(0, 5).includes(action)) continue;
        if (!groups.has(action.group)) groups.set(action.group, []);
        groups.get(action.group).push(action);
      }
      if (groups.size === 0) {
        commandList.innerHTML = '<p class="empty">No commands match "' + escapeHtml(q) + '".</p>';
        return;
      }
      let firstId = "";
      for (const [group, actions] of groups) {
        const section = document.createElement("section");
        section.className = "command-group";
        const heading = document.createElement("h4");
        heading.textContent = group;
        section.append(heading);
        for (const action of actions) {
          const enabled = action.enabled ? !!action.enabled() : true;
          const item = document.createElement("div");
          item.className = "command-option";
          item.id = "cmd-" + action.id;
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", "false");
          item.setAttribute("aria-disabled", enabled ? "false" : "true");
          item.dataset.actionId = action.id;
          const reason = enabled ? "" : disabledReason(action);
          item.innerHTML = '<span><span class="command-name">' + escapeHtml(action.name) + '</span><span class="command-desc">' + escapeHtml(action.what || "") + '</span>' + (reason ? '<span class="command-why"> - ' + escapeHtml(reason) + '</span>' : "") + '</span><span class="palette-meta">' + escapeHtml(action.group) + '</span><span class="kbd">' + escapeHtml(action.acc || "Enter") + '</span>';
          section.append(item);
          if (!firstId && enabled) firstId = item.id;
        }
        commandList.append(section);
      }
      if (firstId) selectOption(firstId);
    }
    function isSuggested(action) {
      if (lastState.canOpenFolder && (action.id === "open-folder" || action.id === "doctor")) return true;
      if (lastState.needsCodexPath && action.id === "fix-codex") return true;
      if (lastState.needsClaudePath && action.id === "fix-claude") return true;
      if (lastState.canStop && ["stop", "open-actions", "open-queue"].includes(action.id)) return true;
      if (lastState.canAcceptDefault && action.id === "accept-default") return true;
      if (lastState.canAssignBuilder && (action.id === "assign-codex" || action.id === "assign-claude")) return true;
      if (lastState.canRequestReview && action.id === "request-review") return true;
      if (String(lastState.verificationSummary || "").toLowerCase().includes("fail") && (action.id === "verification" || action.id === "open-verify")) return true;
      if (lastState.canSend && (action.id === "send" || action.id === "pin-objective")) return true;
      return false;
    }
    function disabledReason(action) {
      if (action.id === "send") return "composer is disabled";
      if (action.id === "stop") return "no active turn";
      if (action.id === "open-folder") return "workspace is already open";
      if (action.id === "fix-codex") return "Codex path check is not failing";
      if (action.id === "fix-claude") return "Claude path check is not failing";
      if (action.id === "choose-model" || action.id === "open-objective" || action.id === "open-agent-calls") return "open a workspace folder first";
      if (action.id.indexOf("assign-") === 0) return "builder assignment unavailable";
      if (action.id === "request-review") return "no build ready for review";
      if (action.id.indexOf("poke-") === 0 || action.id.indexOf("-command") > 0 || action.id.indexOf("-raw") > 0 || action.id === "native-action") return "native terminal actions unavailable";
      if (action.id.indexOf("verification") >= 0) return "verification unavailable in this state";
      return "not available in this state";
    }
    function fuzzyMatch(q, hay) {
      if (!q) return true;
      q = q.toLowerCase();
      hay = hay.toLowerCase();
      let index = 0;
      for (const char of q) {
        index = hay.indexOf(char, index);
        if (index < 0) return false;
        index++;
      }
      return true;
    }
    function selectOption(id) {
      document.querySelectorAll(".command-option").forEach((item) => item.setAttribute("aria-selected", item.id === id ? "true" : "false"));
      paletteInput.setAttribute("aria-activedescendant", id || "");
    }
    function moveSelection(delta) {
      const items = Array.from(document.querySelectorAll('.command-option[aria-disabled="false"]'));
      if (!items.length) return;
      const current = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
      const next = (current + delta + items.length) % items.length;
      selectOption(items[next].id);
      items[next].scrollIntoView({ block: "nearest" });
    }
    function activateSelection() {
      const selected = document.querySelector('.command-option[aria-selected="true"]');
      if (!selected || selected.getAttribute("aria-disabled") === "true") return;
      const action = ACTIONS.find((item) => item.id === selected.dataset.actionId);
      if (!action) return;
      action.run();
      closePalette();
    }
    function headAsset(role) {
      return HEAD_ASSETS[role] || HEAD_ASSETS.system || "";
    }
    function headGlyph(role) {
      if (role === "codex") return "C";
      if (role === "claude") return "C";
      if (role === "user") return "U";
      return "H";
    }
    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
