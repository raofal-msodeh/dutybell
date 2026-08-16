# dutybell — architecture, failure matrix, and threat model

dutybell is a daemon-less reliability layer for scheduled tasks on a single host. Host cron (or a systemd timer) invokes `dutybell tick` once per minute. Each tick evaluates the due window of every registered duty, enforces the overlap policy, spawns the command with retries and a hard timeout, and appends every event to an append-only JSONL ledger. When the tick exits, its code is the verdict: `0` ok, `1` operational failure, `2` drift. Silence is never the answer — a silent cron failure is the loudest drift of all.

All state lives as plain text under `.dutybell/` and is fully auditable with `git diff`.

## Components

| Component | File(s) | Responsibility |
| --- | --- | --- |
| Registry | `tasks.json` | Duties: id, cron (5 fields, optional `TZ:` wall-clock prefix), command, overlap policy, retry, timeout, notify policy, lock TTL, catch-up window. |
| State | `state.json` | Per-duty last-due horizon and last exit, plus the last tick timestamp. This is how each minute's window stays exact even when ticks are lost. |
| Locks | `locks/<id>.lock` | Per-duty lock with pid, start time, and heartbeat. Evaluated against `lockTtlMs` to distinguish a live holder from a stale one. |
| Engine | `shared/dutybell/index.ts` | Scheduling, due-window math, overlap decisions, spawning, retries, ledger writes, drift analysis. Zero runtime dependencies. |
| Ledger | `runs.jsonl` | Append-only event log. Corruption is recorded as a drift event, never dropped silently. |
| Notifier | webhook | Advisory POST to `DUTYBELL_NOTIFY_URL`, gated by per-duty `--notify` policy. Failure is advisory; it never alters the exit code. |
| CLI | `tools/dutybell.ts` | `init add list run-now tick lock-status log doctor` — one command per duty of care. |

## The due window

Each duty's due minutes are the intersection of its cron and the half-open window `(lastDue, now]`, where `lastDue` is persisted per tick. On the very first tick the window defaults to `(now − catchup − 1min, now]`, bounded by the duty's `maxCatchUpMs`. Matching iterates per minute so every due minute is an exact wall-clock event — including inside `TZ:` schedules, which are evaluated in local wall time and emitted as UTC.

Three protections bound that window in the real world:

1. **Backlog cap.** A duty whose window exceeds `MAX_BACKLOG_DUES` (60) records a *backlog overflow drift event* and runs nothing. After days of downtime the operator sees one ledger entry, not a storm of processes.
2. **Clock-skew guard.** A due time more than `CLOCK_SKEW_MAX_MS` (5 min) past the tick timestamp is drift, never execution.
3. **Empty window is fine.** If `lastDue` sits ahead of `now` (a clock jump forward then back), the window is empty and the tick is quiet — no invented events.

## Overlap policies and locking

A duty's lock is held by a live process (`process.kill(pid, 0)`) whose heartbeat is within `lockTtlMs`. When a due minute arrives with the lock held, the policy decides: `skip` records an overlap-skipped event and moves on; `queue` releases and immediately runs; `run` runs regardless. A stale lock (dead holder or expired heartbeat) is recovered: the duty runs and the recovery is itself a drift event, because a stale lock means the previous host never told the truth about finishing.

## Failure matrix

| Code | Meaning | When |
| --- | --- | --- |
| `0` | ok | Every due duty completed within its attempts and window. |
| `1` | operational | The tool itself could not function: malformed state it cannot recover, spawn not found with no retry path, an unresolvable internal error. |
| `2` | drift | The duties are not being fulfilled: a duty exhausted retries, backlog overflow, stale lock recovery, clock skew, an unreadable ledger line, or — by policy — zero registered duties. |

The matrix is closed: no other code is ever emitted, and `2` always includes a bell emoji on the human output so a silent CI log still rings.

## Threat model

| # | Threat | Mitigation |
| --- | --- | --- |
| T1 | Host cron never runs the tick (cron stopped, machine down) | Catch-up window replays missed dues on the first subsequent tick; backlog overflow caps the flood; `doctor` flags a `lastTickAt` older than 24 h. |
| T2 | A duty runs long and overlaps the next window | Per-duty lock + overlap policy; stale locks recovered as drift. |
| T3 | State file tampered or reverted (old git checkout, manual edit) | Every read is validated; malformed tasks/locks/ledger lines surface as operational failures or drift events; `doctor` enumerates them. |
| T4 | Malicious command in the registry | `tasks.json` is only written by the CLI; `--shell` is an explicit, warned opt-in at `add` time. |
| T5 | Webhook exfiltration or leak | Notify is advisory and opt-in per duty and globally; the notifier never blocks the exit code; secrets are never written to the ledger. |
| T6 | Clock skew / DST transitions | TZ schedules evaluate wall time and emit UTC; due times beyond the skew threshold are drift, never executed. |

## Design decisions

See `docs/adr/`: daemon-less invocation (0001), the closed exit-code set (0002), the empty registry as drift (0003), and the advisory notifier (0004).
