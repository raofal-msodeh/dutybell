# dutybell

Fail-closed, offline-first reliability for scheduled tasks. dutybell wraps your host cron (or systemd timers) in a small, daemon-less reliability layer: each minute it computes exactly which duties are due, enforces overlap policies, retries with backoff, and writes every event to an append-only ledger. When the tick exits, the exit code is the verdict — `0` ok, `1` operational failure, `2` drift, bell included.

> A nightwatch for your cron jobs: it does not sleep, it does not guess, and it never answers `0` when the duties were not fulfilled.

## Why

A cron entry is a promise with no memory. If the host goes down, the cron fires late, or a job runs long and overlaps its successor, nobody tells you — until the missed deadline does. dutybell remembers every minute a duty was due, replays what it can within a bounded catch-up window, rings a bell (exit `2` plus a webhook when configured) on what it cannot, and fails closed when it cannot verify anything at all — including when its own registry is empty.

## Install

No runtime dependencies. Build once, run anywhere Node 20+ is present.

```
pnpm install        # devDependencies only
npm run build       # → dist/tools/dutybell.js (single ESM file)
```

Or vendor `dist/tools/dutybell.js` directly into any project — it is one auditable file with a `node:*`-only import set.

## Quick start

```bash
# 1. Initialize the state directory (plain text, git-trackable)
node dist/tools/dutybell.js init

# 2. Register duties — the bell emoji warns when --shell opts in
node dist/tools/dutybell.js add backup-nightly '0 3 * * *' /usr/local/bin/backup.sh
node dist/tools/dutybell.js add ping-hourly '5 * * * *' /usr/local/bin/ping.sh \
  --notify failure --retry-max 3 --retry-backoff 10000 --catchup 7200000

# 3. Put this in crontab (once per minute)
* * * * * /usr/bin/node /opt/dutybell/dist/tools/dutybell.js tick
```

When cron misses a tick — power loss, paused host, broken cron — the next tick replays the due minutes inside each duty's catch-up window. Missed dues beyond the window, and any run that exhausts its retries, ring the bell:

```
dutybell: duty backup-nightly → drift 🔔 (drift: due window exhausted retries)
```

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Create `.dutybell/`; idempotent — never clobbers existing state. |
| `add <id> <cron> <command>...` | Register a duty. Optional flags below. |
| `list` | Show registered duties and their policies. |
| `run-now <id>` | Execute a duty immediately, outside the schedule. |
| `tick` | The reliability tick — invoke once per minute from cron. |
| `lock-status <id>` | Report a duty's lock (held, stale, reason). |
| `log` | Tail the append-only ledger. |
| `doctor` | Health-check the state: cold starts, stale locks, corrupt lines, silent cron. |

## Duty flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--overlap skip \| queue \| run` | `skip` | Behavior when a due window arrives with the duty still running. |
| `--retry-max N` | `1` | Attempts per due window. |
| `--retry-backoff <ms>` | `1000` | Backoff base between attempts. |
| `--retry-maxwait <ms>` | `60000` | Backoff cap per tick. |
| `--timeout <ms>` | `600000` | Hard per-run cap. |
| `--notify always \| failure \| none` | `none` | Advisory webhook (requires `DUTYBELL_NOTIFY_URL`). |
| `--shell` | off | Run the command through the host shell — explicit opt-in, warned. |
| `--lock-ttl <ms>` | `3600000` | Heartbeat expiry for stale-lock recovery. |
| `--catchup <ms>` | `86400000` | How far back missed dues replay after downtime. |
| `--tz <iana>` | — | Force a wall-clock timezone on the cron expression. |
| `--json` | off | Machine-readable output (`list`, `tick`). |

Cron is standard 5-field syntax; prefix with `TZ:Area/City` for wall-clock scheduling evaluated in that zone and emitted as UTC.

## Exit codes (fail-closed)

| Code | Verdict |
| --- | --- |
| `0` | Every due duty completed within its attempts and window. |
| `1` | Operational failure — dutybell itself could not function. |
| `2` | Drift — the duties were not fulfilled, or could not be verified (including an empty registry — see [ADR 0003](docs/adr/0003-empty-registry-is-drift.md)). |

## Design

dutybell is invoked per minute and owns no process beyond the tick. Scheduling is exact per-minute window iteration over a persisted per-duty horizon, bounded by three protections: a per-duty catch-up window (default 24 h), a hard backlog cap of 60 due minutes (overflow is one drift event, not a flood of processes), and a clock-skew guard that refuses to execute dues more than 5 minutes in the future.

Everything is plain text under `.dutybell/` — `tasks.json`, `state.json`, `locks/*.lock`, and the append-only `runs.jsonl` — so the entire history is auditable with `git diff` and recoverable from version control.

The full architecture, failure matrix, and threat model (T1–T6) live in [docs/architecture.md](docs/architecture.md); the four governing decisions are under [docs/adr](docs/adr/).

## Notify

Set `DUTYBELL_NOTIFY_URL` and a duty's `--notify` policy to receive a POST with `{ taskId, runId, event, attempts, ... }` on the final outcome of a due window. Notification is advisory: it never changes the exit code, and a failing endpoint is never retried beyond the attempt budget ([ADR 0004](docs/adr/0004-advisory-notifier.md)).

## Development

```
npm run verify   # typecheck + tests + build
npm test         # vitest only
```

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md); releases are validated by clean-clone audits in a fresh directory with no caches.

## License

MIT — see [LICENSE](LICENSE).
