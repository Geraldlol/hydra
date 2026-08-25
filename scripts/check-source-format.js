const fs = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const ROOT_FILES = [
  ".editorconfig",
  ".gitignore",
  ".vscodeignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  "SUPPORT.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
];
const ROOT_DIRECTORIES = [".github", "docs", "scripts", "skills", "src", "tasks", "test"];
const TEXT_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".ts", ".txt", ".yaml", ".yml",
]);
const MAX_FILES = 10_000;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

async function main() {
  const candidates = [];
  for (const file of ROOT_FILES) {
    if (await exists(file)) candidates.push(file);
  }
  for (const directory of ROOT_DIRECTORIES) {
    if (await exists(directory)) await collect(directory, candidates);
  }
  candidates.sort((left, right) => left.localeCompare(right));
  if (candidates.length > MAX_FILES) throw new Error("Source-format file count exceeds its bound.");

  const issues = [];
  for (const file of candidates) {
    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)
      && !ROOT_FILES.includes(file.replace(/\\/g, "/"))) continue;
    const bytes = await fs.readFile(file);
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      issues.push(`${file}: exceeds ${MAX_TEXT_BYTES} text bytes`);
      continue;
    }
    let text;
    try {
      text = UTF8.decode(bytes);
    } catch {
      issues.push(`${file}: is not valid UTF-8`);
      continue;
    }
    if (text.startsWith("\uFEFF")) issues.push(`${file}: starts with a UTF-8 BOM`);
    if (text.includes("\u0000")) issues.push(`${file}: contains a NUL byte`);
    if (text.length > 0 && !text.endsWith("\n")) issues.push(`${file}: lacks a final newline`);
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/[ \t]+$/u.test(line)) issues.push(`${file}:${index + 1}: trailing whitespace`);
      if (line.includes("\t")) issues.push(`${file}:${index + 1}: tab indentation/content`);
      if (/^(?:<{7}|={7}|>{7})(?:\s|$)/u.test(line)) {
        issues.push(`${file}:${index + 1}: unresolved conflict marker`);
      }
    }
  }
  if (issues.length > 0) {
    throw new Error(`Source-format check failed:\n${issues.slice(0, 100).map((issue) => `- ${issue}`).join("\n")}`);
  }
  console.log(`Source-format check passed for ${candidates.length} bounded files.`);
}

async function collect(directory, output) {
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    const candidate = path.join(directory, entry.name);
    if (candidate.includes(`${path.sep}fixtures${path.sep}`)) continue;
    if (candidate.startsWith(path.join("docs", "native-internals") + path.sep)
      && path.extname(candidate).toLowerCase() === ".txt") continue;
    if (entry.isSymbolicLink()) throw new Error(`Source-format root contains a symbolic link: ${candidate}`);
    if (entry.isDirectory()) {
      await collect(candidate, output);
    } else if (entry.isFile()) {
      output.push(candidate);
    }
    if (output.length > MAX_FILES) throw new Error("Source-format file count exceeds its bound.");
  }
}

async function exists(candidate) {
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error(`Source-format path is linked: ${candidate}`);
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
