// dutybell — The Nightwatch Ledger (CLI)
// Fail-closed, offline-first reliability layer for scheduled tasks.
// Design ethos: silence is an exception. Exits: 0 = ok, 1 = operational,
// 2 = drift. State is plain auditable text under .dutybell/.
import {
  appendLedger,
  cronMatchTimes,
  DUTYBELL_DIR,
  dueTimesFor,
  ensureDirs,
  lockStatus,
  normalizeRetry,
  OperationalFailure,
  DriftFailure,
  readLedger,
  readRegistry,
  readState,
  runCommand,
  shouldNotify,
  tick,
  validateTask,
  writeRegistry,
  type LedgerEntry,
  type LockState,
  type OverlapPolicy,
  type NotifyWhen,
  type Registry,
  type TaskDef,
} from "../shared/dutybell/index.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// ── arg parsing ────────────────────────────────────────────────────────────

interface ParsedArgs {
  pos: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a: string = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next: string | undefined = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[a.slice(2)] = next;
          i += 1;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

// The ledger root is the invocation directory itself — the engine helpers
// append .dutybell/ internally. dutybell is a project-local ledger, never
// installed-tool-global.
const rootDir = process.cwd();

// ── commands ───────────────────────────────────────────────────────────────

function usage(): string {
  return `dutybell — the nightwatch ledger for scheduled tasks

Usage:
  dutybell init                              create the .dutybell/ ledger root
  dutybell add <id> <cron> <command> [flags] register a watched duty
  dutybell list                              list registered duties
  dutybell run-now <id> [command]            fire a duty once, unconditionally
  dutybell tick                              evaluate due duties (call from cron)
  dutybell lock-status [id]                  report lock states
  dutybell log [--last N]                    read the append-only ledger
  dutybell doctor                            integrity check of the ledger

Add flags:
  --overlap   skip | queue | run    (default skip)
  --retry-max N                       attempts per due window (default 1)
  --retry-backoff <ms>                backoff base (default 1000)
  --retry-maxwait <ms>                backoff cap per tick (default 60000)
  --timeout <ms>                      per-run cap (default 600000)
  --notify    always | failure | none (default none)
  --shell                             run via shell (explicit opt-in)
  --lock-ttl <ms>                     stale-lock threshold (default 3600000)
  --catchup <ms>                      backfill window (default 86400000)
  --tz <iana>                         force a timezone on the cron

Exit codes: 0 ok · 1 operational failure · 2 drift (the bell was rung).
`;
}

function fail(message: string, code: 1 | 2 = 1): never {
  console.error(`dutybell: ${message}`);
  process.exit(code);
}

function cmdInit(): void {
  ensureDirs(rootDir);
  if (!existsSync(join(rootDir, DUTYBELL_DIR, "tasks.json"))) {
    writeRegistry(rootDir, { version: 1, tasks: [] });
  }
  console.log(`dutybell: initialized ${join(rootDir, DUTYBELL_DIR)}`);
  console.log("Add duties with `dutybell add`, then call `dutybell tick` from cron each minute.");
}

function cmdAdd(args: ParsedArgs): void {
  const [id, cron, ...rest] = args.pos;
  if (!id || !cron || rest.length === 0) fail("add requires <id> <cron> <command>...", 1);
  const command = rest.join(" ");
  const reg = readRegistry(rootDir);
  if (reg.tasks.some((t) => t.id === id)) fail(`task ${id} already registered`, 1);
  const tz = args.flags.tz;
  const cronSpec = typeof tz === "string" && !cron.startsWith("TZ:") ? `TZ:${tz} ${cron}` : cron;
  const task: TaskDef = {
    id,
    cron: cronSpec,
    command,
    overlap: args.flags.overlap as OverlapPolicy | undefined,
    shell: args.flags.shell === true || args.flags.shell === "true",
    notify: args.flags.notify as NotifyWhen | undefined,
    retry: {
      max: Number(args.flags["retry-max"] ?? 1),
      backoffMs: Number(args.flags["retry-backoff"] ?? 1000),
      maxWaitMs: Number(args.flags["retry-maxwait"] ?? 60000),
    },
    timeoutMs: args.flags.timeout ? Number(args.flags.timeout) : undefined,
    lockTtlMs: args.flags["lock-ttl"] ? Number(args.flags["lock-ttl"]) : undefined,
    maxCatchUpMs: args.flags.catchup ? Number(args.flags.catchup) : undefined,
  };
  const err = validateTask(task);
  if (err) fail(err, 1);
  if (task.shell) {
    console.error("dutybell: --shell opted in; the command will be interpreted by the host shell.");
  }
  reg.tasks.push(task);
  writeRegistry(rootDir, reg);
  console.log(`dutybell: registered ${id} (${cronSpec})`);
}

function cmdList(): void {
  const reg = readRegistry(rootDir);
  if (reg.tasks.length === 0) {
    console.log("dutybell: no duties registered — an empty ledger is drift.");
    return;
  }
  console.log(`dutybell: ${reg.tasks.length} registered dut${reg.tasks.length === 1 ? "y" : "ies"}`);
  for (const t of reg.tasks) {
    const r = normalizeRetry(t.retry);
    console.log(
      `  ${t.id.padEnd(22)} ${t.cron.padEnd(34)} ${(t.overlap ?? "skip").padEnd(7)} retry=${r.max} notify=${t.notify ?? "none"}${t.shell ? " shell" : ""}`,
    );
  }
}

async function cmdRunNow(args: ParsedArgs): Promise<void> {
  const id: string = args.pos[0]!;
  const reg = readRegistry(rootDir);
  const task = reg.tasks.find((t) => t.id === id);
  if (!task) fail(`unknown duty: ${id}`, 1);
  const override = args.pos.slice(1).join(" ");
  const command = override || task.command;
  const shell = args.flags.shell === true || args.flags.shell === "true" || task.shell === true;
  ensureDirs(rootDir);
  const ts = new Date();
  const runId = `${id}-manual-${Date.now()}`;
  appendLedger(rootDir, { ts: ts.toISOString(), runId, taskId: id, event: "started", attempt: 1 });
  const res = await runCommand(command, [], { shell, timeoutMs: task.timeoutMs, cwd: rootDir });
  const entry: LedgerEntry = (res.exitCode === 0 ? {
    ts: new Date().toISOString(), runId, taskId: id, event: "succeeded", attempt: 1, durationMs: res.durationMs, exitCode: 0,
  } : {
        ts: new Date().toISOString(),
        runId,
        taskId: id,
        event: res.timedOut || res.signal ? "timedout" : "failed",
        attempt: 1,
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        signal: res.signal ?? undefined,
        reason: res.timedOut ? "exceeded timeout" : res.signal ? `signal ${res.signal}` : `exit ${res.exitCode}`,
      }) as LedgerEntry;
  appendLedger(rootDir, entry);
  const notify = task.notify ?? "none";
  if (shouldNotify(notify, entry.event)) {
    const url = process.env.DUTYBELL_NOTIFY_URL;
    if (url) {
      const { notifyWebhook } = await import("../shared/dutybell/index.ts");
      await notifyWebhook(url, {
        ts: entry.ts,
        root: rootDir,
        runId,
        taskId: id,
        event: entry.event,
        exitCode: entry.exitCode ?? null,
        reason: entry.reason,
        attempt: entry.attempt,
        durationMs: entry.durationMs,
      });
    }
  }
  console.log(`dutybell: ${id} → ${entry.event} (exit ${entry.exitCode ?? "-"}${entry.durationMs !== undefined ? `, ${entry.durationMs}ms` : ""})`);
  if (entry.event !== "succeeded") process.exit(2);
}

async function cmdTick(args: ParsedArgs): Promise<void> {
  const json = args.flags.json === true || args.flags.json === "1" || process.env.DUTYBELL_JSON === "1";
  const report = await tick(rootDir);
  if (report.pendingNotifications?.length) {
    await Promise.allSettled(
      report.pendingNotifications.map((p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, attempts: 0, lastError: "timeout" }), 5000))])),
    );
  }
  if (json) {
    console.log(JSON.stringify(report));
    process.exit(report.exitCode);
  }
  const bell = report.drift > 0 || report.skipped > 0;
  console.log(
    `dutybell${bell ? " 🔔" : ""}: tick — evaluated ${report.evaluated}, started ${report.started}, succeeded ${report.succeeded}, failed ${report.failed}, skipped ${report.skipped}, drift ${report.drift}`,
  );
  if (report.reason) console.error(`dutybell: ${report.reason}`);
  console.log(`--- sealed at ${new Date().toISOString()} ---`);
  if (report.pendingNotifications?.length) {
    // Give advisory notifications a bounded window to land before exit.
    await Promise.allSettled(
      report.pendingNotifications.map((p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, attempts: 0, lastError: "timeout" }), 5000))])),
    );
  }
  process.exit(report.exitCode);
}

