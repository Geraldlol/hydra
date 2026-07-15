import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.slice("--port=".length) || process.env.HYDRA_PREVIEW_PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid preview port: ${port}`);
}

let renderHtml;
try {
  ({ renderHtml } = await import(pathToFileUrl(path.join(workspaceRoot, "dist", "src", "webview.html.js"))));
} catch (error) {
  throw new Error("Hydra preview requires compiled output. Run `corepack pnpm run compile` first.", { cause: error });
}

const origin = `http://127.0.0.1:${port}`;
const nonce = "hydra-local-preview";
const heads = {
  cspSource: origin,
  brand: `${origin}/media/hydra-heads/guard.png`,
  codex: `${origin}/media/hydra-heads/codex.png`,
  claude: `${origin}/media/hydra-heads/claude.png`,
  system: `${origin}/media/hydra-heads/system.png`,
  user: `${origin}/media/hydra-heads/user.png`,
};

function previewHtml() {
  return renderHtml(nonce, heads, `${origin}/webview.js`).replace(
    `<script nonce="${nonce}" src="${origin}/webview.js"></script>`,
    `<script nonce="${nonce}" src="${origin}/preview-bootstrap.js"></script>\n  <script nonce="${nonce}" src="${origin}/webview.js"></script>`,
  );
}

