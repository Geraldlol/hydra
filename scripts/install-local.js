const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const extensionPath = path.resolve(__dirname, "..");
const skipPackage = process.argv.includes("--skip-package");

if (!skipPackage) {
  runPowerShell(`& ${psQuote(resolveNpmCommand())} run package`);
}

const vsixPath = newestVsix(extensionPath);
if (!vsixPath) {
  console.error("No .vsix found. Run npm run package first, or rerun without --skip-package.");
  process.exit(1);
}

const codeCmd = resolveCodeCommand();
const installArgs = [
  optionalDirArg("--user-data-dir", process.env.HYDRA_VSCODE_USER_DATA_DIR),
  optionalDirArg("--extensions-dir", process.env.HYDRA_VSCODE_EXTENSIONS_DIR),
  `--install-extension ${psQuote(vsixPath)}`,
  "--force",
].filter(Boolean);
runPowerShell(`& ${psQuote(codeCmd)} ${installArgs.join(" ")}`);
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

function runPowerShell(command) {
  const result = cp.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: extensionPath, stdio: "inherit", windowsHide: false }
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function optionalDirArg(flag, dirPath) {
  if (!dirPath) return "";
  fs.mkdirSync(dirPath, { recursive: true });
  return `${flag} ${psQuote(path.resolve(dirPath))}`;
}

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

function resolveNpmCommand() {
  const fromPath = firstWhere(process.platform === "win32" ? "npm.cmd" : "npm");
  if (fromPath) return fromPath;

  const programFiles = process.env.ProgramFiles || "";
  const nodePath = programFiles ? path.join(programFiles, "nodejs", "npm.cmd") : "";
  if (nodePath && fs.existsSync(nodePath)) return nodePath;

  console.error("Could not find npm. Install Node.js or run with --skip-package to reuse an existing .vsix.");
  process.exit(1);
}

function firstWhere(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = cp.spawnSync(lookup, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "";
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}