function cmdLockStatus(args: ParsedArgs): void {
  const reg = readRegistry(rootDir);
  const ids = args.pos.length > 0 ? args.pos : reg.tasks.map((t) => t.id);
  let anyHeld = false;
  for (const id of ids) {
    const task = reg.tasks.find((t) => t.id === id);
    if (!task) {
      console.log(`  ${id}: unknown duty`);
      continue;
    }
    const ls = lockStatus(rootDir, id, task.lockTtlMs ?? 3600_000, Date.now());
    if (ls.held) {
      const st = readFileSync(join(rootDir, DUTYBELL_DIR, "locks", `${id}.lock`), "utf8");
      const s = JSON.parse(st) as LockState;
      console.log(`  ${id}: held by pid ${s.pid} since ${s.startedAt}`);
      anyHeld = true;
    } else {
      console.log(`  ${id}: free (${ls.reason})`);
    }
  }
  if (!anyHeld && ids.length === 0) console.log("dutybell: no locks held");
}

function cmdLog(args: ParsedArgs): void {
  const last = args.flags.last ? Number(args.flags.last) : 20;
  const entries = readLedger(rootDir, last);
  if (entries.length === 0) {
    console.log("dutybell: ledger empty — no runs recorded yet.");
    return;
  }
  for (const e of entries) {
    const tag = e.event === "drift" || e.event === "failed" || e.event === "timedout" ? "!!" : "  ";
    console.log(
      `${tag} ${e.ts} ${e.event.padEnd(16)} ${e.taskId.padEnd(22)} attempt=${e.attempt}${e.exitCode !== undefined ? ` exit=${e.exitCode}` : ""}${e.reason ? ` (${e.reason})` : ""}`,
    );
  }
}

