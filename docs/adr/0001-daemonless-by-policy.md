# ADR 0001 — Daemon-less by policy: the host cron is the daemon

## Status

Accepted.

## Context

A scheduled task that depends on a long-lived supervisor inherits the supervisor's failure modes: the daemon itself can die silently, its restart policy can mask that death, and its state can diverge from the cron schedule it was meant to protect. Small teams rarely notice that their scheduler died until a deadline passes quietly.

## Decision

dutybell has no process that outlives a tick. Host cron (or a systemd timer) invokes `dutybell tick` once per minute; the tick evaluates dues, runs what is due, writes the ledger, and exits with a verdict code. Per-task state is a small JSON file; locks are short-lived files with a pid and heartbeat.

## Consequences

No daemon means no state drift between a running process and a persisted schedule — there is only ever persisted state. The cost is that every minute must be re-derived from the ledger, which is why the due window is computed from a persisted per-task `lastDue` horizon rather than from process memory.

## References

- systemd timer units and their `OnCalendar` semantics (the model cron job dutybell wraps)
