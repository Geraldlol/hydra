export interface HydraHeadAssets {
  cspSource: string;
  brand: string;
  codex: string;
  claude: string;
  system: string;
  user: string;
}

export function renderHtml(nonce: string, heads: HydraHeadAssets, scriptUri: string): string {
  // HEAD_ASSETS is passed to the external webview script via a data
  // attribute on <body>. JSON.stringify is safe inside a double-quoted
  // attribute as long as we encode the few HTML-special characters that
  // can appear in URL paths (& < >) plus the embedded " delimiters.
  const headAssetsAttr = JSON.stringify({
    codex: heads.codex,
    claude: heads.claude,
    system: heads.system,
    user: heads.user,
  })
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${heads.cspSource}; script-src 'nonce-${nonce}' ${heads.cspSource}; style-src 'unsafe-inline';">
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
    #usageRail { max-width: 310px; }
    .rail-primary #usageRail {
      flex: none;
      color: var(--text);
      border-color: var(--focus);
      background: color-mix(in srgb, var(--focus) 10%, transparent);
      font-weight: 650;
    }
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
    .app.in-flight #stopBtn { display: block; }
    .workflow-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      grid-column: 1 / -1;
    }
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
    #panelOverlay[data-panel="term"] .panel-view[data-view="term"],
    #panelOverlay[data-panel="usage"] .panel-view[data-view="usage"] {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .native-action-board,
    .work-queue-board,
    .decision-board,
    .terminal-sessions,
    .usage-board {
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
    .usage-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(110px, 1fr));
      gap: 8px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    .usage-stat {
      display: grid;
      gap: 2px;
      padding: 8px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-alt) 50%, transparent);
    }
    .usage-stat strong {
      color: var(--text);
      font-size: 15px;
      font-weight: 650;
    }
    .usage-stat span { color: var(--muted); }
    .usage-row {
      display: grid;
      grid-template-columns: 76px 76px minmax(90px, 0.7fr) repeat(4, minmax(74px, 0.55fr)) 72px;
      gap: 8px;
      align-items: center;
      padding: 7px 8px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-alt) 50%, transparent);
    }
    .usage-row.header {
      color: var(--text);
      font-weight: 650;
      background: color-mix(in srgb, var(--panel-alt) 76%, var(--panel));
    }
    .native-action-row span,
    .work-queue-row span,
    .decision-row span,
    .terminal-session span,
    .usage-row span {
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
      .usage-summary { grid-template-columns: 1fr 1fr; }
      .usage-row { grid-template-columns: 1fr; gap: 4px; align-items: stretch; }
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
<body data-head-assets="${headAssetsAttr}">
  <div class="app" id="app">
    <header id="operationalRail">
      <div class="brand"><span class="brand-mark"><img src="${heads.brand}" alt=""></span><span>Hydra</span></div>
      <div class="rail-primary">
        <span id="phaseChip" class="phase-chip idle">Idle</span>
        <span id="usageRail" class="rail-chip" role="button" tabindex="0" title="Open session token usage and estimated cost. Costs are estimates using hydraRoom.modelPrices (defaults: Claude Sonnet 4.6, Codex GPT-5 blend).">usage: 0 turns</span>
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
          <button id="autoAdvanceDefaultsBtn" class="secondary" type="button">Auto Accept: On</button>
          <button id="nativeActionBtn" class="secondary hidden" type="button" title="Choose a direct native terminal action">Native Action...</button>
        </div>
        <div id="workflowActions" class="workflow-actions">
          <button id="assignCodexBtn" class="secondary hidden" type="button">Assign Builder: Codex</button>
          <button id="assignClaudeBtn" class="secondary hidden" type="button">Assign Builder: Claude</button>
          <button id="assignBothBtn" class="secondary hidden" type="button">Assign Builders: Both</button>
          <button id="reviewBtn" class="secondary hidden" type="button">Request Review</button>
          <button id="handBackBtn" class="secondary hidden" type="button">Hand back to Builder</button>
          <button id="resetTurnBtn" class="secondary hidden" type="button">Reset Turn</button>
        </div>

        <div class="action-bank" aria-hidden="true">
          <button id="setObjectiveBtn" class="secondary" type="button">Pin Objective</button>
          <button id="previewPromptBtn" class="secondary" type="button">Preview Prompt</button>
          <button id="openLastPromptBtn" class="secondary" type="button">Open Last Prompt</button>
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
        <section class="panel-view" data-view="usage">
          <div class="insp-head"><h3>Usage</h3><span class="count" id="usagePanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body">
            <div id="usageSummary" class="usage-summary"></div>
            <div id="usageBoard" class="usage-board hidden"></div>
          </div>
        </section>
        <section class="panel-view" data-view="term">
          <div class="insp-head"><h3>Terminal Sessions</h3><span class="count" id="terminalPanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="terminalSessions" class="terminal-sessions hidden"></div></div>
        </section>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
