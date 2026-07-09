import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
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
    assert.equal(describeCapabilityProfile("codex", "build", args, authority).id, "fullNative");
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

    assert.equal(argsForCapabilityProfile("codex", "custom"), undefined);
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
