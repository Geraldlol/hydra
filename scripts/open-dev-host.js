const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const extensionPath = path.resolve(__dirname, "..");
// Hydra used to live at <Spireslap>/tools/vscode-hydra-room, where the
// dev-host workspace was the Spireslap repo root two levels up. Since
// the standalone Hydra pull, the extension IS the repo root, so we
// open it as its own dev workspace (.hydra/ already lives here).
// Override via DEV_HOST_WORKSPACE if you want to test against a
// different folder.
const workspacePath = process.env.DEV_HOST_WORKSPACE
  ? path.resolve(process.env.DEV_HOST_WORKSPACE)
  : extensionPath;
const codeCmd = resolveCodeCommand();

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

const child = cp.spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `& ${psQuote(codeCmd)} --new-window --extensionDevelopmentPath ${psQuote(extensionPath)} ${psQuote(workspacePath)}`,
  ],
  {
    env: {
      ...process.env,
      HYDRA_WORKSPACE_ROOT: workspacePath,
    },
    stdio: "inherit",
    windowsHide: false,
  }
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});

function resolveCodeCommand() {
  const fromEnv = process.env.VSCODE_CLI || process.env.CODE_CMD;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const fromPath = firstWhere(process.platform === "win32" ? "code.cmd" : "code");
  if (fromPath) return fromPath;

  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
        "C:\\Program Files\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd",
        path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
        path.join(localAppData, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"),
      ]
    : ["/usr/local/bin/code", "/opt/visual-studio-code/bin/code"];

  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    console.error("Could not find the VS Code CLI. Set VSCODE_CLI to code.cmd or run this from a shell where code is on PATH.");
    process.exit(1);
  }
  return found;
}

function firstWhere(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = cp.spawnSync(lookup, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "";
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}
