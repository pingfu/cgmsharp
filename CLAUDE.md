# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

cgmsharp is a continuous glucose monitoring (CGM) application that polls the LibreLinkUp API on a cron schedule, stores readings in InfluxDB, and sends push notifications via ntfy.sh across three channels (alert, canary, nudge) when glucose levels are critically high or low for extended periods.

## Build & Run

All application code lives in `src/`. There is no root-level package.json.

```bash
# Install dependencies
cd src && npm install

# Run locally (requires .env file in src/)
cd src && node app.js
# or: cd src && npm start

# Docker (development - builds from local source)
docker-compose -f docker-compose.dev.yml up

# Docker (production - pulls from ghcr.io)
docker-compose -f docker-compose.prod.yml up
```

There is no linter and no build step.

## Tests

The nudge engine has two test tools. Both use the same scenario JSON files and share the same engine profile. No actual notifications are dispatched, no API calls are made.

**Assertion tests** (`node:test`, built into Node 22 — zero dependencies):

```bash
# Build the test image (--no-cache ensures local source changes are picked up)
docker build --no-cache -t cgmsharp-test .

# Run assertion tests
docker run --rm -e TZ=Europe/London cgmsharp-test node --test test/nudge.test.js
```

**Scenario inspector** (visual debugging — prints every reading and marks which ones fired nudges):

```bash
# Inspect all scenarios
docker run --rm -e TZ=Europe/London cgmsharp-test node test/inspect-scenario.js

# Inspect a single scenario
docker run --rm -e TZ=Europe/London cgmsharp-test node test/inspect-scenario.js test/scenarios/2026-04-06-evening.json
```

Test scenarios live in `src/test/scenarios/` as JSON files. Each contains a name, description, optional `timezoneOffsetMinutes` (for converting stored UTC timestamps to local time), and an array of `{ time, reading }` pairs. Both tools create a fresh nudge engine per scenario with the individual's profile and feed each reading sequentially.

Dated scenarios (2025-*, 2026-*) use real InfluxDB data stored as UTC timestamps with `timezoneOffsetMinutes: 60` for BST conversion. Synthetic scenarios use local timestamps with no offset.

## Manual Notification Tests

Requires `src/.env` with the relevant credentials set. Build the test image first:

```bash
docker build --no-cache -t cgmsharp-test .
```

**ntfy** — `src/test-ntfy.js` sends a test notification to the first available `NTFY_TOPIC_*` in `.env` (`NTFY_TOPIC_ALERT`, `NTFY_TOPIC_CANARY`, or `NTFY_TOPIC_NUDGE`).

```bash
docker run --rm --env-file src/.env cgmsharp-test node test-ntfy.js
```

**Pushover** — `src/test-pushover.js` sends a test notification via Pushover. Requires `PUSHOVER_USER` and `PUSHOVER_TOKEN` in `.env`.

```bash
docker run --rm --env-file src/.env cgmsharp-test node test-pushover.js
```

## CI/CD

Pushing to `main` triggers `.github/workflows/docker-publish.yml`, which builds and pushes a Docker image to `ghcr.io/pingfu/cgmsharp/cgmsharp:latest`.

## Architecture

Node.js app with five source files:
- `src/app.js` — orchestrator: cron schedules, Tick loop, alarm sliding window, main()
- `src/librelinkup.js` — LibreLinkUp API client: authentication, reading retrieval, error counter, 401 handling
- `src/nudge.js` — nudge engine: insulin model, trend analysis, carb estimation, zone-based decision logic (maintains own readings buffer)
- `src/notifications.js` — notification transport: ntfy.sh, Pushover, SendAlert/SendCanary/SendNudge
- `src/influxdb.js` — InfluxDB client: initialisation, glucose writes, reconnection

Each module that needs glucose history maintains its own readings buffer. App.js passes each new reading to modules individually.

Three scheduled loops:

1. **Tick** (every 10 min) - Fetches glucose reading from LibreLinkUp API, writes to InfluxDB, evaluates sliding window of last 6 readings against critical thresholds (low: 3.5, high: 22 mmol/L), runs nudge engine evaluation
2. **Canary** (daily at 9 AM) - Sends a heartbeat notification to confirm the monitor is alive
3. **Startup** - Runs one immediate Tick and sends a startup notification

Three notification channels via ntfy.sh (each mapped to a separate ntfy topic). Alert and Canary also fan out to Pushover when configured:
- **Alert** (ntfy priority 5/max, Pushover priority 2/emergency with retry=30s, expire=5min) - Critical glucose alarms, API disruptions, fatal errors
- **Canary** (ntfy priority 2/low, Pushover priority -1/silent) - Daily heartbeat, startup notification
- **Nudge** (ntfy priority 3/default, ntfy only) - Proactive carb-guidance messages based on glucose trend, insulin activity, and time of day

Key behaviours:
- `clientVersion` is passed to the LibreLinkUp client via `LIBRE_AGENT_VERSION` env var (not defaulted from the library)
- After 6 consecutive LibreLinkUp API errors, a disruption notification is sent on the alert channel
- HTTP 401 from LibreLinkUp is treated as fatal (process exits) - usually means Abbott's EULA needs re-accepting in the mobile app
- InfluxDB is optional; if env vars are missing, it silently skips database writes
- InfluxDB auto-reconnects on timeout/connection errors

### Nudge Engine (`src/nudge.js`)

Designed for a type 1 diabetic on twice-daily premixed (biphasic) insulin. The user produces no insulin of their own — the injected insulin is the only insulin in their system, which means no natural reduction when BG drops and acute overnight hypo risk.

