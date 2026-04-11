// sync-observations.js
//
// Pulls glucose readings from InfluxDB since the latest entry in
// observations/2026.json and appends them to the file. Preserves the existing
// hand-formatted layout (indentation, line breaks, line endings) by doing
// surgical text insertion rather than JSON.stringify round-tripping.
//
// usage (host):
//   docker run --rm --env-file src/.env \
//     -v "$(pwd)/src/observations:/usr/src/app/observations" \
//     cgmsharp-test node sync-observations.js
//
// env vars (from src/.env):
//   INFLUX_DB_URL    base URL, e.g. http://home-nas.enclave:8086
//                    (any trailing /api/v2/... path or backslash is stripped)
//   INFLUX_DB_TOKEN  auth token
//   INFLUX_DB_ORG    org name (default: Homenet)
//   INFLUX_DB_BUCKET bucket name (default: cgmsharp)
//
// Behavior:
//   - reads the last timestamp in observations/2026.json, queries InfluxDB
//     for everything newer, dedupes against the existing times, and appends.
//   - if no new readings exist, exits quietly with a status message.
//   - does not rewrite the file if there are no changes.
//   - InfluxDB stores timestamps in UTC; observations/2026.json stores UTC
//     (with timezoneOffsetMinutes=60 applied at inspection time). no local-time
//     conversion happens here — it's UTC in, UTC out.

require(`dotenv`).config();

const fs = require(`fs`);
const path = require(`path`);
const http = require(`http`);
const https = require(`https`);

const OBSERVATIONS_FILE = path.join(__dirname, `observations`, `2026.json`);

function cleanUrl(raw)
{
    if (!raw) return null;
    // strip trailing backslashes (common env-file artifact) and stray /api/v2/... paths
    return raw.replace(/\\+$/, ``).replace(/\/api\/v2\/.*$/, ``).replace(/\/$/, ``);
}

