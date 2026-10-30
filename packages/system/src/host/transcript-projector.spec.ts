import { describe, expect, it } from "vitest";
import type { HostToClientMessage } from "@morse/protocol";
import { TranscriptProjector } from "./transcript-projector.js";

const TICKS = [10, 20, 30, 40];
let next = 0;
const now = (): number => TICKS[next++ % TICKS.length];

describe("TranscriptProjector live compaction", () => {
  it("records a successful compaction as a marker row carrying the summary", () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({
      emit: (message) => emitted.push(message),
      now,
    });

    projector.apply({
      type: "agent/compaction",
      at: now(),
      summary: "## Summary\n\nBuilt the tree.",
      tokensBefore: 150_000,
    });
    const appends = emitted
      .filter(
        (
          message,
        ): message is Extract<
          HostToClientMessage,
          { type: "transcript/append" }
        > => message.type === "transcript/append",
      )
      .map((message) => message.payload);
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      kind: "compaction",
      summary: expect.stringContaining("Built the tree."),
      tokensBefore: 150_000,
    });
    expect(projector.snapshot()).toHaveLength(1);
  });

  it("keeps a summary-less marker without an empty summary field", () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({
      emit: (message) => emitted.push(message),
      now,
    });

    projector.apply({ type: "agent/compaction", at: now(), summary: "" });
    const appends = emitted
      .filter(
        (
          message,
        ): message is Extract<
          HostToClientMessage,
          { type: "transcript/append" }
        > => message.type === "transcript/append",
      )
      .map((message) => message.payload);
    expect(appends[0]).toMatchObject({ kind: "compaction" });
    expect("summary" in (appends[0] as Record<string, unknown>)).toBe(false);
  });
});

/**
 * pi never reports a per-tool duration, so the projector measures one from the
 * start it stamped — otherwise a finished turn can never say "Worked for Ns".
 */
describe("TranscriptProjector tool elapsed", () => {
  it("measures a duration when the event carries none", () => {
    const emitted: HostToClientMessage[] = [];
    let clock = 1_000;
    const projector = new TranscriptProjector({
      emit: (message) => emitted.push(message),
      now: () => clock,
    });

    projector.apply({
      type: "agent/tool-start",
      at: clock,
      toolCallId: "c1",
      name: "bash",
      title: "bash: npm test",
    });
    clock = 4_500;
    projector.apply({
      type: "agent/tool-end",
      at: clock,
      toolCallId: "c1",
      status: "ok",
      output: "done",
    });

    const item = projector.snapshot().find((entry) => entry.kind === "tool");
    expect(item).toMatchObject({
      kind: "tool",
      status: "ok",
      durationMs: 3_500,
    });
  });

  it("keeps a duration the event did report", () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({
      emit: (message) => emitted.push(message),
      now: () => 0,
    });

    projector.apply({
      type: "agent/tool-start",
      at: 0,
      toolCallId: "c1",
      name: "read",
      title: "read: a.ts",
    });
    projector.apply({
      type: "agent/tool-end",
      at: 0,
      toolCallId: "c1",
      status: "ok",
      durationMs: 42,
    });

    expect(
      projector.snapshot().find((entry) => entry.kind === "tool"),
    ).toMatchObject({
      durationMs: 42,
    });
  });

  it("carries a tool\u2019s structured details so a frontend can probe its shape", () => {
    const projector = new TranscriptProjector({ emit: () => {}, now: () => 0 });
    projector.apply({
      type: "agent/tool-start",
      at: 0,
      toolCallId: "c1",
      name: "anything",
      title: "anything",
    });
    projector.apply({
      type: "agent/tool-end",
      at: 0,
      toolCallId: "c1",
      status: "ok",
      details: { tasks: [{ id: 1, subject: "Do it", status: "pending" }] },
    });

    const item = projector.snapshot().find((entry) => entry.kind === "tool");
    expect(item).toMatchObject({
      details: { tasks: [{ id: 1, subject: "Do it", status: "pending" }] },
    });
  });

  it("leaves details absent when a tool returned only text", () => {
    const projector = new TranscriptProjector({ emit: () => {}, now: () => 0 });
    projector.apply({
      type: "agent/tool-start",
      at: 0,
      toolCallId: "c1",
      name: "bash",
      title: "bash: ls",
    });
    projector.apply({
      type: "agent/tool-end",
      at: 0,
      toolCallId: "c1",
      status: "ok",
      output: "a.ts",
    });

    const item = projector.snapshot().find((entry) => entry.kind === "tool");
    expect(
      item && "details" in item ? item.details : undefined,
    ).toBeUndefined();
  });
});
/**
 * A tool row that spawned a session (a subagent run) carries the link to it so
 * the frontend can open the child's transcript from the row. The link can land
 * at start, with a progress report, or with the end — whenever the engine first
 * learns the child exists — and each later report wins, so a row never keeps a
 * stale or missing link when the engine knows better.
 */
describe("TranscriptProjector child session link", () => {
  function toolAppends(emitted: HostToClientMessage[]) {
    return emitted.flatMap((message) =>
      message.type === "transcript/append" ||
      message.type === "transcript/update"
        ? [message.payload]
        : [],
    );
  }

  it("carries the child announced at start", () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({
      emit: (m) => emitted.push(m),
      now,
    });
    projector.apply({
      type: "agent/tool-start",
      at: now(),
      toolCallId: "call-1",
      name: "task",
      title: "explore",
      childSession: { sessionId: "child-a", agent: "explore" },
    });

    expect(toolAppends(emitted)[0]).toMatchObject({
      kind: "tool",
      child: { sessionId: "child-a", agent: "explore" },
    });
  });

  it("attaches the child when a later update names it", () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({
      emit: (m) => emitted.push(m),
      now,
    });
    projector.apply({
      type: "agent/tool-start",
      at: now(),
      toolCallId: "call-1",
      name: "task",
      title: "t",
    });
    projector.apply({
      type: "agent/tool-update",
      at: now(),
      toolCallId: "call-1",
      childSession: { sessionId: "child-a" },
    });

    const rows = toolAppends(emitted).filter((item) => item.kind === "tool");
    expect(rows.at(-1)).toMatchObject({ child: { sessionId: "child-a" } });
  });

  it("keeps two parallel children apart, each on its own row", () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({
      emit: (m) => emitted.push(m),
      now,
    });
    projector.apply({
      type: "agent/tool-start",
      at: now(),
      toolCallId: "a",
      name: "task",
      title: "one",
      childSession: { sessionId: "child-a" },
    });
    projector.apply({
      type: "agent/tool-start",
      at: now(),
      toolCallId: "b",
      name: "task",
      title: "two",
      childSession: { sessionId: "child-b" },
    });

    const rows = toolAppends(emitted).filter((item) => item.kind === "tool");
    expect(
      rows.map(
        (row) => (row as { child?: { sessionId: string } }).child?.sessionId,
      ),
    ).toEqual(["child-a", "child-b"]);
  });
});
