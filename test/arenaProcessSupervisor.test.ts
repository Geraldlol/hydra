import { strict as assert } from "node:assert";
import * as cp from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import {
  executeArenaFakeHeadRequest,
  parseArenaFakeHeadRequest,
  type ArenaFakeHeadRequest,
} from "../src/arenaFakeHeadCli";
import {
  arenaProcessEnvironmentPolicySha256,
  arenaProcessFileIdentitySha256,
  arenaProcessWorktreeDirectoryIdentitySha256,
  createArenaProcessIntent,
  sanitizedArenaProcessEnvironment,
  sha256ArenaProcessUtf8,
  superviseArenaProcess,
  type ArenaProcessSupervisorInput,
} from "../src/arenaProcessSupervisor";

const REGISTRATION_SHA256 = digest("registration");
const INVOCATION_SHA256 = digest("invocation");
const FINAL_FINGERPRINT_SHA256 = digest("final-fingerprint");

describe("Arena process supervisor", () => {
  test("runs the bundled fake head with isolated edits and metadata-only output", async (t) => {
    const fixture = await createFixture(t);
    const request = fakeRequest({
      fixtureContent: "contestant result\n",
      untrackedRelativePath: "arena-note.txt",
      untrackedContent: "bounded note\n",
    });
    const result = await superviseArenaProcess(
      await supervisorInput(fixture.root, request, {
        postProcessFingerprintSha256: () => FINAL_FINGERPRINT_SHA256,
      }),
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.failureCode, null);
    assert.equal(result.stage, "execution");
    assert.equal(result.traceId, request.traceId);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminationConfirmed, true);
    assert.match(result.intentSha256, /^[0-9a-f]{64}$/);
    assert.match(result.processOwnerSha256, /^[0-9a-f]{64}$/);
    assert.match(result.submissionReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(result.quiescenceReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      result.quiescenceWorkspaceFingerprintSha256,
      FINAL_FINGERPRINT_SHA256,
    );
    assert.equal(result.quiescence?.activeProcessCount, 0);
    assert.equal(result.quiescence?.terminationConfirmed, true);
    assert.equal(result.stdout.complete, true);
    assert.equal(result.stdout.exceededLimit, false);
    assert.ok(result.stdout.bytes > 0);
    assert.equal(result.stderr.bytes, 0);
    assert.equal(result.output.bytes, result.stdout.bytes + result.stderr.bytes);
    assert.equal("text" in result.stdout, false);
    assert.equal("buffer" in result.stdout, false);
    assert.equal(await fs.readFile(fixture.file, "utf8"), "contestant result\n");
    assert.equal(
      await fs.readFile(path.join(fixture.root, "arena-note.txt"), "utf8"),
      "bounded note\n",
    );
  });

  test("binds process generation, prompt/input, registration, and invocation", async (t) => {
    const fixture = await createFixture(t);
    const base = await supervisorInput(fixture.root, fakeRequest());
    const first = createArenaProcessIntent({
      ...base,
      processGenerationId: "generation-one",
    });
    const repeated = createArenaProcessIntent({
      ...base,
      processGenerationId: "generation-one",
    });
    const changedInput = createArenaProcessIntent({
      ...base,
      processGenerationId: "generation-one",
      stdin: `${base.stdin} `,
    });
    const changedGeneration = createArenaProcessIntent({
      ...base,
      processGenerationId: "generation-two",
    });

    assert.deepEqual(first, repeated);
    assert.notEqual(first.intentSha256, changedInput.intentSha256);
    assert.notEqual(first.promptSha256, changedInput.promptSha256);
    assert.notEqual(first.inputSha256, changedInput.inputSha256);
    assert.notEqual(first.intentSha256, changedGeneration.intentSha256);
    assert.notEqual(
      first.processOwnerSha256,
      changedGeneration.processOwnerSha256,
    );
    assert.equal(first.registrationSha256, REGISTRATION_SHA256);
    assert.equal(first.invocationSha256, INVOCATION_SHA256);
  });

  test("uses a fixed environment allowlist and permits Electron Node mode only explicitly", () => {
    const dirty: NodeJS.ProcessEnv = {
      PATH: "safe-path",
      HOME: "safe-home",
      OPENAI_API_KEY: "not-implicitly-forwarded",
      GIT_DIR: "escape.git",
      git_work_tree: "escape-tree",
      NODE_OPTIONS: "--require attacker.js",
      NODE_PATH: "attacker-modules",
      ELECTRON_RUN_AS_NODE: "attacker-choice",
      ELECTRON_INSPECTOR_WS: "ws://attacker",
      VSCODE_INSPECTOR_OPTIONS: "attacker",
      NPM_CONFIG_NODE_OPTIONS: "--require attacker.js",
    };

    const ordinary = sanitizedArenaProcessEnvironment(dirty);
    assert.deepEqual(
      { ...ordinary },
      { PATH: "safe-path", HOME: "safe-home", CI: "1", NO_COLOR: "1" },
    );
    const bundled = sanitizedArenaProcessEnvironment(dirty, true);
    assert.equal(bundled.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(bundled.NODE_OPTIONS, undefined);
    assert.equal(bundled.GIT_DIR, undefined);
    assert.equal(bundled.OPENAI_API_KEY, undefined);
  });

  test("rejects an ambient environment that does not match the locked policy before spawn", async (t) => {
    const fixture = await createFixture(t);
    const input = await supervisorInput(fixture.root, fakeRequest());
    let spawned = false;
    await assert.rejects(
      superviseArenaProcess(
        {
          ...input,
          environmentPolicySha256: digest("stale-environment-policy"),
        },
        {
          spawnProcess: () => {
            spawned = true;
            throw new Error("must not spawn");
          },
        },
      ),
      /environment does not match the locked environment policy/,
    );
    assert.equal(spawned, false);
  });

  test("rejects changed worktree and executable identities before spawn", async (t) => {
    const fixture = await createFixture(t);
    const input = await supervisorInput(fixture.root, fakeRequest());
    let spawned = false;
    for (const changed of [
      {
        ...input,
        worktreeDirectoryIdentitySha256: digest("wrong-worktree"),
      },
      {
        ...input,
        commandFileIdentitySha256: digest("wrong-command"),
      },
    ]) {
      await assert.rejects(
        superviseArenaProcess(changed, {
          spawnProcess: () => {
            spawned = true;
            throw new Error("must not spawn");
          },
        }),
        /identity does not match/,
      );
    }
    assert.equal(spawned, false);
  });

  test("rejects non-exact cwd and command paths before spawning", async (t) => {
    const fixture = await createFixture(t);
    let spawned = false;
    const request = fakeRequest();
    const relative = await supervisorInput(fixture.root, request);
    await assert.rejects(
      superviseArenaProcess(
        { ...relative, worktreePath: "." },
        { spawnProcess: () => {
          spawned = true;
          throw new Error("must not spawn");
        } },
      ),
      /exact normalized absolute path/,
    );
    assert.equal(spawned, false);

    await assert.rejects(
      superviseArenaProcess(
        { ...relative, command: path.join(fixture.root, "missing.exe") },
        { spawnProcess: () => {
          spawned = true;
          throw new Error("must not spawn");
        } },
      ),
      /ENOENT|no such file/i,
    );
    assert.equal(spawned, false);
  });

  test("refuses Electron Node mode for a lookalike helper outside Hydra", async (t) => {
    const fixture = await createFixture(t);
    const lookalikeDirectory = path.join(fixture.root, "lookalike");
    const lookalike = path.join(lookalikeDirectory, "arenaFakeHeadCli.js");
    await fs.mkdir(lookalikeDirectory);
    await fs.writeFile(lookalike, "process.exit(0);", "utf8");
    const request = fakeRequest();
    const input = await supervisorInput(fixture.root, request);
    const lookalikeIdentity = await arenaProcessFileIdentitySha256(lookalike);
    await assert.rejects(
      superviseArenaProcess({
        ...input,
        args: [lookalike],
        bundledHelper: {
          scriptPath: lookalike,
          scriptFileIdentitySha256: lookalikeIdentity,
        },
      }),
      /Hydra's installed arenaFakeHeadCli\.js/,
    );
  });

  test("does not spawn or mint submission/quiescence receipts when pre-aborted", async (t) => {
    const fixture = await createFixture(t);
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const result = await superviseArenaProcess(
      {
        ...await supervisorInput(fixture.root, fakeRequest()),
        signal: controller.signal,
      },
      {
        spawnProcess: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      },
    );

    assert.equal(spawned, false);
    assert.equal(result.stage, "beforeDispatch");
    assert.equal(result.traceId, null);
    assert.equal(result.status, "cancelled");
    assert.equal(result.failureCode, "cancelled");
    assert.equal(result.submissionReceiptSha256, null);
    assert.equal(result.quiescenceReceiptSha256, null);
  });

  test("maps a synchronous spawn rejection to beforeDispatch", async (t) => {
    const fixture = await createFixture(t);
    const result = await superviseArenaProcess(
      await supervisorInput(fixture.root, fakeRequest()),
      {
        spawnProcess: () => {
          throw new Error("synthetic spawn rejection");
        },
      },
    );

    assert.equal(result.stage, "beforeDispatch");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "dispatchRejected");
    assert.equal(result.submissionReceiptSha256, null);
    assert.equal(result.quiescenceReceiptSha256, null);
    assert.equal(result.diagnosticCode, "spawnRejected");
  });

  test("awaits durable submission and sends no stdin when persistence fails", async (t) => {
    const fixture = await createFixture(t);
    const observed = acceptedMockChild();
    let submissionCalls = 0;
    const input = await supervisorInput(fixture.root, fakeRequest(), {
      onSubmission: async () => {
        submissionCalls += 1;
        throw new Error("synthetic durable write failure");
      },
    });
    const result = await superviseArenaProcess(input, {
      spawnProcess: () => {
        queueMicrotask(() => observed.child.emit("spawn"));
        return observed.child;
      },
      terminateProcess: async () => {
        queueMicrotask(() => observed.child.emit("close", null));
        return true;
      },
      terminationGraceMs: 20,
    });

    assert.equal(submissionCalls, 1);
    assert.equal(observed.stdinBytes(), 0);
    assert.equal(result.stage, "execution");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "transportFailure");
    assert.equal(result.diagnosticCode, "submissionPersistenceFailed");
    assert.match(result.submissionReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(result.quiescenceReceiptSha256, null);
  });

  test("does not finalize a fast-closing process ahead of the durable submission gate", async (t) => {
    const fixture = await createFixture(t);
    const observed = acceptedMockChild();
    let release!: () => void;
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const input = await supervisorInput(fixture.root, fakeRequest(), {
      onSubmission: () => durable,
      timeoutMs: 25,
    });
    const running = superviseArenaProcess(input, {
      spawnProcess: () => {
        queueMicrotask(() => {
          observed.child.emit("spawn");
          observed.child.emit("close", 0);
        });
        return observed.child;
      },
      terminationGraceMs: 20,
    }).then((result) => {
      settled = true;
      return result;
    });
    // The old implementation abandoned the uncancellable authority write at
    // timeoutMs and resolved while it could still mutate receipts later.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false);
    release();
    const result = await running;

    assert.equal(observed.stdinBytes(), 0);
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "transportFailure");
    assert.equal(result.diagnosticCode, "stdinWriteFailed");
  });

  test("observes an abort fired synchronously inside spawn and never writes stdin", async (t) => {
    const fixture = await createFixture(t);
    const observed = acceptedMockChild();
    const controller = new AbortController();
    let submissionCalls = 0;
    const input = await supervisorInput(fixture.root, fakeRequest(), {
      signal: controller.signal,
      onSubmission: async () => {
        submissionCalls += 1;
      },
    });
    const result = await superviseArenaProcess(input, {
      spawnProcess: () => {
        controller.abort();
        queueMicrotask(() => observed.child.emit("spawn"));
        return observed.child;
      },
      terminateProcess: async () => {
        queueMicrotask(() => observed.child.emit("close", null));
        return true;
      },
      terminationGraceMs: 20,
    });

    assert.equal(submissionCalls, 1);
    assert.equal(observed.stdinBytes(), 0);
    assert.equal(result.status, "cancelled");
    assert.equal(result.failureCode, "cancelled");
    assert.equal(result.terminationConfirmed, true);
  });

  test("maps a non-zero fake provider exit after confirmed close", async (t) => {
    const fixture = await createFixture(t);
    const result = await superviseArenaProcess(
      await supervisorInput(fixture.root, fakeRequest({ exitCode: 7 }), {
        postProcessFingerprintSha256: () => FINAL_FINGERPRINT_SHA256,
      }),
    );

    assert.equal(result.stage, "execution");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "providerFailure");
    assert.equal(result.exitCode, 7);
    assert.equal(result.terminationConfirmed, true);
    assert.match(result.submissionReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(result.quiescenceReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
  });

  test("defers the typed quiescence hash until a final workspace fingerprint is bound", async (t) => {
    const fixture = await createFixture(t);
    const result = await superviseArenaProcess(
      await supervisorInput(fixture.root, fakeRequest()),
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.terminationConfirmed, true);
    assert.equal(result.quiescence, null);
    assert.equal(result.quiescenceReceiptSha256, null);
    assert.ok(result.submission);
  });

  test("never grants generic/native execution a bundled quiescence receipt", async (t) => {
    const fixture = await createFixture(t);
    const bundled = await supervisorInput(fixture.root, fakeRequest());
    const generic: ArenaProcessSupervisorInput = {
      ...bundled,
      args: ["-e", "process.stdin.resume();"],
      stdin: "",
      environmentPolicySha256:
        arenaProcessEnvironmentPolicySha256(process.env, false),
      bundledHelper: undefined,
      postProcessFingerprintSha256: () => FINAL_FINGERPRINT_SHA256,
    };
    const result = await superviseArenaProcess(generic);

    assert.equal(result.status, "succeeded");
    assert.equal(result.terminationConfirmed, true);
    assert.equal(result.quiescence, null);
    assert.equal(result.quiescenceReceiptSha256, null);
  });

  test("bundled fake-head quiescence contract has no process-spawn surface", async () => {
    const source = await fs.readFile(
      path.resolve(process.cwd(), "src", "arenaFakeHeadCli.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /node:child_process|child_process|\.spawn\s*\(/);
    assert.match(
      source,
      /if \(require\.main === module\)/,
      "the installed helper remains one bounded, direct process entry point",
    );
  });

  test("caps stdout hashing/counting and terminates a flooding process", async (t) => {
    const fixture = await createFixture(t);
    const bundled = await supervisorInput(fixture.root, fakeRequest());
    const generic: ArenaProcessSupervisorInput = {
      ...bundled,
      args: [
        "-e",
        "process.stdout.write(Buffer.alloc(5*1024*1024,97));setInterval(()=>{},1000);",
      ],
      stdin: "",
      environmentPolicySha256:
        arenaProcessEnvironmentPolicySha256(process.env, false),
      bundledHelper: undefined,
    };
    const result = await superviseArenaProcess(generic);

    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "transportFailure");
    assert.equal(result.diagnosticCode, "stdoutLimitExceeded");
    assert.equal(result.stdout.exceededLimit, true);
    assert.equal(result.stdout.fullByteCountKnown, false);
    assert.equal(result.stdout.bytes, 4 * 1024 * 1024);
    assert.equal(result.quiescenceReceiptSha256, null);
  });

  test("caps stderr hashing/counting and marks the full byte count unknown", async (t) => {
    const fixture = await createFixture(t);
    const bundled = await supervisorInput(fixture.root, fakeRequest());
    const generic: ArenaProcessSupervisorInput = {
      ...bundled,
      args: [
        "-e",
        "process.stderr.write(Buffer.alloc(2*1024*1024,98));setInterval(()=>{},1000);",
      ],
      stdin: "",
      environmentPolicySha256:
        arenaProcessEnvironmentPolicySha256(process.env, false),
      bundledHelper: undefined,
    };
    const result = await superviseArenaProcess(generic);

    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "transportFailure");
    assert.equal(result.diagnosticCode, "stderrLimitExceeded");
    assert.equal(result.stderr.exceededLimit, true);
    assert.equal(result.stderr.fullByteCountKnown, false);
    assert.equal(result.stderr.bytes, 1 * 1024 * 1024);
    assert.equal(result.quiescenceReceiptSha256, null);
  });

  test("maps timeout and abort only after draining the fake child", async (t) => {
    const timeoutFixture = await createFixture(t);
    const timedOut = await superviseArenaProcess({
      ...await supervisorInput(timeoutFixture.root, fakeRequest({ hang: true }), {
        postProcessFingerprintSha256: () => FINAL_FINGERPRINT_SHA256,
      }),
      timeoutMs: 100,
    });
    assert.equal(timedOut.status, "timedOut");
    assert.equal(timedOut.failureCode, "timeout");
    assert.equal(timedOut.terminationConfirmed, true);
    assert.match(timedOut.quiescenceReceiptSha256 ?? "", /^[0-9a-f]{64}$/);

    const abortFixture = await createFixture(t);
    const controller = new AbortController();
    const running = superviseArenaProcess({
      ...await supervisorInput(abortFixture.root, fakeRequest({ hang: true }), {
        postProcessFingerprintSha256: () => FINAL_FINGERPRINT_SHA256,
      }),
      signal: controller.signal,
    });
    await waitForFileText(abortFixture.file, "changed by fake head\n");
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failureCode, "cancelled");
    assert.equal(cancelled.terminationConfirmed, true);
    assert.match(cancelled.quiescenceReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
  });

  test("fails closed without quiescence when termination cannot be confirmed", async (t) => {
    const fixture = await createFixture(t);
    const child = fakeNeverClosingChild();
    const controller = new AbortController();
    let spawned!: () => void;
    const spawnCalled = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const running = superviseArenaProcess(
      {
        ...await supervisorInput(fixture.root, fakeRequest()),
        signal: controller.signal,
      },
      {
        spawnProcess: () => {
          spawned();
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        terminateProcess: async () => false,
        terminationGraceMs: 5,
      },
    );
    await spawnCalled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await running;

    assert.equal(result.stage, "execution");
    assert.equal(result.status, "deliveryUnknown");
    assert.equal(result.failureCode, "terminationUnconfirmed");
    assert.equal(result.terminationConfirmed, false);
    assert.match(result.submissionReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(result.quiescenceReceiptSha256, null);
    assert.equal(result.quiescence, null);
    assert.equal(result.stdout.complete, false);
    assert.equal(result.stderr.complete, false);
  });

  test("does not resolve unconfirmed termination ahead of the durable submission gate", async (t) => {
    const fixture = await createFixture(t);
    const child = fakeNeverClosingChild();
    const controller = new AbortController();
    let releaseSubmission!: () => void;
    const submissionReleased = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    let observeSubmission!: () => void;
    const submissionObserved = new Promise<void>((resolve) => {
      observeSubmission = resolve;
    });
    let settled = false;
    const running = superviseArenaProcess(
      {
        ...await supervisorInput(fixture.root, fakeRequest(), {
          signal: controller.signal,
          onSubmission: () => {
            observeSubmission();
            return submissionReleased;
          },
        }),
      },
      {
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        terminateProcess: async () => false,
        terminationGraceMs: 5,
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    await submissionObserved;
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(
      settled,
      false,
      "the controller must not outlive an uncancellable authority write",
    );

    releaseSubmission();
    const result = await running;
    assert.equal(result.status, "deliveryUnknown");
    assert.equal(result.failureCode, "terminationUnconfirmed");
    assert.equal(result.terminationConfirmed, false);
    assert.match(result.submissionReceiptSha256 ?? "", /^[0-9a-f]{64}$/);
  });

  test("strict fake-head request parsing and filesystem guards reject escape attempts", async (t) => {
    const fixture = await createFixture(t);
    const valid = fakeRequest();
    assert.equal(parseArenaFakeHeadRequest(valid).contestantId, "contestant-a");
    assert.throws(
      () => parseArenaFakeHeadRequest({ ...valid, extra: "injection" }),
      /exactly the supported keys/,
    );
    assert.throws(
      () => parseArenaFakeHeadRequest({
        ...valid,
        fixtureRelativePath: `..${path.sep}outside.txt`,
      }),
      /relative path|escapes|normalized/,
    );
    assert.throws(
      () => parseArenaFakeHeadRequest({
        ...valid,
        inputSha256: digest("wrong"),
      }),
      /does not bind/,
    );

    const outside = path.join(path.dirname(fixture.root), "outside.txt");
    await fs.writeFile(outside, "outside\n", "utf8");
    t.after(async () => {
      await fs.rm(outside, { force: true });
    });
    await assert.rejects(
      executeArenaFakeHeadRequest(
        { ...valid, fixtureRelativePath: `..${path.sep}outside.txt` },
        fixture.root,
      ),
      /relative path|escapes|normalized/,
    );
    assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
  });

  test("fake head refuses final symlinks and hashes authenticated read-back bytes", async (t) => {
    const fixture = await createFixture(t);
    const valid = fakeRequest({ fixtureContent: "read-back bytes\n" });
    const execution = await executeArenaFakeHeadRequest(valid, fixture.root);
    assert.equal(
      execution.response.fixtureSha256,
      digest(await fs.readFile(fixture.file, "utf8")),
    );

    const outside = path.join(path.dirname(fixture.root), "outside-target.txt");
    const link = path.join(fixture.root, "linked-fixture.txt");
    await fs.writeFile(outside, "outside\n", "utf8");
    t.after(async () => {
      await fs.rm(outside, { force: true });
    });
    try {
      await fs.symlink(outside, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This Windows account cannot create test symlinks.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      executeArenaFakeHeadRequest(
        { ...valid, fixtureRelativePath: "linked-fixture.txt" },
        fixture.root,
      ),
      /real, singly-linked regular file|linked components/,
    );
    assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
  });
});

async function supervisorInput(
  root: string,
  request: ArenaFakeHeadRequest,
  overrides: Partial<ArenaProcessSupervisorInput> = {},
): Promise<ArenaProcessSupervisorInput> {
  const helper = path.resolve(
    __dirname,
    "..",
    "src",
    "arenaFakeHeadCli.js",
  );
  const command = path.resolve(process.execPath);
  const worktreeDirectoryIdentitySha256 =
    await arenaProcessWorktreeDirectoryIdentitySha256(root);
  const commandFileIdentitySha256 =
    await arenaProcessFileIdentitySha256(command);
  const scriptFileIdentitySha256 =
    await arenaProcessFileIdentitySha256(helper);
  return {
    runId: request.runId,
    contestantId: request.contestantId,
    traceId: request.traceId,
    registrationSha256: request.registrationSha256,
    worktreeDirectoryIdentitySha256,
    worktreePath: root,
    command,
    commandFileIdentitySha256,
    args: [helper],
    stdin: JSON.stringify(request),
    environmentPolicySha256:
      arenaProcessEnvironmentPolicySha256(process.env, true),
    invocationSha256: INVOCATION_SHA256,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    processGenerationId: request.processGenerationId,
    bundledHelper: { scriptPath: helper, scriptFileIdentitySha256 },
    onSubmission: async () => {},
    ...overrides,
  };
}

function fakeRequest(
  overrides: Partial<ArenaFakeHeadRequest> = {},
): ArenaFakeHeadRequest {
  const input = overrides.input ?? "identical Arena input";
  return {
    schemaVersion: 1,
    requestType: "arenaFakeHead",
    runId: "run-one",
    contestantId: "contestant-a",
    traceId: "trace-a",
    registrationSha256: REGISTRATION_SHA256,
    processGenerationId: "generation-a",
    input,
    inputSha256: sha256ArenaProcessUtf8(input),
    fixtureRelativePath: "fixture.txt",
    fixtureContent: "changed by fake head\n",
    untrackedRelativePath: null,
    untrackedContent: null,
    delayMs: 0,
    exitCode: 0,
    hang: false,
    ...overrides,
  };
}

async function createFixture(t: { after(callback: () => Promise<void>): void }): Promise<{
  readonly root: string;
  readonly file: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-process-"));
  const file = path.join(root, "fixture.txt");
  await fs.writeFile(file, "base\n", "utf8");
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, file };
}

function fakeNeverClosingChild(): cp.ChildProcess {
  const child = new EventEmitter() as cp.ChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  });
  return child;
}

function acceptedMockChild(): {
  readonly child: cp.ChildProcess;
  readonly stdinBytes: () => number;
} {
  const stdin = new PassThrough();
  let bytes = 0;
  stdin.on("data", (chunk: Buffer | string) => {
    bytes += Buffer.byteLength(chunk);
  });
  const child = new EventEmitter() as cp.ChildProcess;
  Object.assign(child, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  });
  return {
    child,
    stdinBytes: () => bytes,
  };
}

async function waitForFileText(
  file: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fs.readFile(file, "utf8") === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file} to contain fake-head output.`);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
