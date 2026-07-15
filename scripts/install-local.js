const fs = require("node:fs");
const path = require("node:path");
const { findOnPath, spawnCommandSync } = require("./platform-command");

const extensionPath = path.resolve(__dirname, "..");
const skipPackage = process.argv.includes("--skip-package");

if (!skipPackage) {
  runCommand(resolvePnpmCommand(), ["run", "package"]);
}

const vsixPath = newestVsix(extensionPath);
if (!vsixPath) {
  console.error("No .vsix found. Run pnpm run package first, or rerun without --skip-package.");
  process.exit(1);
}

const codeCmd = resolveCodeCommand();
const installArgs = [
  ...optionalDirArgs("--user-data-dir", process.env.HYDRA_VSCODE_USER_DATA_DIR),
  ...optionalDirArgs("--extensions-dir", process.env.HYDRA_VSCODE_EXTENSIONS_DIR),
  "--install-extension",
  vsixPath,
  "--force",
];
runCommand(codeCmd, installArgs);
console.log(`Installed ${path.basename(vsixPath)} into VS Code.`);

function newestVsix(root) {
  return fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".vsix"))
    .map((name) => {
      const filePath = path.join(root, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || "";
}

function runCommand(command, args) {
  const result = spawnCommandSync(command, args, {
    cwd: extensionPath,
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function optionalDirArgs(flag, dirPath) {
  if (!dirPath) return [];
  fs.mkdirSync(dirPath, { recursive: true });
  return [flag, path.resolve(dirPath)];
}

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

function resolvePnpmCommand() {
  // Why: the repo uses pnpm via Corepack (see packageManager in package.json).
  // Shelling out to npm here would defeat the version pin and break on machines
  // that only have pnpm via Corepack with no global npm install.
  const fromPath = findOnPath(process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  if (fromPath) return fromPath;

  console.error("Could not find pnpm. Enable Corepack (`corepack enable`) or install pnpm globally, or run with --skip-package to reuse an existing .vsix.");
  process.exit(1);
}
