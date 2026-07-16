import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBrowserCliRequest } from "../src/browserCli";
import {
  createSecretStreamRedactor,
  normalizeBrowserUrl,
  parseBrowserBridgeRequest,
  parseBrowserPageId,
  withBrowserMcpArgs,
} from "../src/browserProtocol";

describe("Hydra browser protocol", () => {
  test("normalizes human URLs and rejects local-file schemes", () => {
    assert.equal(normalizeBrowserUrl("example.com/docs"), "https://example.com/docs");
    assert.equal(normalizeBrowserUrl("example.com:8443/docs"), "https://example.com:8443/docs");
    assert.equal(normalizeBrowserUrl("localhost:3000"), "http://localhost:3000");
    assert.equal(normalizeBrowserUrl("127.0.0.1:5173/app"), "http://127.0.0.1:5173/app");
    assert.equal(normalizeBrowserUrl("about:blank"), "about:blank");
    assert.throws(() => normalizeBrowserUrl("file:///etc/passwd"), /http or https/);
  });

  test("rejects link-local metadata hosts and embedded credentials, keeps local dev targets", () => {
    // Loopback / LAN dev servers stay browsable — that is the point of the feature.
    assert.equal(normalizeBrowserUrl("localhost:3000"), "http://localhost:3000");
    assert.equal(normalizeBrowserUrl("127.0.0.1:5173/app"), "http://127.0.0.1:5173/app");
    assert.equal(normalizeBrowserUrl("192.168.1.10:8080"), "https://192.168.1.10:8080");
    // Cloud instance-metadata / link-local space is refused (SSRF-to-credentials sink).
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "open", input: { url: "http://169.254.169.254/latest/meta-data/" } }),
      /link-local or cloud-metadata/,
    );
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "navigate", input: { pageId: "page-1", url: "http://[fe80::1]/" } }),
      /link-local or cloud-metadata/,
    );
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "open", input: { url: "http://[::ffff:169.254.169.254]/" } }),
      /link-local or cloud-metadata/,
    );
    assert.throws(() => normalizeBrowserUrl("169.254.169.254/latest"), /link-local or cloud-metadata/);
    // Credentials in the authority are a leak/phishing vector and never needed.
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "open", input: { url: "https://user:pass@internal.example/" } }),
      /must not embed credentials/,
    );
  });

  test("requires page ownership keys on every page operation", () => {
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "read", input: {} }),
      /requires a valid pageId/,
    );
    assert.deepEqual(
      parseBrowserBridgeRequest({ operation: "read", input: { pageId: "page-1" } }),
      { operation: "read", input: { pageId: "page-1" } },
    );
  });

  test("extracts VS Code's page handle without swallowing the snapshot", () => {
    assert.equal(parseBrowserPageId("Page ID: 6e479140-abcd\n\nSummary:\nbutton"), "6e479140-abcd");
    assert.equal(parseBrowserPageId("no page here"), undefined);
  });

  test("builds ergonomic CLI requests for the common browser actions", () => {
    assert.deepEqual(parseBrowserCliRequest(["open", "https://example.com"]), {
      operation: "open",
      input: { forceNew: true, url: "https://example.com" },
    });
    assert.deepEqual(parseBrowserCliRequest(["navigate", "page-1", "example.com"]), {
      operation: "navigate",
      input: { pageId: "page-1", url: "https://example.com", type: "url" },
    });
    assert.deepEqual(parseBrowserCliRequest(["click", "page-1", "--ref", "e12"]), {
      operation: "click",
      input: { ref: "e12", pageId: "page-1", element: "e12" },
    });
    assert.deepEqual(parseBrowserCliRequest(["type", "page-1", "Hello Hydra", "--submit"]), {
      operation: "type",
      input: { submit: true, pageId: "page-1", text: "Hello Hydra" },
    });
    assert.deepEqual(parseBrowserCliRequest(["open"]), {
      operation: "open",
      input: { url: "about:blank", forceNew: true },
    });
    assert.deepEqual(parseBrowserBridgeRequest({
      operation: "open",
      input: { url: "https://example.com", forceNew: false },
    }), {
      operation: "open",
      input: { url: "https://example.com", forceNew: true },
    });
  });

  test("bounds nested and oversized untrusted request data", () => {
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "open", input: { url: `https://example.com/${"x".repeat(70_000)}` } }),
      /too large|8192/,
    );
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "status", input: { a: { b: { c: { d: { e: { f: { g: true } } } } } } } }),
      /nested too deeply/,
    );
    assert.throws(
      () => parseBrowserBridgeRequest({
        operation: "status",
        input: JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
      }),
      /unsafe object key/,
    );
    assert.throws(
      () => parseBrowserCliRequest(["status", "--constructor", "polluted"]),
      /Unsafe browser CLI flag/,
    );
  });

  test("redacts bearer tokens even when process output splits them across chunks", () => {
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const marker = "[redacted-hydra-browser-token]";
    for (let split = 1; split < secret.length; split += 1) {
      const redactor = createSecretStreamRedactor(() => [secret]);
      const output = [
        redactor.push(`before ${secret.slice(0, split)}`),
        redactor.push(`${secret.slice(split)} after`),
        redactor.flush(),
      ].join("");
      assert.equal(output, `before ${marker} after`, `split at ${split}`);
      assert.equal(output.includes(secret), false);
    }

    const characterRedactor = createSecretStreamRedactor(() => [secret]);
    const output = [...`x${secret}y`].map((character) => characterRedactor.push(character)).join("")
      + characterRedactor.flush();
    assert.equal(output, `x${marker}y`);
  });

  test("keeps local-file selection outside the agent control surface", () => {
    assert.throws(
      () => parseBrowserBridgeRequest({
        operation: "dialog",
        input: { pageId: "page-1", selectFiles: ["C:\\secrets.txt"] },
      }),
      /does not allow agents to select or upload local files/,
    );
    assert.throws(
      () => parseBrowserBridgeRequest({ operation: "click", input: { pageId: "page-1", upload: true } }),
      /Unsupported input field/,
    );
  });

  test("rejects ambiguous browser targets before asking the user to confirm", () => {
    assert.throws(
      () => parseBrowserBridgeRequest({
        operation: "click",
        input: { pageId: "page-1", ref: "e12", selector: "#delete-account", element: "Next" },
      }),
      /either ref or selector/,
    );
    assert.throws(
      () => parseBrowserBridgeRequest({
        operation: "type",
        input: { pageId: "page-1", text: "yes", key: "Enter", element: "Confirmation", ref: "e4" },
      }),
      /text or key/,
    );
  });

  test("injects vendor MCP configuration before stdin without putting the bearer token in argv", () => {
    const endpoint = "http://127.0.0.1:43123/mcp";
    const codex = withBrowserMcpArgs("codex", ["exec", "--json", "-"], endpoint);
    assert.equal(codex.at(-1), "-");
    assert.ok(codex.some((arg) => arg.includes(`url=\"${endpoint}\"`)));
    assert.ok(codex.some((arg) => arg.includes("bearer_token_env_var")));
    assert.equal(codex.some((arg) => arg.includes("secret-token-value")), false);
    const codexCollision = withBrowserMcpArgs("codex", [
      "exec",
      "-c",
      "mcp_servers.hydra_vscode_browser.url=\"http://127.0.0.1:1/wrong\"",
      "-",
    ], endpoint);
    assert.ok(codexCollision.includes(`mcp_servers.hydra_vscode_browser.url=\"${endpoint}\"`));

    const claude = withBrowserMcpArgs("claude", ["-p", "--permission-mode", "acceptEdits"], endpoint);
    const allowedTool = claude[claude.indexOf("--allowedTools") + 1];
    assert.equal(allowedTool, "mcp__hydra_vscode_browser__*");
    const config = claude[claude.indexOf("--mcp-config") + 1];
    assert.ok(config);
    assert.match(config, /Bearer \$\{HYDRA_BROWSER_TOKEN\}/);
    assert.doesNotMatch(config, /secret-token-value/);
    assert.equal(claude.at(-2), "--mcp-config");
    assert.equal(claude.at(-1), config);
    assert.deepEqual(withBrowserMcpArgs("claude", claude, endpoint), claude);
    const claudeCollision = withBrowserMcpArgs("claude", [
      "-p",
      "--mcp-config",
      '{"mcpServers":{"hydra_vscode_browser":{"type":"http","url":"http://127.0.0.1:1/wrong"}}}',
    ], endpoint);
    assert.equal(claudeCollision.at(-2), "--mcp-config");
    assert.match(claudeCollision.at(-1) ?? "", new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const claudeWithDash = withBrowserMcpArgs("claude", ["-p", "-"], endpoint);
    assert.equal(claudeWithDash.at(-2), "--mcp-config");
    assert.match(claudeWithDash.at(-1) ?? "", /hydra_vscode_browser/);
    assert.ok(claudeWithDash.indexOf("-") < claudeWithDash.indexOf("--allowedTools"));

    assert.deepEqual(withBrowserMcpArgs("gemini", ["--prompt"], endpoint), ["--prompt"]);
  });
});
