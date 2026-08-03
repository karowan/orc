import { describe, expect, it } from "vitest";
import type {
  JournalRecord,
  RunManifest,
  TraceRecord,
} from "../src/contracts.js";
import { projectStatus } from "../src/status.js";

const manifest: RunManifest = {
  runId: "r_test",
  programPath: "/tmp/p.orc.ts",
  programSha256: "0".repeat(64),
  cwd: "/tmp",
  brief: "test",
  allowWrites: false,
  approvalMode: "auto",
  sandbox: false,
  sandboxDirs: [],
  networkAccess: false,
  maxParallel: 1,
  idleTimeoutMs: false,
  defaultHarness: "fake",
  createdAtMs: 1,
  orcVersion: "test",
};

describe("status projection across retries", () => {
  it("projects bounded stage artifacts, attempts, tool activity, logs, approvals, usage, and cost", () => {
    const journal: JournalRecord[] = [
      {
        t: "call",
        seq: 0,
        id: "draft",
        phase: "requirements",
        kind: "agent",
        readOnly: true,
        specDigest: "a",
      },
      { t: "attempt", seq: 0, attempt: 1, atMs: 10 },
      {
        t: "done",
        seq: 0,
        attempt: 1,
        status: "error",
        error: "retry me",
      },
      { t: "retry", seqs: [0], atMs: 20 },
      { t: "attempt", seq: 0, attempt: 2, atMs: 30 },
      {
        t: "cost",
        seq: 0,
        attempt: 2,
        costUsd: 0.2,
        costEstimated: false,
        atMs: 34,
      },
      {
        t: "done",
        seq: 0,
        attempt: 2,
        status: "ok",
        resultSha: "result",
      },
      { t: "finish", status: "completed", resultSha: "final" },
    ];
    const approval = {
      id: "approval-1",
      runId: manifest.runId,
      seq: 0,
      toolName: "example.document-gate",
      input: {},
      requestedAtMs: 31,
      presentation: {
        title: "Requirements approval",
        summary: "Review the requirements",
      },
      actions: [
        {
          id: "approve",
          label: "Approve",
          behavior: "allow" as const,
        },
      ],
    };
    const traces: TraceRecord[] = [
      {
        t: "program-meta",
        atMs: 1,
        meta: {
          graph: {
            nodes: [{ id: "requirements", title: "Requirements" }],
            edges: [],
          },
        },
      },
      {
        t: "event",
        atMs: 5,
        event: {
          kind: "phase",
          name: "requirements",
          state: "started",
          scope: 1,
        },
      },
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 1,
        status: "error",
        id: "draft",
        phase: "requirements",
        kind: "agent",
        harness: "codex",
        model: "gpt-test",
        readOnly: true,
        startMs: 10,
        endMs: 19,
        error: "retry me",
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.1,
        costEstimated: true,
        toolCalls: [
          {
            id: "tool-1",
            name: "read",
            status: "error",
            input: { path: "/tmp/one" },
            result: "x".repeat(3_000),
            startMs: 11,
            endMs: 12,
          },
        ],
      },
      {
        t: "leaf",
        seq: 0,
        attempt: 2,
        rev: 1,
        status: "ok",
        id: "draft",
        phase: "requirements",
        kind: "agent",
        harness: "claude",
        model: "claude-test",
        readOnly: true,
        startMs: 30,
        endMs: 39,
        tokensIn: 200,
        tokensOut: 40,
        costUsd: 0.19,
        costEstimated: false,
        output: { markdown: "done" },
        presentation: {
          output: {
            title: "Requirements",
            summary: "Generated requirements",
            documents: [
              {
                label: "Requirements",
                path: "/tmp/requirements.md",
                sha256: "a".repeat(64),
                mediaType: "text/markdown",
                content: "r".repeat(9_000),
              },
            ],
          },
        },
        toolCalls: [
          {
            id: "tool-2",
            name: "write",
            status: "ok",
            input: { path: "/tmp/requirements.md" },
            result: { bytes: 9_000 },
            startMs: 32,
            endMs: 33,
          },
        ],
      },
      {
        t: "hlog",
        seq: 0,
        atMs: 14,
        message: "native harness warning",
      },
      {
        t: "hlog",
        seq: 0,
        atMs: 15,
        message: "native harness warning",
      },
      {
        t: "event",
        atMs: 31,
        event: { kind: "approval-requested", approval },
      },
      {
        t: "event",
        atMs: 35,
        event: {
          kind: "approval-resolved",
          approvalId: approval.id,
          decision: { behavior: "allow", action: "approve" },
          by: "operator",
        },
      },
      {
        t: "event",
        atMs: 36,
        event: { kind: "log", message: "requirements accepted" },
      },
      {
        t: "event",
        atMs: 40,
        event: {
          kind: "phase",
          name: "requirements",
          state: "completed",
          scope: 1,
        },
      },
    ];

    const detail = projectStatus(manifest, journal, traces).detail;
    expect(detail?.metrics).toMatchObject({
      callCount: 1,
      attemptCount: 2,
      failedAttemptCount: 1,
      toolCallCount: 2,
      artifactCount: 1,
      logCount: 2,
      approvalCount: 1,
      tokensIn: 300,
      tokensOut: 60,
      costBasis: "mixed",
    });
    expect(detail?.metrics.costUsd).toBeCloseTo(0.3);
    expect(detail?.runLog).toEqual([
      {
        firstAtMs: 36,
        lastAtMs: 36,
        message: "requirements accepted",
        occurrences: 1,
      },
    ]);
    const stage = detail?.stages.find(
      (candidate) => candidate.phase === "requirements",
    );
    expect(stage?.metrics).toMatchObject({
      attemptCount: 2,
      toolCallCount: 2,
      artifactCount: 1,
      costBasis: "mixed",
      startedAtMs: 5,
      endedAtMs: 40,
    });
    expect(stage?.metrics.costUsd).toBeCloseTo(0.3);
    expect(stage?.attempts.map((attempt) => attempt.attempt)).toEqual([2, 1]);
    expect(stage?.attempts[1]?.toolCalls[0]?.result?.truncated).toBe(true);
    expect(stage?.artifacts[0]).toMatchObject({
      label: "Requirements",
      mediaType: "text/markdown",
      contentTruncated: true,
    });
    expect(stage?.logs).toEqual([
      {
        firstAtMs: 14,
        lastAtMs: 15,
        message: "native harness warning",
        occurrences: 2,
      },
    ]);
    expect(stage?.approvals).toEqual([
      expect.objectContaining({
        id: "approval-1",
        status: "allowed",
        action: "approve",
        actionLabel: "Approve",
      }),
    ]);
  });

  it("invalidates stale partial cost when an attempt becomes unpriceable", () => {
    const journal: JournalRecord[] = [
      {
        t: "call",
        seq: 0,
        phase: "implementation",
        kind: "agent",
        readOnly: true,
        specDigest: "a",
      },
      { t: "attempt", seq: 0, attempt: 1, atMs: 2 },
      {
        t: "cost",
        seq: 0,
        attempt: 1,
        costUsd: 0.25,
        costEstimated: true,
        atMs: 3,
      },
      {
        t: "cost",
        seq: 0,
        attempt: 1,
        costUsd: null,
        atMs: 4,
      },
      {
        t: "done",
        seq: 0,
        attempt: 1,
        status: "ok",
        resultSha: "result",
      },
      { t: "finish", status: "completed", resultSha: "final" },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 1,
        status: "ok",
        phase: "implementation",
        kind: "agent",
        readOnly: true,
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.25,
        costEstimated: true,
      },
    ];

    const detail = projectStatus(manifest, journal, traces).detail;
    expect(detail?.metrics).toMatchObject({
      tokensIn: 100,
      tokensOut: 20,
      costUnavailable: true,
    });
    expect(detail?.metrics).not.toHaveProperty("costUsd");
    expect(detail?.stages[0]?.metrics).toMatchObject({
      costUnavailable: true,
    });
    expect(detail?.stages[0]?.metrics).not.toHaveProperty("costUsd");
    expect(detail?.stages[0]?.attempts[0]?.usage).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      costUnavailable: true,
    });
  });

  it("projects a durable labeled graph from metadata and phase traces", () => {
    const journal: JournalRecord[] = [
      {
        t: "call",
        seq: 0,
        id: "draft",
        phase: "requirements",
        kind: "agent",
        readOnly: true,
        specDigest: "a",
      },
      {
        t: "done",
        seq: 0,
        attempt: 1,
        status: "ok",
        resultSha: "result",
      },
      {
        t: "call",
        seq: 1,
        id: "approve",
        phase: "requirements-approval",
        kind: "gate",
        readOnly: true,
        specDigest: "b",
      },
    ];
    const approval = {
      id: "approval-1",
      runId: manifest.runId,
      seq: 1,
      toolName: "gate",
      input: {},
      requestedAtMs: 5,
    };
    const traces: TraceRecord[] = [
      {
        t: "program-meta",
        atMs: 1,
        meta: {
          graph: {
            nodes: [
              { id: "requirements", title: "Requirements" },
              {
                id: "requirements-approval",
                title: "Approve requirements",
                kind: "gate",
              },
              { id: "implementation", title: "Implementation" },
            ],
            edges: [
              { from: "requirements", to: "requirements-approval" },
              { from: "requirements-approval", to: "implementation" },
              {
                from: "requirements-approval",
                to: "requirements",
                kind: "loop",
                label: "revise",
              },
            ],
          },
        },
      },
      {
        t: "event",
        atMs: 2,
        event: {
          kind: "phase",
          name: "requirements",
          state: "started",
          scope: 1,
        },
      },
      {
        t: "event",
        atMs: 3,
        event: {
          kind: "phase",
          name: "requirements",
          state: "completed",
          scope: 1,
        },
      },
      {
        t: "event",
        atMs: 4,
        event: {
          kind: "phase",
          name: "requirements-approval",
          state: "started",
          scope: 2,
        },
      },
      {
        t: "event",
        atMs: 5,
        event: { kind: "approval-requested", approval },
      },
    ];

    expect(projectStatus(manifest, journal, traces).graph).toEqual({
      nodes: [
        {
          id: "requirements",
          title: "Requirements",
          state: "completed",
          visits: 1,
        },
        {
          id: "requirements-approval",
          title: "Approve requirements",
          kind: "gate",
          state: "waiting",
          visits: 1,
        },
        {
          id: "implementation",
          title: "Implementation",
          state: "pending",
          visits: 0,
        },
      ],
      edges: [
        {
          from: "requirements",
          to: "requirements-approval",
          traversals: 1,
        },
        {
          from: "requirements-approval",
          to: "implementation",
          traversals: 0,
        },
        {
          from: "requirements-approval",
          to: "requirements",
          kind: "loop",
          label: "revise",
          traversals: 0,
        },
      ],
    });
  });

  it("keeps a completed lifecycle phase completed after a handled leaf error", () => {
    const journal: JournalRecord[] = [
      {
        t: "call",
        seq: 0,
        phase: "review",
        kind: "agent",
        readOnly: true,
        specDigest: "a",
      },
      {
        t: "done",
        seq: 0,
        attempt: 1,
        status: "error",
        error: "handled by the program",
      },
      { t: "finish", status: "completed", resultSha: "final" },
    ];
    const traces: TraceRecord[] = [
      {
        t: "program-meta",
        atMs: 1,
        meta: {
          graph: {
            nodes: [{ id: "review", title: "Review" }],
            edges: [],
          },
        },
      },
      {
        t: "event",
        atMs: 2,
        event: {
          kind: "phase",
          name: "review",
          state: "started",
          scope: 1,
        },
      },
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 1,
        status: "error",
        phase: "review",
        kind: "agent",
        readOnly: true,
        error: "handled by the program",
      },
      {
        t: "event",
        atMs: 3,
        event: {
          kind: "phase",
          name: "review",
          state: "completed",
          scope: 1,
        },
      },
    ];

    expect(projectStatus(manifest, journal, traces).graph?.nodes[0]).toEqual({
      id: "review",
      title: "Review",
      state: "completed",
      visits: 1,
    });
  });

  it("completes a terminal outcome and persists branch and loop traversals", () => {
    const journal: JournalRecord[] = [
      { t: "finish", status: "completed", resultSha: "result" },
    ];
    const phase = (
      name: string,
      scope: number,
      startAt: number,
    ): TraceRecord[] => [
      {
        t: "event",
        atMs: startAt,
        event: { kind: "phase", name, state: "started", scope },
      },
      {
        t: "event",
        atMs: startAt + 1,
        event: { kind: "phase", name, state: "completed", scope },
      },
    ];
    const traces: TraceRecord[] = [
      {
        t: "program-meta",
        atMs: 1,
        meta: {
          graph: {
            nodes: [
              { id: "write", title: "Write" },
              { id: "commit", title: "Validate and commit" },
              { id: "publish", title: "Publish CR" },
              { id: "monitor", title: "Monitor CR" },
              { id: "address", title: "Address CR feedback" },
              {
                id: "done",
                title: "Done",
                kind: "terminal",
                terminalState: "completed",
              },
            ],
            edges: [
              { from: "write", to: "commit" },
              { from: "commit", to: "publish" },
              { from: "publish", to: "monitor" },
              { from: "monitor", to: "address", label: "Feedback received" },
              {
                from: "address",
                to: "commit",
                kind: "loop",
                label: "Amend and re-publish",
              },
              { from: "monitor", to: "done", label: "Merged" },
            ],
          },
        },
      },
      ...phase("write", 1, 2),
      ...phase("commit", 2, 4),
      ...phase("publish", 3, 6),
      ...phase("monitor", 4, 8),
      ...phase("address", 5, 10),
      ...phase("commit", 6, 12),
      ...phase("publish", 7, 14),
      ...phase("monitor", 8, 16),
      // A replay re-emits deterministic scope IDs and must not add visits.
      ...phase("write", 1, 18),
      ...phase("commit", 2, 20),
    ];

    const graph = projectStatus(manifest, journal, traces).graph;
    expect(graph?.nodes).toEqual([
      {
        id: "write",
        title: "Write",
        state: "completed",
        visits: 1,
      },
      {
        id: "commit",
        title: "Validate and commit",
        state: "completed",
        visits: 2,
      },
      {
        id: "publish",
        title: "Publish CR",
        state: "completed",
        visits: 2,
      },
      {
        id: "monitor",
        title: "Monitor CR",
        state: "completed",
        visits: 2,
      },
      {
        id: "address",
        title: "Address CR feedback",
        state: "completed",
        visits: 1,
      },
      {
        id: "done",
        title: "Done",
        kind: "terminal",
        terminalState: "completed",
        state: "completed",
        visits: 1,
      },
    ]);
    expect(graph?.edges).toEqual([
      { from: "write", to: "commit", traversals: 1 },
      { from: "commit", to: "publish", traversals: 2 },
      { from: "publish", to: "monitor", traversals: 2 },
      {
        from: "monitor",
        to: "address",
        label: "Feedback received",
        traversals: 1,
      },
      {
        from: "address",
        to: "commit",
        kind: "loop",
        label: "Amend and re-publish",
        traversals: 1,
      },
      {
        from: "monitor",
        to: "done",
        label: "Merged",
        traversals: 1,
      },
    ]);
  });

  it("skips an untaken remediation branch when the terminal completes", () => {
    const journal: JournalRecord[] = [
      { t: "finish", status: "completed", resultSha: "result" },
    ];
    const traces: TraceRecord[] = [
      {
        t: "program-meta",
        atMs: 1,
        meta: {
          graph: {
            nodes: [
              { id: "monitor", title: "Monitor" },
              { id: "address", title: "Address feedback" },
              {
                id: "done",
                title: "Done",
                kind: "terminal",
                terminalState: "completed",
              },
            ],
            edges: [
              { from: "monitor", to: "address" },
              { from: "monitor", to: "done" },
            ],
          },
        },
      },
      {
        t: "event",
        atMs: 2,
        event: {
          kind: "phase",
          name: "monitor",
          state: "started",
          scope: 1,
        },
      },
      {
        t: "event",
        atMs: 3,
        event: {
          kind: "phase",
          name: "monitor",
          state: "completed",
          scope: 1,
        },
      },
    ];

    const graph = projectStatus(manifest, journal, traces).graph;
    expect(graph?.nodes).toEqual([
      {
        id: "monitor",
        title: "Monitor",
        state: "completed",
        visits: 1,
      },
      {
        id: "address",
        title: "Address feedback",
        state: "skipped",
        visits: 0,
      },
      {
        id: "done",
        title: "Done",
        kind: "terminal",
        terminalState: "completed",
        state: "completed",
        visits: 1,
      },
    ]);
    expect(graph?.edges).toEqual([
      { from: "monitor", to: "address", traversals: 0 },
      { from: "monitor", to: "done", traversals: 1 },
    ]);
  });

  it("attributes a merged target only to the latest incoming branch", () => {
    const journal: JournalRecord[] = [
      { t: "finish", status: "completed", resultSha: "result" },
    ];
    const phase = (
      name: string,
      scope: number,
      startAt: number,
    ): TraceRecord[] => [
      {
        t: "event",
        atMs: startAt,
        event: { kind: "phase", name, state: "started", scope },
      },
      {
        t: "event",
        atMs: startAt + 1,
        event: { kind: "phase", name, state: "completed", scope },
      },
    ];
    const traces: TraceRecord[] = [
      {
        t: "program-meta",
        atMs: 1,
        meta: {
          graph: {
            nodes: [
              { id: "monitor", title: "Monitor" },
              { id: "address", title: "Address feedback" },
              { id: "publish", title: "Publish" },
              {
                id: "done",
                title: "Done",
                kind: "terminal",
                terminalState: "completed",
              },
            ],
            edges: [
              { from: "monitor", to: "publish", label: "No feedback" },
              { from: "monitor", to: "address", label: "Feedback received" },
              { from: "address", to: "publish" },
              { from: "publish", to: "done" },
            ],
          },
        },
      },
      ...phase("monitor", 1, 2),
      ...phase("address", 2, 4),
      ...phase("publish", 3, 6),
    ];

    expect(projectStatus(manifest, journal, traces).graph?.edges).toEqual([
      {
        from: "monitor",
        to: "publish",
        label: "No feedback",
        traversals: 0,
      },
      {
        from: "monitor",
        to: "address",
        label: "Feedback received",
        traversals: 1,
      },
      { from: "address", to: "publish", traversals: 1 },
      { from: "publish", to: "done", traversals: 1 },
    ]);
  });

  it("shows the new running attempt without stale terminal fields", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "attempt", seq: 0, attempt: 1, atMs: 2 },
      { t: "done", seq: 0, attempt: 1, status: "error", error: "old failure" },
      { t: "finish", status: "failed", error: "old failure" },
      { t: "retry", seqs: [0], atMs: 3 },
      { t: "attempt", seq: 0, attempt: 2, atMs: 4 },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 2,
        rev: 0,
        status: "running",
        kind: "agent",
        readOnly: true,
        startMs: 4,
      },
    ];

    const status = projectStatus(manifest, journal, traces);
    expect(status.state).toBe("running");
    expect(status.error).toBeUndefined();
    expect(status.resultSha).toBeUndefined();
    expect(status.leaves[0]).toMatchObject({ status: "running", attempt: 2 });
    expect(status.leaves[0].error).toBeUndefined();
  });

  it("does not overlay an old attempt's timing after a new attempt starts", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "attempt", seq: 0, attempt: 1, atMs: 2 },
      { t: "done", seq: 0, attempt: 1, status: "error", error: "old failure" },
      { t: "attempt", seq: 0, attempt: 2, atMs: 4 },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 1,
        status: "error",
        kind: "agent",
        readOnly: true,
        startMs: 2,
        endMs: 3,
        error: "old failure",
      },
    ];

    const leaf = projectStatus(manifest, journal, traces).leaves[0];
    expect(leaf).toMatchObject({ status: "pending", attempt: 2 });
    expect(leaf.error).toBeUndefined();
    expect(leaf.startMs).toBeUndefined();
    expect(leaf.endMs).toBeUndefined();
  });

  it("keeps a re-armed leaf pending before its next attempt starts", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "attempt", seq: 0, attempt: 1, atMs: 2 },
      { t: "done", seq: 0, attempt: 1, status: "error", error: "old failure" },
      { t: "finish", status: "failed", error: "old failure" },
      { t: "retry", seqs: [0], atMs: 3 },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 1,
        status: "error",
        kind: "agent",
        readOnly: true,
        startMs: 2,
        endMs: 3,
        error: "old failure",
      },
    ];

    const status = projectStatus(manifest, journal, traces);
    expect(status.state).toBe("running");
    expect(status.leaves[0]).toMatchObject({ status: "pending", attempt: 1 });
    expect(status.leaves[0].error).toBeUndefined();
    expect(status.leaves[0].endMs).toBeUndefined();
  });

  it("does not let a same-attempt running trace override a durable completion", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "done", seq: 0, attempt: 1, status: "ok", resultSha: "result" },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 0,
        status: "running",
        kind: "agent",
        readOnly: true,
        startMs: 2,
      },
    ];

    expect(projectStatus(manifest, journal, traces).leaves[0]).toMatchObject({
      status: "ok",
      attempt: 1,
      resultSha: "result",
    });
  });
});
