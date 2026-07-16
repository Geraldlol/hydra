import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { BROWSER_OPERATION_TO_TOOL } from "../src/browserProtocol";

describe("Hydra browser broker security contract", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "browserBroker.ts"), "utf8");
  const panelSource = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

  test("keeps the control bridge loopback-only, origin-fenced, and bearer-authenticated", () => {
    assert.match(source, /server\.listen\(0, "127\.0\.0\.1"/);
    assert.match(source, /if \(request\.headers\.origin\)/);
    assert.match(source, /request\.socket\.remoteAddress/);
    assert.match(source, /header\?\.startsWith\("Bearer "\)/);
    assert.match(source, /crypto\.randomBytes\(32\)\.toString\("base64url"\)/);
  });

  test("requires explicit trusted-session consent and exposes a visible kill switch", () => {
    assert.match(source, /vscode\.workspace\.isTrusted !== true/);
    assert.match(source, /showWarningMessage\([\s\S]*\{ modal: true/);
    assert.match(source, /statusBar\.command = "hydraRoom\.toggleBrowserControl"/);
    assert.match(source, /this\.statusBar\.show\(\)/);
    assert.match(source, /this\.statusBar\.hide\(\)/);
    assert.match(source, /CONFIRMED_INTERACTIONS[\s\S]*"click"[\s\S]*"type"[\s\S]*"dialog"/);
    assert.match(source, /Approve only when this matches your request/);
    assert.match(source, /interactionDetail\(operation, input\)/);
  });

  test("confirms hover and never truncates approved text silently", () => {
    // hover dispatches real pointer events, so it is gated like the other interactions.
    assert.match(source, /CONFIRMED_INTERACTIONS = new Set<BrowserOperation>\(\[[^\]]*"hover"/);
    // The consent modal must reveal the true executed length of any long payload.
    assert.match(source, /characters total will be sent/);
    assert.match(source, /return value\.length > 180/);
  });

  test("stores screenshots privately and does not expose raw Playwright execution", () => {
    assert.match(source, /context\.globalStorageUri\.fsPath/);
    assert.doesNotMatch(source, /this\.workspaceRoot/);
    assert.equal("run" in BROWSER_OPERATION_TO_TOOL, false);
    assert.equal(Object.values(BROWSER_OPERATION_TO_TOOL).includes("run_playwright_code" as never), false);
    assert.match(source, /MAX_SCREENSHOT_SESSION_BYTES/);
    assert.match(source, /hydra-\$\{process\.pid\}-\$\{crypto\.randomUUID\(\)\}/);
    assert.match(source, /initializeScreenshotStorage/);
    assert.match(source, /screenshotQueue/);
    assert.match(source, /enqueueScreenshotTask/);
  });

  test("fails closed across native API drift, queue races, and transport boundaries", () => {
    assert.match(source, /MCP_PROTOCOL_VERSION = "2025-11-25"/);
    assert.match(source, /isCompatibleBrowserToolSchema/);
    assert.match(source, /requestEpoch !== this\.controlEpoch/);
    assert.match(source, /MAX_PENDING_BROWSER_INVOCATIONS/);
    assert.match(source, /BROWSER_INVOCATION_TIMEOUT_MS/);
    assert.match(source, /runtime\.hasError !== true/);
    assert.match(source, /notifications\/cancelled/);
    assert.match(source, /mcpRequestCancellations/);
    assert.match(source, /const invocation = await this\.enqueueInvocation\(async \(\) => \{[\s\S]*await this\.confirmInteraction/);
    assert.match(source, /Promise\.race\(\[confirmation, cancelled, timedOut\]\)/);
    assert.match(panelSource, /browserRequiresOneShot = !!spawn\.env\?\.HYDRA_BROWSER_TOKEN/);
  });

  test("redacts and revokes per-dispatch browser bearer tokens", () => {
    assert.match(source, /revokeAgentSpawn/);
    assert.match(source, /cancellationsByToken/);
    assert.match(source, /This browser dispatch token was revoked/);
    assert.match(source, /\[redacted-hydra-browser-token\]/);
    assert.match(panelSource, /createAgentOutputRedactor\(agent\)/);
    assert.match(panelSource, /browserRedactor\?\.flush\(\)/);
    assert.match(panelSource, /redactAgentResult\(agent, rawResult\)/);
    assert.match(panelSource, /revokeAgentSpawn\(dispatch\.spawn\)/);
    const issueStart = source.indexOf("private issueToken(");
    const revokeStart = source.indexOf("private revokeToken(", issueStart);
    assert.ok(issueStart >= 0 && revokeStart > issueStart);
    const issue = source.slice(issueStart, revokeStart);
    assert.doesNotMatch(issue, /owner === agent[\s\S]*revokeToken/);
    assert.match(issue, /!this\.tokens\.has\(candidate\)/);
  });

  test("keeps prompt previews non-authorizing and shows the operative action", () => {
    const previewStart = panelSource.indexOf("private async buildPromptEnvelope(");
    const previewEnd = panelSource.indexOf("private async nativeCapabilityPromptContext(", previewStart);
    assert.ok(previewStart >= 0 && previewEnd > previewStart);
    const preview = panelSource.slice(previewStart, previewEnd);
    assert.match(preview, /previewAgentSpawn/);
    assert.doesNotMatch(preview, /prepareAgentSpawn/);
    assert.match(source, /Page ID:/);
    assert.match(source, /Reference:/);
    assert.match(source, /Selector:/);
    assert.match(source, /Submit with Enter:/);
    assert.match(source, /Double click:/);
    assert.match(source, /Button:/);
  });
});
