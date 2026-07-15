import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyAgentAuthority } from "../src/authority";
import {
  argsForCapabilityProfile,
  capabilityProfileShortLabel,
  configurableCapabilityProfiles,
  describeCapabilityProfile,
  profileSettingKey,
} from "../src/capabilityProfiles";

describe("capability profiles", () => {
  test("describes safe discussion", () => {
    const args = ["exec", "--sandbox", "read-only", "-"];
    const authority = classifyAgentAuthority("codex", "opener", args);
    assert.equal(describeCapabilityProfile("codex", "opener", args, authority).id, "safeDiscussion");
  });

  test("flags workspace-write during discussion as Elevated, not Native Discussion", () => {
    const args = ["-p", "--permission-mode", "acceptEdits"];
    const authority = classifyAgentAuthority("claude", "parallel", args);
    const profile = describeCapabilityProfile("claude", "parallel", args, authority);
    assert.equal(profile.id, "elevated");
    assert.match(profile.label, /Elevated/);
    assert.match(profile.detail, /broader than expected/);
  });

  test("flags workspace-write during review as Elevated, not Native Review", () => {
    const args = ["-p", "--permission-mode=acceptEdits"];
    const authority = classifyAgentAuthority("claude", "review", args);
    assert.equal(describeCapabilityProfile("claude", "review", args, authority).id, "elevated");
  });

  test("describes build and review profiles", () => {
    const buildArgs = ["exec", "--sandbox", "workspace-write", "-"];
    const reviewArgs = ["review", "--uncommitted", "-"];
    assert.equal(
      describeCapabilityProfile("codex", "build", buildArgs, classifyAgentAuthority("codex", "build", buildArgs)).id,
      "nativeBuild"
    );
    assert.equal(
      describeCapabilityProfile("codex", "review", reviewArgs, classifyAgentAuthority("codex", "review", reviewArgs)).id,
      "nativeReview"
    );
  });

  test("full native overrides phase-specific labels", () => {
    const args = ["exec", "--sandbox", "danger-full-access", "-"];
    const authority = classifyAgentAuthority("codex", "build", args);
    const profile = describeCapabilityProfile("codex", "build", args, authority);
    assert.equal(profile.id, "fullNative");
    assert.match(profile.label, /Equal Maximum Access/);
    assert.match(profile.detail, /equal maximum Hydra authority/i);
    assert.match(profile.detail, /implementations can still differ by CLI/i);
  });

  test("exposes the six configurable profile ids from the parity plan", () => {
    assert.deepEqual(configurableCapabilityProfiles().map((profile) => profile.id), [
      "safeDiscussion",
      "nativeDiscussion",
      "nativeBuild",
      "nativeReview",
      "fullNative",
      "custom",
    ]);
  });

  test("maps configured profile settings to the six user-facing keys", () => {
    assert.equal(profileSettingKey("codex", "discussion"), "codexDiscussionProfile");
    assert.equal(profileSettingKey("codex", "build"), "codexBuildProfile");
    assert.equal(profileSettingKey("codex", "review"), "codexReviewProfile");
    assert.equal(profileSettingKey("claude", "discussion"), "claudeDiscussionProfile");
    assert.equal(profileSettingKey("claude", "build"), "claudeBuildProfile");
    assert.equal(profileSettingKey("claude", "review"), "claudeReviewProfile");
  });

  test("profile presets produce expected native authority levels while custom preserves raw args", () => {
    const codexBuild = argsForCapabilityProfile("codex", "nativeBuild");
    assert.ok(codexBuild);
    assert.equal(classifyAgentAuthority("codex", "build", codexBuild).level, "workspaceWrite");
    assert.deepEqual(codexBuild.slice(3, 5), ["-c", "sandbox_workspace_write.network_access=true"]);

    const claudeReview = argsForCapabilityProfile("claude", "nativeReview");
    assert.ok(claudeReview);
    assert.equal(classifyAgentAuthority("claude", "review", claudeReview).level, "readOnly");

    const claudeFullNative = argsForCapabilityProfile("claude", "fullNative");
    assert.ok(claudeFullNative);
    assert.equal(classifyAgentAuthority("claude", "build", claudeFullNative).level, "fullNative");
    assert.ok(claudeFullNative.includes("--dangerously-skip-permissions"));
    assert.equal(claudeFullNative.includes("--permission-mode"), false);

    const codexFullNative = argsForCapabilityProfile("codex", "fullNative");
    assert.ok(codexFullNative);
    assert.ok(codexFullNative.includes('web_search="live"'));

    assert.equal(argsForCapabilityProfile("codex", "custom"), undefined);
  });

  test("Codex and Claude default every ordinary-room phase to full native parity", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      contributes?: { configuration?: { properties?: Record<string, { default?: unknown; markdownDescription?: string }> } };
    };
    const properties = manifest.contributes?.configuration?.properties ?? {};
    for (const agent of ["codex", "claude"] as const) {
      for (const phase of ["Discussion", "Build", "Review"] as const) {
        const setting = properties[`hydraRoom.${agent}${phase}Profile`];
        assert.ok(setting, `missing ${agent} ${phase} profile setting`);
        assert.equal(setting.default, "fullNative");
        assert.match(setting.markdownDescription ?? "", /equal maximum Hydra authority/i);
        assert.match(setting.markdownDescription ?? "", /per-workspace full-native consent/i);

        const args = argsForCapabilityProfile(agent, "fullNative");
        assert.ok(args);
        const authorityPhase = phase === "Discussion" ? "opener" : phase.toLowerCase() as "build" | "review";
        assert.equal(classifyAgentAuthority(agent, authorityPhase, args).level, "fullNative");
      }
    }
  });

  test("ordinary-room dispatch retains the explicit full-native consent gate", () => {
    const panel = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const start = panel.indexOf("private async callAgent(");
    const end = panel.indexOf("private async ensureFullNativeConsent(", start);
    assert.ok(start >= 0 && end > start, "could not bound callAgent");
    const method = panel.slice(start, end);
    const consent = method.indexOf("await this.ensureFullNativeConsent(");
    const denied = method.indexOf("if (!consent.allowed)", consent);
    const oneShot = method.indexOf("await this.runAgentTransport(", denied);
    const http = method.indexOf("await this.runHttpPipeline(", denied);
    assert.ok(consent >= 0, "ordinary-room dispatch must request full-native consent");
    assert.ok(denied > consent, "dispatch must honor consent denial");
    assert.ok(oneShot > denied, "one-shot execution must remain behind consent");
    assert.ok(http > denied, "HTTP execution must remain behind consent");
  });

  test("profile presets expose compact rail labels", () => {
    assert.equal(capabilityProfileShortLabel("safeDiscussion"), "safe");
    assert.equal(capabilityProfileShortLabel("nativeDiscussion"), "native");
    assert.equal(capabilityProfileShortLabel("nativeBuild"), "build");
    assert.equal(capabilityProfileShortLabel("nativeReview"), "review");
    assert.equal(capabilityProfileShortLabel("fullNative"), "full");
    assert.equal(capabilityProfileShortLabel("custom"), "custom");
  });
});
