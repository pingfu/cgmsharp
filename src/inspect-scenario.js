// observation inspector — visual profiling tool for real CGM data
// usage: node inspect-scenario.js [file-path]
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

async function runScenario(scenario)
{
    var merged = Object.assign({}, profile);
    var engine = createNudgeEngine(merged);
    var nudges = [];

    var mockSendNudge = async function (title, message)
    {
        nudges.push({ title, message });
    };

    console.log(`\n${'='.repeat(80)}`);
    console.log(`SCENARIO: ${scenario.name}`);
    if (scenario.description) console.log(`  ${scenario.description}`);
    console.log(`Profile: carbsPerMmol=${merged.carbsPerMmol}, insulin=${merged.insulinTimeMorning}/${merged.insulinTimeEvening}, mealWindow=${merged.mealWindowMinutes || DEFAULTS.mealWindowMinutes}min`);
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

        // print a day break with notes whenever the reading's date changes
        var readingDate = entry.time.split(` `)[0];
        if (readingDate !== currentDate)
        {
            currentDate = readingDate;
            if (dayNotes[currentDate])
            {
                console.log(`\n--- ${currentDate}: ${dayNotes[currentDate]} ---`);
            }
        }

        var now = moment(entry.time).add(tzOffset, `minutes`);
        var nudgeCountBefore = nudges.length;

        await engine.evaluate(entry.reading, mockSendNudge, now);

        var fired = nudges.length > nudgeCountBefore;
        var marker = fired ? ` << NUDGE` : ``;
        console.log(`  ${entry.time}  ${entry.reading.toFixed(1).padStart(5)}${marker}`);

        if (fired)
        {
            var last = nudges[nudges.length - 1];
            console.log(`    title: ${last.title}`);
            console.log(`    message: ${last.message}`);
            console.log(`    state: carbs=${engine.state.lastNudgeCarbs}, expected=${engine.state.lastNudgeExpectedReading ? engine.state.lastNudgeExpectedReading.toFixed(1) : null}, cat=${engine.state.lastNudgeCategory}`);
        }
    }

    console.log(`\n  Total nudges: ${nudges.length}`);
    return nudges;
}

async function main()
{
    var observationsDir = path.join(__dirname, `observations`);
    var scenariosDir = path.join(__dirname, `test`, `scenarios`);
    var specificFile = process.argv[2];
    var files;

    if (specificFile)
    {
        // resolve relative to cwd or try observations/ then test/scenarios/
        var resolved = path.isAbsolute(specificFile) ? specificFile : path.resolve(specificFile);
        if (!fs.existsSync(resolved)) resolved = path.join(observationsDir, specificFile);
        if (!fs.existsSync(resolved)) resolved = path.join(scenariosDir, specificFile);
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
        await runScenario(scenario);
    }
}

main();
