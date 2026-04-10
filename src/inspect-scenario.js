// observation inspector — visual profiling tool for real CGM data
// usage: node inspect-scenario.js [file-path] [--from <datetime>] [--to <datetime>]
//
// prints every reading and marks which ones fired nudges, with full message
// text and engine state. use this to eyeball the engine's behaviour on real
// user observations (primary use case) or any scenario file.
//
// default: runs all files in observations/ (real raw CGM data). pass a path
// to inspect a specific file — can be any JSON scenario file including the
// synthetic ones in test/scenarios/ for debugging engine behavior on crafted
// cases.
//
// --from and --to filter the DISPLAYED readings to a time window. the engine
// still processes ALL readings in the file to maintain proper buffer and
// insulin-since-injection context — only the output is filtered. this means
// trend/suppression decisions at the start of the window reflect the real
// state of the engine as it would have been mid-day, not a cold start.
//
// datetime format is anything moment can parse; compared against the
// tz-adjusted reading time (after applying the scenario's
// timezoneOffsetMinutes). so `--from "2026-04-10 00:00"` means 00:00 local
// time on April 10, matching the inspector's displayed timestamps.
//
// examples:
//   node inspect-scenario.js observations/2026.json --from "2026-04-10 00:00"
//   node inspect-scenario.js observations/2026.json --from 2026-04-10 --to 2026-04-10T23:59
//
// this is NOT the test suite — see test/nudge.test.js for assertions.
// no actual notifications are dispatched.

const fs = require(`fs`);
const path = require(`path`);
const moment = require(`moment`);
const { createNudgeEngine, DEFAULTS } = require(`./nudge`);

// individual's profile — override any DEFAULTS here to test different configurations.
// only specify per-user overrides; all other values come from DEFAULTS in nudge.js.
// overnightPullRate is left unset so we use the engine's calibrated value (2.15
// under the Humulin M3 curve).
var profile = {
    interval: 10,
    insulinTimeMorning: `07:30`,
    insulinTimeEvening: `19:00`,
    carbsPerMmol: 4.4,
    insulinCounterFactor: 3.2,
    overnightDrop: 3.5
};

async function runScenario(scenario, filters)
{
    var merged = Object.assign({}, profile);
    var engine = createNudgeEngine(merged);
    var nudges = [];
    var displayedNudgeCount = 0;

    var mockSendNudge = async function (title, message)
    {
        nudges.push({ title, message });
    };

    console.log(`\n${'='.repeat(80)}`);
    console.log(`SCENARIO: ${scenario.name}`);
    if (scenario.description) console.log(`  ${scenario.description}`);
    console.log(`Profile: carbsPerMmol=${merged.carbsPerMmol}, insulin=${merged.insulinTimeMorning}/${merged.insulinTimeEvening}, mealWindow=${merged.mealWindowMinutes || DEFAULTS.mealWindowMinutes}min`);
    if (filters.from || filters.to)
    {
        console.log(`Display window: ${filters.from ? filters.from.format('YYYY-MM-DD HH:mm') : '(start)'} → ${filters.to ? filters.to.format('YYYY-MM-DD HH:mm') : '(end)'}`);
    }
    console.log(`${'='.repeat(80)}`);

    // timezoneOffsetMinutes converts stored UTC times to local time.
    // in production, TZ=Europe/London handles this automatically.
    // in tests, we apply it manually since the test process may not have TZ set.
    var tzOffset = scenario.timezoneOffsetMinutes || 0;

    // build a date → notes lookup for files with per-day annotations (consolidated
    // observation files). falls back to no-op for scenarios without days[].
    var dayNotes = {};
    if (Array.isArray(scenario.days))
    {
        for (var d = 0; d < scenario.days.length; d++)
        {
            dayNotes[scenario.days[d].date] = scenario.days[d].notes || ``;
        }
    }
    var currentDate = null;

    for (var i = 0; i < scenario.readings.length; i++)
    {
        var entry = scenario.readings[i];
        var now = moment(entry.time).add(tzOffset, `minutes`);
        var nudgeCountBefore = nudges.length;

        // always process through engine to maintain proper buffer/state context
        await engine.evaluate(entry.reading, mockSendNudge, now);

        var fired = nudges.length > nudgeCountBefore;

        // apply display window filter AFTER engine processing
        if (filters.from && now.isBefore(filters.from)) continue;
        if (filters.to && now.isAfter(filters.to)) break;

        // print a day break with notes whenever the reading's date changes
        // (tracked only for displayed readings so the break appears in context)
        var readingDate = now.format('YYYY-MM-DD');
        if (readingDate !== currentDate)
        {
            currentDate = readingDate;
            if (dayNotes[currentDate])
            {
                console.log(`\n--- ${currentDate}: ${dayNotes[currentDate]} ---`);
            }
        }

        var marker = fired ? ` << NUDGE` : ``;
        console.log(`  ${now.format('YYYY-MM-DD HH:mm')}  ${entry.reading.toFixed(1).padStart(5)}${marker}`);

        if (fired)
        {
            displayedNudgeCount++;
            var last = nudges[nudges.length - 1];
            console.log(`    title: ${last.title}`);
            console.log(`    message: ${last.message}`);
            console.log(`    state: carbs=${engine.state.lastNudgeCarbs}, expected=${engine.state.lastNudgeExpectedReading ? engine.state.lastNudgeExpectedReading.toFixed(1) : null}, cat=${engine.state.lastNudgeCategory}`);
        }
    }

    if (filters.from || filters.to)
    {
        console.log(`\n  Nudges in window: ${displayedNudgeCount}  (total over full scenario: ${nudges.length})`);
    }
    else
    {
        console.log(`\n  Total nudges: ${nudges.length}`);
    }
    return nudges;
}

