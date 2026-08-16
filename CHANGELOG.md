# Changelog

All notable changes to dutybell are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-08-17

Initial release.

**Added**

- A daemon-less reliability layer over host cron/systemd timers: the engine lives in one module (`shared/dutybell/index.ts`) with zero runtime dependencies; the CLI is a single bundled ESM file (`dist/tools/dutybell.js`).
- Per-minute cron window iteration with exact `TZ:Area/City` wall-clock evaluation and UTC emission.
- Overlap policies per task: `skip`, `queue`, `run` — with per-task lock files (pid, start time, heartbeat) and TTL-based stale-lock recovery.
- Retries with configurable backoff (`--retry-max`, `--retry-backoff`, `--retry-maxwait`) and a hard command timeout (`--timeout`, default 10 min).
- Append-only JSONL ledger (`.dutybell/runs.jsonl`): every event — started, succeeded, failed, timedout, drift, catchup, retried, overlap-skipped, overlap-queued — plus corruption lines recorded as drift events instead of being dropped.
- Bounded catch-up: missed dues replay within a per-task window (`--catchup`, default 24 h); the backlog is hard-capped (`MAX_BACKLOG_DUES = 60`) and overflow is raised as drift instead of flooding the host.
- Clock-skew guard: any due time more than 5 min past the tick timestamp is a drift event, never silently executed.
- Advisory webhook notifications via `DUTYBELL_NOTIFY_URL` + per-task `--notify` policy (`none`, `failure`, `always`); notify failures never touch the exit code, and the CLI awaits notifications with a bounded window before exiting.
- Closed exit-code set: `0` ok, `1` operational failure, `2` drift — including the fail-closed case of zero registered duties.
- CLI commands: `init`, `add`, `list`, `run-now`, `tick`, `lock-status`, `log`, `doctor`; `--json` output; `--shell` explicit opt-in.
