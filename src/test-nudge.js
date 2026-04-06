// test harness for the nudge engine
// usage: node test-nudge.js
//
// feeds a timestamped series of glucose readings through the nudge engine
// and prints what notifications would be sent. no actual notifications are dispatched.

const moment = require(`moment`);
const { createNudgeEngine, DEFAULTS } = require(`./nudge`);

// --- individual's profile overrides (tweak these to test different configurations) ---
var profile = {
    interval: 10,
    insulinTimeMorning: `07:30`,
    insulinTimeEvening: `19:00`,
    carbsPerMmol: 4.4
    // add any DEFAULTS overrides here, e.g.:
    // targetLow: 6.5,
    // mealWindowMinutes: 90,
    // insulinActiveThreshold: 0.30,
};

// --- test scenarios ---
// each scenario is a named array of { time, reading } objects
// time is a string parseable by moment (e.g. "2026-04-06 19:10")

var scenarios = {

    // tonight's actual data — the engine should send exactly one nudge at 21:00
    "2026-04-06 evening (real data)": [
        { time: `2026-04-06 19:10`, reading: 4.7 },
        { time: `2026-04-06 19:18`, reading: 6.0 },
        { time: `2026-04-06 19:20`, reading: 6.1 },
        { time: `2026-04-06 19:30`, reading: 6.2 },
        { time: `2026-04-06 19:40`, reading: 6.7 },
        { time: `2026-04-06 19:50`, reading: 7.0 },
        { time: `2026-04-06 20:00`, reading: 8.8 },
        { time: `2026-04-06 20:10`, reading: 8.7 },
        { time: `2026-04-06 20:20`, reading: 8.7 },
        { time: `2026-04-06 20:30`, reading: 7.7 },
        { time: `2026-04-06 20:40`, reading: 8.3 },
        { time: `2026-04-06 20:50`, reading: 7.9 },
        { time: `2026-04-06 21:00`, reading: 7.3 },
        { time: `2026-04-06 21:10`, reading: 7.9 },
        { time: `2026-04-06 21:20`, reading: 7.4 },
        { time: `2026-04-06 21:30`, reading: 8.6 }
    ],

    // steady decline from in-range to below target, no insulin window
    "slow decline mid-afternoon": [
        { time: `2026-04-07 14:00`, reading: 9.0 },
        { time: `2026-04-07 14:10`, reading: 8.7 },
        { time: `2026-04-07 14:20`, reading: 8.3 },
        { time: `2026-04-07 14:30`, reading: 7.8 },
        { time: `2026-04-07 14:40`, reading: 7.4 },
        { time: `2026-04-07 14:50`, reading: 7.0 },
        { time: `2026-04-07 15:00`, reading: 6.7 },
        { time: `2026-04-07 15:10`, reading: 6.3 },
        { time: `2026-04-07 15:20`, reading: 6.0 }
    ],

    // dawn phenomenon — rising BG 4-8 AM
    "dawn phenomenon": [
        { time: `2026-04-07 04:00`, reading: 7.5 },
        { time: `2026-04-07 04:10`, reading: 7.8 },
        { time: `2026-04-07 04:20`, reading: 8.2 },
        { time: `2026-04-07 04:30`, reading: 8.9 },
        { time: `2026-04-07 04:40`, reading: 9.5 },
        { time: `2026-04-07 04:50`, reading: 10.3 },
        { time: `2026-04-07 05:00`, reading: 11.2 },
        { time: `2026-04-07 05:10`, reading: 12.0 },
        { time: `2026-04-07 05:20`, reading: 12.5 }
    ],

    // overnight quiet hours — should produce zero nudges
    "overnight (quiet hours)": [
        { time: `2026-04-07 01:00`, reading: 6.0 },
        { time: `2026-04-07 01:10`, reading: 5.5 },
        { time: `2026-04-07 01:20`, reading: 5.2 },
        { time: `2026-04-07 01:30`, reading: 4.8 },
        { time: `2026-04-07 01:40`, reading: 4.5 }
    ],

    // rapid drop requiring escalation beyond absorption window
    "rapid drop": [
        { time: `2026-04-07 12:00`, reading: 8.5 },
        { time: `2026-04-07 12:10`, reading: 7.8 },
        { time: `2026-04-07 12:20`, reading: 7.0 },
        { time: `2026-04-07 12:30`, reading: 6.2 },
        { time: `2026-04-07 12:40`, reading: 5.5 },
        { time: `2026-04-07 12:50`, reading: 4.8 },
        { time: `2026-04-07 13:00`, reading: 4.2 }
    ]
};

// --- runner ---

async function runScenario(name, data, profileOverrides)
{
    var merged = Object.assign({}, profile, profileOverrides || {});
    var engine = createNudgeEngine(merged);
    var nudges = [];

    var mockSendNudge = async function (title, message)
    {
        nudges.push({ title, message });
    };

    console.log(`\n${'='.repeat(80)}`);
    console.log(`SCENARIO: ${name}`);
    console.log(`Profile: carbsPerMmol=${merged.carbsPerMmol}, insulin=${merged.insulinTimeMorning}/${merged.insulinTimeEvening}, mealWindow=${merged.mealWindowMinutes || DEFAULTS.mealWindowMinutes}min`);
    console.log(`${'='.repeat(80)}`);

    for (var i = 0; i < data.length; i++)
    {
        var entry = data[i];
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
        }
    }

    console.log(`\n  Total nudges: ${nudges.length}`);
    return nudges;
}

async function main()
{
    console.log(`Nudge Engine Test Harness`);
    console.log(`Default profile: ${JSON.stringify(DEFAULTS, null, 2)}`);

    for (var name in scenarios)
    {
        await runScenario(name, scenarios[name]);
    }
}

main();
