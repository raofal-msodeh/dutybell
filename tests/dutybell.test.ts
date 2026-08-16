// dutybell — engine tests. Theme: the nightwatch ledger. Fail-closed by
// policy: silence (empty registry) is drift, backlog floods are drift,
// and notify failures never touch the exit code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLedger,
  cronMatchTimes,
  dueTimesFor,
  ensureDirs,
  lockStatus,
  normalizeRetry,
  readLedger,
  readRegistry,
  readState,
  shouldNotify,
  tick,
  validateTask,
  writeRegistry,
  type TaskDef,
} from "../shared/dutybell/index.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "dutybell-test-"));
}

function taskOf(overrides: Partial<TaskDef>): TaskDef {
  return {
    id: "d1",
    cron: "* * * * *",
    command: "/bin/sh",
    args: ["-c", "true"],
    ...overrides,
  };
}

let root = "";
beforeEach(() => (root = freshRoot()));
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── cron scheduling ─────────────────────────────────────────────────────────

describe("cronMatchTimes / dueTimesFor", () => {
  it("matches every minute inside the window, exact bounds", () => {
    const now = new Date("2026-08-17T01:00:00Z");
    const horizon = new Date("2026-08-16T23:00:00Z");
    const out = cronMatchTimes("* * * * *", now, horizon);
    expect(out).toHaveLength(120);
    expect(out[0]!.toISOString()).toBe("2026-08-16T23:01:00.000Z");
    expect(out[119]!.toISOString()).toBe("2026-08-17T01:00:00.000Z");
  });

  it("excludes the horizon minute (open lower bound)", () => {
    const now = new Date("2026-08-17T00:05:00Z");
    const horizon = new Date("2026-08-17T00:00:00Z");
    expect(cronMatchTimes("* * * * *", now, horizon)).toHaveLength(5);
    expect(cronMatchTimes("* * * * *", now, horizon)[0]!.toISOString()).toBe(
      "2026-08-17T00:01:00.000Z",
    );
  });

  it("parses step, range, list, and plain fields", () => {
    const now = new Date("2026-08-17T10:00:00Z");
    const horizon = new Date("2026-08-17T09:00:00Z");
    const out = cronMatchTimes("*/15 9-10 17 8 *", now, horizon);
    expect(out.map((d) => d.getMinutes())).toEqual([15, 30, 45, 0]);
  });

  it("rejects malformed cron with OperationalFailure", () => {
    expect(() => cronMatchTimes("garbage", new Date(), new Date(0))).toThrow(
      /unparseable cron/,
    );
  });

  it("evaluates TZ-prefixed cron in wall-clock time and returns UTC", () => {
    const now = new Date("2026-08-17T06:00:00Z"); // 09:00 Riyadh (+3)
    const horizon = new Date("2026-08-16T06:00:00Z"); // 09:00 Riyadh, day before
    const out = cronMatchTimes("TZ:Asia/Riyadh 0 9 * * *", now, horizon);
    expect(out).toHaveLength(1);
    expect(out[0]!.toISOString()).toBe("2026-08-17T06:00:00.000Z");
  });

  it("dueTimesFor catches up from last known due horizon", () => {
    const now = new Date("2026-08-17T01:00:00Z");
    const lastDue = new Date("2026-08-17T00:57:00Z");
    const dues = dueTimesFor(taskOf({ cron: "* * * * *" }), now, lastDue, 86_400_000);
    expect(dues.map((d) => d.toISOString())).toEqual([
      "2026-08-17T00:58:00.000Z",
      "2026-08-17T00:59:00.000Z",
      "2026-08-17T01:00:00.000Z",
    ]);
  });

  it("dueTimesFor without state uses the catch-up window", () => {
    const now = new Date("2026-08-17T00:10:00Z");
    // horizon = now - catchup - 1 minute → window (:58:00, :00:10]
    const dues = dueTimesFor(taskOf({ cron: "*/5 * * * *" }), now, null, 600_000);
    expect(dues.map((d) => d.toISOString())).toEqual([
      "2026-08-17T00:00:00.000Z",
      "2026-08-17T00:05:00.000Z",
      "2026-08-17T00:10:00.000Z",
    ]);
  });
});

// ── validation & retry normalization ────────────────────────────────────────

