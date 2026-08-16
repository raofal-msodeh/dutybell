# Contributing to dutybell

Thank you for considering a contribution. dutybell is a small, deliberate project: every addition is judged against its fail-closed doctrine and its zero-runtime-dependency promise. Reading this guide before opening a pull request will save everyone time.

## How to get started

The build, tests, and typecheck are a single command:

```
pnpm install      # devDependencies only — nothing ships
npm run verify    # tsc --noEmit + vitest + esbuild
```

There is no `node_modules` in the distributed artifact. The CLI is bundled to `dist/tools/dutybell.js` by `build.mjs`; anything you change in `shared/` or `tools/` must be rebuilt and re-verified before you consider it done.

## What we will accept

1. **Bugs and drift cases.** If the ledger fails to record something, or a failure mode exits `0`, that is the highest-priority kind of contribution. Every bug fix needs a test that fails without the fix and passes with it.
2. **Documentation.** Clarifications to `README.md`, `docs/architecture.md`, or the ADRs — including reporting a threat the model does not cover.
3. **Small, focused features** that fit the fail-closed doctrine. See the rejection list below.

## What we will not accept

- New runtime dependencies of any kind. The engine imports only `node:*` built-ins.
- Anything that adds a daemon, a long-lived process, or a network listener to the host. dutybell is invoked per minute by cron and must not outlive its tick.
- Changes to the closed exit-code set (`0/1/2`). Drift detection is `2` by policy, including the empty-registry case.
- Silent degradation: any path that swallows an error, skips a ledger write, or lets a malformed state file produce a quiet `0` will be reverted on sight.

## Pull request process

1. Fork, branch off `main`, make your change.
2. Run `npm run verify` — green is the entry ticket.
3. Add tests under `tests/` for any behavior change; run `npx vitest` alone for speed.
4. If your change touches scheduling, locking, or exit codes, add or update an ADR under `docs/adr/` — decisions belong in the repo, not in PR comments.
5. Open the PR. Expect honest review; the doctrine is non-negotiable.

## Clean-clone audits

Releases are validated by cloning the published repository into a fresh directory with no caches, installing devDependencies there, running `npm run verify`, and re-smoking the CLI end to end. If a change would break that flow, it will not ship.
