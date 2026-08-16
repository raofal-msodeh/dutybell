# ADR 0002 — A closed exit-code set: 0 ok, 1 operational, 2 drift

## Status

Accepted.

## Context

Cron jobs report failure through exit codes, but "failure" is ambiguous: did the task fail, or did the tool fail to check? A monitor consuming dutybell's exit code must never have to guess, and a third class of verdict — "the duties were not fulfilled" — must be distinguishable from "the tool broke."

## Decision

dutybell emits exactly three exit codes. `0` means every due duty completed within its attempts and window. `1` means dutybell itself could not function (malformed unrecoverable state, unresolvable internal error). `2` means drift: the duties are not being fulfilled — exhausted retries, backlog overflow, stale lock recovery, clock skew, unreadable ledger lines, or an empty registry.

## Consequences

CI, alerting, or a human tailing logs all read the same three numbers. No exit code is ever added without an ADR. The human output additionally rings a bell emoji on `2`, so a grep-free glance still hears the bell.

## References

- Precedent in cycle 7's `docprove` (0 proved / 1 operational / 2 drift), generalized here to scheduled duties.
