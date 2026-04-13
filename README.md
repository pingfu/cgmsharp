# cgmsharp

Continuous glucose monitoring application that polls the LibreLinkUp API on a 10-minute cron schedule, stores readings in InfluxDB, and sends push notifications via ntfy.sh and Pushover when glucose levels require attention.

Designed for a type 1 diabetic on twice-daily premixed insulin (Humulin M3).

## Deployment

The application image is built and pushed to `ghcr.io/pingfu/cgmsharp/cgmsharp:latest` automatically on every push to `main`.

The full stack (cgmsharp + InfluxDB + Grafana) is deployed as a single unit via Portainer. Set the reference to `refs/heads/main`.

`stack.env` is committed with default values. Portainer reads it automatically via "Load variables from .env file". Fill in the credentials in Portainer's UI.

### Environment Variables

| Variable | Purpose |
|---|---|
| `LIBRE_USERNAME` | LibreLinkUp account email |
| `LIBRE_PASSWORD` | LibreLinkUp account password |
| `LIBRE_AGENT_VERSION` | LibreLinkUp API client version (default: `4.16.0`) |
| `PUSHOVER_USER` | Pushover user ID |
| `PUSHOVER_TOKEN` | Pushover API token |
| `NTFY_TOPIC_ALERT` | ntfy topic for critical alarms |
| `NTFY_TOPIC_CANARY` | ntfy topic for daily heartbeat |
| `NTFY_TOPIC_NUDGE` | ntfy topic for nudge messages |


## Notification Channels

Three channels via ntfy.sh, each mapped to a separate topic. Alert and canary also fan out to Pushover when configured.

| Channel | ntfy | Pushover | Purpose |
|---|---|---|---|
| **Alert** | Priority 5 (max) | Priority 2 (emergency, retry 30s / expire 5min) | Critical glucose alarms, API disruptions, fatal errors |
| **Canary** | Priority 2 (low) | Priority -1 (silent) | Daily heartbeat at 09:00 |
| **Nudge** | Priority 3 (default) | — | Proactive carb guidance based on glucose trend, insulin activity, and time of day |

On startup, a one-off notification is sent to Pushover only (if configured).

## Visualisation

Grafana is included in the stack on port 3001 with a provisioned glucose dashboard. Anonymous viewer access, no login required.

## Tests

```bash
docker build --no-cache -t cgmsharp-test .
docker run --rm -e TZ=Europe/London cgmsharp-test node --test test/nudge.test.js
```

## Troubleshooting

Occasionally Abbott update their [End User License Agreement](https://api.libreview.io/document/toullu?lang=en-gb), which until accepted can cause the API to return HTTP `401` errors. Log out of all devices and log back in using the LibreLinkUp mobile app to accept the latest terms.

## See also

- https://github.com/DiaKEM/libre-link-up-api-client
- https://github.com/timoschlueter/nightscout-librelink-up
