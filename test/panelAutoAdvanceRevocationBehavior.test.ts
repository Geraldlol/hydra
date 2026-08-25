import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as vscode from "vscode";
import type { DecisionPacket } from "../src/decisions";
import { HydraRoomPanel } from "../src/panel";
import { transition, type Event, type State } from "../src/phases";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface AutoAdvanceScenario {
  readonly name: string;
  readonly initialState: State;
  readonly defaultNextAction: string;
}

const DECISION_TIMESTAMP = "2026-08-25T10:00:00.000Z";

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function get<T>(target: object, key: PropertyKey): T {
  return Reflect.get(target, key) as T;
}

function set(target: object, key: PropertyKey, value: unknown): void {
  assert.equal(Reflect.set(target, key, value), true);
}

function invoke<T>(target: object, key: PropertyKey, ...args: unknown[]): T {
  const method = Reflect.get(target, key);
  assert.equal(typeof method, "function", `${String(key)} must be callable`);
  return Reflect.apply(method as (...values: unknown[]) => T, target, args);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!value || typeof value !== "object") return false;
  return typeof Reflect.get(value, "aborted") === "boolean"
    && typeof Reflect.get(value, "addEventListener") === "function";
}

function propagatedAbortSignal(values: readonly unknown[]): AbortSignal | undefined {
  const pending = [...values];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.shift();
    if (isAbortSignal(value)) return value;
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    for (const key of ["signal", "parentSignal", "authority", "autoAdvanceAuthority"] as const) {
      const nested = Reflect.get(value, key);
      if (nested !== undefined) pending.push(nested);
    }
  }
  return undefined;
}

function decision(defaultNextAction: string): DecisionPacket {
  return {
    timestamp: DECISION_TIMESTAMP,
    agent: "codex",
    phase: "closer",
    recommendation: "Continue with the eligible default.",
    defaultNextAction,
    decisionNeededFromUser: "None",
    blockers: "None",
    sourceMessageTimestamp: "2026-08-25T09:59:00.000Z",
  };
}

function createBehaviorHarness(input: {
  state: State;
  defaultNextAction: string;
  phasePersistence?: Deferred;
}): {
  readonly panel: object;
  readonly phaseStarted: Deferred;
  readonly counters: { phaseLaunches: number; nativeDispatches: number };
} {
  const panel = Object.create(HydraRoomPanel.prototype) as object;
  const phaseStarted = deferred();
  const phasePersistence = input.phasePersistence ?? deferred();
  const counters = { phaseLaunches: 0, nativeDispatches: 0 };

  set(HydraRoomPanel, "unconfirmedNativeTerminationForHost", false);
  set(panel, "state", input.state);
  set(panel, "decisions", [decision(input.defaultNextAction)]);
  set(panel, "acceptedDefaultDecisionTimestamp", undefined);
  set(panel, "workspaceReady", true);
  set(panel, "gitAvailable", true);
  set(panel, "flightTransitionReservationInFlight", false);
  set(panel, "arenaSmokeRunning", false);
  set(panel, "terminalPokeInFlight", false);
  set(panel, "verificationRunning", false);
  set(panel, "agentDuelAdmissionRunning", false);
  set(panel, "agentDuelAutomationRunning", false);
  set(panel, "duelCommitmentAbort", undefined);
  set(panel, "autoAdvanceActionableDefaultsOverride", true);
  set(panel, "autoAdvanceSendInstructionCount", 0);
  set(panel, "autoAdvanceGeneration", 0);
  set(panel, "autoAdvanceAbort", new AbortController());
  set(panel, "queuedUserMessages", []);
  set(panel, "drainingQueuedUserMessages", false);
  set(panel, "messages", []);
  set(panel, "activeFlightTurns", []);

  set(panel, "postState", () => undefined);
  set(panel, "sessionCostCapExceeded", () => false);
  set(panel, "roster", () => ["codex", "claude"]);
  set(panel, "getFirstSpeaker", () => "codex");
  set(panel, "isActiveAgent", () => true);
  set(panel, "appendSystemMessage", async () => undefined);
  set(panel, "appendSystemMessageToUi", () => undefined);
  set(panel, "appendUserMessage", async () => ({ timestamp: "2026-08-25T10:00:01.000Z" }));
  set(panel, "appendUserMessageToUi", () => ({ timestamp: "2026-08-25T10:00:01.000Z" }));
  set(panel, "persistTranscriptMessage", async () => undefined);
  set(panel, "prepareUserMessageWithAttachments", (text: string) => ({
    displayText: text,
    promptText: text,
  }));
  set(panel, "tryDeliverCrossWindowSteering", async () => false);
  set(panel, "tryDeliverLiveSteering", async () => false);
  set(panel, "prepareInitiatingFlightTurn", async function prepareInitiatingFlightTurnOverride(this: object) {
    set(this, "flightTransitionReservationInFlight", true);
    return {
      roomTurnId: "auto-revocation-turn",
      authorization: { kind: "bound", binding: {} },
    };
  });
  set(panel, "preparedFlightWasCancelled", () => false);
  set(panel, "finishPreparedFlightTurn", async () => undefined);
  set(panel, "releaseInitiatingFlightTurnReservation", function releaseOverride(this: object) {
    set(this, "flightTransitionReservationInFlight", false);
  });
  set(panel, "applyEvent", function applyEventOverride(this: object, event: Event) {
    set(this, "state", transition(get<State>(this, "state"), event));
  });

  const launchPhase = async (...args: unknown[]): Promise<void> => {
    counters.phaseLaunches += 1;
    const inheritedSignal = propagatedAbortSignal(args);
    phaseStarted.resolve();
    await phasePersistence.promise;
    if (!inheritedSignal?.aborted) counters.nativeDispatches += 1;
  };
  set(panel, "runDiscussionTurn", launchPhase);
  set(panel, "runParallelDiscussionTurn", launchPhase);
  set(panel, "runBuildPhase", launchPhase);
  set(panel, "runParallelBuildPhase", launchPhase);
  set(panel, "runReviewPhase", launchPhase);
  set(panel, "runParallelReviewPhase", launchPhase);

  return { panel, phaseStarted, counters };
}

