import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadCodexModelsSnapshot,
  MAX_CODEX_DEBUG_MODELS_STDERR_BYTES,
  MAX_CODEX_DEBUG_MODELS_STDOUT_BYTES,
  MAX_CODEX_MODELS_SNAPSHOT_BYTES,
  parseCodexDebugModels,
  runCodexDebugModels,
} from "../src/codexModels";

describe("parseCodexDebugModels", () => {
  test("extracts slug + display + reasoning + API support, drops base_instructions blob", () => {
    const json = JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Frontier model for complex coding.",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "fast" },
            { effort: "medium", description: "balanced" },
            { effort: "high", description: "deep" },
            { effort: "xhigh", description: "deepest" },
          ],
          supported_in_api: true,
          visibility: "list",
          base_instructions: "x".repeat(10_000),
          availability_nux: { message: "y".repeat(5_000) },
        },
        {
          slug: "gpt-5.3-codex-spark",
          display_name: "GPT-5.3-Codex-Spark",
          default_reasoning_level: "high",
          supported_reasoning_levels: [{ effort: "high" }],
          supported_in_api: false,
          visibility: "list",
        },
        {
          slug: "hidden-internal-model",
          display_name: "Hidden",
          supported_in_api: true,
          visibility: "hidden",
        },
      ],
    });
    const models = parseCodexDebugModels(json);
    assert.equal(models.length, 3);
    const flagship = models.find((m) => m.slug === "gpt-5.5");
    assert.ok(flagship);
    assert.equal(flagship!.displayName, "GPT-5.5");
    assert.equal(flagship!.defaultReasoning, "medium");
    assert.deepEqual(flagship!.reasoningLevels, ["low", "medium", "high", "xhigh"]);
    assert.equal(flagship!.supportedInApi, true);
    assert.equal(flagship!.visibility, "list");
    // Make sure we didn't carry the giant blobs into the parsed shape.
    assert.equal((flagship as unknown as { base_instructions?: unknown }).base_instructions, undefined);
    assert.equal((flagship as unknown as { availability_nux?: unknown }).availability_nux, undefined);

    const spark = models.find((m) => m.slug === "gpt-5.3-codex-spark");
    assert.ok(spark);
    assert.equal(spark!.supportedInApi, false);

    const hidden = models.find((m) => m.slug === "hidden-internal-model");
    assert.ok(hidden);
    assert.equal(hidden!.visibility, "hidden");
  });

  test("returns [] on malformed input rather than throwing", () => {
    assert.deepEqual(parseCodexDebugModels(""), []);
    assert.deepEqual(parseCodexDebugModels("not json"), []);
    assert.deepEqual(parseCodexDebugModels("{}"), []);
    assert.deepEqual(parseCodexDebugModels('{"models":"oops"}'), []);
    assert.deepEqual(parseCodexDebugModels('{"models":[{}]}'), []);
  });

  test("defaults supportedInApi to true and visibility to list when the CLI omits them", () => {
    const json = JSON.stringify({
      models: [{ slug: "gpt-test", display_name: "Test" }],
    });
    const [m] = parseCodexDebugModels(json);
    assert.ok(m);
    assert.equal(m.supportedInApi, true);
    assert.equal(m.visibility, "list");
    assert.deepEqual(m.reasoningLevels, []);
  });
});

describe("runCodexDebugModels", () => {
  test("parses a valid bounded CLI response", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-fake-codex-valid-"));
    const command = await fakeCodexCommand(
      dir,
      `process.stdout.write(JSON.stringify({ models: [{ slug: "gpt-test", display_name: "Test" }] }));`
    );
    const models = await runCodexDebugModels(command, { ...process.env });
    assert.deepEqual(models.map((model) => model.slug), ["gpt-test"]);
  });

  test("rejects a zero-exit response that is not valid model JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-fake-codex-"));
    const command = await fakeCodexCommand(dir, 'process.stdout.write("not json");');
    await assert.rejects(
      runCodexDebugModels(command, { ...process.env }),
      /returned invalid JSON/
    );
  });

  test("rejects stdout and stderr that exceed their protocol caps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-fake-codex-cap-"));
    const stdoutCommand = await fakeCodexCommand(
      dir,
      `process.stdout.write("x".repeat(${MAX_CODEX_DEBUG_MODELS_STDOUT_BYTES + 1}));`,
      "stdout"
    );
    await assert.rejects(
      runCodexDebugModels(stdoutCommand, { ...process.env }),
      /stdout exceeded the \d+-byte limit/
    );

    const stderrCommand = await fakeCodexCommand(
      dir,
      `process.stderr.write("x".repeat(${MAX_CODEX_DEBUG_MODELS_STDERR_BYTES + 1})); setTimeout(() => {}, 1000);`,
      "stderr"
    );
    await assert.rejects(
      runCodexDebugModels(stderrCommand, { ...process.env }),
      /stderr exceeded the \d+-byte limit/
    );
  });

  test("timeout kills a model-discovery grandchild before rejecting", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-model-tree-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const grandchildCode = "setInterval(() => {}, 1000);";
    const command = await fakeCodexCommand(
      dir,
      [
        'const cp = require("node:child_process");',
        'const fs = require("node:fs");',
        `const child = cp.spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "tree"
    );

    await assert.rejects(
      runCodexDebugModels(command, { ...process.env }, 150),
      /timed out after 150ms/
    );
    const grandchildPid = Number(await fs.readFile(pidFile, "utf8"));
    assert.equal(Number.isInteger(grandchildPid) && grandchildPid > 0, true);
    assert.equal(await waitForProcessExit(grandchildPid), true, "grandchild remained alive after model discovery rejected");
  });

  test("refuses an oversized cached model snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-model-cache-"));
    const file = path.join(dir, "models.json");
    await fs.writeFile(
      file,
      JSON.stringify({ models: [], padding: "x".repeat(MAX_CODEX_MODELS_SNAPSHOT_BYTES) }),
      "utf8"
    );
    assert.equal(await loadCodexModelsSnapshot(file), undefined);
  });
});

async function fakeCodexCommand(dir: string, javascript: string, name = "fake"): Promise<string> {
  const scriptPath = path.join(dir, `${name}.js`);
  await fs.writeFile(scriptPath, javascript, "utf8");
  if (process.platform === "win32") {
    const commandPath = path.join(dir, `${name}.cmd`);
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }
  const commandPath = path.join(dir, name);
  const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
  await fs.writeFile(commandPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited between the final probe and cleanup.
  }
  return false;
}
