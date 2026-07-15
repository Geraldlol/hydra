const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let invocationSequence = 0;

function isWindowsBatchCommand(command, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

/**
 * Escape a value that will be expanded from an environment variable inside a
 * quoted cmd.exe argument.
 *
 * Passing the value through one percent-variable expansion (with delayed
 * expansion disabled) prevents %, !, and shell metacharacters in a path from
 * being interpreted as a second command. Doubling embedded quotes preserves
 * them without allowing them to break out of the surrounding quoted argument.
 */
function escapeCmdEnvironmentValue(value) {
  return value.replace(/"/g, '""');
}

function windowsCommandProcessor(env = process.env) {
  const systemRoot = env.SystemRoot || env.WINDIR;
  if (systemRoot && path.win32.isAbsolute(systemRoot)) {
    return path.win32.join(systemRoot, "System32", "cmd.exe");
  }

  const comspec = env.ComSpec || env.COMSPEC;
  if (comspec && path.win32.isAbsolute(comspec)) return comspec;

  // Windows normally defines SystemRoot. This absolute fallback fails safely
  // on unusual installations instead of searching the workspace for cmd.exe.
  return "C:\\Windows\\System32\\cmd.exe";
}

function commandInvocation(command, args, options = {}) {
  const platform = options.platform || process.platform;
  const baseEnv = options.env || process.env;
  if (!isWindowsBatchCommand(command, platform)) {
    return { command, args, env: options.env, windowsVerbatimArguments: false };
  }

  // Node's CVE-2024-27980 mitigation intentionally refuses to spawn batch
  // files directly. Use cmd.exe without `shell: true`, and expand the command
  // plus its arguments from uniquely named environment variables. Expansion
  // is single-pass, so values such as `%PATH%` stay literal rather than being
  // expanded a second time.
  const variablePrefix = options.variablePrefix
    || `__HYDRA_COMMAND_${process.pid}_${++invocationSequence}`;
  const values = [command, ...args];
  const env = { ...baseEnv };
  const references = values.map((value, index) => {
    const name = `${variablePrefix}_${index}`;
    env[name] = escapeCmdEnvironmentValue(value);
    return `"%${name}%"`;
  });
  const line = references.join(" ");
  return {
    command: windowsCommandProcessor(env),
    args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
    env,
    windowsVerbatimArguments: true,
  };
}

function spawnCommand(command, args, options = {}) {
  const invocation = commandInvocation(command, args, { env: options.env });
  return cp.spawn(invocation.command, invocation.args, {
    ...options,
    env: invocation.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

function spawnCommandSync(command, args, options = {}) {
  const invocation = commandInvocation(command, args, { env: options.env });
  return cp.spawnSync(invocation.command, invocation.args, {
    ...options,
    env: invocation.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

function findOnPath(command, env = process.env, platform = process.platform) {
  const pathValue = env.PATH || env.Path || "";
  const delimiter = platform === "win32" ? ";" : ":";
  const executableExtensions = platform === "win32"
    ? windowsExtensions(command, env.PATHEXT)
    : [""];

  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    // Empty and relative PATH entries search the current workspace. Ignore
    // them so a repository cannot replace `code`, `pnpm`, or a system tool.
    if (!directory || !isAbsoluteForPlatform(directory, platform)) continue;

    for (const extension of executableExtensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return "";
}

function windowsExtensions(command, pathExt) {
  if (path.win32.extname(command)) return [""];
  return (pathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
}

function isAbsoluteForPlatform(value, platform) {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function isExecutableFile(candidate, platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  commandInvocation,
  escapeCmdEnvironmentValue,
  findOnPath,
  isWindowsBatchCommand,
  spawnCommand,
  spawnCommandSync,
  windowsCommandProcessor,
};
