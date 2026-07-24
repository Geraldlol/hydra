"use strict";

// A deliberately tiny Codex App Server v2 stand-in. It exercises Hydra's
// JSONL request/response ordering without depending on an installed Codex CLI
// or spending model credits.
const fs = require("node:fs");
const readline = require("node:readline");

const mode = process.env.HYDRA_FAKE_CODEX_MODE || "normal";
const logPath = process.env.HYDRA_FAKE_CODEX_LOG;
let initialPrompt = "";
let activeTurnId = "turn-1";

function record(message) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(message)}\n`, "utf8");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendBatch(messages) {
  process.stdout.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
}

function sandboxResult(sandbox) {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return { type: "unknown" };
  }
}

function completionMessages(steeringText) {
  const text = `initial=${initialPrompt}; steer=${steeringText}`;
  return [
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: activeTurnId,
        itemId: "message-1",
        delta: text,
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: activeTurnId,
        item: { id: "message-1", type: "agentMessage", text },
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: activeTurnId,
        tokenUsage: {
          total: {
            inputTokens: 11,
            cachedInputTokens: 3,
            outputTokens: 7,
            reasoningOutputTokens: 2,
            totalTokens: 20,
          },
          last: {
            inputTokens: 11,
            cachedInputTokens: 3,
            outputTokens: 7,
            reasoningOutputTokens: 2,
            totalTokens: 20,
          },
        },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: activeTurnId, status: "completed", items: [] },
      },
    },
  ];
}

function completeTurn(steeringText) {
  if (mode === "many-deltas") {
    const delta = "abcdefgh";
    const deltaCount = 4096;
    for (let index = 0; index < deltaCount; index++) {
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: activeTurnId,
          itemId: "message-1",
          delta,
        },
      });
    }
    const completed = {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: activeTurnId,
        item: {
          id: "message-1",
          type: "agentMessage",
          text: delta.repeat(deltaCount),
        },
      },
    };
    send(completed);
    for (const message of completionMessages(steeringText).slice(2)) send(message);
    return;
  }
  for (const message of completionMessages(steeringText)) send(message);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (line) => {
  if (!line) return;
  const message = JSON.parse(line);
  record(message);

  if (
    mode === "string-server-request"
    && message.id === "approval-request-1"
    && message.error
  ) {
    completeTurn("");
    return;
  }

  if (message.method === "initialize") {
    const initializeResponse = {
      id: message.id,
      result: {
        userAgent: mode === "old-version"
          ? "fake-codex-app-server/0.143.9"
          : "fake-codex-app-server/0.144.1",
        codexHome: "fake",
        platformFamily: process.platform,
        platformOs: process.platform,
      },
    };
    if (mode === "delayed-initialize") {
      setTimeout(() => send(initializeResponse), 250);
    } else {
      send(initializeResponse);
    }
    return;
  }

  if (message.method === "initialized") return;

  if (message.method === "thread/start") {
    const params = message.params || {};
    send({
      id: message.id,
      result: {
        thread: { id: "thread-1", ephemeral: params.ephemeral },
        model: params.model || "fake-model",
        cwd: mode === "mismatched-cwd" ? `${params.cwd}-mismatch` : params.cwd,
        approvalPolicy: params.approvalPolicy,
        sandbox: sandboxResult(params.sandbox),
      },
    });
    setImmediate(() => {
      send({
        method: "thread/started",
        params: { thread: { id: "thread-1" } },
      });
    });
    return;
  }

  if (message.method === "turn/start") {
    const params = message.params || {};
    const firstInput = Array.isArray(params.input) ? params.input[0] : undefined;
    initialPrompt = firstInput && typeof firstInput.text === "string" ? firstInput.text : "";
    activeTurnId = "turn-1";
    if (mode === "exit-after-turn-start") {
      process.exit(17);
      return;
    }
    if (mode === "exit-zero-after-turn-start") {
      process.exit(0);
      return;
    }
    if (mode === "malformed-turn-start") {
      send({ id: message.id, result: { turn: {} } });
      return;
    }
    const started = {
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: activeTurnId, status: "inProgress", items: [] },
      },
    };
    const itemStarted = {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: activeTurnId,
        item: { id: "message-1", type: "agentMessage", text: "" },
      },
    };
    if (mode === "batched-start-and-complete") {
      sendBatch([
        { id: message.id, result: { turn: { id: activeTurnId } } },
        started,
        itemStarted,
        ...completionMessages(""),
      ]);
      return;
    }
    send({ id: message.id, result: { turn: { id: activeTurnId } } });
    // A separate event-loop turn models a provider that flushes its response
    // before notifications. A dedicated regression mode below intentionally
    // batches them to expose ordering bugs in the client.
    setImmediate(() => {
      send(started);
      send(itemStarted);
      if (mode === "string-server-request") {
        send({
          id: "approval-request-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: activeTurnId,
            itemId: "command-1",
          },
        });
      }
      if (mode === "many-deltas") {
        // Keep the flood outside the turn/start response chunk so the client
        // has established its exact thread/turn binding before deltas arrive.
        setTimeout(() => completeTurn(""), 20);
      } else if (mode === "complete-without-steer") {
        completeTurn("");
      }
    });
    return;
  }

  if (message.method === "turn/steer") {
    const params = message.params || {};
    const firstInput = Array.isArray(params.input) ? params.input[0] : undefined;
    const steeringText = firstInput && typeof firstInput.text === "string" ? firstInput.text : "";
    const returnedTurnId = mode === "stale-steer-ack" ? "turn-stale" : activeTurnId;
    if (mode === "complete-before-steer-ack") {
      completeTurn(steeringText);
      setTimeout(() => send({ id: message.id, result: { turnId: returnedTurnId } }), 75);
      return;
    }
    send({ id: message.id, result: { turnId: returnedTurnId } });
    if (mode !== "stale-steer-ack") setImmediate(() => completeTurn(steeringText));
    return;
  }

  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    send({
      id: message.id,
      error: { code: -32601, message: `Unsupported method ${String(message.method)}` },
    });
  }
});
