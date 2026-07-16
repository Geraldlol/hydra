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
  // style-src remains 'unsafe-inline' because the webview ships a large
  // inline CSS block; default-src 'none' + nonced script-src + the policies
  // below neutralize CSS-injection-to-XSS without the refactor cost.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${heads.cspSource}; script-src 'nonce-${nonce}' ${heads.cspSource}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';">
  <title>Hydra Room</title>
  <style>
    /* ============================================================
       Hydra UI Kit — "Abyssal" identity. Ported from the Claude
       Design system. The token block below is the single source of
       truth; it mirrors foundations/abyssal.html one-for-one so the
       kit and the live webview never drift. Many heads, one body:
       agent color comes from the --head-1..8 ramp by index, never a
       hardcoded per-model literal, so a new model just takes the
       next hue. Fixed dark palette by design (marketing identity);
       it deliberately overrides the VS Code theme.
       ============================================================ */
    :root {
      color-scheme: dark;

      /* ---- Neutrals — deep water, cool teal undertone ---- */
      --ink: #0A0F14;            /* app background, deepest */
      --abyss: #10171E;          /* primary surface / panel */
      --abyss-raised: #161F28;   /* cards, message bubbles */
      --abyss-overlay: #1C2731;  /* modals, command center */
      --border: #26323D;         /* hairline divider */
      --border-strong: #3A4A57;  /* emphasized edge */
      --text: #E6ECEF;           /* primary text, cool ivory */
      --text-muted: #93A4AD;     /* secondary */
      --text-faint: #83939D;     /* tertiary / disabled; AA on raised surfaces */

      /* ---- Brand — bioluminescent hydra glow ---- */
      --hydra: #74D0C9;
      --hydra-deep: #3E948E;
      --hydra-glow: rgba(116, 208, 201, 0.35);

      /* ---- Semantic ---- */
      --ok: #74C29A;
      --warn: #D9B871;
      --error: #E08B8B;
      --info: #7FB4D6;

      /* ---- Head ramp — categorical & scalable. Add a model -> next hue. ---- */
      --head-1: #7FA8D9;  /* azure    — Codex   */
      --head-2: #D6A77F;  /* amber    — Claude  */
      --head-3: #7FC9A8;  /* emerald  */
      --head-4: #B79BD6;  /* violet   */
      --head-5: #D68FA8;  /* rose     */
      --head-6: #D6C27F;  /* gold     */
      --head-7: #8FCBC9;  /* aqua     */
      --head-8: #A89BD6;  /* lavender */
      --user: #A8D6C2;    /* the operator — soft mint, distinct from the heads */

      /* ---- Compatibility aliases (kept so legacy selectors + the
             webview contract's var(--focus) reference keep resolving) ---- */
      --focus: var(--hydra);
      --panel: var(--abyss);
      --panel-alt: var(--abyss-raised);
      --muted: var(--text-muted);
      --codex: var(--head-1);
      --claude: var(--head-2);
      --button: var(--hydra);
      --button-text: var(--ink);
      --input: var(--ink);
      --input-border: var(--border-strong);
      --stream-width: 1120px;

      /* ---- Type — serif display + mono instrument layer (no generic sans) ---- */
      --font-display: "Hoefler Text", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
      --font-ui: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
      --font-mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;

      /* ---- Radii — sharp, etched edges ---- */
      --r-chip: 2px; --r-card: 2px; --r-panel: 3px; --r-pill: 2px;

      font-family: var(--font-ui);
      font-size: 13px;
    }
    * { box-sizing: border-box; min-width: 0; }
    body {
      margin: 0; color: var(--text); overflow: hidden;
      background:
        radial-gradient(900px 380px at 82% -12%, rgba(116,208,201,.11), transparent 58%),
        radial-gradient(760px 460px at 6% 2%, rgba(127,168,217,.05), transparent 52%),
        radial-gradient(1000px 720px at 50% 118%, rgba(62,148,142,.08), transparent 62%),
        radial-gradient(160% 130% at 50% -8%, #05090A 0%, var(--ink) 34%, #04080A 100%);
      -webkit-font-smoothing: antialiased;
    }
    /* the presence — a heavy, slow-breathing vignette; something watching from the dark */
    body::before {
      content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background:
        radial-gradient(135% 105% at 50% 4%, transparent 42%, rgba(0,0,0,.70) 100%),
        radial-gradient(58% 44% at 50% 113%, rgba(62,148,142,.13), transparent 72%);
      animation: breathe 12s ease-in-out infinite;
    }
    @keyframes breathe { 0%,100% { opacity: .84 } 50% { opacity: 1 } }
    /* drifting deep-water caustics, slow and cold */
    body::after {
      content: ""; position: fixed; inset: -20%; pointer-events: none; z-index: 0; opacity: .42;
      background:
        radial-gradient(closest-side, rgba(116,208,201,.07), transparent) 12% 22%/360px 360px no-repeat,
        radial-gradient(closest-side, rgba(127,168,217,.05), transparent) 88% 64%/420px 420px no-repeat;
      animation: drift 34s ease-in-out infinite alternate;
    }
    @keyframes drift { from { transform: translate3d(-14px,-10px,0) scale(1) } to { transform: translate3d(20px,16px,0) scale(1.08) } }
    /* eldritch tendrils — glowing limbs curling up from beneath the surface */
    .abyss-tendrils {
      position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none;
      opacity: .2; mix-blend-mode: screen; filter: drop-shadow(0 0 7px rgba(116,208,201,.4));
      animation: sway 26s ease-in-out infinite alternate;
    }
    .abyss-tendrils path { fill: none; stroke: var(--hydra-deep); stroke-width: 1.5; stroke-linecap: round; }
    .abyss-tendrils path.f { stroke: var(--head-1); opacity: .55; }
    .abyss-tendrils path.s { stroke: var(--hydra); opacity: .7; stroke-width: 1.1; }
    @keyframes sway { from { transform: translateY(0) rotate(-.7deg) scale(1.02) } to { transform: translateY(-16px) rotate(.7deg) scale(1.06) } }
    @keyframes pulse { 0%,100% { opacity: 1; filter: brightness(1) } 50% { opacity: .62; filter: brightness(1.35) } }
    @keyframes rot { to { transform: rotate(360deg) } }
    @keyframes blink { 50% { opacity: 0; } }
    @keyframes flicker {
      0%,100% { opacity: 1; text-shadow: 0 0 18px var(--hydra-glow); }
      40% { opacity: 1; } 41% { opacity: .45; text-shadow: none; }
      42.5% { opacity: 1; text-shadow: 0 0 18px var(--hydra-glow); }
      71% { opacity: 1; } 72% { opacity: .7; } 73% { opacity: 1; }
      87% { opacity: 1; } 87.7% { opacity: .35; text-shadow: none; }
      88.6% { opacity: 1; text-shadow: 0 0 18px var(--hydra-glow); }
    }

    button, textarea, select, input { font: inherit; }
    /* base button == kit .btn (secondary-ish neutral); variant classes refine */
    button {
      display: inline-flex; align-items: center; gap: 7px; justify-content: center;
      min-height: 28px; padding: 7px 12px; line-height: 1; font-weight: 600;
      color: var(--text); background: var(--abyss-raised);
      border: 1px solid var(--border-strong); border-radius: var(--r-chip);
      cursor: pointer; white-space: nowrap;
      transition: filter .12s ease, background .12s ease, box-shadow .12s ease, border-color .12s ease;
    }
    button:hover:not(:disabled) { border-color: var(--text-faint); background: var(--abyss-overlay); }
    button:active:not(:disabled) { filter: brightness(.94); }
    button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--hydra-glow); }
    [role="button"]:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--hydra-glow); }
    [role="button"] { cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button.secondary,
    .rail-chip,
    .rail-link,
    .palette-meta {
      color: var(--text-muted);
      background: var(--abyss-raised);
      border: 1px solid var(--border);
    }
    button.secondary:hover:not(:disabled),
    .rail-link:hover { color: var(--text); background: var(--abyss-overlay); border-color: var(--border-strong); }
    button.danger {
      color: var(--error); background: rgba(224,139,139,.10);
      border-color: rgba(224,139,139,.5);
    }
    button.danger:hover:not(:disabled) { background: rgba(224,139,139,.16); border-color: var(--error); }
    button.suggested {
      color: var(--hydra); background: rgba(116,208,201,.10);
      border-color: rgba(116,208,201,.45);
    }
    button.suggested:hover:not(:disabled) { background: rgba(116,208,201,.16); border-color: var(--hydra); }
    .hidden { display: none !important; }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      border: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .app {
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: transparent;
      position: relative;
      z-index: 1;
    }

    #operationalRail {
      min-height: 76px;
      display: grid;
      grid-template-areas:
        "brand primary"
        "secondary secondary";
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 5px 12px;
      padding: 7px 12px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, var(--abyss-raised), var(--abyss));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
      overflow: hidden;
      font-size: 12px;
    }
    .brand {
      grid-area: brand;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      flex: none;
    }
    .brand .wordmark {
      font-family: var(--font-display);
      font-size: 15px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    }
    .brand .wm-accent { color: var(--hydra); animation: flicker 6.5s linear infinite; }
    .brand-mark {
      width: 24px; height: 24px; border-radius: 50%;
      overflow: hidden;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--hydra); font-size: 11px; font-weight: 700;
      flex: none;
      box-shadow: 0 0 0 1px var(--border-strong), 0 0 10px -1px var(--hydra-glow);
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
    .rail-primary {
      grid-area: primary;
      display: grid;
      grid-template-columns: auto minmax(180px, 320px) minmax(0, 1fr) auto;
      flex-wrap: nowrap;
      overflow: hidden;
    }
    .rail-secondary-wrap {
      grid-area: secondary;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .rail-secondary {
      flex-wrap: nowrap;
      max-height: 38px;
      overflow-x: auto;
      overflow-y: hidden;
      align-content: center;
      padding-bottom: 3px;
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong) transparent;
    }
    .rail-secondary > * { flex: 0 0 auto; }
    .agent-rail {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 0 0 auto;
    }
    .rail-secondary-wrap:not(.is-expanded) .rail-secondary > .optional:not(.warn):not(.error) {
      display: none;
    }
    .rail-secondary-wrap.is-expanded {
      align-items: start;
    }
    .rail-secondary-wrap.is-expanded .rail-secondary {
      flex-wrap: wrap;
      max-height: 84px;
      overflow-x: hidden;
      overflow-y: auto;
      padding-bottom: 0;
    }
    #railOverflowBtn {
      min-height: 24px;
      padding: 3px 8px;
      color: var(--text-muted);
      font-size: 10.5px;
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
      max-width: 200px;
      padding: 3px 9px;
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-muted);
      font-size: 11px;
    }
    .phase-chip {
      flex: none;
      max-width: 240px;
      color: var(--hydra);
      border-color: rgba(116,208,201,.34);
      font-weight: 700; letter-spacing: .04em;
      background: rgba(116,208,201,.08);
      box-shadow: 0 0 16px -7px var(--hydra-glow);
    }
    .agent-status { max-width: 168px; font-weight: 600; }
    .authority-badge { max-width: 150px; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; }
    .rail-chip.optional { max-width: 165px; }
    #usageRail { max-width: 340px; }
    .rail-primary #usageRail {
      flex: none;
      color: var(--text);
      border-color: var(--focus);
      background: color-mix(in srgb, var(--focus) 12%, transparent);
      font-weight: 650;
    }
    .phase-chip.idle { color: var(--text-muted); border-color: var(--border-strong); background: transparent; font-weight: 600; box-shadow: none; }
    .phase-chip.experimental { color: var(--warn); border-color: var(--warn); }
    .agent-status::before,
    .authority-badge::before,
    .rail-chip::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--text-faint);
      box-shadow: 0 0 6px currentColor;
      flex: none;
    }
    .agent-status.running::before { background: var(--hydra); animation: pulse 1.4s ease-in-out infinite; }
    .agent-status.replied::before,
    .authority-badge.readOnly::before,
    .rail-chip.ok::before { background: var(--ok); }
    .agent-status.error::before,
    .authority-badge.unknown::before,
    .rail-chip.error::before { background: var(--error); }
    .agent-status.head-1::before { background: var(--head-1); }
    .agent-status.head-2::before { background: var(--head-2); }
    .agent-status.head-3::before { background: var(--head-3); }
    .agent-status.head-4::before { background: var(--head-4); }
    .agent-status.head-5::before { background: var(--head-5); }
    .agent-status.head-6::before { background: var(--head-6); }
    .agent-status.head-7::before { background: var(--head-7); }
    .agent-status.head-8::before { background: var(--head-8); }
    .agent-status.running { color: var(--hydra); border-color: rgba(116,208,201,.4); background: rgba(116,208,201,.07); }
    .agent-status.replied { color: var(--ok); border-color: rgba(116,194,154,.35); }
    .agent-status.error { color: var(--error); border-color: rgba(224,139,139,.4); background: rgba(224,139,139,.06); }
    .authority-badge.workspaceWrite { color: var(--info); border-color: rgba(127,180,214,.4); background: rgba(127,180,214,.08); }
    .authority-badge.workspaceWrite::before { background: var(--info); }
    .authority-badge.fullNative { color: var(--warn); border-color: rgba(217,184,113,.45); background: rgba(217,184,113,.08); }
    .authority-badge.fullNative::before,
    .rail-chip.warn::before { background: var(--warn); }
    .authority-badge.unknown { border-style: dashed; }
    .rail-chip.warn { color: var(--warn); border-color: rgba(217,184,113,.4); }
    .rail-chip.ok { color: var(--ok); }
    .rail-chip.error { color: var(--error); border-color: rgba(224,139,139,.4); }
    .rail-label { color: var(--text-faint); }
    .rail-value { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
    .rail-value strong { color: inherit; font-weight: 700; }
    .rail-objective {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      max-width: 100%;
      color: var(--text-muted);
      overflow: hidden;
      white-space: nowrap;
    }
    #objectiveLabel { font-size: 9px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--text-faint); flex: none; }
    #objectiveText {
      min-width: 0;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #resetObjectiveBtn { flex: none; }

    #messages {
      overflow: auto;
      padding: 14px 16px 20px;
      scroll-behavior: auto;
      overflow-anchor: none;
      background: transparent;
    }
    .empty {
      max-width: 760px;
      color: var(--text-muted);
      line-height: 1.55;
      margin: 24px auto;
      text-align: center;
      font-family: var(--font-mono);
      font-size: 12.5px;
    }
    /* phase divider — etched line flanking an uppercase badge */
    .phase-mark {
      display: flex;
      align-items: center;
      gap: 14px;
      width: min(100%, var(--stream-width));
      margin: 10px auto 12px;
    }
    .phase-mark::before,
    .phase-mark::after {
      content: "";
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--border) 40%, var(--border));
    }
    .phase-mark::after { background: linear-gradient(270deg, transparent, var(--border) 40%, var(--border)); }
    .phase-mark span {
      flex: none;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--hydra);
      padding: 4px 13px;
      border-radius: var(--r-pill);
      background: rgba(116,208,201,.07);
      border: 1px solid rgba(116,208,201,.3);
      box-shadow: 0 0 18px -8px var(--hydra-glow);
    }
    .message {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      gap: 12px;
      width: min(100%, var(--stream-width));
      margin: 0 auto 13px;
    }
    .message-time {
      color: var(--text-faint);
      text-align: right;
      font-size: 10px;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      padding-top: 8px;
    }
    .message-card {
      border: 1px solid var(--border);
      border-left: 2px solid var(--border-strong);
      padding: 9px 13px 11px;
      background: var(--abyss-raised);
      border-radius: var(--r-card);
    }
    .message.user .message-card { border-left-color: var(--user); background: linear-gradient(180deg, color-mix(in srgb, var(--user) 5%, transparent), var(--abyss-raised)); }
    .message.codex .message-card { border-left-color: var(--head-1); }
    .message.claude .message-card { border-left-color: var(--head-2); }
    .message.error .message-card { border-left-color: var(--error); }
    .message.cancelled .message-card { border-left-color: var(--warn); opacity: 0.86; }
    .message-head {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 5px;
      color: var(--text-muted);
      font-size: 11px;
    }
    /* head-art == the kit head orb, but keeping the existing avatar image
       inside it; the orb supplies the per-head bioluminescent glow ring. */
    .head-art {
      position: relative;
      width: 28px; height: 28px;
      border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      overflow: hidden;
      background: color-mix(in srgb, var(--hc, var(--text-faint)) 22%, var(--abyss-raised));
      box-shadow: 0 0 0 1px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.05) inset, 0 0 14px -3px var(--hc, var(--text-faint));
      font-size: 10px;
      font-weight: 800;
      color: var(--ink);
      flex: none;
    }
    .head-art img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .head-art.codex { --hc: var(--head-1); }
    .head-art.claude { --hc: var(--head-2); }
    .head-art.user { --hc: var(--user); }
    .head-art.system { --hc: var(--text-faint); }
    /* Roster-driven heads: media/webview.js:headColorClass emits "head-<N>"
       from the agent's colorIndex once state.roster arrives, so any new head
       (not just codex/claude) resolves to the ramp by index. */
    .head-art.head-1 { --hc: var(--head-1); }
    .head-art.head-2 { --hc: var(--head-2); }
    .head-art.head-3 { --hc: var(--head-3); }
    .head-art.head-4 { --hc: var(--head-4); }
    .head-art.head-5 { --hc: var(--head-5); }
    .head-art.head-6 { --hc: var(--head-6); }
    .head-art.head-7 { --hc: var(--head-7); }
    .head-art.head-8 { --hc: var(--head-8); }
    /* the currently-streaming head pulses a ring of its own color */
    .message.pending .head-art::after {
      content: "";
      position: absolute; inset: -3px; border-radius: 50%;
      box-shadow: 0 0 0 1.5px var(--hc, var(--hydra)), 0 0 12px 1px var(--hc, var(--hydra));
      animation: pulse 2s ease-in-out infinite;
    }
    .speaker.codex { color: var(--head-1); }
    .speaker.claude { color: var(--head-2); }
    .speaker.user { color: var(--user); }
    .speaker.system { color: var(--text-muted); }
    .speaker { color: var(--text); font-weight: 700; }
    .role-tag { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
    .message-status { margin-left: auto; color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
    .text {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
      font-family: var(--font-mono);
      font-size: 12.5px;
    }
    .live-channel-events {
      margin-top: 9px;
      display: grid;
      gap: 6px;
    }
    .live-channel-event {
      border: 1px solid var(--border);
      border-left: 2px solid color-mix(in srgb, var(--hydra) 70%, var(--border));
      background: var(--ink);
      border-radius: var(--r-card);
      padding: 7px 10px;
      display: grid;
      gap: 4px;
      font-family: var(--font-mono);
    }
    .live-channel-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--text-faint);
      font-size: 11px;
    }
    .live-channel-title span:first-child {
      color: var(--hydra);
      font-weight: 650;
    }
    .live-channel-summary {
      color: var(--text);
      overflow-wrap: anywhere;
      line-height: 1.45;
      font-size: 11.5px;
    }
    .live-channel-summary.muted { color: var(--text-muted); }
    .live-channel-output {
      margin: 0;
      max-height: 220px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.45;
      color: var(--text-muted);
    }
    .run-failure {
      margin-top: 9px;
      padding-top: 9px;
      border-top: 1px solid rgba(224,139,139,.4);
      display: grid;
      gap: 7px;
    }
    .run-failure-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: var(--error);
      font-size: 12.5px;
      font-weight: 700;
    }
    .run-failure-head span {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-weight: 400;
      overflow-wrap: anywhere;
      text-align: right;
    }
    .run-failure-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
      color: var(--text-muted);
      font-size: 11px;
      font-family: var(--font-mono);
    }
    .run-failure-meta b { color: var(--text); font-weight: 650; }
    .run-failure-stderr {
      margin: 0;
      max-height: 160px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      padding: 7px 9px;
      border: 1px solid var(--border);
      background: var(--ink);
      border-radius: var(--r-card);
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.45;
      color: var(--text-muted);
    }
    .run-failure-stderr.muted { color: var(--text-faint); font-style: italic; }
    .run-failure-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .run-failure-actions button {
      min-height: 24px;
      padding: 4px 9px;
      font-size: 11px;
    }
    .pending .text::after {
      content: "\\258B";
      display: inline-block;
      margin-left: 1px;
      color: var(--hydra);
      text-shadow: 0 0 8px var(--hydra);
      animation: blink 1s steps(1) infinite;
    }
    .pending .text:empty::before {
      content: attr(data-placeholder);
      color: var(--text-faint);
      font-style: italic;
    }
    @media (max-width: 720px) {
      .message, .phase-mark { grid-template-columns: 54px minmax(0, 1fr); gap: 8px; }
      .message-time { font-size: 10px; }
      #messages { padding-left: 10px; padding-right: 10px; }
      #operationalRail { grid-template-columns: auto minmax(0, 1fr); }
      .rail-secondary-wrap { grid-column: 1 / -1; }
      .rail-objective, .authority-badge .rail-value { display: none; }
    }

    #composer-region {
      border-top: 1px solid var(--border);
      background: linear-gradient(180deg, var(--abyss), var(--abyss-raised));
    }
    .ribbon-stack {
      display: grid;
      position: relative;
      max-height: min(40vh, 360px);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .ribbon-toggle {
      position: absolute;
      top: 6px;
      right: 12px;
      z-index: 2;
      min-height: 23px;
      padding: 3px 9px;
      font-size: 11px;
    }
    .ribbon-minimized-summary {
      display: none;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
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
      background: rgba(0,0,0,.18);
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
    /* ribbon strips == kit .ribbon: semantic left edge + faint wash */
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
      padding: 10px 13px;
      border-bottom: 1px solid var(--border);
      border-left: 2px solid var(--border-strong);
      color: var(--text-muted);
      font-size: 12px;
      background:
        linear-gradient(90deg, color-mix(in srgb, var(--border-strong) 18%, transparent), transparent 40%),
        var(--abyss-raised);
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
      font-weight: 700;
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
      width: 24px;
      padding: 2px;
      color: var(--text-faint);
      font-size: 14px;
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
    #setupStrip { border-left-color: var(--text-faint); background: linear-gradient(90deg, color-mix(in srgb, var(--warn) 8%, transparent), transparent 40%), var(--abyss-raised); }
    #verificationStrip { border-left-color: var(--info); background: linear-gradient(90deg, rgba(127,180,214,.08), transparent 40%), var(--abyss-raised); }
    #verificationStrip.failed { border-left-color: var(--error); background: linear-gradient(90deg, rgba(224,139,139,.10), transparent 42%), var(--abyss-raised); }
    #nativeActionStrip { border-left-color: var(--warn); background: linear-gradient(90deg, rgba(217,184,113,.09), transparent 40%), var(--abyss-raised); }
    #workQueueStrip { border-left-color: var(--info); }
    #decisionStrip {
      display: grid;
      grid-template-columns: minmax(150px, auto) minmax(300px, 1fr) auto;
      align-items: center;
      gap: 8px 14px;
      border-left-color: var(--hydra);
      background: linear-gradient(90deg, rgba(116,208,201,.08), transparent 42%), var(--abyss-raised);
      box-shadow: 0 0 26px -14px var(--hydra-glow);
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
    #decisionStrip.is-collapsed .decision-details,
    #decisionStrip.is-collapsed .decision-actions {
      display: none !important;
    }
    .decision-title {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--text);
      font-weight: 700;
    }
    .decision-count { margin-left: 4px; color: var(--text-muted); font-weight: 400; font-family: var(--font-mono); }
    .risk-chip {
      display: inline-flex; align-items: center; gap: 4px;
      margin-left: 8px; padding: 2px 8px; border-radius: var(--r-pill);
      background: rgba(217,184,113,.16);
      color: var(--warn); border: 1px solid rgba(217,184,113,.45);
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
    .decision-field strong { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); }
    .decision-needed {
      min-width: 0;
      padding: 7px 10px;
      border: 1px solid rgba(116,208,201,.25);
      border-radius: var(--r-card);
      background: rgba(116,208,201,.06);
    }
    .decision-needed strong { color: var(--hydra); }
    .decision-needed span {
      margin-top: 4px;
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      overflow-wrap: anywhere;
      color: var(--text);
      font-size: 12.5px;
      font-weight: 650;
      line-height: 1.4;
    }
    #decisionStrip:not(.needs-user) .decision-needed {
      border-color: var(--border);
      background: transparent;
    }
    #decisionStrip:not(.needs-user) .decision-needed span {
      color: var(--text-muted);
      font-weight: 400;
    }
    .decision-details {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      padding-top: 7px;
      border-top: 1px solid var(--border);
    }
    #decisionStrip .decision-actions {
      align-self: center;
    }
    @media (max-width: 880px) {
      #decisionStrip { grid-template-columns: minmax(0, 1fr) auto; }
      #decisionStrip .decision-needed,
      #decisionStrip .decision-details { grid-column: 1 / -1; }
      .decision-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #decisionStrip .decision-actions { justify-content: flex-end; }
      .setup-strip,
      .verification-strip,
      .native-action-strip,
      .work-queue-strip { align-items: stretch; flex-direction: column; }
      .setup-actions, .ribbon-actions { justify-content: flex-start; }
    }

    .composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 8px 12px 10px;
    }
    #composerFrame {
      position: relative;
      min-width: 0;
      background: var(--abyss-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-panel);
      box-shadow: 0 18px 44px rgba(0,0,0,.5);
    }
    #composerFrame:focus-within { border-color: var(--hydra-deep); box-shadow: 0 0 0 3px var(--hydra-glow), 0 18px 44px rgba(0,0,0,.5); }
    #composer {
      display: block;
      width: 100%;
      min-height: 62px;
      max-height: 180px;
      resize: vertical;
      padding: 11px 13px 36px;
      border: none;
      color: var(--text);
      background: transparent;
      border-radius: var(--r-panel);
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.55;
    }
    #composer::placeholder { color: var(--text-faint); }
    #composer:focus { outline: none; }
    #composer:disabled { opacity: 0.5; cursor: not-allowed; }
    #composerToolbar {
      position: absolute;
      left: 9px;
      right: 9px;
      bottom: 7px;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: none;
    }
    #composerToolbar > * { pointer-events: auto; }
    #attachmentTray {
      display: none;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 9px 11px 0;
      color: var(--text-muted);
      font-size: 11px;
    }
    #attachmentTray.has-attachments { display: flex; }
    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 24px;
      max-width: 260px;
      padding: 4px 5px 4px 8px;
      border: 1px solid var(--border);
      border-radius: var(--r-chip);
      background: var(--ink);
      color: var(--text);
    }
    .attachment-chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .attachment-chip button {
      min-height: 18px;
      padding: 0 6px;
      line-height: 1;
      background: transparent;
      border-color: transparent;
      color: var(--text-faint);
    }
    .attachment-chip button:hover:not(:disabled) { background: var(--border); color: var(--text); }
    #openerBtn {
      min-height: 24px;
      padding: 4px 9px;
      font-size: 11px;
      color: var(--text);
      background: var(--abyss-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-pill);
    }
    #composerHint {
      margin-left: auto;
      color: var(--text-faint);
      font-family: var(--font-mono);
      font-size: 10.5px;
    }
    #composerActions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      align-content: start;
      gap: 4px;
      width: 224px;
    }
    #sendBtn {
      grid-column: 1 / -1;
      min-height: 34px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--ink);
      background: linear-gradient(180deg, var(--hydra), var(--hydra-deep));
      border-color: transparent;
      box-shadow: 0 0 18px -5px var(--hydra-glow);
    }
    #sendBtn:hover:not(:disabled) { filter: brightness(1.1); border-color: transparent; background: linear-gradient(180deg, var(--hydra), var(--hydra-deep)); }
    #sendBtn:disabled { background: var(--abyss); color: var(--text-faint); box-shadow: none; border-color: var(--border); }
    #stopBtn {
      display: none;
      grid-column: 1 / -1;
      min-height: 34px;
      font-weight: 700;
      letter-spacing: 0.04em;
      background: rgba(224,139,139,.1);
      color: var(--error);
      border-color: rgba(224,139,139,.5);
    }
    .app.in-flight #stopBtn { display: inline-flex; }
    #autoAdvanceDefaultsBtn { grid-column: 1 / -1; }
    #composerActions > .secondary { min-height: 24px; padding: 4px 8px; font-size: 10.5px; }
    .workflow-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      grid-column: 1 / -1;
    }
    .workflow-actions button { font-size: 12px; }
    .builder-buttons {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
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
      background: radial-gradient(120% 100% at 50% 0%, rgba(116,208,201,.05), transparent 60%), rgba(4,8,10,.62);
    }
    .overlay[data-open="true"] { display: flex; }
    #commandCenter,
    .inspector {
      width: min(920px, calc(100vw - 24px));
      max-height: calc(100vh - 72px);
      overflow: hidden;
      border: 1px solid var(--border-strong);
      background: linear-gradient(180deg, var(--abyss-overlay), var(--abyss));
      border-radius: var(--r-panel);
      box-shadow: 0 40px 90px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.5), 0 0 40px -16px var(--hydra-glow);
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .palette-input {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 11px;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }
    .palette-input .brand-mark { box-shadow: 0 0 0 1px var(--border-strong), 0 0 10px -1px var(--hydra-glow); }
    #paletteInput {
      min-height: 32px;
      border: none;
      background: transparent;
      color: var(--text);
      padding: 2px 0;
      font-size: 15px;
    }
    #paletteInput:focus { outline: none; }
    #paletteInput::placeholder { color: var(--text-faint); }
    #commandList {
      overflow: auto;
      padding: 7px;
    }
    .command-group { margin-bottom: 8px; }
    .command-group h4 {
      margin: 9px 8px 5px;
      color: var(--text-faint);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .command-option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 10px;
      align-items: center;
      padding: 8px 10px;
      border-radius: var(--r-chip);
      cursor: pointer;
    }
    .command-option:hover { background: var(--abyss-raised); }
    .command-option[aria-selected="true"] {
      background: rgba(116,208,201,.10);
      box-shadow: inset 2px 0 0 var(--hydra);
    }
    .command-option[aria-disabled="true"] {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .command-name { color: var(--text); font-weight: 600; }
    .command-desc { color: var(--text-faint); margin-left: 6px; font-family: var(--font-mono); font-size: 11px; }
    .command-why { color: var(--warn); font-size: 11px; margin-left: 6px; }
    .palette-meta { font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); padding: 2px 7px; }
    .kbd {
      color: var(--text-muted);
      border: 1px solid var(--border-strong);
      border-bottom-width: 2px;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-family: var(--font-mono);
      background: linear-gradient(180deg, var(--abyss-raised), var(--abyss));
    }

    .inspector { display: grid; }
    .insp-head {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 12px 13px;
      border-bottom: 1px solid var(--border);
    }
    .insp-head h3 { margin: 0; font-size: 13px; font-weight: 700; }
    .insp-head .count { color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; }
    .insp-head .close { margin-left: auto; }
    .insp-body { overflow: auto; padding: 12px 13px; }
    .panel-view { display: none; min-height: 0; overflow: hidden; }
    #panelOverlay[data-panel="actions"] .panel-view[data-view="actions"],
    #panelOverlay[data-panel="queue"] .panel-view[data-view="queue"],
    #panelOverlay[data-panel="edits"] .panel-view[data-view="edits"],
    #panelOverlay[data-panel="verify"] .panel-view[data-view="verify"],
    #panelOverlay[data-panel="decisions"] .panel-view[data-view="decisions"],
    #panelOverlay[data-panel="standings"] .panel-view[data-view="standings"],
    #panelOverlay[data-panel="duels"] .panel-view[data-view="duels"],
    #panelOverlay[data-panel="term"] .panel-view[data-view="term"],
    #panelOverlay[data-panel="usage"] .panel-view[data-view="usage"] {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .native-action-board,
    .work-queue-board,
    .edit-board,
    .decision-board,
    .standings-board,
    .duels-board,
    .terminal-sessions,
    .usage-board {
      display: grid;
      gap: 1px;
      color: var(--text-muted);
      font-size: 12px;
    }
    .native-action-row,
    .work-queue-row,
    .edit-row,
    .decision-row,
    .terminal-session {
      display: grid;
      grid-template-columns: minmax(90px, 0.32fr) minmax(140px, 0.5fr) minmax(220px, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 8px 9px;
      border-bottom: 1px solid var(--border);
      background: var(--ink);
      border-radius: var(--r-chip);
    }
    .native-action-row {
      grid-template-columns: 92px 82px minmax(140px, 0.55fr) minmax(220px, 1fr) auto;
    }
    .work-queue-row {
      grid-template-columns: 92px minmax(160px, 0.55fr) minmax(220px, 1fr) auto;
    }
    .edit-row {
      grid-template-columns: 88px 96px minmax(220px, 1fr) auto;
    }
    .decision-row {
      grid-template-columns: 110px minmax(150px, 1fr) minmax(150px, 1fr) minmax(120px, 0.7fr);
    }
    .terminal-session {
      grid-template-columns: 1fr;
      align-items: stretch;
    }
    .session-line { display: flex; gap: 8px; font-size: 11.5px; font-family: var(--font-mono); }
    .session-line strong { color: var(--text-faint); font-weight: 600; }
    .session-line span { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .usage-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(110px, 1fr));
      gap: 8px;
      padding: 0 0 12px;
    }
    .usage-stat {
      display: grid;
      gap: 2px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--r-card);
      background: var(--ink);
    }
    .usage-stat strong {
      color: var(--text);
      font-family: var(--font-display);
      font-size: 20px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .usage-stat span { color: var(--text-faint); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
    .usage-row {
      display: grid;
      grid-template-columns: 76px 76px minmax(90px, 0.7fr) repeat(4, minmax(74px, 0.55fr)) 72px;
      gap: 8px;
      align-items: center;
      padding: 8px 9px;
      border-bottom: 1px solid var(--border);
      background: var(--ink);
      border-radius: var(--r-chip);
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .usage-row.header {
      color: var(--text);
      font-weight: 700;
      background: var(--abyss-raised);
    }
    .native-action-row span,
    .work-queue-row span,
    .edit-row span,
    .decision-row span,
    .terminal-session span,
    .usage-row span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .native-action-controls,
    .edit-controls,
    .work-queue-controls {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .native-action-controls button,
    .edit-controls button,
    .work-queue-controls button { min-height: 24px; padding: 3px 8px; font-size: 11px; }
    .status.completed,
    .severity.info { color: var(--info); }
    .status.failed,
    .severity.error { color: var(--error); }
    .status.cancelled,
    .severity.warning { color: var(--warn); }
    select {
      min-height: 28px;
      color: var(--text);
      background: var(--ink);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-chip);
      padding: 3px 8px;
    }
    select:focus { outline: none; border-color: var(--hydra-deep); box-shadow: 0 0 0 3px var(--hydra-glow); }
    @media (max-width: 900px) {
      #operationalRail { grid-template-columns: auto minmax(150px, 1fr); }
      .rail-secondary-wrap { grid-column: 1 / -1; }
      .rail-primary { grid-template-columns: auto minmax(140px, 240px) minmax(0, 1fr) auto; }
      #objectiveLabel { display: none; }
      .native-action-row,
      .work-queue-row,
      .edit-row,
      .decision-row { grid-template-columns: 1fr; gap: 4px; align-items: stretch; }
      .composer { grid-template-columns: 1fr; }
      #composerActions { display: flex; width: auto; min-width: 0; flex-direction: row; flex-wrap: wrap; }
      #sendBtn, #stopBtn { flex: 1 1 140px; }
      #autoAdvanceDefaultsBtn { flex: 1 1 230px; }
      .usage-summary { grid-template-columns: 1fr 1fr; }
      .usage-row { grid-template-columns: 1fr; gap: 4px; align-items: stretch; }
    }
    @media (max-width: 720px) {
      #operationalRail {
        min-height: 44px;
        grid-template-areas: "brand" "primary" "secondary";
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
      }
      .brand .wordmark { display: none; }
      .rail-primary,
      .rail-secondary {
        width: 100%;
        overflow-x: auto;
        flex-wrap: nowrap;
        scrollbar-width: thin;
      }
      .rail-primary {
        display: flex;
        overflow-y: hidden;
      }
      .rail-secondary-wrap { grid-column: auto; }
      .phase-chip,
      .agent-status,
      .authority-badge,
      .rail-chip {
        flex: 0 0 auto;
        max-width: 200px;
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
      .message-card { padding: 7px 10px; }
      .rail-primary { flex-direction: row; align-items: center; overflow-x: auto; }
      .rail-secondary { max-height: 30px; }
      .phase-chip,
      .rail-objective,
      #objectiveText {
        max-width: 100%;
      }
      .ribbon-stack { max-height: 28vh; }
      #decisionStrip { grid-template-columns: 1fr; }
      .decision-details { grid-template-columns: 1fr; }
      #decisionStrip .decision-actions { justify-content: flex-start; }
      #composerFrame { min-height: 82px; }
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
    .standings-board { gap: 7px; }
    .standing-policy {
      margin: 0 0 10px;
      padding: 9px 11px;
      border: 1px solid var(--border);
      border-radius: var(--r-chip);
      color: var(--text-faint);
      background: var(--ink);
      font-size: 11px;
      line-height: 1.45;
    }
    .standing-row {
      display: grid;
      grid-template-columns: 42px minmax(120px, .7fr) 88px minmax(150px, 1fr) 92px;
      gap: 10px;
      align-items: center;
      padding: 10px 11px;
      border: 1px solid var(--border);
      border-radius: var(--r-chip);
      background: var(--ink);
    }
    .standing-row.leader { border-color: var(--hydra-line); box-shadow: inset 2px 0 0 var(--hydra); }
    .standing-rank, .standing-score { font-family: var(--font-display); font-variant-numeric: tabular-nums; }
    .standing-rank { color: var(--hydra); font-size: 18px; }
    .standing-score { color: var(--text); font-size: 16px; }
    .standing-meta { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
    .standing-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
    .duels-board { gap: 14px; }
    .duel-policy {
      margin: 0 0 10px;
      padding: 9px 11px;
      border: 1px solid var(--warn);
      border-radius: var(--r-chip);
      color: var(--text);
      background: color-mix(in srgb, var(--warn) 7%, var(--ink));
      font-size: 11px;
      line-height: 1.45;
    }
    .duel-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 12px; }
    .duel-section { display: grid; gap: 7px; }
    .duel-rating-domain { display: grid; gap: 5px; padding-top: 3px; }
    .duel-section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin: 0;
      color: var(--text);
      font-size: 11px;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .duel-section-head span { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0; text-transform: none; }
    .duel-card,
    .duel-rating-row {
      border: 1px solid var(--border);
      border-radius: var(--r-chip);
      background: var(--ink);
    }
    .duel-card { display: grid; gap: 9px; padding: 10px 11px; }
    .duel-card.active { border-color: var(--hydra-line); box-shadow: inset 2px 0 0 var(--hydra); }
    .duel-card-head,
    .duel-matchup,
    .duel-card-actions {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
    }
    .duel-card-head { justify-content: space-between; }
    .duel-matchup { color: var(--text); font-size: 13px; font-weight: 700; }
    .duel-status,
    .duel-domain,
    .duel-rated {
      padding: 2px 6px;
      border: 1px solid var(--border-strong);
      border-radius: var(--r-pill);
      color: var(--text-faint);
      font-family: var(--font-mono);
      font-size: 10px;
    }
    .duel-status { color: var(--hydra); border-color: var(--hydra-line); }
    .duel-proposition { margin: 0; color: var(--text); line-height: 1.5; overflow-wrap: anywhere; }
    .duel-meta { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; line-height: 1.45; overflow-wrap: anywhere; }
    .duel-evidence-packet { color: var(--text-muted); font-size: 11px; }
    .duel-evidence-packet summary { cursor: pointer; color: var(--hydra); font-family: var(--font-mono); }
    .duel-evidence-packet pre {
      max-height: 220px;
      margin: 7px 0 0;
      padding: 8px 9px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border: 1px solid var(--border);
      border-radius: var(--r-chip);
      background: var(--abyss-raised);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      line-height: 1.45;
    }
    .duel-commitment-state {
      padding: 8px 9px;
      border: 1px dashed var(--border-strong);
      border-radius: var(--r-chip);
      color: var(--text-muted);
      font-size: 11px;
    }
    .duel-reveal { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .duel-answer { min-width: 0; padding: 9px; border: 1px solid var(--border); border-radius: var(--r-chip); background: var(--abyss-raised); }
    .duel-answer strong { display: block; margin-bottom: 5px; color: var(--text); }
    .duel-answer p { margin: 0; color: var(--text-muted); line-height: 1.45; overflow-wrap: anywhere; }
    .duel-resolution { padding-top: 7px; border-top: 1px solid var(--border); color: var(--text-muted); }
    .duel-rating-row {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) minmax(150px, .9fr) 82px minmax(130px, .8fr) 82px;
      gap: 9px;
      align-items: center;
      padding: 9px 10px;
    }
    .duel-rating-row.leader { border-color: var(--hydra-line); box-shadow: inset 2px 0 0 var(--hydra); }
    .duel-rating-value { color: var(--text); font-family: var(--font-display); font-size: 16px; font-variant-numeric: tabular-nums; }
    .duel-rank-chase { color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; }
    .duel-rating-row.leader .duel-rank-chase { color: var(--hydra); font-weight: 700; }
    .duel-card-actions { justify-content: flex-end; }
    @media (max-width: 720px) {
      .standing-row {
        grid-template-columns: 38px minmax(0, 1fr) auto;
        gap: 7px;
      }
      .standing-row > :nth-child(4) { grid-column: 2 / -1; }
      .standing-row > :nth-child(5) { grid-column: 2 / -1; }
      .duel-reveal { grid-template-columns: 1fr; }
      .duel-rating-row { grid-template-columns: minmax(0, 1fr) auto; gap: 5px 8px; }
      .duel-rating-row > :nth-child(n+3) { grid-column: 1 / -1; }
      .duel-card-actions { justify-content: stretch; }
      .duel-card-actions button { flex: 1 1 150px; }
    }
    body.vscode-high-contrast,
    body.vscode-high-contrast-light {
      --ink: var(--vscode-editor-background);
      --abyss: var(--vscode-editor-background);
      --abyss-raised: var(--vscode-sideBar-background);
      --abyss-overlay: var(--vscode-editorWidget-background);
      --border: var(--vscode-contrastBorder);
      --border-strong: var(--vscode-contrastActiveBorder);
      --text: var(--vscode-editor-foreground);
      --text-muted: var(--vscode-descriptionForeground);
      --text-faint: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
    }
    @media (forced-colors: active) {
      body { background: Canvas; color: CanvasText; }
      body::before, body::after, .abyss-tendrils { display: none; }
      button, textarea, select, input, [role="button"], .message-card, .phase-chip,
      .agent-status, .authority-badge, .rail-chip, .decision-needed { forced-color-adjust: auto; }
    }
  </style>
</head>
<body data-head-assets="${headAssetsAttr}">
  <svg class="abyss-tendrils" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <path d="M-40 770 C 200 720 250 540 175 395 C 120 285 235 185 380 210"/>
    <path d="M-60 840 C 250 815 340 615 305 450 C 286 330 385 255 540 300" class="f"/>
    <path d="M120 920 C 150 760 60 660 130 520 C 185 408 110 320 170 215" class="s"/>
    <path d="M1490 110 C 1240 175 1170 360 1255 525 C 1320 650 1215 750 1050 728"/>
    <path d="M1500 50 C 1205 115 1110 305 1175 480 C 1230 620 1115 712 970 690" class="f"/>
    <path d="M740 950 C 720 770 575 705 615 525 C 645 405 555 322 615 222" class="s"/>
  </svg>
  <div class="app" id="app">
    <header id="operationalRail">
      <div class="brand"><span class="brand-mark"><img src="${heads.brand}" alt=""></span><span class="wordmark">Hy<span class="wm-accent">dra</span></span></div>
      <div class="rail-primary">
        <span id="phaseChip" class="phase-chip idle">Idle</span>
        <span id="usageRail" class="rail-chip" role="button" tabindex="0" title="Open session token usage and estimated cost. Costs are estimates using hydraRoom.modelPrices (defaults: Claude Sonnet 4.6, Codex GPT-5 blend).">usage: 0 turns</span>
        <span class="rail-objective"><span id="objectiveLabel">Objective</span><span id="objectiveText">Not set</span></span>
        <button id="resetObjectiveBtn" class="secondary rail-link" type="button" title="Clear the pinned room objective">Reset</button>
      </div>
      <div id="railSecondaryWrap" class="rail-secondary-wrap">
        <div id="railSecondary" class="rail-secondary" role="region" tabindex="0" aria-label="Operational status. Scroll horizontally for more details." title="Scroll horizontally for more status, or choose All status.">
          <span id="transportChip" class="rail-chip">Safe one-shot</span>
          <span id="standingsRail" class="rail-chip" role="button" tabindex="0" aria-label="scoreboard: unranked. Open passive Hydra Scoreboard" aria-haspopup="dialog" aria-controls="panelOverlay">scoreboard: unranked</span>
          <span id="duelsRail" class="rail-chip" role="button" tabindex="0" aria-label="duels: none. Open formal Hydra duels" aria-haspopup="dialog" aria-controls="panelOverlay">duels: none</span>
          <span id="agentStatusRail" class="agent-rail" role="list" aria-label="Hydra head status"></span>
          <span id="authorityRail" class="agent-rail" role="list" aria-label="Hydra head authority"></span>
          <span id="verificationRail" class="rail-chip optional">verify: none</span>
          <span id="editsRail" class="rail-chip optional" role="button" tabindex="0" title="Open current workspace edits">edits: 0</span>
          <span id="nativeActionRail" class="rail-chip optional">actions: 0</span>
          <span id="workQueueRail" class="rail-chip optional">queue clear</span>
          <span id="decisionRail" class="rail-chip optional">decision: none</span>
          <span id="modelRail" class="rail-chip" role="button" tabindex="0" title="Click to change model or thinking level.">models: CLI default</span>
          <button id="profileBtn" class="secondary rail-link" type="button" title="Change Codex or Claude capability profile">Profiles</button>
        </div>
        <button id="railOverflowBtn" class="secondary" type="button" aria-expanded="false" aria-controls="railSecondary" title="Show every operational status">All status</button>
      </div>
    </header>

    <main id="messages"><p class="empty">Loading the room...</p></main>
    <div id="srAnnounce" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>

    <section id="composer-region">
      <div class="ribbon-stack" id="ribbonStack">
        <div id="ribbonMinimizedSummary" class="ribbon-minimized-summary">Status ribbons hidden</div>
        <button id="toggleRibbonsBtn" class="secondary ribbon-toggle" type="button" aria-expanded="true">Hide status</button>
        <div class="objective"><strong>Objective</strong><span id="objectiveTextShim">Not set</span></div>
        <div id="setupStrip" class="setup-strip">
          <span><strong>Autopilot</strong> <span id="autopilotText">Not run</span></span>
          <span class="setup-actions">
            <button id="fixCodexBtn" class="secondary hidden" type="button">Fix Codex Path</button>
            <button id="fixClaudeBtn" class="secondary hidden" type="button">Fix Claude Path</button>
            <button id="retryAutopilotBtn" class="secondary" type="button">Retry Autopilot</button>
            <button id="safeModeBtn" class="secondary" type="button">Use Safe Mode</button>
            <button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="setupStrip" data-ribbon-label="Autopilot" aria-label="Collapse Autopilot status" title="Collapse Autopilot status" aria-expanded="true">&#8722;</button>
          </span>
        </div>
        <div id="verificationStrip" class="verification-strip">
          <span><strong>Verification</strong> <span id="verificationText">No verification yet</span></span>
          <span class="ribbon-actions">
            <button id="runVerificationBtn" class="secondary" type="button">Run Verification</button>
            <button id="openVerificationBtn" class="secondary" type="button">Open Verification</button>
            <button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="verificationStrip" data-ribbon-label="Verification" aria-label="Collapse Verification status" title="Collapse Verification status" aria-expanded="true">&#8722;</button>
          </span>
        </div>
        <div id="nativeActionStrip" class="native-action-strip">
          <span><strong>Native Actions</strong> <span id="nativeActionText">No native actions yet</span></span>
          <span class="ribbon-actions">
            <label class="visually-hidden" for="nativeAgentFilter">Filter native actions by target</label>
            <select id="nativeAgentFilter" title="Filter native actions by target">
              <option value="all">All heads</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="both">Both</option>
            </select>
            <label class="visually-hidden" for="nativeStatusFilter">Filter native actions by status</label>
            <select id="nativeStatusFilter" title="Filter native actions by status">
              <option value="all">All statuses</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button id="clearNativeActionsBtn" class="secondary" type="button" title="Clear all native actions currently shown by the filters">Clear Shown</button>
            <button id="openNativeActionsBtn" class="secondary" type="button">Open Actions</button>
            <button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="nativeActionStrip" data-ribbon-label="Native actions" aria-label="Collapse Native actions status" title="Collapse Native actions status" aria-expanded="true">&#8722;</button>
          </span>
        </div>
        <div id="workQueueStrip" class="work-queue-strip">
          <span><strong>Work Queue</strong> <span id="workQueueText">Queue clear</span></span>
          <span class="ribbon-actions"><button id="openWorkQueuePanelBtn" class="secondary" type="button">Open Queue</button><button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="workQueueStrip" data-ribbon-label="Work queue" aria-label="Collapse Work queue status" title="Collapse Work queue status" aria-expanded="true">&#8722;</button></span>
        </div>
        <div id="decisionStrip" class="decision-strip hidden">
          <div class="decision-title">Latest Decision<span id="decisionCount" class="decision-count"></span><span id="decisionRiskChip" class="risk-chip" style="display:none"></span><button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="decisionStrip" data-ribbon-label="Latest decision" aria-label="Collapse Latest decision" title="Collapse Latest decision" aria-expanded="true">&#8722;</button></div>
          <div class="decision-field decision-needed"><strong>Needs your decision</strong><span id="decisionNeeded">None</span></div>
          <div class="decision-actions"><button id="acceptDefaultBtn" class="secondary" type="button">Accept Default</button></div>
          <div class="decision-details">
            <div class="decision-field"><strong>Default next action</strong><span id="decisionDefault">None yet</span></div>
            <div class="decision-field"><strong>Recommendation</strong><span id="decisionRecommendation">None yet</span></div>
            <div class="decision-field"><strong>Blockers</strong><span id="decisionBlockers">None</span></div>
          </div>
        </div>
      </div>

      <footer class="composer">
        <div id="composerFrame">
          <label class="visually-hidden" for="composer">Message Hydra heads</label>
          <textarea id="composer" placeholder="message - type / for commands, Ctrl+Enter to send"></textarea>
          <div id="attachmentTray" aria-live="polite"></div>
          <div id="composerToolbar">
            <button id="openerBtn" class="secondary" type="button" title="Choose the next configured opener for this turn only" aria-label="Choose next opener, currently Codex">Opener: Codex</button>
            <button id="attachFilesBtn" class="secondary" type="button" title="Attach files to the next room turn">Attach</button>
            <span id="composerHint">Ctrl+Enter send - Shift+Enter newline - Ctrl+K commands</span>
          </div>
        </div>
        <div id="composerActions">
          <button id="sendBtn" type="button">SEND</button>
          <button id="stopBtn" class="danger" type="button">STOP TURN</button>
          <button id="commandCenterBtn" class="secondary" type="button" title="Open Command Center (Ctrl+K)">Commands</button>
          <button id="browserBtn" class="secondary" type="button" title="Open VS Code's Integrated Browser">Browser</button>
          <button id="nativeActionBtn" class="secondary hidden" type="button" title="Choose a direct native terminal action">Native Action...</button>
          <button id="autoAdvanceDefaultsBtn" class="secondary" type="button">Auto-advance safe defaults: On</button>
        </div>
        <div id="workflowActions" class="workflow-actions">
          <span id="builderButtons" class="builder-buttons hidden" role="group" aria-label="Choose a Hydra builder"></span>
          <button id="assignBothBtn" class="secondary hidden" type="button">Assign Builders: Both</button>
          <button id="reviewBtn" class="secondary hidden" type="button">Request Review</button>
          <button id="handBackBtn" class="secondary hidden" type="button">Hand back to Builder</button>
          <button id="resetTurnBtn" class="secondary hidden" type="button">Reset Turn</button>
        </div>

        <div class="action-bank" aria-hidden="true">
          <button id="setObjectiveBtn" class="secondary" type="button">Pin Objective</button>
          <button id="previewPromptBtn" class="secondary" type="button">Preview Prompt</button>
          <button id="openLastPromptBtn" class="secondary" type="button">Open Last Prompt</button>
          <button id="clearAttachmentsBtn" class="secondary" type="button">Clear Attachments</button>
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
      <div id="commandCenter" role="dialog" aria-modal="true" aria-label="Command Center">
        <div class="palette-input">
          <span class="brand-mark"><img src="${heads.brand}" alt=""></span>
          <input id="paletteInput" role="combobox" aria-label="Search Hydra commands" aria-controls="commandList" aria-expanded="true" aria-activedescendant="" placeholder="Search commands" autocomplete="off">
          <span class="kbd">Esc</span>
        </div>
        <div id="commandList" role="listbox" aria-label="Hydra commands"></div>
      </div>
    </div>

    <div class="overlay" id="panelOverlay" data-open="false" data-panel="actions" aria-hidden="true">
      <div class="inspector" role="dialog" aria-modal="true" aria-label="Hydra inspector">
        <section class="panel-view" data-view="actions">
          <div class="insp-head"><h3>Native Actions</h3><span class="count" id="nativePanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="nativeActionBoard" class="native-action-board hidden"></div></div>
        </section>
        <section class="panel-view" data-view="queue">
          <div class="insp-head"><h3>Work Queue</h3><span class="count" id="queuePanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="workQueueBoard" class="work-queue-board hidden"></div></div>
        </section>
        <section class="panel-view" data-view="edits">
          <div class="insp-head"><h3>Edits</h3><span class="count" id="editsPanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body"><div id="editBoard" class="edit-board hidden"></div></div>
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
        <section class="panel-view" data-view="standings">
          <div class="insp-head"><h3>Evidence Scoreboard</h3><span class="count" id="standingsPanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body">
            <p class="standing-policy">Passive only: evidence scores never change native permissions, approval rights, builder assignment, or speaking order. Peer opinions are advisory; duel rating will remain separate.</p>
            <div class="standing-actions"><button id="recordVerdictBtn" type="button">Record Verdict</button><button id="adjudicatePendingBtn" class="secondary" type="button">Adjudicate Pending</button><button id="openEvidenceBtn" class="secondary" type="button">Review Evidence</button><button id="reverseVerdictBtn" class="secondary" type="button">Reverse Verdict</button><button id="openStandingsBtn" class="secondary" type="button">Open Standings File</button></div>
            <div id="standingsBoard" class="standings-board"></div>
          </div>
        </section>
        <section class="panel-view" data-view="duels">
          <div class="insp-head"><h3>Formal Duels</h3><span class="count" id="duelsPanelCount"></span><button class="secondary close" type="button">Close</button></div>
          <div class="insp-body">
            <p class="duel-policy">Heads initiate their own formal duels from consequential, falsifiable disagreements in serial discussion. Hydra admits or rejects each challenge by policy, then automatically runs both sealed commitments—the human does not create, accept, or author either answer. No duel is downgraded to an exhibition. Both heads receive equal maximum Hydra-granted permissions and the same host-built evidence brief. Hydra locks each effective command, model, arguments, working directory, and environment digest; vendor-native tool catalogs and provider capabilities can still differ. The project is read-only by duel contract, with bounded content and entry-metadata checks plus live mutation monitoring outside <code>.git</code> and Hydra-owned <code>.hydra</code>. A detected or unverifiable change cancels without Elo; this is not an absolute defense against a malicious same-user process. Persistent full-native consent is still required. The human independently judges the revealed evidence. Results never change permissions, approvals, builder assignment, speaking order, safety policy, or orchestration authority.</p>
            <div class="duel-actions"><span id="agentDuelMode" class="duel-status">Agent challenges: enabled</span><button id="openDuelAuditBtn" class="secondary" type="button">Open Audit</button><button id="correctDuelResultBtn" class="secondary" type="button">Correct Result</button></div>
            <div id="duelsBoard" class="duels-board"></div>
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
