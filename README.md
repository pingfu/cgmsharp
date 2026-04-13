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

## Glucose Ranges

Based on the [international consensus on Time in Range](https://pmc.ncbi.nlm.nih.gov/articles/PMC7645943/) (ADA/EASD endorsed, used by AGP reports and CGM reporting standards).

| Range (mmol/L) | Classification | Physiological impact | Timeframe |
|---|---|---|---|
| < 3.0 | Very low (level 2) | Neuroglycopenia: confusion, seizures, loss of consciousness. Brain cannot function without glucose. Cardiac arrhythmia risk. Fatal if untreated. | Minutes. Requires immediate fast-acting sugar. |
| 3.0 -- 3.9 | Low (level 1) | Adrenergic response: shakiness, sweating, palpitations, hunger. Cognitive impairment begins. Counter-regulatory hormones (glucagon, adrenaline) attempt to raise BG. | 15--30 minutes before symptoms escalate. Treat promptly with fast-acting sugar. |
| 3.9 -- 10.0 | In range (target) | Normal cellular function. No acute harm. Minimal oxidative stress. | Aim for >70% of the day (>16h 48min). |
| 10.0 -- 13.9 | Above range (level 1) | Chronic cumulative damage: glycation of proteins, endothelial dysfunction, oxidative stress. Kidneys begin spilling glucose near the top of this range. No acute symptoms in most people. | Damage is cumulative over months/years. Aim for <25% of the day (<6h). |
| > 13.9 | Very high (level 2) | Osmotic diuresis (dehydration, thirst, frequent urination). Cognitive impairment, fatigue, blurred vision. Fat breakdown begins producing ketones. Pathway to DKA in insulin-deficient type 1 diabetics. Accelerated vascular damage. | DKA can develop within 4--6 hours of complete insulin absence. With twice-daily Humulin M3, the NPH component provides residual basal coverage for ~18 hours, so total insulin absence is unlikely -- but a missed dose (especially evening) leaves no basal coverage overnight, risking high BG and rising ketones within 12--16 hours. Aim for <5% of the day (<1h 12min). |

## Emergency response

**Very low (< 3.0 mmol/L) -- severe hypo:**

- If conscious and able to swallow: give fast-acting sugar immediately -- jelly babies (3--5), fruit juice (200ml), or a tablespoon of honey/jam. Follow with slower-acting carbs (toast, biscuits) once BG starts rising.
- If unconscious, fitting, or unable to swallow: place in the recovery position. **Do not put anything in their mouth.** Administer glucagon injection if available and you are trained to do so. Call 999.
- Do not leave them alone. Recheck BG after 10--15 minutes.
- **Hospital treatment for severe hypo**: IV dextrose (typically 75--100ml of 20% glucose) if unconscious or not responding to glucagon. IM glucagon (1mg) if IV access is not yet established. Monitoring until BG is stable above 4.0 and the patient is fully conscious and able to eat. Observation for recurrence, particularly with long-acting insulin on board.

**Very high (> 13.9 mmol/L):**

- Ask if they have taken their insulin. A missed dose is the most common cause.
- Encourage sipping water to counter dehydration from osmotic diuresis.
- Do not give additional insulin beyond the prescribed dose without medical advice. This user is on premixed Humulin M3 and cannot give a correction bolus without also adding extra NPH (intermediate-acting), which would cause unpredictable basal insulin activity 6--8 hours later and risk a severe delayed hypo.

### When to escalate to hospital

**Signs of DKA**: fruity/acetone smell on breath, nausea or vomiting, rapid deep breathing (Kussmaul breathing), abdominal pain, drowsiness or confusion. If any are present: call 999. Do not wait for symptoms to worsen.

If a blood ketone meter is available:

| Blood ketones (mmol/L) | Severity | Action |
|---|---|---|
| < 0.6 | Normal | No action required. |
| 0.6 -- 1.5 | Mild | Drink plenty of water. Retest every 1--2 hours. Do not exercise. |
| 1.5 -- 3.0 | Moderate | Drink plenty of water. Contact diabetes team or call 111. If ketones are not falling after 2 hours, or vomiting prevents keeping fluids down, go to A&E. |
| > 3.0 | High | Go to A&E immediately. This is DKA or imminent DKA. Hospital treatment: IV fluids (0.9% saline, 1L in first hour), IV insulin infusion to halt ketone production, potassium replacement (insulin drives potassium into cells, risking cardiac arrhythmia without replacement), continuous monitoring of blood gases, electrolytes, and ketones. Typically 12--24 hours in a high-dependency setting. |

## Visualisation

Grafana is included in the stack on port 8070 with a provisioned glucose dashboard. Anonymous viewer access, no login required.

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
