// nudge engine test runner
// usage: node test/run-nudge.js [scenario-file]
//
// runs all scenarios in test/scenarios/ or a single file if specified.
// feeds timestamped glucose readings through the nudge engine and prints
// what notifications would be sent. no actual notifications are dispatched.

const fs = require(`fs`);
const path = require(`path`);
const moment = require(`moment`);
const { createNudgeEngine, DEFAULTS } = require(`../nudge`);

// individual's profile — override any DEFAULTS here to test different configurations
var profile = {
    interval: 10,
    insulinTimeMorning: `07:30`,
    insulinTimeEvening: `19:00`,
    carbsPerMmol: 4.4
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

    for (var i = 0; i < scenario.readings.length; i++)
    {
        var entry = scenario.readings[i];
        var now = moment(entry.time);
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
    var scenariosDir = path.join(__dirname, `scenarios`);
    var specificFile = process.argv[2];
    var files;

    if (specificFile)
    {
        // resolve relative to cwd or scenarios dir
        var resolved = path.isAbsolute(specificFile) ? specificFile : path.resolve(specificFile);
        if (!fs.existsSync(resolved)) resolved = path.join(scenariosDir, specificFile);
        files = [resolved];
    }
    else
    {
        files = fs.readdirSync(scenariosDir)
            .filter(f => f.endsWith(`.json`))
            .sort()
            .map(f => path.join(scenariosDir, f));
    }

    console.log(`Nudge Engine Test Runner`);
    console.log(`Scenarios: ${files.length}`);

    for (var i = 0; i < files.length; i++)
    {
        var scenario = JSON.parse(fs.readFileSync(files[i], `utf8`));
        await runScenario(scenario);
    }
}

main();
