import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  label: "extensionHost",
  files: "test/integration/**/*.test.js",
  version: "1.120.0",
  extensionDevelopmentPath: repoRoot,
  workspaceFolder: path.join(repoRoot, "test", "fixtures", "extension-host-workspace"),
  launchArgs: [
    "--disable-extensions",
    "--disable-workspace-trust",
    "--disable-gpu",
    "--disable-telemetry",
  ],
  mocha: {
    ui: "tdd",
    timeout: 30_000,
  },
});
