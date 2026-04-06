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

There are no tests, no linter, and no build step. The app is a single file (`src/app.js`) run directly with Node.js.

## CI/CD

Pushing to `main` triggers `.github/workflows/docker-publish.yml`, which builds and pushes a Docker image to `ghcr.io/pingfu/cgmsharp/cgmsharp:latest`.

## Architecture

Single-file Node.js app (`src/app.js`) with three scheduled loops:

1. **Tick** (every 10 min) - Fetches glucose reading from LibreLinkUp API, writes to InfluxDB, evaluates sliding window of last 6 readings against critical thresholds (low: 3.5, high: 22 mmol/L), runs nudge engine evaluation
2. **Canary** (daily at 9 AM) - Sends a heartbeat notification to confirm the monitor is alive
3. **Startup** - Runs one immediate Tick and sends a startup notification

Three notification channels via ntfy.sh (each mapped to a separate ntfy topic):
- **Alert** (priority 5/max) - Critical glucose alarms, API disruptions, fatal errors. Fans out to both ntfy and Pushover if configured.
- **Canary** (priority 2/low) - Daily heartbeat, startup notification
- **Nudge** (priority 3/default) - Proactive carb-guidance messages based on glucose trend, insulin activity, and time of day

Key behaviours:
- `clientVersion` is passed to the LibreLinkUp client via `LIBRE_AGENT_VERSION` env var (not defaulted from the library)
- After 6 consecutive LibreLinkUp API errors, a disruption notification is sent on the alert channel
- HTTP 401 from LibreLinkUp is treated as fatal (process exits) - usually means Abbott's EULA needs re-accepting in the mobile app
- InfluxDB is optional; if env vars are missing, it silently skips database writes
- InfluxDB auto-reconnects on timeout/connection errors

### Nudge Engine

The nudge engine runs every tick and evaluates whether to send a proactive message on the nudge channel. It uses three inputs:

1. **Zone** — current reading vs target range (7.0–10.0 mmol/L)
2. **Trend** — rate of change from the sliding window (stable, slowly/rapidly rising/falling)
3. **Insulin activity** — biphasic curve model of premixed insulin (30% rapid-acting + 70% intermediate-acting)

The biphasic insulin model uses piecewise linear interpolation with tunable constants for onset, peak, and tail of each component. Rapid component peaks at 60–90 min post-injection and tapers by 4 hours. Intermediate component peaks at 4–8 hours and tapers by 16 hours. Combined activity (0.0–1.0) determines whether insulin is "meaningfully active" (threshold: 0.15).

Nudge scenarios: below-target carb suggestions (adjusted for insulin activity), in-target preemptive warnings when projected to drop below 7.0, above-target hold-off messages, and dawn phenomenon awareness (4–8 AM rising BG flagged as potentially self-resolving).

If insulin times are not configured, the engine degrades gracefully — it still nudges based on zone and trend, just without insulin-aware adjustments.

## Required Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `LIBRE_USERNAME` | Yes | LibreLinkUp account |
| `LIBRE_PASSWORD` | Yes | LibreLinkUp account |
| `LIBRE_AGENT_VERSION` | Yes | API client version string |
| `PUSHOVER_USER` | No | Pushover user ID (enables Pushover as joint alert channel) |
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

## Docker

The Dockerfile uses `node:22-alpine`. The build context is the repo root but only `src/` is copied into the image.
