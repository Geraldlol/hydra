import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { TRUST_SCOPED_SETTINGS } from "../src/doctor";

// Why: The security invariant in CLAUDE.md says that every setting flowing
// into a spawn argv/env/PATH/terminal/verify/webhook/telegram sink must be
// declared `scope:"application"`, listed in
// capabilities.untrustedWorkspaces.restrictedConfigurations, AND mirrored in
// Doctor's TRUST_SCOPED_SETTINGS. This contract test guards all three sides.

// __dirname at runtime is dist/test, so package.json is two levels up.
const PACKAGE_JSON_PATH = path.resolve(__dirname, "..", "..", "package.json");

interface PackageJsonShape {
  contributes?: {
    configuration?: {
      properties?: Record<string, {
        scope?: string;
        items?: { properties?: Record<string, { properties?: Record<string, unknown> }> };
      }>;
    };
  };
  capabilities?: {
    untrustedWorkspaces?: {
      restrictedConfigurations?: string[];
    };
  };
}

function loadPackageJson(): PackageJsonShape {
  const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
  return JSON.parse(raw) as PackageJsonShape;
}

describe("trust scope contract", () => {
  test("restrictedConfigurations and TRUST_SCOPED_SETTINGS are the same set", () => {
    const pkg = loadPackageJson();
    const restricted = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
    assert.ok(restricted.length > 0, "package.json restrictedConfigurations is empty");

    const PREFIX = "hydraRoom.";
    const pkgSet = new Set<string>();
    for (const key of restricted) {
      assert.ok(
        key.startsWith(PREFIX),
        `restrictedConfigurations entry ${key} should start with ${PREFIX}`
      );
      pkgSet.add(key.slice(PREFIX.length));
    }

    const doctorSet = new Set<string>(TRUST_SCOPED_SETTINGS);

    const missingInDoctor = [...pkgSet].filter((k) => !doctorSet.has(k)).sort();
    const missingInPkg = [...doctorSet].filter((k) => !pkgSet.has(k)).sort();

    assert.deepEqual(
      missingInDoctor,
      [],
      `TRUST_SCOPED_SETTINGS is missing entries present in package.json restrictedConfigurations: ${missingInDoctor.join(", ")}`
    );
    assert.deepEqual(
      missingInPkg,
      [],
      `package.json restrictedConfigurations is missing entries present in TRUST_SCOPED_SETTINGS: ${missingInPkg.join(", ")}`
    );
  });

  test("every TRUST_SCOPED_SETTINGS key has scope:\"application\" on its package.json property", () => {
    const pkg = loadPackageJson();
    const props = pkg.contributes?.configuration?.properties ?? {};
    const missing: string[] = [];
    for (const shortKey of TRUST_SCOPED_SETTINGS) {
      const fullKey = `hydraRoom.${shortKey}`;
      const prop = props[fullKey];
      if (!prop) {
        missing.push(`${fullKey} (property not found)`);
        continue;
      }
      if (prop.scope !== "application") {
        missing.push(`${fullKey} (scope=${JSON.stringify(prop.scope)})`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Trust-scoped settings missing scope:"application": ${missing.join(", ")}`
    );
  });

  test("capability profile settings are pinned as trust-scoped", () => {
    // Why: the six *Profile settings select Codex/Claude argv at dispatch
    // time. A `fullNative` value maps to Codex `--sandbox danger-full-access`
    // or Claude `--dangerously-skip-permissions`. A workspace setting
    // override could flip an untrusted repo into either argv shape; pin
    // them explicitly so a future removal from the generic lockstep test
    // above is still caught.
    const profileSettings = [
      "codexDiscussionProfile",
      "codexBuildProfile",
      "codexReviewProfile",
      "claudeDiscussionProfile",
      "claudeBuildProfile",
      "claudeReviewProfile",
    ];
    for (const key of profileSettings) {
      assert.ok(
        (TRUST_SCOPED_SETTINGS as readonly string[]).includes(key),
        `${key} must be in TRUST_SCOPED_SETTINGS — fullNative profile maps to dangerous argv`
      );
    }
  });

  test("gemini spawn settings are trust-scoped", () => {
    const geminiKeys = [
      "geminiCommand", "geminiExecArgsDiscussion", "geminiExecArgsBuild",
      "geminiExecArgsReview", "geminiModel", "geminiNativeEnv", "geminiNativePathPrepend",
    ];
    for (const key of geminiKeys) {
      assert.ok(
        (TRUST_SCOPED_SETTINGS as readonly string[]).includes(key),
        `${key} must be trust-scoped — it flows into a native spawn`,
      );
    }
  });

  test("hydraRoom.agents is trust-scoped (spawn command + network endpoint)", () => {
    assert.ok(
      (TRUST_SCOPED_SETTINGS as readonly string[]).includes("agents"),
      "agents must be trust-scoped — it defines a spawn command and an HTTP endpoint",
    );
  });

  test("hydraRoom.agents item schema declares pricing so a valid AgentDefinition doesn't squiggle", () => {
    const pkg = loadPackageJson();
    const agentsProp = pkg.contributes?.configuration?.properties?.["hydraRoom.agents"];
    const pricing = agentsProp?.items?.properties?.pricing;
    assert.ok(pricing, "hydraRoom.agents items.properties.pricing is missing");
    assert.deepEqual(
      Object.keys(pricing?.properties ?? {}).sort(),
      ["cacheCreatePerMTok", "cacheReadPerMTok", "inputPerMTok", "outputPerMTok"],
      "pricing schema should mirror the ModelPrices fields"
    );
  });
});
