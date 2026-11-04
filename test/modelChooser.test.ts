import * as assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import * as vscode from "vscode";
import type { CodexModelInfo, CodexModelsSnapshot } from "../src/codexModels";
import { chooseModelInteractively } from "../src/modelChooser";
import type { PhaseScope } from "../src/phasedSetting";

const ASTRA = "gpt-6-astra";
const CURRENT_CODEX_MODELS = [ASTRA, "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"];

interface PickerItem {
  label: string;
  description?: string;
  value: string;
}

interface SettingUpdate {
  key: string;
  value: unknown;
  target: vscode.ConfigurationTarget;
}

function catalogModel(slug: string, overrides: Partial<CodexModelInfo> = {}): CodexModelInfo {
  return {
    slug,
    displayName: slug,
    reasoningLevels: ["medium"],
    supportedInApi: true,
    visibility: "list",
    ...overrides,
  };
}

function snapshot(models: CodexModelInfo[]): CodexModelsSnapshot {
  return { fetchedAt: "2026-09-24T00:00:00.000Z", models };
}

async function openModelChooser(t: TestContext, options: {
  agent?: "codex" | "claude";
  snapshot?: CodexModelsSnapshot;
  scope?: PhaseScope;
  current?: unknown;
  selectModel?: string;
} = {}) {
  const agent = options.agent ?? "codex";
  const updates: SettingUpdate[] = [];
  const messages: string[] = [];
  let postedStates = 0;
  let pickerCalls = 0;
  let modelItems: readonly PickerItem[] = [];
  const window = vscode.window as unknown as {
    showQuickPick(items: readonly PickerItem[]): Promise<PickerItem | undefined>;
  };
  const workspace = vscode.workspace as unknown as {
    getConfiguration(section: string): {
      get(key: string): unknown;
      update(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void>;
    };
  };
  t.mock.method(window, "showQuickPick", async (items: readonly PickerItem[]) => {
    pickerCalls += 1;
    if (pickerCalls <= 2) {
      const value = pickerCalls === 1 ? agent : options.scope ?? "all";
      const pick = items.find((item) => item.value === value);
      assert.ok(pick, `Expected chooser option ${value}`);
      return pick;
    }
    assert.equal(pickerCalls, 3);
    modelItems = items;
    if (!options.selectModel) return undefined;
    const pick = items.find((item) => item.value === options.selectModel);
    assert.ok(pick, `${options.selectModel} must be selectable without entering a custom model ID`);
    return pick;
  });
  t.mock.method(workspace, "getConfiguration", (section: string) => {
    assert.equal(section, "hydraRoom");
    return {
      get: (key: string) => key === `${agent}Model` ? options.current : undefined,
      update: async (key: string, value: unknown, target: vscode.ConfigurationTarget) => {
        updates.push({ key, value, target });
      },
    };
  });
  await chooseModelInteractively({
    workspaceRoot: process.cwd(),
    codexModelsPath: "unused-codex-models.json",
    getCodexModelsSnapshot: () => options.snapshot,
    setCodexModelsSnapshot: () => assert.fail("Choosing a preset must not refresh the catalog"),
    appendSystemMessage: async (message) => { messages.push(message); },
    postState: () => { postedStates += 1; },
  });
  assert.equal(pickerCalls, 3);
  return { items: modelItems, updates, messages, postedStates };
}

describe("current model chooser", () => {
  for (const [name, cached] of [
    ["absent", undefined],
    ["empty", snapshot([])],
  ] as const) {
    test(`offers the GPT-6 family in the fallback when the catalog is ${name}`, async (t) => {
      const { items } = await openModelChooser(t, { snapshot: cached });
      for (const model of CURRENT_CODEX_MODELS) {
        assert.equal(items.filter((item) => item.value === model).length, 1);
      }
      assert.deepEqual(items.slice(1, 1 + CURRENT_CODEX_MODELS.length).map((item) => item.value), CURRENT_CODEX_MODELS);
      assert.ok(items.some((item) => item.value === "gpt-5.6-sol"));
    });
  }

  test("omits retired Spark from the fallback and labels GPT-5.5 as API-key only", async (t) => {
    const { items } = await openModelChooser(t);
    assert.ok(!items.some((item) => item.value === "gpt-5.3-codex-spark"));
    assert.match(items.find((item) => item.value === "gpt-5.5")?.description ?? "", /API key only.*retired/);
    assert.match(items.find((item) => item.value === "gpt-6.1-terra")?.description ?? "", /0\.159\.0/);
  });

  test("prepends the GPT-6 family to a catalog from before its release", async (t) => {
    const { items } = await openModelChooser(t, {
      snapshot: snapshot([catalogModel("gpt-5.6-sol")]),
    });
    assert.deepEqual(
      items.filter((item) => item.value.startsWith("gpt-")).map((item) => item.value),
      [...CURRENT_CODEX_MODELS, "gpt-5.6-sol"],
    );
  });

  for (const model of CURRENT_CODEX_MODELS) {
    test(`uses catalog metadata for ${model} without adding a second preset`, async (t) => {
      const { items } = await openModelChooser(t, {
        snapshot: snapshot([
          catalogModel("gpt-5.6-sol"),
          catalogModel(model, {
            displayName: "Live model name",
            defaultReasoning: "medium",
            description: "Current catalog description. More details.",
          }),
        ]),
      });
      assert.deepEqual(items.filter((item) => item.value === model), [{
        label: model,
        value: model,
        description: "Live model name \u00b7 reasoning: medium \u00b7 Current catalog description",
      }]);
    });

    test(`respects an explicit hidden ${model} catalog entry`, async (t) => {
      const { items } = await openModelChooser(t, {
        snapshot: snapshot([
          catalogModel(model, { visibility: "hide" }),
          catalogModel("gpt-5.6-sol"),
        ]),
      });
      assert.deepEqual(
        items.filter((item) => item.value.startsWith("gpt-")).map((item) => item.value),
        [...CURRENT_CODEX_MODELS.filter((slug) => slug !== model), "gpt-5.6-sol"],
      );
    });

    test(`persists ${model} globally for all phases`, async (t) => {
      const result = await openModelChooser(t, { selectModel: model });
      assert.deepEqual(result.updates, [{
        key: "codexModel", value: model, target: vscode.ConfigurationTarget.Global,
      }]);
      assert.equal(result.messages.length, 1);
      assert.ok(result.messages[0]?.includes(`--model ${model}`));
      assert.equal(result.postedStates, 1);
    });

    test(`persists ${model} for the requested phase while retaining other phase models`, async (t) => {
      const { updates } = await openModelChooser(t, {
        snapshot: snapshot([catalogModel("gpt-5.6-sol")]),
        scope: "build",
        current: "gpt-5.6-sol",
        selectModel: model,
      });
      assert.deepEqual(updates, [{
        key: "codexModel",
        value: { discussion: "gpt-5.6-sol", build: model, review: "gpt-5.6-sol" },
        target: vscode.ConfigurationTarget.Global,
      }]);
    });
  }

  test("does not repopulate a catalog that explicitly hides all current models", async (t) => {
    const { items } = await openModelChooser(t, {
      snapshot: snapshot(CURRENT_CODEX_MODELS.map((model) => catalogModel(model, { visibility: "hide" }))),
    });
    assert.deepEqual(items.map((item) => item.value), ["", "__custom__", "__refreshCodex__"]);
  });

  test("keeps newly discovered catalog models and their API limitations", async (t) => {
    const { items } = await openModelChooser(t, {
      snapshot: snapshot([catalogModel("future-model", { supportedInApi: false })]),
    });
    const model = items.find((item) => item.value === "future-model");
    assert.ok(model);
    assert.match(model.description ?? "", /interactive only.*codex exec won't work/);
  });

  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "opus", "sonnet", "haiku"]) {
    test(`offers and persists Claude ${model}`, async (t) => {
      const { items, updates, messages } = await openModelChooser(t, { agent: "claude", selectModel: model });
      assert.equal(items.filter((item) => item.value === model).length, 1);
      assert.deepEqual(updates, [{
        key: "claudeModel", value: model, target: vscode.ConfigurationTarget.Global,
      }]);
      assert.ok(messages[0]?.includes(`--model ${model}`));
    });
  }

  test("persists Opus 5.5 only for the requested Claude phase", async (t) => {
    const { updates } = await openModelChooser(t, {
      agent: "claude", selectModel: "claude-opus-5-5", scope: "build", current: "sonnet",
    });
    assert.deepEqual(updates, [{
      key: "claudeModel",
      value: { discussion: "sonnet", build: "claude-opus-5-5", review: "sonnet" },
      target: vscode.ConfigurationTarget.Global,
    }]);
  });
});
