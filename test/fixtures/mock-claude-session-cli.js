"use strict";

const readline = require("node:readline");

const scenario = process.env.HYDRA_MOCK_CLAUDE_SCENARIO || "normal";
const argv = process.argv.slice(2);
const required = [
  ["--input-format", "stream-json"],
  ["--output-format", "stream-json"],
];

for (const [flag, value] of required) {
  const index = argv.indexOf(flag);
  const inline = argv.find((arg) => arg === `${flag}=${value}`);
  if (!inline && (index < 0 || argv[index + 1] !== value)) {
    process.stderr.write(`missing ${flag} ${value}\n`);
    process.exit(64);
  }
}
if (!argv.includes("-p") && !argv.includes("--print")) {
  process.stderr.write("missing print mode\n");
  process.exit(64);
}
if (!argv.includes("--verbose") || !argv.includes("--replay-user-messages")) {
  process.stderr.write("missing verbose/replay flags\n");
  process.exit(64);
}

const providerSessionId = "11111111-1111-4111-8111-111111111111";
let uuidCounter = 1;
let inputIndex = 0;
let initialized = false;
let pumping = false;
let inputEnded = false;
const results = [];

function uuid() {
  const suffix = String(uuidCounter++).padStart(12, "0");
  return `22222222-2222-4222-8222-${suffix}`;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitInit() {
  if (initialized) return;
  initialized = true;
  const init = {
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: providerSessionId,
    capabilities: scenario === "old-version" ? [] : ["interrupt_receipt_v1", "msg_lifecycle_v1"],
    fixture_args: argv,
    uuid: uuid(),
  };
  if (scenario !== "capability-no-version") {
    init.claude_code_version = scenario === "old-version" ? "2.1.204" : "2.1.218";
  }
  if (scenario === "malformed-capabilities") init.capabilities = ["msg_lifecycle_v1", "msg_lifecycle_v1"];
  if (scenario === "wrong-cwd") init.cwd = `${process.cwd()}-other`;
  emit(init);
}

function replay(input, index) {
  const content = scenario === "mismatched-replay" && index === 2
    ? `${input.message.content}-changed`
    : input.message.content;
  emit({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: scenario === "wrong-session" && index === 2
      ? "33333333-3333-4333-8333-333333333333"
      : providerSessionId,
    isReplay: true,
    uuid: input.uuid,
  });
}

function enqueueResult(input, index) {
  results.push({ input, index });
  pumpResults();
}

function pumpResults() {
  if (pumping || results.length === 0) {
    maybeExit();
    return;
  }
  pumping = true;
  const current = results.shift();
  const delay = current.index === 1 ? 100 : 15;
  setTimeout(() => {
    const text = `reply:${current.input.message.content}`;
    emit({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
      session_id: providerSessionId,
      uuid: uuid(),
    });
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: current.index * 10,
      duration_api_ms: current.index * 5,
      num_turns: current.index,
      result: text,
      session_id: providerSessionId,
      total_cost_usd: current.index / 100,
      usage: {
        input_tokens: current.index,
        output_tokens: current.index * 2,
        cache_read_input_tokens: current.index * 3,
        server_tool_use: { web_search_requests: current.index },
        service_tier: "standard",
      },
      modelUsage: {
        "claude-mock": {
          inputTokens: current.index,
          outputTokens: current.index * 2,
          cacheReadInputTokens: current.index * 3,
          cacheCreationInputTokens: current.index * 4,
          webSearchRequests: current.index,
          costUSD: current.index / 100,
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
      },
      permission_denials: [],
      stop_reason: "end_turn",
      terminal_reason: "completed",
      uuid: uuid(),
    };
    if (scenario === "malformed-result") delete result.uuid;
    if (scenario === "error-result" && current.index === 2) {
      result.subtype = "error_during_execution";
      result.is_error = true;
      result.terminal_reason = "api_error";
      result.errors = ["fixture execution error"];
      delete result.result;
    }
    emit(result);
    if (scenario === "duplicate-result" && current.index === 1) emit(result);
    pumping = false;
    pumpResults();
  }, delay);
}

function maybeExit() {
  if (!inputEnded || pumping || results.length > 0) return;
  process.exit(0);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (line) => {
  if (!line.trim()) return;
  let envelope;
  try {
    envelope = JSON.parse(line);
  } catch {
    process.stderr.write("fixture received malformed JSON\n");
    process.exit(65);
    return;
  }
  inputIndex++;
  if (inputIndex === 1 && Object.prototype.hasOwnProperty.call(envelope, "session_id")) {
    process.stderr.write("initial input must omit session_id before init\n");
    process.exit(66);
    return;
  }
  if (inputIndex > 1 && envelope.session_id !== providerSessionId) {
    process.stderr.write("steering input must bind the initialized session_id\n");
    process.exit(66);
    return;
  }
  if (envelope.origin?.kind !== "human") {
    process.stderr.write("Hydra input must carry explicit human origin\n");
    process.exit(66);
    return;
  }
  emitInit();
  if (scenario === "malformed-output" && inputIndex === 1) {
    process.stdout.write("{not-json}\n");
    return;
  }
  if (scenario === "oversized-output" && inputIndex === 1) {
    process.stdout.write(`${"x".repeat(1_000_001)}\n`);
    return;
  }
  if (scenario === "result-before-replay" && inputIndex === 1) {
    enqueueResult(envelope, inputIndex);
    return;
  }
  if (scenario === "no-steering-replay" && inputIndex > 1) return;
  replay(envelope, inputIndex);
  if (scenario === "exit-before-result" && inputIndex === 1) {
    setTimeout(() => process.exit(17), 20);
    return;
  }
  enqueueResult(envelope, inputIndex);
});

input.on("close", () => {
  inputEnded = true;
  maybeExit();
});

process.stdin.on("error", () => {});