describe("validateTask / normalizeRetry", () => {
  it("accepts a well-formed task", () => {
    expect(validateTask(taskOf({}))).toBeNull();
  });

  it("rejects bad ids, cron, commands, overlap, notify", () => {
    expect(validateTask(taskOf({ id: "bad id!" }))).toMatch(/invalid task id/);
    expect(validateTask(taskOf({ command: "" }))).toMatch(/empty command/);
    expect(validateTask(taskOf({ overlap: "boom" as never }))).toMatch(/invalid overlap/);
    expect(validateTask(taskOf({ notify: "maybe" as never }))).toMatch(/invalid notify/);
  });

  it("normalizes retry with floors and caps", () => {
    const r = normalizeRetry({ max: -3, backoffMs: 0, maxWaitMs: -1 });
    expect(r.max).toBe(1);
    expect(r.backoffMs).toBe(0);
    expect(r.maxWaitMs).toBe(0);
  });
});

// ── the tick loop ───────────────────────────────────────────────────────────

describe("tick()", () => {
  function seed(...tasks: TaskDef[]): void {
    ensureDirs(root);
    writeRegistry(root, { version: 1, tasks });
  }

  it("returns drift when no duties are registered", async () => {
    ensureDirs(root);
    const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    expect(r.exitCode).toBe(2);
    expect(r.entries[0]!.event).toBe("drift");
  });

  it("runs due tasks to success with exit 0", async () => {
    seed(taskOf({ cron: "* * * * *", command: "/bin/sh", args: ["-c", "true"], maxCatchUpMs: 60_000 }));
    const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    // fresh state → window (23:58:00, 00:00:00] = two due minutes
    expect(r.exitCode).toBe(0);
    expect(r.started).toBe(2);
    expect(r.succeeded).toBe(2);
  });

  it("records failed + drift when the command exits non-zero without retries", async () => {
    seed(taskOf({ command: "/bin/sh", args: ["-c", "exit 7"], maxCatchUpMs: 60_000 }));
    const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    expect(r.exitCode).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.drift).toBe(2);
    const events = r.entries.map((e) => e.event);
    expect(events).toContain("started");
    expect(events).toContain("failed");
    expect(events).toContain("drift");
  });

  it("retries with backoff when allowed", async () => {
    seed(taskOf({ command: "/bin/sh", args: ["-c", "exit 7"], retry: { max: 3, backoffMs: 10, maxWaitMs: 60000 }, maxCatchUpMs: 60_000 }));
    const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    // two due minutes × three attempts each
    const starts = r.entries.filter((e) => e.event === "started").length;
    expect(starts).toBe(6);
    expect(r.drift).toBe(2);
  });

  it("caps the backlog flood as drift instead of executing it", async () => {
    seed(taskOf({ cron: "* * * * *" })); // full 24h default window = 1441 dues
    const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    expect(r.exitCode).toBe(2);
    const overflow = r.entries.find((e) => e.event === "drift" && /backlog overflow/.test(e.reason ?? ""));
    expect(overflow).toBeDefined();
    // nothing was actually spawned
    expect(r.started).toBe(0);
  });

  it("honors the state-driven second tick (idempotent when nothing due)", async () => {
    seed(taskOf({ cron: "0 3 * * *" })); // not due at 00:00
    const a = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    expect(a.exitCode).toBe(0);
    const b = await tick(root, { now: new Date("2026-08-17T00:00:01Z") });
    expect(b.started).toBe(0);
    expect(b.exitCode).toBe(0);
  });

  it("catches up missed runs within a bounded window", async () => {
    seed(taskOf({ cron: "*/5 * * * *", command: "/bin/sh", args: ["-c", "true"], maxCatchUpMs: 600_000 }));
    const r = await tick(root, { now: new Date("2026-08-17T00:10:00Z") });
    // horizon = now - 600_000 - 60_000 → window (:59:00, :00:10] → :00, :05, :10
    expect(r.succeeded).toBe(3);
    expect(r.started).toBe(3);
    expect(r.exitCode).toBe(0);
  });

  it("does not falsely drift when state horizon sits ahead of the host clock", async () => {
    // A lastDue ahead of now makes the due window empty — the engine must
    // stay quiet rather than invent drift events.
    seed(taskOf({ cron: "0 3 * * *" }));
    const st = readState(root);
    st.perTask["d1"] = { lastDue: "2026-08-17T03:05:00.000Z", lastExit: "ok" };
    writeFileSyncState(st);
    const r = await tick(root, { now: new Date("2026-08-17T03:00:00Z") });
    expect(r.exitCode).toBe(0);
    expect(r.drift).toBe(0);
  });

  it("recovers stale locks and counts them as drift", async () => {
    seed(taskOf({ command: "/bin/sh", args: ["-c", "true"], lockTtlMs: 1000, maxCatchUpMs: 60_000 }));
    // plant a stale lock (dead holder, heartbeat long past the ttl)
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".dutybell", "locks", "d1.lock"), JSON.stringify({
      pid: -1,
      startedAt: new Date(Date.now() - 7200_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 7200_000).toISOString(),
    }));
    const ls = lockStatus(root, "d1", 1000, Date.now());
    expect(ls.stale).toBe(true);
    const r = await tick(root, { now: new Date() });
    // each caught-up due minute surfaces one stale-lock drift and one success
    expect(r.drift).toBeGreaterThanOrEqual(1);
    expect(r.entries.some((e) => e.event === "drift" && /stale lock/.test(e.reason ?? ""))).toBe(true);
    expect(r.succeeded).toBeGreaterThanOrEqual(1);
  });

  it("overlap=skip skips a live holder", async () => {
    seed(taskOf({ command: "/bin/sh", args: ["-c", "sleep 0.2 && true"], overlap: "skip", maxCatchUpMs: 60_000 }));
    // start a tick, then overlap-check inside it via two concurrent ticks:
    // simpler — plant a fresh live lock (this pid alive, heartbeat fresh) before ticking.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".dutybell", "locks", "d1.lock"), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));
    const r = await tick(root, { now: new Date() });
    // every due minute lands overlap-skipped, nothing runs
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.started).toBe(0);
  });

  it("appends to the ledger and never rewrites history", async () => {
    seed(taskOf({ command: "/bin/sh", args: ["-c", "true"] }));
    await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    const before = readLedger(root, 1000);
    await tick(root, { now: new Date("2026-08-17T00:01:00Z") });
    const after = readLedger(root, 1000);
    expect(after.length).toBeGreaterThan(before.length);
    // original lines intact, unchanged
    for (const e of before) {
      expect(after.find((a) => a.ts === e.ts && a.runId === e.runId)).toEqual(e);
    }
  });

  it("tolerates a corrupt ledger line by recording it as drift", async () => {
    const { appendFileSync } = await import("node:fs");
    ensureDirs(root);
    appendFileSync(join(root, ".dutybell", "runs.jsonl"), "NOT JSON {{{\n");
    seed(taskOf({ command: "/bin/sh", args: ["-c", "true"], maxCatchUpMs: 60_000 }));
    // the corrupt line is surfaced by readLedger itself (engine records it
    // as a drift event in the report entries it returns).
    const lines = readLedger(root, 1000);
    expect(lines.find((e) => e.runId === "corrupt")).toBeDefined();
    const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    expect(r.exitCode).toBe(0);
    expect(r.succeeded).toBeGreaterThanOrEqual(1);
  });

  it("fires advisory webhooks on drift outcomes without affecting the exit", async () => {
    const notify = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    vi.stubGlobal("fetch", notify);
    vi.stubEnv("DUTYBELL_NOTIFY_URL", "https://example.test/hook");
    try {
      seed(taskOf({ command: "/bin/sh", args: ["-c", "exit 7"], notify: "failure", maxCatchUpMs: 60_000 }));
      const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
      // await the advisory promises the report exposes
      await Promise.all((r.pendingNotifications ?? []).map((p) => p));
      expect(r.exitCode).toBe(2);
      expect(notify.mock.calls.length).toBe(2); // two due windows, two drift outcomes
      const payload = JSON.parse(notify.mock.calls[0]![1]!.body);
      expect(payload.event).toBe("drift");
      expect(payload.taskId).toBe("d1");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("never notifies a none-policy task", async () => {
    const notify = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    vi.stubGlobal("fetch", notify);
    vi.stubEnv("DUTYBELL_NOTIFY_URL", "https://example.test/hook");
    seed(taskOf({ command: "/bin/sh", args: ["-c", "exit 7"], notify: "none" }));
    const r = await tick(root, { now: new Date("2026-08-17T00:00:00Z") });
    await Promise.all((r.pendingNotifications ?? []).map((p) => p));
    expect(notify).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});

function writeFileSyncState(st: ReturnType<typeof readState>): void {
  // small helper mirroring the engine's private write path
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  writeFileSync(join(root, ".dutybell", "state.json"), JSON.stringify(st));
}

// ── notify policy matrix ────────────────────────────────────────────────────

describe("shouldNotify", () => {
  it("maps the policy matrix", () => {
    expect(shouldNotify("none", "drift")).toBe(false);
    expect(shouldNotify("always", "succeeded")).toBe(true);
    expect(shouldNotify("failure", "failed")).toBe(true);
    expect(shouldNotify("failure", "drift")).toBe(true);
    expect(shouldNotify("failure", "timedout")).toBe(true);
    expect(shouldNotify("failure", "succeeded")).toBe(false);
    expect(shouldNotify("failure", "catchup")).toBe(false);
  });
});
