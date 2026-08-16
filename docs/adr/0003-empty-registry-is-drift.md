# ADR 0003 — An empty registry is drift

## Status

Accepted.

## Context

A tool that schedules duties and then finds none registered has two options: exit `0` (nothing to do) or declare that something is wrong. Silence is the comfortable answer and the dangerous one — an empty registry usually means `init` was never run, the registry file was reverted, or the host was restored from a snapshot without its duties.

## Decision

`dutybell tick` with zero registered duties records a drift event ("no tasks registered") and exits `2`. `dutybell doctor` enumerates the same condition textually.

## Consequences

New deployments fail closed on their first tick until duties are registered, which surfaces missing configuration immediately instead of after the first missed deadline. The cost is one deliberate `2` during fresh setup; `doctor` explains it.

## References

- Fail-closed doctrine: assume the worst that evidence supports.