**Current patient regimen**:
- **Morning**: 12 units at 07:30 BST (covers breakfast + lunch + dawn phenomenon)
- **Evening**: 9 units at 19:00 BST (covers dinner + overnight)
- **Total**: 21 units/day, premixed 30% rapid + 70% intermediate

Extracted into its own module via `createNudgeEngine(config)` factory. App.js passes `SendNudge` as a callback so nudge.js has no dependency on the notification transport.

The engine uses zone-based decision logic (below target / in target / quiet zone / above threshold) combined with:
- **Trend** — two-timescale slope analysis (long-term 60 min + short-term 20 min) with acceleration detection
- **Insulin activity** — biphasic curve model (30% rapid + 70% intermediate, piecewise linear, threshold 0.25). Insulin counter-factor scales carb suggestions proportionally by current activity level.
- **Meal window** — suppresses carb suggestions for 120 min after injection times (covers eat-peak-settle cycle)
- **Absorption awareness** — after recommending carbs, suppresses repeat nudges until the food has had time to show in BG (20 min for ≤7g, 35 min for >7g), unless the situation materially worsens
- **Overnight quiet hours** — fully silent midnight–6 AM
- **Dawn phenomenon** — suppresses nudges during 4–10 AM rising BG
- **Calibrated carb estimation** — uses observed ratio of 4.4g per 1 mmol/L rise, with insulin counter-factor scaling and food suggestions from a tiered lookup table
- **Breakfast nudge** — one proactive message per morning (07:00-07:30) with carb guidance based on current BG. Calculates available room below targetHigh, suggests appropriately sized breakfast. If BG is already above target from dawn, suggests low-carb options (eggs, yoghurt). If well above (>14), suggests skipping carbs entirely.
- **Bedtime nudge** — one proactive message per evening (21:00-22:00) suggesting slow-release starchy carbs to sustain BG through the overnight insulin peak. Integrates insulin activity curve to estimate overnight drop. Includes timing advice (eat around half ten) and food order advice (eat fat/protein first, then carbs — delays glucose absorption 1-3h). Above-target readings get a conservative suggestion with explanation that overnight insulin will bring BG down.
- **Five food categories** — each with a distinct label used in every message so the recipient always knows what type of food is being recommended:
  - **Emergency** (`EMERGENCY_SUGGESTIONS`) — fast-acting sugar (jelly babies, honey, jam). Labelled **"fast-acting sugar"** in messages. Used for clinical hypo (≤5.0), urgent/accelerating drops, and below-target with active insulin.
  - **Normal** (`CARB_SUGGESTIONS`) — fruit, yoghurt, oatcakes, toast, porridge — mixed foods with protein/fat/fibre that raise BG more gradually. Labelled **"slower-acting carbs (low GI)"** in messages. Used for gentle daytime corrections when the situation is not urgent.
  - **Bedtime** (`BEDTIME_SUGGESTIONS`) — slow-release starchy carbs with protein/fat (toast+cheese, oatcakes+PB, porridge). Oatcake carbs based on Nairn's Rough Oatcakes (5.8g/oatcake). Labelled **"something starchy"** in messages. Used for bedtime top-ups and as follow-up after emergency sugar when insulin is active.
  - **Breakfast** (`BREAKFAST_SUGGESTIONS`) — breakfast-appropriate carb foods (porridge, toast, crumpets, Weetabix, banana). Used when the breakfast nudge calculates room for carbs.
  - **Low-carb breakfast** (`LOW_CARB_BREAKFAST_SUGGESTIONS`) — zero/minimal carb options (eggs, yoghurt, cheese, omelette). Used when BG is already above target at breakfast.

Every message sent is actionable. The one exception is the bedtime nudge, which also sends a reassuring "looking good" message if BG is high enough for the night.

## Required Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `LIBRE_USERNAME` | Yes | LibreLinkUp account |
| `LIBRE_PASSWORD` | Yes | LibreLinkUp account |
| `LIBRE_AGENT_VERSION` | Yes | API client version string |
| `PUSHOVER_USER` | No | Pushover user ID (enables Pushover for alert and canary channels) |
| `PUSHOVER_TOKEN` | No | Pushover API token (both required to enable) |
| `NTFY_TOPIC_ALERT` | No | ntfy topic for critical alarms |
| `NTFY_TOPIC_CANARY` | Yes | ntfy topic for heartbeat/status |
| `NTFY_TOPIC_NUDGE` | No | ntfy topic for nudge messages |
| `INSULIN_TIME_MORNING` | No | Morning insulin injection time (HH:mm) |
| `INSULIN_TIME_EVENING` | No | Evening insulin injection time (HH:mm) |
| `INFLUX_DB_URL` | No | InfluxDB URL |
| `INFLUX_DB_TOKEN` | No | InfluxDB auth token |
| `INFLUX_DB_ORG` | No | InfluxDB organization |
| `INFLUX_DB_BUCKET` | No | InfluxDB bucket |

## Timezone

The container must run with `TZ=Europe/London` (set in docker-compose and Portainer). All time-of-day logic in the codebase (quiet hours, dawn window, bedtime window, meal window, insulin injection times) is expressed in local UK time. InfluxDB stores timestamps in UTC; the conversion happens at the OS level via the TZ environment variable. Test scenarios store UTC timestamps with `timezoneOffsetMinutes` to convert to local time for the engine.

## Docker

The Dockerfile uses `node:22-alpine`. The build context is the repo root but only `src/` is copied into the image.
