# ADR: Agent-controllable in-app browser

Date: 2026-07-16
Status: Accepted for MVP

## Context

Hydra is distributed as a VS Code extension. It needs a browser the user can see and operate inside the editor, while Hydra-dispatched Codex and Claude processes can inspect and control explicitly authorized tabs.

An iframe inside the room webview is not a general browser: sites can refuse framing, the room has a deliberately strict CSP, and cross-origin pages do not expose a stable inspection/input API. Forking Code - OSS is legally possible under its MIT license, but would turn Hydra into an editor distribution with a permanent merge, signing, update, and Chromium-patching burden.

VS Code 1.127 introduced the native Integrated Browser and browser tools. The stable public extension API exposes all registered language-model tools through `vscode.lm.tools` and permits any extension to call them through `vscode.lm.invokeTool`. The Integrated Browser's individual tool names and schemas remain internal implementation details, so they must be discovered and validated at runtime.

## Decision

Keep Hydra as an ordinary extension and add an extension-owned `IntegratedBrowserBroker`:

1. Open visible pages in VS Code's native Integrated Browser. Prefer the built-in `open_browser_page` tool; fall back to `workbench.action.browser.open`, then `simpleBrowser.api.open`, on builds without agentic browser tools.
2. Discover the current browser tool set at runtime and translate Hydra's stable operations (`open`, `read`, `screenshot`, `navigate`, `click`, `type`, `hover`, `drag`, and `dialog`) into the available VS Code tools.
3. Expose those operations to dispatched Codex and Claude heads through a small authenticated Streamable HTTP MCP server. Hydra injects the non-secret loopback URL in trusted CLI configuration and places a per-dispatch bearer token only in the child environment. A packaged Node CLI adapter is retained as a fallback for other spawned heads that have Node on `PATH`.
4. Keep browser ownership outside `HydraRoomPanel`, so closing the room does not destroy visible browser tabs. The broker lasts for the extension-host session and exposes a persistent status-bar kill switch while agent control is enabled.

The Code - OSS fork remains a future option only if VS Code removes the tool seam or Hydra needs browser capabilities that an extension cannot provide.

## Security boundaries

- Agent control is off by default, session-only, and requires a trusted workspace plus explicit modal consent.
- The bridge binds to `127.0.0.1` on an ephemeral port, requires a random 256-bit bearer token, rejects browser `Origin` headers, bounds its queue and invocation duration, caps request/result sizes, and serializes browser actions.
- A fresh token is passed through the child environment for each dispatch and revoked when that process exits. Hydra redacts issued tokens from stdout/stderr before collected output reaches transcripts or agent-call traces. The spawned process necessarily can read its own token, so the globe kill switch remains the hard revocation boundary.
- Each head can control only pages it opened. Pages opened by the user through Hydra's Browser command become shared only when control is already enabled; unrelated Integrated Browser tabs are not discovered or inherited.
- Agent opens, navigation, `click`, `type`, `drag`, `hover`, and dialog responses require a request-specific **Allow Once** modal that shows the destination or target. The modal surfaces the full executed length of any long text and labels agent-supplied target descriptions as untrusted, so an approved action cannot conceal a larger payload or misrepresent what it clicks. VS Code's browser policy still applies underneath. This web-interaction grant is separate from Hydra's filesystem authority labels.
- Only `http:`, `https:`, and `about:blank` top-level URLs are accepted by Hydra. Link-local / cloud-metadata hosts (`169.254.0.0/16`, IPv6 `fe80::/10`) and credential-bearing `user:pass@host` URLs are rejected; loopback and private ranges stay allowed so local and LAN dev servers remain browsable. No raw CDP endpoint or workbench/Electron object is exposed.
- Browser observations and screenshots are explicitly labeled untrusted web content. Page content cannot grant authority. Local-file selection/uploads are rejected.
- Screenshots have per-part, per-response, file-count, and session-byte limits. They are kept in a process-specific extension-private directory, deleted on disable, and may be returned as MCP image content; they are not written to project files or durable Hydra logs.
- Browser-enabled calls use one-shot process transport even if the experimental persistent Terminal Bridge is selected, because that bridge deliberately does not serialize child environment secrets.

## Consequences

### Positive

- The browser is genuinely native, interactive, and visible inside VS Code.
- Hydra ships no Chromium binary, Playwright runtime, browser profile manager, or remote-page renderer.
- Codex and Claude receive the same structured MCP tools automatically, with a Node-based CLI escape hatch for compatible local heads.
- VS Code retains browser isolation, auth/tab sharing, permission prompts, remote-workspace proxying, and enterprise network policy.
- All private VS Code details are isolated in one feature-detected adapter.

### Negative

- Deep control is available only when the current VS Code build registers agentic browser tools (1.127+ in the initial implementation and dependent on browser/chat tool availability).
- Tool IDs and schemas are not a promised compatibility surface even though `lm.invokeTool` is public. Hydra filters every input through a fixed operation allowlist and hides a tool when its core schema is incompatible.
- The MCP injection syntax is vendor-specific at the process boundary and needs regression tests against supported Codex and Claude CLI versions.
- Existing signed-in tabs are intentionally not inherited; users reopen the destination through Hydra after enabling control to create an isolated controllable tab.

## Alternatives considered

- **Iframe the destination in the room webview:** rejected because framing policies, CSP, and cross-origin isolation make it unreliable and uncontrollable.
- **Use only VS Code's browser-open command:** useful fallback for user browsing, but it provides no page handle or DOM/screenshot control.
- **Dedicated Chromium + CDP/Playwright sidecar:** viable fallback if the native tools disappear, but adds browser discovery/profile lifecycle, a renderer, package/runtime weight, and a larger security boundary.
- **Debugger (`editor-browser`) automation:** supported for launch/attach, but DOM control would depend on debugger-adapter-specific requests and is more brittle than `lm.invokeTool`.
- **Fork Code - OSS now:** deferred; technically possible and MIT-compatible, but a distribution-scale commitment rather than a feature-sized change.

## Validation

- Unit-test URL normalization, request validation, CLI parsing, page-ID extraction, MCP argument shaping, and page-ownership rejection.
- Contract-test command registration, Command Center/webview wiring, session-only enablement, loopback-only binding, environment-only token handling, and absence of browser data from `.hydra`.
- Runtime-spike discovery plus `open -> read -> type -> click -> read -> screenshot` against the current VS Code extension host, without a paid model call.
- Manually verify the session consent modal, per-action **Allow Once** prompts, status-bar kill switch, isolated and Hydra-shared tabs, MCP discovery in Codex and Claude, and clean degradation on a build without agentic tools.

## Rollout and rollback

The server starts only after consent and stops when control is disabled or the extension host disposes. With control off, Hydra still opens the Integrated Browser for manual use and injects no token, MCP server, CLI path, or prompt capability. Removing broker registration and the two commands fully rolls back the feature; there is no workspace-state migration.

## Source anchors

- VS Code Integrated Browser: https://code.visualstudio.com/docs/debugtest/integrated-browser
- VS Code 1.127 browser-tool release: https://code.visualstudio.com/updates/v1_127
- Stable language-model tool API: https://code.visualstudio.com/api/references/vscode-api#lm
- Code - OSS repository and MIT license: https://github.com/microsoft/vscode
- Model Context Protocol Streamable HTTP transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
