// Mock CLI for agent runner tests.
// Usage:
//   node mock-cli.js --emit "foo" "bar"      # stream chunks then exit 0
//   node mock-cli.js --delay 50 --emit "x"   # wait 50ms between chunks
//   node mock-cli.js --hang                  # never exit (test cancellation)
//   node mock-cli.js --fail                  # exit code 1
const args = process.argv.slice(2);
const chunks = [];
let delay = 0;
let hang = false;
let fail = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--emit") {
    while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      chunks.push(args[++i]);
    }
  } else if (args[i] === "--delay") {
    delay = parseInt(args[++i], 10);
  } else if (args[i] === "--hang") {
    hang = true;
  } else if (args[i] === "--fail") {
    fail = true;
  }
}

(async () => {
  for (const chunk of chunks) {
    process.stdout.write(chunk);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  if (hang) {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(fail ? 1 : 0);
})();
