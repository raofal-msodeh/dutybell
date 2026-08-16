// dutybell — The Nightwatch Ledger
// Fail-closed, offline-first reliability layer for scheduled tasks.
// Design ethos (see ideas.md): every tick writes to an append-only ledger;
// silence is an exception, and the bell is rung only on drift. State is
// plain auditable text under .dutybell/.
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

// ── types ────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  max: number; // max attempts per due window (1 = fire once)
  backoffMs: number; // base delay between attempts
  maxWaitMs: number; // hard cap on cumulative backoff within one tick
}

export type OverlapPolicy = "skip" | "queue" | "run";
export type NotifyWhen = "always" | "failure" | "none";

export interface TaskDef {
  id: string;
  cron: string; // 5-field cron expression (UTC-based, with optional `TZ:` prefix: "TZ:Europe/Berlin 0 2 * * *")
  command: string;
  args?: string[];
  shell?: boolean; // explicit opt-in for shell interpretation
  overlap?: OverlapPolicy;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  notify?: NotifyWhen;
  lockTtlMs?: number; // how long a lock may stay "alive" after last heartbeat before stale
  maxCatchUpMs?: number; // window of past due runs to backfill (default 24h)
  cwd?: string;
}

export interface Registry {
  version: 1;
  tasks: TaskDef[];
}

export type LedgerEvent =
  | "scheduled"
  | "started"
  | "failed"
  | "retried"
  | "succeeded"
  | "overlap-skipped"
  | "overlap-queued"
  | "catchup"
  | "timedout"
  | "drift"
  | "aborted";

export interface LedgerEntry {
  ts: string; // ISO
  runId: string;
  taskId: string;
  event: LedgerEvent;
  attempt: number;
  durationMs?: number;
  exitCode?: number | null;
  reason?: string;
  signal?: string;
}

export interface TickReport {
  exitCode: 0 | 1 | 2;
  reason?: string;
  evaluated: number; // tasks evaluated this tick
  started: number;
  succeeded: number;
  failed: number;
  drift: number; // drift events raised
  skipped: number;
  entries: LedgerEntry[];
  // Advisory notification promises the host SHOULD await before exiting —
  // they are excluded from the exit code on purpose.
  pendingNotifications?: Promise<NotifierResult>[];
}

// ── constants ─────────────────────────────────────────────────────────────

export const DUTYBELL_DIR = ".dutybell";
export const TASKS_FILE = "tasks.json";
export const LEDGER_FILE = "runs.jsonl";
export const LOCKS_DIR = "locks";
export const STATE_FILE = "state.json"; // monotonic last-tick bookkeeping

