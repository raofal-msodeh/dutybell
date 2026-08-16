# ADR 0004 — The notifier is advisory and opt-in

## Status

Accepted.

## Context

Operators want to know when duties drift, and the natural answer is a webhook. But tying the reliability verdict to a network call corrupts the verdict: a reachable alerting endpoint becomes a prerequisite for a `0`, and an unreachable one manufactures drift from nothing. Notification failure is not duty failure.

## Decision

Notification is advisory and strictly opt-in at three levels: a duty's `--notify` policy (`none` by default), the `DUTYBELL_NOTIFY_URL` environment variable, and the CLI awaits pending notifies with a bounded window before exiting. A notify failure is never recorded as drift and never changes the exit code; it is swallowed after the attempt budget with no retry loop.

## Consequences

The exit code remains a pure statement about the duties themselves, which is the one number alerting integrations must trust. The webhook becomes a courtesy channel on top of that number — useful for chat rooms and dashboards, irrelevant for correctness.

## References

- The fail-closed doctrine permits optimism only where it cannot lie about the duties.