function formatTimestampForFile(isoString)
{
    // "2026-04-10T22:10:01.953Z" -> "2026-04-10 22:10"
    var d = new Date(isoString);
    var yyyy = d.getUTCFullYear();
    var mm = String(d.getUTCMonth() + 1).padStart(2, `0`);
    var dd = String(d.getUTCDate()).padStart(2, `0`);
    var hh = String(d.getUTCHours()).padStart(2, `0`);
    var min = String(d.getUTCMinutes()).padStart(2, `0`);
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatReading(value)
{
    // match existing file style: integers without decimal, else stripped of trailing zeros
    if (Number.isInteger(value)) return String(value);
    var str = value.toFixed(1);
    // "6.0" -> "6" (matches existing file which stores "6" not "6.0")
    if (str.endsWith(`.0`)) return str.slice(0, -2);
    return str;
}

function queryInflux(baseUrl, token, org, bucket, sinceIso)
{
    var flux = `from(bucket:"${bucket}") |> range(start: ${sinceIso}) |> filter(fn: (r) => r._measurement == "glucose" and r._field == "value") |> keep(columns: ["_time", "_value"]) |> sort(columns: ["_time"])`;
    var queryUrl = new URL(baseUrl + `/api/v2/query?org=` + encodeURIComponent(org));
    var lib = queryUrl.protocol === `https:` ? https : http;

    return new Promise(function (resolve, reject)
    {
        var req = lib.request({
            method: `POST`,
            hostname: queryUrl.hostname,
            port: queryUrl.port || (queryUrl.protocol === `https:` ? 443 : 80),
            path: queryUrl.pathname + queryUrl.search,
            headers: {
                'Authorization': `Token ` + token,
                'Accept': `application/csv`,
                'Content-Type': `application/vnd.flux`,
                'Content-Length': Buffer.byteLength(flux)
            }
        }, function (res)
        {
            var body = ``;
            res.on(`data`, function (chunk) { body += chunk; });
            res.on(`end`, function ()
            {
                if (res.statusCode !== 200)
                {
                    reject(new Error(`InfluxDB query failed: HTTP ${res.statusCode} — ${body}`));
                    return;
                }
                resolve(body);
            });
        });
        req.on(`error`, reject);
        req.write(flux);
        req.end();
    });
}

function parseCsv(csv)
{
    var lines = csv.trim().split(/\r?\n/);
    var results = [];
    for (var i = 0; i < lines.length; i++)
    {
        var line = lines[i];
        if (!line || line.startsWith(`,result,`)) continue; // header row
        if (!line.startsWith(`,`)) continue;
        var cols = line.split(`,`);
        // expected shape: ['', '_result', '0', '<time>', '<value>']
        if (cols.length < 5) continue;
        var time = cols[3];
        var value = parseFloat(cols[4]);
        if (isNaN(value)) continue;
        results.push({ time: time, value: value });
    }
    return results;
}

async function main()
{
    var baseUrl = cleanUrl(process.env.INFLUX_DB_URL);
    var token = process.env.INFLUX_DB_TOKEN;
    var org = process.env.INFLUX_DB_ORG || `Homenet`;
    var bucket = process.env.INFLUX_DB_BUCKET || `cgmsharp`;

    if (!baseUrl || !token)
    {
        console.error(`Error: INFLUX_DB_URL and INFLUX_DB_TOKEN must be set in src/.env`);
        process.exit(1);
    }

    if (!fs.existsSync(OBSERVATIONS_FILE))
    {
        console.error(`Error: ${OBSERVATIONS_FILE} not found`);
        process.exit(1);
    }

    var fileText = fs.readFileSync(OBSERVATIONS_FILE, `utf8`);

    // parse the JSON once to find the last timestamp and build a dedupe set
    var parsed;
    try
    {
        parsed = JSON.parse(fileText);
    }
    catch (e)
    {
        console.error(`Error: ${OBSERVATIONS_FILE} is not valid JSON — ${e.message}`);
        process.exit(1);
    }

    if (!parsed.readings || parsed.readings.length === 0)
    {
        console.error(`Error: no existing readings in ${OBSERVATIONS_FILE}`);
        process.exit(1);
    }

    var existingTimes = new Set(parsed.readings.map(function (r) { return r.time; }));
    var lastReading = parsed.readings[parsed.readings.length - 1];
    var lastTimeStr = lastReading.time; // "YYYY-MM-DD HH:MM" UTC

    // convert "YYYY-MM-DD HH:MM" -> ISO string for the InfluxDB range query
    var sinceIso = lastTimeStr.replace(` `, `T`) + `:00Z`;
    console.log(`Last reading in file: ${lastTimeStr} (${lastReading.reading})`);
    console.log(`Querying InfluxDB since: ${sinceIso}`);
    console.log(`  url:    ${baseUrl}`);
    console.log(`  org:    ${org}`);
    console.log(`  bucket: ${bucket}`);

    var csv;
    try
    {
        csv = await queryInflux(baseUrl, token, org, bucket, sinceIso);
    }
    catch (e)
    {
        console.error(`Error querying InfluxDB: ${e.message}`);
        process.exit(1);
    }

    var rows = parseCsv(csv);
    console.log(`InfluxDB returned ${rows.length} rows`);

    // format + dedupe against existing timestamps
    var newEntries = [];
    for (var i = 0; i < rows.length; i++)
    {
        var timeStr = formatTimestampForFile(rows[i].time);
        if (existingTimes.has(timeStr)) continue;
        existingTimes.add(timeStr); // guard against duplicates within the result set
        newEntries.push({ time: timeStr, value: rows[i].value });
    }

    if (newEntries.length === 0)
    {
        console.log(`No new readings to append — file already current at ${lastTimeStr}`);
        return;
    }

    console.log(`Appending ${newEntries.length} new reading${newEntries.length === 1 ? `` : `s`}: ${newEntries[0].time} -> ${newEntries[newEntries.length - 1].time}`);

    // ---- surgical text insertion ----
    // preserve the hand-formatted layout by editing the text, not round-tripping
    // through JSON.stringify. the file's readings array ends like:
    //
    //         {"time":"...","reading":X}     <- last reading, NO trailing comma
    //     ]
    // }
    //
    // we need to:
    //   1. add a trailing comma to the current last reading line
    //   2. insert the new reading lines before the `]`
    //   3. leave the new last reading without a trailing comma

    // detect line ending
    var lineEnding = fileText.indexOf(`\r\n`) !== -1 ? `\r\n` : `\n`;
    var lines = fileText.split(lineEnding);

    // find the last reading line (matches the {"time":..."reading":...} pattern AND has no trailing comma)
    var lastReadingLineIdx = -1;
    for (var i = lines.length - 1; i >= 0; i--)
    {
        var line = lines[i];
        if (/^\s*\{"time":/.test(line) && !/\},\s*$/.test(line))
        {
            lastReadingLineIdx = i;
            break;
        }
    }
    if (lastReadingLineIdx === -1)
    {
        console.error(`Error: could not locate the last reading line in ${OBSERVATIONS_FILE}`);
        process.exit(1);
    }

    // add a trailing comma to the current last reading
    lines[lastReadingLineIdx] = lines[lastReadingLineIdx] + `,`;

    // build the new reading lines using the same 8-space indent
    var newLines = newEntries.map(function (entry, idx)
    {
        var isLast = idx === newEntries.length - 1;
        var val = formatReading(entry.value);
        var body = `        {"time":"${entry.time}","reading":${val}}`;
        if (!isLast) body += `,`;
        return body;
    });

    // splice new lines in right after the (now comma-terminated) last reading
    var before = lines.slice(0, lastReadingLineIdx + 1);
    var after = lines.slice(lastReadingLineIdx + 1);
    var newFileLines = before.concat(newLines).concat(after);

    var newText = newFileLines.join(lineEnding);
    fs.writeFileSync(OBSERVATIONS_FILE, newText, `utf8`);

    console.log(`Updated ${OBSERVATIONS_FILE}`);
    console.log(`  new total: ${parsed.readings.length + newEntries.length} readings`);
    console.log(`  last entry: ${newEntries[newEntries.length - 1].time} (${formatReading(newEntries[newEntries.length - 1].value)})`);
}

main().catch(function (err)
{
    console.error(`Unexpected error: ${err.message}`);
    process.exit(1);
});
