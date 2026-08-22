import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  MISSION_SUBMISSION_WRITTEN,
  SubmissionCancelledBeforeWriteError,
  missionDispatchTraceFields,
  startMissionBoundSubmission,
  type MissionSubmissionGate,
} from "../src/missionDispatch";
import {
  UNBOUND_MISSION_BINDING_SHA256,
  type MissionContractBinding,
} from "../src/missionContract";

const BINDING: MissionContractBinding = {
  state: "unbound",
  documentSha256: null,
  bindingSha256: UNBOUND_MISSION_BINDING_SHA256,
};

describe("Mission-bound provider submission", () => {
  test("releases the gate after start while provider completion remains pending", async () => {
    let gateReleased = false;
    const gate: MissionSubmissionGate = {
      write: async (_point, performWrite) => {
        assert.equal(await performWrite(), MISSION_SUBMISSION_WRITTEN);
        gateReleased = true;
      },
    };
    let resolveCompletion!: (value: string) => void;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });

    const result = startMissionBoundSubmission(
      gate,
      "native.oneShot",
      () => completion,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(gateReleased, true);

    resolveCompletion("done");
    assert.equal(await result, "done");
  });

  test("a rejected gate performs zero provider starts", async () => {
    let starts = 0;
    const gate: MissionSubmissionGate = {
      write: async () => {
        throw new Error("binding changed");
      },
    };
    await assert.rejects(
      startMissionBoundSubmission(gate, "http.request", async () => {
        starts++;
        return "unreachable";
      }),
      /binding changed/,
    );
    assert.equal(starts, 0);
  });

  test("Stop while waiting for the gate prevents provider start", async () => {
    const ctrl = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate: MissionSubmissionGate = {
      write: async (_point, performWrite) => {
        await held;
        assert.equal(await performWrite(), MISSION_SUBMISSION_WRITTEN);
      },
    };
    let starts = 0;
    const result = startMissionBoundSubmission(
      gate,
      "native.oneShot",
      async () => {
        starts++;
        return "unreachable";
      },
      ctrl.signal,
    );
    ctrl.abort();
    release();
    await assert.rejects(
      result,
      (error: unknown) => error instanceof SubmissionCancelledBeforeWriteError
        && /cancelled before provider submission/.test(error.message),
    );
    assert.equal(starts, 0);
  });

  test("trace fields distinguish bound work from enumerated maintenance", () => {
    assert.deepEqual(
      missionDispatchTraceFields({
        kind: "bound",
        binding: BINDING,
        roomTurnId: "room-turn-one",
        submissionGate: {
          write: async () => undefined,
        },
      }),
      {
        missionBindingSha256: BINDING.bindingSha256,
        missionDocumentSha256: BINDING.documentSha256,
        roomTurnId: "room-turn-one",
      },
    );
    assert.deepEqual(
      missionDispatchTraceFields({
        kind: "maintenanceExempt",
        reason: "diagnosticProbe",
      }),
      { missionDispatchExemption: "diagnosticProbe" },
    );
  });
});
