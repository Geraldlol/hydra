const fs = require("node:fs");
const path = require("node:path");
const { findOnPath, spawnCommand } = require("./platform-command");

const extensionPath = path.resolve(__dirname, "..");
// The extension is the repo root, so open it as its own dev workspace by
// default. Override via DEV_HOST_WORKSPACE to test against a different folder.
const workspacePath = process.env.DEV_HOST_WORKSPACE
  ? path.resolve(process.env.DEV_HOST_WORKSPACE)
  : extensionPath;
const codeCmd = resolveCodeCommand();

const child = spawnCommand(
  codeCmd,
  [
    "--new-window",
    "--extensionDevelopmentPath",
    extensionPath,
    workspacePath,
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
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);

  const fromPath = findOnPath(process.platform === "win32" ? "code.cmd" : "code");
  if (fromPath) return fromPath;

  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
        "C:\\Program Files\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd",
        ...(localAppData
          ? [
              path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
              path.join(localAppData, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"),
            ]
          : []),
      ]
    : [
        "/usr/local/bin/code",
        "/usr/bin/code",
        "/opt/visual-studio-code/bin/code",
        "/snap/bin/code",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
      ];

  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    console.error("Could not find the VS Code CLI. Set VSCODE_CLI to its executable path or run this from a shell where code is on PATH.");
    process.exit(1);
  }
  return found;
}
