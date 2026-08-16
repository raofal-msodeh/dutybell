# Security

## Reporting

If you find a security vulnerability in dutybell, contact **raofal-msodeh** via the contact on the repository profile. Do not open a public issue for a vulnerability — a tracked issue is visible to everyone while the fix ships.

## What dutybell is

dutybell is a reliability layer for scheduled tasks. It does not defend your host from its own cron jobs; it makes their behavior auditable, bounded, and fail-closed. Its threat model is documented in `docs/architecture.md` (T1–T6) and summarized below.

## Attack surface and mitigations

dutybell spawns the commands registered in `.dutybell/tasks.json`, exactly as cron would. The additional surface it introduces — and the mitigations it applies — are listed in this table.

| Threat | Mitigation |
| --- | --- |
| T1: command injection via task definition | `tasks.json` is only written by the CLI (`dutybell add`); the ledger never feeds a shell. `--shell` is an explicit opt-in, printed at `add` time. |
| T2: state tampering (editing `tasks.json`) | State files are plain text by design (auditable), but every read is validated: malformed tasks, locks, or ledger lines raise operational failures or drift events — never silent misbehavior. |
| T3: lock-file races between concurrent ticks | Per-task `.lock` files carry a pid, a start time, and a heartbeat; the holder must be a live process within the TTL, otherwise the lock is recovered as drift. |
| T4: host clock skew / backward jumps | A due time more than `CLOCK_SKEW_MAX_MS` (5 min) beyond the tick timestamp is raised as a drift event, never silently executed. |
| T5: flood of missed runs after downtime | The backlog is capped per task (`MAX_BACKLOG_DUES`, default 60); excess dues become a recorded drift event instead of a storm of spawned processes. |
| T6: notification exfiltration | Webhook notification is advisory only and requires explicit `DUTYBELL_NOTIFY_URL` and a per-task `--notify` policy. Notify failures never alter the exit code. |

## What dutybell does not do

dutybell is not a sandbox and does not drop privileges. It runs commands with the same authority as the cron job that invokes it. It is a nightwatch, not a wall: it rings the bell when duties drift, and it fails closed (exit 2) when it cannot verify that they ran.
