import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import {
  loadArenaProductReceipts,
  persistArenaProductReceipt,
} from "../src/arenaProductStore";
import type {
  ArenaSynthesisRequest,
  ArenaWinnerSelection,
} from "../src/arenaProduct";
import { canonicalArenaManifestJson } from "../src/arenaRunManifest";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-product-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function selection(
  overrides: Partial<ArenaWinnerSelection> = {},
): ArenaWinnerSelection {
  const requested = {
    schemaVersion: 1 as const,
    receiptType: "arenaWinnerSelection" as const,
    selectionId: "selection-one",
    occurredAt: "2026-08-24T12:00:00.000Z",
    actorId: "local-user" as const,
    action: "Select Arena Winner" as const,
    runId: "run-one",
    revealSha256: digest("reveal"),
    contestantId: "contestant-codex",
    artifactSetSha256: digest("artifacts"),
    authorityGranted: false as const,
    ...overrides,
  };
  const { selectionSha256: _ignored, ...withoutHash } = requested;
  return {
    ...withoutHash,
    selectionSha256: createHash("sha256")
      .update("hydra.arena.product.v1.selection\u0000", "utf8")
      .update(canonicalArenaManifestJson(withoutHash), "utf8")
      .digest("hex"),
  };
}

describe("Arena product receipt storage", () => {
  test("publishes an immutable winner receipt and accepts an exact retry", async (t) => {
    const root = await fixture(t);
    const receipt = selection();

    const first = await persistArenaProductReceipt(root, receipt);
    const retry = await persistArenaProductReceipt(root, receipt);
    const loaded = await loadArenaProductReceipts(root, "run-one");

    assert.equal(first, retry);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], receipt);
  });

  test("rejects forged hashes and same-id collisions", async (t) => {
    const root = await fixture(t);
    const receipt = selection();
    await persistArenaProductReceipt(root, receipt);

    await assert.rejects(
      persistArenaProductReceipt(root, {
        ...receipt,
        selectionSha256: "f".repeat(64),
      }),
      /hash/u,
    );
    const collision = selection({
      contestantId: "contestant-claude",
    });
    await assert.rejects(
      persistArenaProductReceipt(root, collision),
      /conflicts with durable state/u,
    );
  });

  test("strict loading rejects unknown files instead of hiding them", async (t) => {
    const root = await fixture(t);
    const receiptPath = await persistArenaProductReceipt(root, selection());
    const directory = path.dirname(receiptPath);
    await fs.writeFile(path.join(directory, "surprise.txt"), "unsafe\n", {
      mode: 0o600,
    });

    await assert.rejects(
      loadArenaProductReceipts(root, "run-one"),
      /unexpected entry/u,
    );
  });

  test("supports immutable synthesis request receipts", async (t) => {
    const root = await fixture(t);
    const withoutHash = {
      schemaVersion: 1 as const,
      receiptType: "arenaSynthesisRequest" as const,
      requestId: "synthesis-one",
      occurredAt: "2026-08-24T12:00:00.000Z",
      actorId: "local-user" as const,
      action: "Request Arena Synthesis" as const,
      runId: "run-one",
      revealSha256: digest("reveal"),
      missionBindingSha256: digest("mission"),
      sources: [{
        contestantId: "contestant-codex",
        artifactSetSha256: digest("codex-artifacts"),
        patchSha256: digest("codex-patch"),
      }, {
        contestantId: "contestant-claude",
        artifactSetSha256: digest("claude-artifacts"),
        patchSha256: digest("claude-patch"),
      }],
      isolatedRunRequired: true as const,
      mutatesSourceWorkspace: false as const,
    };
    const receipt: ArenaSynthesisRequest = {
      ...withoutHash,
      synthesisRequestSha256: createHash("sha256")
        .update("hydra.arena.product.v1.synthesis\u0000", "utf8")
        .update(canonicalArenaManifestJson(withoutHash), "utf8")
        .digest("hex"),
    };

    await persistArenaProductReceipt(root, receipt);
    const loaded = await loadArenaProductReceipts(root, "run-one");
    assert.equal(loaded[0]?.receiptType, "arenaSynthesisRequest");
  });
});