const DEFAULT_RETRY: RetryPolicy = { max: 1, backoffMs: 1000, maxWaitMs: 60000 };
const DEFAULT_LOCK_TTL_MS = 3600_000;
const DEFAULT_CATCHUP_MS = 86400_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const CLOCK_SKEW_MAX_MS = 300_000; // a tick evaluated more than this in the future is drift
const MAX_BACKLOG_DUES = 60; // per-task cap on catch-up runs in one tick; excess is drift
const MINUTE_MS = 60_000;
const TASK_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const CRON_FIELDS_RE =
  /^(TZ:[A-Za-z_][A-Za-z0-9_\/+-]+ )?(\*|[0-9]+|\*\/[0-9]+|[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*) (\*|[0-9]+|\*\/[0-9]+|[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*) (\*|[0-9]+|\*\/[0-9]+|[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*) (\*|[0-9]+|\*\/[0-9]+|[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*) (\*|[0-9]+|\*\/[0-9]+|[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)$/;

export class OperationalFailure extends Error {}
export class DriftFailure extends Error {}

// ── small pure helpers ────────────────────────────────────────────────────

export function validateTask(task: TaskDef): string | null {
  if (!TASK_ID_RE.test(task.id)) return `invalid task id: ${task.id}`;
  if (!CRON_FIELDS_RE.test(task.cron)) return `invalid cron for ${task.id}: ${task.cron}`;
  if (!task.command || !task.command.trim()) return `empty command for ${task.id}`;
  const ov = task.overlap;
  if (ov !== undefined && ov !== "skip" && ov !== "queue" && ov !== "run")
    return `invalid overlap for ${task.id}: ${ov}`;
  const n = task.notify;
  if (n !== undefined && n !== "always" && n !== "failure" && n !== "none")
    return `invalid notify for ${task.id}: ${n}`;
  return null;
}

export function normalizeRetry(p: Partial<RetryPolicy> | undefined): RetryPolicy {
  return {
    max: Math.max(1, Math.floor(p?.max ?? DEFAULT_RETRY.max)),
    backoffMs: Math.max(0, Math.floor(p?.backoffMs ?? DEFAULT_RETRY.backoffMs)),
    maxWaitMs: Math.max(0, Math.floor(p?.maxWaitMs ?? DEFAULT_RETRY.maxWaitMs)),
  };
}

/**
 * Enumerate every minute inside (horizonExclusive, nowInclusive] whose
 * wall clock satisfies the 5-field cron expression (TZ: prefix shifts
 * evaluation into the named wall clock, then converts back to UTC).
 * Exact and bounded by the window length — no "next-N" guessing.
 */
export function cronMatchTimes(cronSpec: string, now: Date, horizonExclusive: Date): Date[] {
  const m = CRON_FIELDS_RE.exec(cronSpec.trim());
  if (!m) throw new OperationalFailure(`unparseable cron: ${cronSpec}`);
  const tz = m[1] ? m[1].slice(3, m[1].length - 1) : undefined;
  const [minF, hourF, domF, monthF, dowF] = [m[2]!, m[3]!, m[4]!, m[5]!, m[6]!];

  const tzOffsetMs = tz ? tzOffsetAt(now, tz) : 0;

  function fieldMatches(field: string, value: number, min: number, max: number): boolean {
    if (field === "*") return true;
    if (/^\*\/(\d+)$/.test(field)) {
      const step = Number(field.slice(2));
      return value % step === min % step;
    }
    return field.split(",").some((part) => {
      if (/^(\d+)-(\d+)$/.test(part)) {
        const lo = Number(part.slice(0, part.indexOf("-")));
        const hi = Number(part.slice(part.indexOf("-") + 1));
        return value >= lo && value <= hi;
      }
      return Number(part) === value;
    });
  }

  // wall-clock minute index of the window start (exclusive) and end (inclusive)
  const startMinute = Math.floor((horizonExclusive.getTime() + tzOffsetMs) / MINUTE_MS);
  const endMinute = Math.floor((now.getTime() + tzOffsetMs) / MINUTE_MS);

  // minuteAbs is an index in the wall-clock minute axis (UTC-shifted).
  // The corresponding UTC epoch is naive-wall-epoch minus the offset — a
  // single subtraction performed inside wallClockInTz, never twice.
  const out: Date[] = [];
  for (let minuteAbs = startMinute + 1; minuteAbs <= endMinute; minuteAbs++) {
    const naiveWallMs = minuteAbs * MINUTE_MS;
    const utcMs = naiveWallMs - tzOffsetMs;
    // wallClockInTz reads wall-clock components from a NAIVE wall epoch
    // (one subtraction: wall → utc), so pass the naive epoch, not utcMs.
    const components = wallClockInTz(naiveWallMs, tzOffsetMs);
    const ok =
      fieldMatches(minF, components.minute, 0, 59) &&
      fieldMatches(hourF, components.hour, 0, 23) &&
      fieldMatches(domF, components.dom, 1, 31) &&
      fieldMatches(monthF, components.month, 1, 12) &&
      fieldMatches(dowF, components.dow, 0, 6);
    if (ok) out.push(new Date(utcMs));
  }
  return out;
}

interface WallComponents {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

function wallClockInTz(wallMs: number, tzOffsetMs: number): WallComponents {
  // wallMs is a NAIVE wall-clock epoch ("as if UTC"): its UTC parts are
  // exactly the wall-clock components — no offset arithmetic here.
  void tzOffsetMs;
  const d = new Date(wallMs);
  return {
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    dom: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    dow: d.getUTCDay(),
  };
}

// IANA TZ offset approximation: try to derive offset by evaluating the
// wall-clock of a UTC-naive date shifted, using Intl-based guess.
// We use a numerical search over candidate offsets and verify against
// Intl.DateTimeFormat to find the offset where the wall clock is consistent.
export function tzOffsetAt(date: Date, tz: string): number {
  const guessMin = -14 * 60;
  const guessMax = 14 * 60;
  // Start with the offset for this date (coarse): use a two-step refinement.
  let off = guessOffset(date, tz);
  // Refine: compute wall clock with off, then recompute offset at that wall time.
  for (let i = 0; i < 2; i++) {
    const wallMs = date.getTime() + off;
    off = guessOffset(new Date(wallMs - off), tz);
  }
  void guessMin;
  void guessMax;
  return off;
}

function guessOffset(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const h = Number(get("hour"));
  const m = Number(get("minute"));
  // hour is 12-based in 'numeric' for some locales; normalize by using 24h:
  // safer: use hourCycle h23 via locale option
  const parts2 = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const h23 = Number(parts2.find((p) => p.type === "hour")?.value ?? "0");
  const utcH = date.getUTCHours();
  let diffH = h23 - utcH;
  if (diffH > 12) diffH -= 24;
  if (diffH < -12) diffH += 24;
  return (diffH * 60 + m) * 60_000;
}

/** The set of due run-times for a task whose last scheduled wall time was
 *  `lastDue`. Due times are computed from the last-known tick horizon so
 *  catch-up windows are exact per-minute slices. */
export function dueTimesFor(task: TaskDef, now: Date, lastDue: Date | null, maxCatchUpMs: number): Date[] {
  const horizon = lastDue ?? new Date(now.getTime() - maxCatchUpMs - MINUTE_MS);
  return cronMatchTimes(task.cron, now, horizon);
}

// ── ledger (append-only) ──────────────────────────────────────────────────

export function ensureDirs(root: string): void {
  mkdirSync(join(root, DUTYBELL_DIR), { recursive: true });
  mkdirSync(join(root, DUTYBELL_DIR, LOCKS_DIR), { recursive: true });
}

export function readRegistry(root: string): Registry {
  const path = join(root, DUTYBELL_DIR, TASKS_FILE);
  if (!existsSync(path)) {
    return { version: 1, tasks: [] };
  }
  const raw = readFileSync(path, "utf8").trim();
  try {
    const reg = JSON.parse(raw) as Registry;
    if (!reg || reg.version !== 1 || !Array.isArray(reg.tasks)) {
      throw new OperationalFailure(`malformed ${TASKS_FILE}`);
    }
    for (const t of reg.tasks) {
      const err = validateTask(t as TaskDef);
      if (err) throw new OperationalFailure(err);
    }
    return reg;
  } catch (e) {
    if (e instanceof OperationalFailure) throw e;
    throw new OperationalFailure(`cannot parse ${TASKS_FILE}: ${(e as Error).message}`);
  }
}

export function writeRegistry(root: string, reg: Registry): void {
  const path = join(root, DUTYBELL_DIR, TASKS_FILE);
  writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
}

export function appendLedger(root: string, entry: LedgerEntry): void {
  const path = join(root, DUTYBELL_DIR, LEDGER_FILE);
  const line = JSON.stringify(entry) + "\n";
  if (!existsSync(path)) writeFileSync(path, line);
  else {
    const tmp = path + ".tmp";
    let existing: string;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = "";
    }
    writeFileSync(tmp, existing + line);
    renameSync(tmp, path);
  }
}

export function readLedger(root: string, limit = 500): LedgerEntry[] {
  const path = join(root, DUTYBELL_DIR, LEDGER_FILE);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const entries: LedgerEntry[] = [];
  for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    try {
      entries.push(JSON.parse(l) as LedgerEntry);
    } catch {
      // ledger corruption is drift — recorded rather than silently dropped
      entries.push({
        ts: new Date().toISOString(),
        runId: "corrupt",
        taskId: "unknown",
        event: "drift",
        attempt: 0,
        reason: `ledger line ${i + 1} unreadable`,
      });
    }
  }
  return entries;
}

// ── lock file ─────────────────────────────────────────────────────────────

export interface LockState {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export function lockPath(root: string, taskId: string): string {
  return join(root, DUTYBELL_DIR, LOCKS_DIR, `${taskId}.lock`);
}

export function readLock(root: string, taskId: string): LockState | null {
  const path = lockPath(root, taskId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const st = JSON.parse(raw) as LockState;
    if (!st || typeof st.pid !== "number" || !st.startedAt || !st.heartbeatAt) {
      throw new OperationalFailure(`malformed lock ${taskId}`);
    }
    return st;
  } catch (e) {
    if (e instanceof OperationalFailure) throw e;
    throw new OperationalFailure(`unreadable lock ${taskId}: ${(e as Error).message}`);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when a lock genuinely represents a running sibling (process alive).
 *  A stale lock (dead pid or expired ttl) is reported as stale with reason. */
export function lockStatus(
  root: string,
  taskId: string,
  lockTtlMs: number,
  now: number,
): { held: true; stale: false } | { held: false; stale: true; reason: string } {
  const st = readLock(root, taskId);
  if (!st) return { held: false, stale: true, reason: "no-lock" };
  const heldByPid = pidAlive(st.pid);
  const ttlExpired = now - new Date(st.heartbeatAt).getTime() > lockTtlMs;
  if (heldByPid && !ttlExpired) return { held: true, stale: false };
  const reason = heldByPid ? "lock-ttl-expired" : "dead-holder";
  return { held: false, stale: true, reason };
}

export function acquireLock(root: string, taskId: string, pid: number, now: Date): void {
  const path = lockPath(root, taskId);
  writeFileSync(path, JSON.stringify({
    pid,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
  }) + "\n");
}

export function releaseLock(root: string, taskId: string): void {
  const path = lockPath(root, taskId);
  if (existsSync(path)) unlinkSync(path);
}

// ── spawner ───────────────────────────────────────────────────────────────

export interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

export function runCommand(
  command: string,
  args: string[],
  opts: { shell?: boolean; timeoutMs?: number; cwd?: string },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const started = Date.now();
    let cp: ChildProcess;
    let settled = false;
    const finish = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      cp = spawn(command, args, {
        shell: opts.shell === true,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cwd: opts.cwd,
      });
    } catch (e) {
      finish({ exitCode: null, signal: `spawn:${(e as Error).message}`, timedOut: false, durationMs: Date.now() - started });
      return;
    }
    cp.on("error", (err) => {
      finish({ exitCode: null, signal: `spawn:${(err as NodeJS.ErrnoException).code ?? err.message}`, timedOut: false, durationMs: Date.now() - started });
    });
    cp.on("exit", (code, signal) => {
      finish({ exitCode: code, signal, timedOut: false, durationMs: Date.now() - started });
    });
    cp.on("timeout", () => {
      cp.kill("SIGKILL");
      finish({ exitCode: null, signal: "SIGKILL", timedOut: true, durationMs: Date.now() - started });
    });
  });
}

// ── state.json (last-due bookkeeping, monotonic) ─────────────────────────

export interface TickState {
  lastTickAt: string | null;
  perTask: Record<string, { lastDue: string | null; lastExit: "ok" | "drift" | "failed" | null }>;
}

export function readState(root: string): TickState {
  const path = join(root, DUTYBELL_DIR, STATE_FILE);
  if (!existsSync(path)) return { lastTickAt: null, perTask: {} };
  try {
    const st = JSON.parse(readFileSync(path, "utf8")) as TickState;
    if (!st || typeof st !== "object") throw new OperationalFailure("malformed state");
    return st;
  } catch (e) {
    if (e instanceof OperationalFailure) throw e;
    throw new OperationalFailure(`unreadable state: ${(e as Error).message}`);
  }
}

export function writeState(root: string, st: TickState): void {
  const path = join(root, DUTYBELL_DIR, STATE_FILE);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(st) + "\n");
  renameSync(tmp, path);
}

// ── notifier ──────────────────────────────────────────────────────────────

export interface NotifyPayload {
  ts: string;
  root: string;
  runId: string;
  taskId: string;
  event: LedgerEvent;
  exitCode: number | null;
  reason?: string;
  attempt: number;
  durationMs?: number;
}

export interface NotifierResult {
  ok: boolean;
  attempts: number;
  lastError?: string;
}

const NOTIFIER_TIMEOUT_MS = 10_000;
const NOTIFIER_MAX_ATTEMPTS = 3;

export async function notifyWebhook(url: string, payload: NotifyPayload): Promise<NotifierResult> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= NOTIFIER_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(NOTIFIER_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, attempts: attempt };
      lastError = `http ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return { ok: false, attempts: NOTIFIER_MAX_ATTEMPTS, lastError };
}

export function shouldNotify(notify: NotifyWhen, event: LedgerEvent): boolean {
  if (notify === "none") return false;
  if (notify === "always") return true;
  return event === "failed" || event === "timedout" || event === "drift" || event === "aborted";
}

// ── tick: the heart of the ledger ────────────────────────────────────────

export interface TickOptions {
  now?: Date;
  runIdGen?: (taskId: string, attempt: number) => string;
}

let defaultTickCounter = 0;

export async function tick(root: string, opts: TickOptions = {}): Promise<TickReport> {
  const now = opts.now ?? new Date();
  const runIdGen =
    opts.runIdGen ??
    ((taskId: string, attempt: number) => {
      defaultTickCounter += 1;
      // Stable, host-portable id — never embed the working directory.
      return `${process.pid}-${Date.now().toString(36)}-${defaultTickCounter}-${taskId}-${attempt}`;
    });
  ensureDirs(root);
  const reg = readRegistry(root);
  if (reg.tasks.length === 0) {
    // fail-closed: an empty ledger of duties is itself drift.
    const entry: LedgerEntry = {
      ts: now.toISOString(),
      runId: runIdGen("registry", 0),
      taskId: "registry",
      event: "drift",
      attempt: 0,
      reason: "no tasks registered",
    };
    appendLedger(root, entry);
    return { exitCode: 2, reason: "no tasks registered", evaluated: 0, started: 0, succeeded: 0, failed: 0, drift: 1, skipped: 0, entries: [entry] };
  }

  const state = readState(root);
  const evaluated = reg.tasks.length;
  let started = 0;
  let succeeded = 0;
  let failed = 0;
  let drift = 0;
  let skipped = 0;
  const entries: LedgerEntry[] = [];
  const pendingNotifications: Promise<NotifierResult>[] = [];
  let operationalFail: string | undefined;

  for (const task of reg.tasks) {
    const ts = state.perTask[task.id] ?? { lastDue: null, lastExit: null };
    const maxCatchUp = task.maxCatchUpMs ?? DEFAULT_CATCHUP_MS;
    const dues = dueTimesFor(task, now, ts.lastDue ? new Date(ts.lastDue) : null, maxCatchUp);

    // clock skew check: nothing may be due more than one minute past now
    // plus tolerance — a due time that far in the future means the host
    // clock jumped backwards relative to our horizon.
    for (const due of dues) {
      if (due.getTime() - now.getTime() > CLOCK_SKEW_MAX_MS) {
        const e: LedgerEntry = {
          ts: now.toISOString(),
          runId: runIdGen(task.id, 0),
          taskId: task.id,
          event: "drift",
          attempt: 0,
          reason: `clock skew: due ${due.toISOString()} beyond tolerance`,
        };
        entries.push(e);
        appendLedger(root, e);
        drift += 1;
        ts.lastExit = "drift";
        break;
      }
    }

    // backlog flood guard: a huge catch-up set on first run (e.g. a
    // "* * * * *" duty registered after a long idle) must not detonate
    // hundreds of runs at once. Exceeding the cap is treated as drift.
    if (dues.length > MAX_BACKLOG_DUES) {
      const e: LedgerEntry = {
        ts: now.toISOString(),
        runId: runIdGen(task.id, 0),
        taskId: task.id,
        event: "drift",
        attempt: 0,
        reason: `backlog overflow: ${dues.length} due runs exceeds cap of ${MAX_BACKLOG_DUES}`,
      };
      entries.push(e);
      appendLedger(root, e);
      drift += 1;
      failed += 1;
      ts.lastExit = "drift";
      state.perTask[task.id] = ts;
      continue;
    }

    for (const due of dues) {
      const isCatchUp = dues.length > 1;
      if (isCatchUp) {
        const e: LedgerEntry = {
          ts: now.toISOString(),
          runId: runIdGen(task.id, 0),
          taskId: task.id,
          event: "catchup",
          attempt: 0,
          reason: `backfilling window ${due.toISOString()}`,
        };
        entries.push(e);
        appendLedger(root, e);
      }

      const retry = normalizeRetry(task.retry);
      const lockTtl = task.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
      let attempt = 0;
      let lastExitOk = false;
      let waited = 0;

      while (attempt < retry.max) {
        attempt += 1;
        const ls = lockStatus(root, task.id, lockTtl, now.getTime());

        if (attempt === 1 && ls.held && !ls.stale) {
          const policy: OverlapPolicy = task.overlap ?? "skip";
          if (policy === "skip") {
            const e: LedgerEntry = {
              ts: now.toISOString(),
              runId: runIdGen(task.id, attempt),
              taskId: task.id,
              event: "overlap-skipped",
              attempt,
              reason: "holder alive",
            };
            entries.push(e);
            appendLedger(root, e);
            skipped += 1;
            lastExitOk = false;
            break;
          }
          if (policy === "queue") {
            const e: LedgerEntry = {
              ts: now.toISOString(),
              runId: runIdGen(task.id, attempt),
              taskId: task.id,
              event: "overlap-queued",
              attempt,
              reason: "holder alive; will run after release",
            };
            entries.push(e);
            appendLedger(root, e);
            skipped += 1;
            lastExitOk = false;
            break;
          }
          // policy === 'run': continue to spawn (parallel)
        }

        if (attempt > 1) {
          const e: LedgerEntry = {
            ts: now.toISOString(),
            runId: runIdGen(task.id, attempt),
            taskId: task.id,
            event: "retried",
            attempt,
            reason: entries.length ? "previous attempt failed" : undefined,
          };
          entries.push(e);
          appendLedger(root, e);
        }

        if (ls.stale && ls.held === false && ls.reason !== "no-lock") {
          // stale lock: recover then continue — a stale lock is drift if
          // it exceeds ttl by more than CLOCK_SKEW_MAX_MS
          const e: LedgerEntry = {
            ts: now.toISOString(),
            runId: runIdGen(task.id, attempt),
            taskId: task.id,
            event: "drift",
            attempt,
            reason: `stale lock: ${ls.reason}`,
          };
          entries.push(e);
          appendLedger(root, e);
          drift += 1;
          // clear the stale lock before re-acquiring
          releaseLock(root, task.id);
        }

        acquireLock(root, task.id, process.pid, now);
        const runId = runIdGen(task.id, attempt);
        const start = Date.now();
        const eStarted: LedgerEntry = {
          ts: now.toISOString(),
          runId,
          taskId: task.id,
          event: "started",
          attempt,
        };
        entries.push(eStarted);
        appendLedger(root, eStarted);
        started += 1;

        const res = await runCommand(task.command, task.args ?? [], {
          shell: task.shell,
          timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          cwd: task.cwd ?? root,
        });
        const durationMs = res.durationMs;

        if (res.timedOut || res.signal) {
          const e: LedgerEntry = {
            ts: now.toISOString(),
            runId,
            taskId: task.id,
            event: res.timedOut ? "timedout" : "failed",
            attempt,
            durationMs,
            exitCode: res.exitCode,
            signal: res.signal ?? undefined,
            reason: res.timedOut ? "exceeded timeout" : `signal ${res.signal}`,
          };
          entries.push(e);
          appendLedger(root, e);
          lastExitOk = false;
          releaseLock(root, task.id);
          if (attempt < retry.max && waited + retry.backoffMs <= retry.maxWaitMs) {
            await new Promise((r) => setTimeout(r, retry.backoffMs));
            waited += retry.backoffMs;
            continue;
          }
          break;
        }

        if (res.exitCode === 0) {
          const e: LedgerEntry = {
            ts: now.toISOString(),
            runId,
            taskId: task.id,
            event: "succeeded",
            attempt,
            durationMs,
            exitCode: res.exitCode,
          };
          entries.push(e);
          appendLedger(root, e);
          succeeded += 1;
          lastExitOk = true;
          releaseLock(root, task.id);
          break;
        }

        const e: LedgerEntry = {
          ts: now.toISOString(),
          runId,
          taskId: task.id,
          event: "failed",
          attempt,
          durationMs,
          exitCode: res.exitCode,
        };
        entries.push(e);
        appendLedger(root, e);
        lastExitOk = false;
        releaseLock(root, task.id);
        if (attempt < retry.max && waited + retry.backoffMs <= retry.maxWaitMs) {
          await new Promise((r) => setTimeout(r, retry.backoffMs));
          waited += retry.backoffMs;
          continue;
        }
        break;
      }

      if (!lastExitOk) {
        failed += 1;
        drift += 1;
        const e: LedgerEntry = {
          ts: now.toISOString(),
          runId: runIdGen(task.id, attempt + 1),
          taskId: task.id,
          event: "drift",
          attempt,
          reason: "retries exhausted",
        };
        entries.push(e);
        appendLedger(root, e);
      }

      // Advisory notification for the final outcome of this due window —
      // only when the host opted in (DUTYBELL_NOTIFY_URL) and the task's
      // notify policy matches the final event. Notify failure must never
      // influence the exit code: the ledger is the source of truth.
      if (process.env.DUTYBELL_NOTIFY_URL) {
        const finalEvent = lastExitOk ? "succeeded" : "drift";
        if (shouldNotify(task.notify ?? "none", finalEvent)) {
          pendingNotifications.push(
            notifyWebhook(process.env.DUTYBELL_NOTIFY_URL, {
              ts: now.toISOString(),
              root,
              runId: runIdGen(task.id, attempt),
              taskId: task.id,
              event: finalEvent,
              exitCode: lastExitOk ? 0 : null,
              reason: lastExitOk ? undefined : "retries exhausted",
              attempt,
              durationMs: undefined,
            }).catch((e) => ({ ok: false, attempts: 0, lastError: (e as Error).message })),
          );
        }
      }

      ts.lastDue = due.toISOString();
      ts.lastExit = lastExitOk ? "ok" : drift > 0 ? "drift" : "failed";
    }

    state.perTask[task.id] = ts;
  }

  state.lastTickAt = now.toISOString();
  writeState(root, state);

  const exitCode: 0 | 1 | 2 = drift > 0 || skipped > 0 ? (operationalFail ? 1 : 2) : 0;
  return { exitCode, reason: operationalFail, evaluated, started, succeeded, failed, drift, skipped, entries, pendingNotifications };
}

export { dirname };
