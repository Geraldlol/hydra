const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(__dirname, "..", "skills", "hydra-handoff", "SKILL.md");
if (!fs.existsSync(source)) {
  console.error(`Cannot find skill source: ${source}`);
  process.exit(1);
}

const targets = [
  path.join(os.homedir(), ".claude", "skills", "hydra-handoff", "SKILL.md"),
  path.join(os.homedir(), ".codex", "skills", "hydra-handoff", "SKILL.md"),
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`Installed ${target}`);
}