const previewState = {
  type: "state",
  phaseLabel: "Discussion",
  isIdle: true,
  canSend: true,
  canStop: false,
  canPokeNativeTerminals: true,
  canClearNativeActions: true,
  canAssignBuilder: true,
  canRequestReview: false,
  canRunVerification: true,
  canRunWikiWrapup: true,
  canPreviewPrompt: true,
  canArchiveRoom: true,
  canAttachFiles: true,
  canHandBack: false,
  canOpenFolder: false,
  canAcceptDefault: true,
  firstSpeaker: "codex",
  suggestedBuilder: "codex",
  transport: "oneShot",
  objective: "Audit Hydra, harden its runtime, and make multi-head competition useful without compromising safety.",
  roster: [
    { id: "codex", displayName: "Codex", colorIndex: 1 },
    { id: "claude", displayName: "Claude", colorIndex: 2 },
    { id: "gemini", displayName: "Gemini", colorIndex: 3 },
  ],
  agentStatuses: {
    codex: { state: "replied", detail: "Audit pass complete" },
    claude: { state: "idle", detail: "Ready" },
    gemini: { state: "running", detail: "Checking UX findings" },
  },
  authoritySummaries: {
    codex: {
      authority: { level: "fullNative", label: "Full native", detail: "Equal maximum native access after explicit consent." },
      profile: { label: "Full Native - Equal Maximum Access", detail: "Full-native profile for Discussion, Build, and Review" },
    },
    claude: {
      authority: { level: "fullNative", label: "Full native", detail: "Equal maximum native access after explicit consent." },
      profile: { label: "Full Native - Equal Maximum Access", detail: "Full-native profile for Discussion, Build, and Review" },
    },
    gemini: {
      authority: { level: "readOnly", label: "Read only", detail: "Review without modifying files." },
      profile: { label: "UX Review", detail: "Read-only UX verification profile" },
    },
  },
  terminalSessions: [],
  messages: [
    {
      id: "preview-user-1",
      role: "user",
      phase: "discussion",
      text: "Audit Hydra, then improve the UX and design a fair high-score system for the heads.",
      timestamp: "2026-07-14T09:00:00.000Z",
    },
    {
      id: "preview-codex-1",
      role: "codex",
      phase: "opener",
      text: "The hardening pass is complete. The important next step is durable N-head identity before reputation can safely influence orchestration.",
      timestamp: "2026-07-14T09:01:00.000Z",
    },
    {
      id: "preview-claude-1",
      role: "claude",
      phase: "reactor",
      text: "Agreed. Score falsifiable claims only, keep security authority separate, and introduce influence gradually after passive standings have real evidence.",
      timestamp: "2026-07-14T09:02:00.000Z",
    },
    {
      id: "preview-gemini-1",
      role: "gemini",
      phase: "reactor",
      text: "The three-head room now needs a compact evidence surface: current rank, maturity, domain record, and a clear reminder that standings do not grant native authority.",
      timestamp: "2026-07-14T09:03:00.000Z",
    },
  ],
  pendingAttachments: [
    { id: "attachment-1", name: "verification.jsonl", relativePath: ".hydra/verification.jsonl", sizeBytes: 18432, binary: false, previewChars: 2048 },
  ],
  sessionUsage: {
    turns: 8,
    inputTokens: 84200,
    outputTokens: 17400,
    cacheReadTokens: 121000,
    cacheCreateTokens: 6300,
    totalTokens: 228900,
    costUsd: 0.84,
    byAgent: {
      codex: { turns: 3, totalTokens: 96200, costUsd: 0.36 },
      claude: { turns: 3, totalTokens: 81100, costUsd: 0.31 },
      gemini: { turns: 2, totalTokens: 51600, costUsd: 0.17 },
    },
  },
  weeklyUsage: { turns: 31, totalTokens: 782000, costUsd: 4.62 },
  recentUsageRecords: [],
  models: { codex: "gpt-5", claude: "sonnet" },
  efforts: { codex: "high", claude: "high" },
  capabilityProfiles: {
    codex: { text: "full/full/full", title: "Discussion, Build, and Review: Full Native - Equal Maximum Access" },
    claude: { text: "full/full/full", title: "Discussion, Build, and Review: Full Native - Equal Maximum Access" },
  },
  manyHeads: { enabled: true, claudeWorkerCount: 2 },
  latestDecision: {
    agent: "codex",
    phase: "discussion",
    defaultNextAction: "Implement durable N-head identity, then add passive standings.",
    recommendation: "Keep reliability, duel rating, and native authority as separate concepts.",
    decisionNeededFromUser: "Approve the identity-first rollout order.",
    blockers: "none",
  },
  latestDecisionAccepted: false,
  latestDecisionRisky: { risky: false, reasons: [] },
  recentDecisions: [],
  decisionsCount: 1,
  decisionAction: { kind: "send", label: "Accept Identity First", detail: "Proceed with the safe rollout order." },
  standings: {
    eventCount: 44,
    error: undefined,
    overall: [
      {
        agentId: "codex",
        domains: ["runtime", "security", "ux"],
        counts: { claims: 8, verdictsRecorded: 9, verdictsReversed: 1, activeVerdicts: 8, pending: 0, correct: 5, partial: 2, incorrect: 1, trustedCorrect: 5, trustedPartial: 2, trustedIncorrect: 1, unresolved: 0, void: 0, independentlyResolved: 8, independentRounds: 8, advisoryResolved: 0 },
        weightedResolvedEvidence: 7.25,
        weightedCorrectness: 5.5,
        weightedAccuracy: 0.7586206896551724,
        reliability: 1,
        score: 0.5750278804045027,
        provisional: false,
      },
      {
        agentId: "gemini",
        domains: ["research", "runtime", "security"],
        counts: { claims: 6, verdictsRecorded: 6, verdictsReversed: 0, activeVerdicts: 6, pending: 0, correct: 4, partial: 1, incorrect: 1, trustedCorrect: 4, trustedPartial: 1, trustedIncorrect: 1, unresolved: 0, void: 0, independentlyResolved: 6, independentRounds: 6, advisoryResolved: 0 },
        weightedResolvedEvidence: 5.5,
        weightedCorrectness: 4.125,
        weightedAccuracy: 0.75,
        reliability: 1,
        score: 0.5373964396512035,
        provisional: false,
      },
      {
        agentId: "claude",
        domains: ["runtime", "security", "ux"],
        counts: { claims: 7, verdictsRecorded: 7, verdictsReversed: 0, activeVerdicts: 7, pending: 0, correct: 4, partial: 2, incorrect: 1, trustedCorrect: 3, trustedPartial: 2, trustedIncorrect: 1, unresolved: 0, void: 0, independentlyResolved: 6, independentRounds: 6, advisoryResolved: 1 },
        weightedResolvedEvidence: 4.75,
        weightedCorrectness: 3.25,
        weightedAccuracy: 0.6842105263157895,
        reliability: 0.95,
        score: 0.4556971356186208,
        provisional: false,
      },
    ],
    byDomain: [
      {
        agentId: "codex",
        domain: "security",
        counts: { claims: 3, verdictsRecorded: 4, verdictsReversed: 1, activeVerdicts: 3, pending: 0, correct: 3, partial: 0, incorrect: 0, trustedCorrect: 3, trustedPartial: 0, trustedIncorrect: 0, unresolved: 0, void: 0, independentlyResolved: 3, independentRounds: 3, advisoryResolved: 0 },
        weightedResolvedEvidence: 2.75,
        weightedCorrectness: 2.75,
        weightedAccuracy: 1,
        reliability: 0.55,
        score: 0.7333333333333333,
        provisional: true,
      },
      {
        agentId: "claude",
        domain: "security",
        counts: { claims: 2, verdictsRecorded: 2, verdictsReversed: 0, activeVerdicts: 2, pending: 0, correct: 1, partial: 1, incorrect: 0, trustedCorrect: 1, trustedPartial: 1, trustedIncorrect: 0, unresolved: 0, void: 0, independentlyResolved: 2, independentRounds: 2, advisoryResolved: 0 },
        weightedResolvedEvidence: 1.75,
        weightedCorrectness: 1.375,
        weightedAccuracy: 0.7857142857142857,
        reliability: 0.35,
        score: 0.41345482701595027,
        provisional: true,
      },
      {
        agentId: "gemini",
        domain: "security",
        counts: { claims: 1, verdictsRecorded: 1, verdictsReversed: 0, activeVerdicts: 1, pending: 0, correct: 1, partial: 0, incorrect: 0, trustedCorrect: 1, trustedPartial: 0, trustedIncorrect: 0, unresolved: 0, void: 0, independentlyResolved: 1, independentRounds: 1, advisoryResolved: 0 },
        weightedResolvedEvidence: 0.75,
        weightedCorrectness: 0.75,
        weightedAccuracy: 1,
        reliability: 0.15,
        score: 0.4285714285714286,
        provisional: true,
      },
      {
        agentId: "codex",
        domain: "runtime",
        counts: { claims: 3, verdictsRecorded: 3, verdictsReversed: 0, activeVerdicts: 3, pending: 0, correct: 1, partial: 1, incorrect: 1, trustedCorrect: 1, trustedPartial: 1, trustedIncorrect: 1, unresolved: 0, void: 0, independentlyResolved: 3, independentRounds: 3, advisoryResolved: 0 },
        weightedResolvedEvidence: 2.75,
        weightedCorrectness: 1.375,
        weightedAccuracy: 0.5,
        reliability: 0.55,
        score: 0.2418011102528389,
        provisional: true,
      },
      {
        agentId: "claude",
        domain: "runtime",
        counts: { claims: 3, verdictsRecorded: 3, verdictsReversed: 0, activeVerdicts: 3, pending: 0, correct: 2, partial: 1, incorrect: 0, trustedCorrect: 2, trustedPartial: 1, trustedIncorrect: 0, unresolved: 0, void: 0, independentlyResolved: 3, independentRounds: 3, advisoryResolved: 0 },
        weightedResolvedEvidence: 2.25,
        weightedCorrectness: 1.875,
        weightedAccuracy: 0.8333333333333334,
        reliability: 0.45,
        score: 0.5000000000000001,
        provisional: true,
      },
      {
        agentId: "gemini",
        domain: "runtime",
        counts: { claims: 3, verdictsRecorded: 3, verdictsReversed: 0, activeVerdicts: 3, pending: 0, correct: 2, partial: 1, incorrect: 0, trustedCorrect: 2, trustedPartial: 1, trustedIncorrect: 0, unresolved: 0, void: 0, independentlyResolved: 3, independentRounds: 3, advisoryResolved: 0 },
        weightedResolvedEvidence: 2.75,
        weightedCorrectness: 2.375,
        weightedAccuracy: 0.8636363636363636,
        reliability: 0.55,
        score: 0.5646565659091034,
        provisional: true,
      },
      {
        agentId: "codex",
        domain: "ux",
        counts: { claims: 2, verdictsRecorded: 2, verdictsReversed: 0, activeVerdicts: 2, pending: 0, correct: 1, partial: 1, incorrect: 0, trustedCorrect: 1, trustedPartial: 1, trustedIncorrect: 0, unresolved: 0, void: 0, independentlyResolved: 2, independentRounds: 2, advisoryResolved: 0 },
        weightedResolvedEvidence: 1.75,
        weightedCorrectness: 1.375,
        weightedAccuracy: 0.7857142857142857,
        reliability: 0.35,
        score: 0.41345482701595027,
        provisional: true,
      },
      {
        agentId: "claude",
        domain: "ux",
        counts: { claims: 2, verdictsRecorded: 2, verdictsReversed: 0, activeVerdicts: 2, pending: 0, correct: 1, partial: 0, incorrect: 1, trustedCorrect: 0, trustedPartial: 0, trustedIncorrect: 1, unresolved: 0, void: 0, independentlyResolved: 1, independentRounds: 1, advisoryResolved: 1 },
        weightedResolvedEvidence: 0.75,
        weightedCorrectness: 0,
        weightedAccuracy: 0,
        reliability: 0.15,
        score: 0,
        provisional: true,
      },
      {
        agentId: "gemini",
        domain: "research",
        counts: { claims: 2, verdictsRecorded: 2, verdictsReversed: 0, activeVerdicts: 2, pending: 0, correct: 1, partial: 0, incorrect: 1, trustedCorrect: 1, trustedPartial: 0, trustedIncorrect: 1, unresolved: 0, void: 0, independentlyResolved: 2, independentRounds: 2, advisoryResolved: 0 },
        weightedResolvedEvidence: 2,
        weightedCorrectness: 1,
        weightedAccuracy: 0.5,
        reliability: 0.4,
        score: 0.21132486540518713,
        provisional: true,
      },
    ],
  },
  duels: {
    eventCount: 60,
    ratedDuelCount: 10,
    activeTotal: 2,
    ratingsTotal: 5,
    recentTotal: 1,
    active: [
      {
        duelId: "duel-runtime-cache-001",
        status: "awaiting_commitments",
        challengerId: "codex",
        challengedId: "claude",
        domain: "runtime",
        proposition: "The cache hydration race is caused by the stale generation check, not by duplicate transport delivery.",
        evidenceContract: "Reproduce with the focused concurrency test, then inspect the ordered runtime receipts.",
        sharedEvidencePacket: "Focused concurrency test: 40/40 passes. Ordered receipts show the second logical append starts only after the first durable append completes.",
        adjudicatorType: "human",
        adjudicatorId: "local-user",
        createdBy: "hydra-runtime",
        ratingPolicy: "elo-v3-agent-initiated",
        rated: true,
        capabilityPolicy: "hydra-duel-full-native-v1",
        commitmentCount: 1,
      },
      {
        duelId: "duel-legacy-no-packet-001",
        status: "awaiting_acceptance",
        challengerId: "claude",
        challengedId: "gemini",
        domain: "requirements",
        proposition: "This pre-upgrade challenge has no locked shared evidence packet.",
        evidenceContract: "Legacy operator notes only.",
        adjudicatorType: "human",
        adjudicatorId: "local-user",
        rated: false,
        commitmentCount: 0,
      },
    ],
    ratings: [
      { agentId: "codex", domain: "security", rating: 1064, wins: 4, draws: 1, losses: 1, ratedMatches: 6, provisional: false },
      { agentId: "claude", domain: "security", rating: 1000, wins: 2, draws: 1, losses: 3, ratedMatches: 6, provisional: false },
      { agentId: "gemini", domain: "security", rating: 936, wins: 2, draws: 0, losses: 4, ratedMatches: 6, provisional: false },
      { agentId: "gemini", domain: "research", rating: 1016, wins: 1, draws: 0, losses: 0, ratedMatches: 1, provisional: true },
      { agentId: "codex", domain: "research", rating: 984, wins: 0, draws: 0, losses: 1, ratedMatches: 1, provisional: true },
    ],
    recent: [
      {
        duelId: "duel-security-path-001",
        status: "resolved",
        challengerId: "codex",
        challengedId: "claude",
        domain: "security",
        proposition: "The reported path escape remains exploitable after normalization because the containment check occurs before decoding.",
        evidenceContract: "Run the agreed traversal fixture against the patched path boundary.",
        sharedEvidencePacket: "Traversal fixture: ../CLAUDE.md rejected; /identity/self.md rejected; knowledge/safe.md accepted. Build and focused guard tests pass.",
        adjudicatorType: "human",
        adjudicatorId: "local-user",
        createdBy: "hydra-runtime",
        ratingPolicy: "elo-v3-agent-initiated",
        rated: true,
        capabilityPolicy: "hydra-duel-full-native-v1",
        commitmentCount: 2,
        commitments: [
          { agentId: "codex", captureType: "agent-call", captureRef: "agent-call:preview-codex-security", agentReceipt: { agentKind: "codex", model: "gpt-5", transport: "oneShot", sharedEvidenceSha256: "a".repeat(64), capabilityPolicy: "hydra-duel-full-native-v1" }, answer: "Yes. The decode step reintroduces a parent segment after the early check.", confidence: 0.88 },
          { agentId: "claude", captureType: "agent-call", captureRef: "agent-call:preview-claude-security", agentReceipt: { agentKind: "claude", model: "claude-sonnet", transport: "oneShot", sharedEvidenceSha256: "a".repeat(64), capabilityPolicy: "hydra-duel-full-native-v1" }, answer: "No. The normalized path remains inside the allowlisted prefix.", confidence: 0.72 },
        ],
        resolution: {
          outcome: "challengerWin",
          winnerId: "codex",
          rationale: "The agreed traversal fixture escaped the prefix after decoding.",
          ratingDeltas: { codex: 12, claude: -12 },
          source: "human",
          adjudicatorId: "local-user",
          evidenceRef: "human:local-user:2026-07-14T20:00:00.000Z",
        },
      },
    ],
  },
  autoAdvanceActionableDefaults: false,
  latestVerification: {},
  verificationSummary: "passed: compile, 246 tests, extension host",
  verificationRunning: false,
  latestNativeAction: undefined,
  nativeActionSummary: "No native actions yet",
  recentNativeActions: [],
  nativeActionsCount: 0,
  workspaceChanges: [
    { status: "M", kind: "modified", path: "src/panel.ts" },
    { status: "A", kind: "added", path: "docs/architecture/001-runtime-state-boundaries.md" },
  ],
  workspaceChangesCount: 2,
  workQueue: [
    {
      id: "queue-1",
      kind: "decision",
      severity: "info",
      title: "Choose scoreboard rollout",
      detail: "Identity -> passive ledger -> adjudication -> bounded influence -> duels",
      actionLabel: "Accept",
      actionType: "acceptDefaultDecision",
    },
  ],
  latestDoctorReport: undefined,
  autopilotRunning: false,
  autopilotSummary: "Ready",
  needsCodexPath: false,
  needsClaudePath: false,
};

