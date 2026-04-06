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
- **Alert** (priority 5/max) - Critical glucose alarms, API disruptions, fatal errors
- **Canary** (priority 2/low) - Daily heartbeat, startup notification
- **Nudge** (priority 3/default) - Proactive carb-guidance messages (placeholder, not yet active)

Key behaviours:
- `clientVersion` is passed to the LibreLinkUp client via `LIBRE_AGENT_VERSION` env var (not defaulted from the library)
- After 6 consecutive LibreLinkUp API errors, a disruption notification is sent on the alert channel
- HTTP 401 from LibreLinkUp is treated as fatal (process exits) - usually means Abbott's EULA needs re-accepting in the mobile app
- InfluxDB is optional; if env vars are missing, it silently skips database writes
- InfluxDB auto-reconnects on timeout/connection errors
- Nudge engine is stubbed out (`NUDGE_ENABLED = false`) with rate-of-change calculation and trend classification ready for future implementation

## Required Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `LIBRE_USERNAME` | Yes | LibreLinkUp account |
| `LIBRE_PASSWORD` | Yes | LibreLinkUp account |
| `LIBRE_AGENT_VERSION` | Yes | API client version string |
| `NTFY_TOPIC_ALERT` | Yes | ntfy topic for critical alarms |
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