function parseArgs(argv)
{
    var args = argv.slice(2);
    var fileArg = null;
    var fromArg = null;
    var toArg = null;

    for (var i = 0; i < args.length; i++)
    {
        if (args[i] === `--from` && i + 1 < args.length)
        {
            fromArg = args[++i];
        }
        else if (args[i] === `--to` && i + 1 < args.length)
        {
            toArg = args[++i];
        }
        else if (!args[i].startsWith(`--`))
        {
            fileArg = args[i];
        }
    }

    var filters = {
        from: fromArg ? moment(fromArg) : null,
        to: toArg ? moment(toArg) : null
    };

    if (filters.from && !filters.from.isValid())
    {
        console.error(`Invalid --from datetime: ${fromArg}`);
        process.exit(1);
    }
    if (filters.to && !filters.to.isValid())
    {
        console.error(`Invalid --to datetime: ${toArg}`);
        process.exit(1);
    }

    return { fileArg, filters };
}

async function main()
{
    var observationsDir = path.join(__dirname, `observations`);
    var scenariosDir = path.join(__dirname, `test`, `scenarios`);
    var parsed = parseArgs(process.argv);
    var files;

    if (parsed.fileArg)
    {
        // resolve relative to cwd or try observations/ then test/scenarios/
        var resolved = path.isAbsolute(parsed.fileArg) ? parsed.fileArg : path.resolve(parsed.fileArg);
        if (!fs.existsSync(resolved)) resolved = path.join(observationsDir, parsed.fileArg);
        if (!fs.existsSync(resolved)) resolved = path.join(scenariosDir, parsed.fileArg);
        files = [resolved];
    }
    else
    {
        // default: run all observations (real data)
        files = fs.readdirSync(observationsDir)
            .filter(f => f.endsWith(`.json`))
            .sort()
            .map(f => path.join(observationsDir, f));
    }

    console.log(`Nudge Engine Observation Inspector`);
    console.log(`Files: ${files.length}`);

    for (var i = 0; i < files.length; i++)
    {
        var scenario = JSON.parse(fs.readFileSync(files[i], `utf8`));
        await runScenario(scenario, parsed.filters);
    }
}

main();