const bootstrap = `(() => {
  const state = ${JSON.stringify(previewState)};
  let persisted = {};
  window.acquireVsCodeApi = () => ({
    getState: () => persisted,
    setState: (next) => { persisted = next || {}; },
    postMessage: (message) => {
      if (message && message.type === "ready") {
        setTimeout(() => window.postMessage(state, "*"), 0);
        return;
      }
      window.dispatchEvent(new CustomEvent("hydra-preview-action", { detail: message }));
    },
  });
})();`;

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", origin).pathname;
    if (pathname === "/" || pathname === "/index.html") {
      return send(response, 200, "text/html; charset=utf-8", previewHtml());
    }
    if (pathname === "/preview-bootstrap.js") {
      return send(response, 200, "text/javascript; charset=utf-8", bootstrap);
    }
    if (pathname === "/webview.js") {
      return send(response, 200, "text/javascript; charset=utf-8", await fs.readFile(path.join(workspaceRoot, "media", "webview.js")));
    }
    const headMatch = /^\/media\/hydra-heads\/([a-z-]+\.png)$/.exec(pathname);
    if (headMatch) {
      return send(response, 200, "image/png", await fs.readFile(path.join(workspaceRoot, "media", "hydra-heads", headMatch[1])));
    }
    return send(response, 404, "text/plain; charset=utf-8", "Not found");
  } catch (error) {
    return send(response, 500, "text/plain; charset=utf-8", error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Hydra webview preview: ${origin}/`);
  console.log("Press Ctrl+C to stop.");
});

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function pathToFileUrl(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return `file:///${normalized.replace(/^\/+/, "")}`;
}
