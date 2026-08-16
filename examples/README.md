# dutybell examples

A hands-on walkthrough of the most important behaviors: registration, the reliability tick, catch-up after downtime, retries, overlap, and drift detection.

Run the walkthrough against the built CLI:

```bash
npm run build
export DB=node dist/tools/dutybell.js
```

Each scenario below uses a fresh temporary directory.

## 1. Register duties

```bash
mkdir -p /tmp/dutybell-demo && cd /tmp/dutybell-demo
$DB init
$DB add backup-nightly '0 3 * * *' /usr/local/bin/backup.sh
$DB add ping-hourly '5 * * * *' /usr/local/bin/ping.sh --retry-max 3 --retry-backoff 10000
$DB list
```

An empty registry is drift by policy ([ADR 0003](../docs/adr/0003-empty-registry-is-drift.md)), so `init` followed by at least one `add` is the required first step.

## 2. The reliability tick

```bash
$DB tick          # exit 0 — duties ran, ledger updated
$DB log           # append-only JSONL: started → succeeded per due minute
```

Put this in crontab once per minute:

```
* * * * * /usr/bin/node /opt/dutybell/dist/tools/dutybell.js tick
```

## 3. Catch-up after downtime

A duty with `--catchup 3600000` that missed ticks (host down, cron paused) replays due minutes on the next tick — bounded by its catch-up window, never a flood:

```bash
$DB add hourly '0 * * * *' /bin/echo duty-ran --shell --catchup 3600000
# simulate 40 lost minutes by ticking at :40 with an empty horizon:
$DB tick
```

The ledger shows the replayed dues as `catchup` events. Miss more than `MAX_BACKLOG_DUES` (60) and the excess becomes a single drift event instead of running.

## 4. Retries and the bell

```bash
$DB add flaky '*/2 * * * *' /bin/false --shell --retry-max 2 --retry-backoff 500
$DB tick
# exit 2: retries exhausted — drift 🔔
```

Every attempt is logged: `started → failed → retried → failed → drift`.

## 5. Overlap policy

```bash
# Plant a live lock (a long-running duty) and tick while it is held:
$DB add slow '* * * * *' 'sleep 60' --shell --overlap skip --lock-ttl 120000
$DB tick
# exit 0, ledger shows overlap-skipped — the next window decides again.
```

With `--overlap run` the duty executes regardless; with `--overlap queue` it runs immediately once the holder releases.

## 6. doctor — the health check

```bash
$DB doctor
```

Reports a never-ticked state, stale locks past their heartbeat TTL, unreadable ledger lines, and a `lastTickAt` older than 24 hours — the telltale of a silent cron failure.

## 7. Advisory webhook

```bash
export DUTYBELL_NOTIFY_URL=http://127.0.0.1:8899/hook
$DB add watched '* * * * *' /bin/false --shell --notify failure
$DB tick   # exit 2, and a POST lands on the endpoint with the drift payload
```

Notification never affects the verdict ([ADR 0004](../docs/adr/0004-advisory-notifier.md)).