const phaseScenarios: readonly AutoAdvanceScenario[] = [
  {
    name: "sendInstruction",
    initialState: { name: "AwaitingUser" },
    defaultNextAction: "Continue the discussion using the gathered evidence.",
  },
  {
    name: "assignBuilder",
    initialState: { name: "AwaitingUser" },
    defaultNextAction: "Codex implements the agreed patch.",
  },
  {
    name: "requestReview",
    initialState: { name: "BuildDone", builder: "codex" },
    defaultNextAction: "Request review of the completed build.",
  },
  {
    name: "handBack",
    initialState: { name: "ReviewDone", reviewer: "claude", builder: "codex", approved: false },
    defaultNextAction: "Hand back to the builder to address the findings.",
  },
];

describe("automatic default revocation behavior", () => {
  for (const scenario of phaseScenarios) {
    test(
      `${scenario.name} revocation after phase launch reaches no native dispatch and does not accept a no-op`,
      { timeout: 5_000 },
      async () => {
        const phasePersistence = deferred();
        const { panel, phaseStarted, counters } = createBehaviorHarness({
          state: scenario.initialState,
          defaultNextAction: scenario.defaultNextAction,
          phasePersistence,
        });

        const run = invoke<Promise<void>>(panel, "autoAdvanceActionableDefault", "test completion");
        await phaseStarted.promise;
        invoke<void>(panel, "invalidateAutoAdvanceDispatches");
        phasePersistence.resolve();
        await run;

        assert.deepEqual(
          {
            phaseLaunches: counters.phaseLaunches,
            nativeDispatches: counters.nativeDispatches,
            acceptedDefaultDecisionTimestamp: get<string | undefined>(
              panel,
              "acceptedDefaultDecisionTimestamp",
            ),
          },
          {
            phaseLaunches: 1,
            nativeDispatches: 0,
            acceptedDefaultDecisionTimestamp: undefined,
          },
        );
      },
    );
  }

  test("revoking a queued automatic send drops it without accepting or dispatching the default", async () => {
    const { panel, counters } = createBehaviorHarness({
      state: { name: "AwaitingUser" },
      defaultNextAction: "Continue the discussion using the gathered evidence.",
    });
    set(panel, "flightTransitionReservationInFlight", true);

    await invoke<Promise<void>>(panel, "autoAdvanceActionableDefault", "test completion");
    assert.equal(get<unknown[]>(panel, "queuedUserMessages").length, 1);

    invoke<void>(panel, "invalidateAutoAdvanceDispatches");
    set(panel, "flightTransitionReservationInFlight", false);
    await invoke<Promise<void>>(panel, "drainQueuedUserMessages");

    assert.deepEqual(
      {
        queuedMessages: get<unknown[]>(panel, "queuedUserMessages").length,
        phaseLaunches: counters.phaseLaunches,
        nativeDispatches: counters.nativeDispatches,
        acceptedDefaultDecisionTimestamp: get<string | undefined>(
          panel,
          "acceptedDefaultDecisionTimestamp",
        ),
      },
      {
        queuedMessages: 0,
        phaseLaunches: 0,
        nativeDispatches: 0,
        acceptedDefaultDecisionTimestamp: undefined,
      },
    );
  });
});