function cmdDoctor(): void {
  let problems = 0;
  const statePath = join(rootDir, DUTYBELL_DIR, "state.json");
  if (!existsSync(statePath)) {
    console.log("dutybell doctor: state.json missing — tick has never run; registering first tick as cold start.");
    problems += 1;
  }
  const reg = readRegistry(rootDir);
  for (const t of reg.tasks) {
    const ls = lockStatus(rootDir, t.id, t.lockTtlMs ?? 3600_000, Date.now());
    if (ls.held === false && ls.stale && ls.reason !== "no-lock") {
      console.log(`dutybell doctor: stale lock for ${t.id} (${ls.reason}) — next tick will recover it and ring the bell.`);
      problems += 1;
    }
  }
  const entries = readLedger(rootDir, 1000);
  const corrupt = entries.filter((e) => e.runId === "corrupt").length;
  if (corrupt > 0) {
    console.log(`dutybell doctor: ${corrupt} unreadable ledger line(s) recorded as drift events.`);
    problems += 1;
  }
  if (reg.tasks.length === 0) {
    console.log("dutybell doctor: NO duties registered — an empty ledger is drift by policy.");
    problems += 1;
  }
  const state = readState(rootDir);
  if (state.lastTickAt) {
    const horizon = Date.now() - new Date(state.lastTickAt).getTime();
    if (horizon > 24 * 3600_000) {
      console.log(`dutybell doctor: last tick ${Math.floor(horizon / 3600_000)}h ago — host cron may be silent.`);
      problems += 1;
    }
  }
  if (problems === 0) console.log("dutybell doctor: ledger healthy.");
  process.exit(problems > 0 ? 2 : 0);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] ?? "help";
  // Subcommand flags ride along with the subcommand's positional arguments —
  // never re-parse (that would strip the flags away).
  const rest: ParsedArgs = { pos: pos.slice(1), flags };

  try {
    switch (cmd) {
      case "help":
      case "-h":
      case "--help":
        console.log(usage());
        return;
      case "init":
        cmdInit();
        return;
      case "add":
        cmdAdd(rest);
        return;
      case "list":
        cmdList();
        return;
      case "run-now":
        await cmdRunNow(rest);
        return;
      case "tick":
        await cmdTick(rest);
        return;
      case "lock-status":
        cmdLockStatus(rest);
        return;
      case "log":
        cmdLog(rest);
        return;
      case "doctor":
        cmdDoctor();
        return;
      default:
        fail(`unknown command: ${cmd}\n\n${usage()}`, 1);
    }
  } catch (e) {
    if (e instanceof OperationalFailure) {
      console.error(`dutybell: operational failure — ${e.message}`);
      process.exit(1);
    }
    if (e instanceof DriftFailure) {
      console.error(`dutybell: drift detected — ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

main();
