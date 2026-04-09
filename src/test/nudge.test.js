// nudge engine assertion tests
// usage: node --test test/nudge.test.js
//
// uses node:test (built into Node 22). zero dependencies.
// the visual runner (run-nudge.js) remains for inspection.
// this file adds pass/fail assertions against scenario outcomes.

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const fs = require(`fs`);
const path = require(`path`);
const moment = require(`moment`);
const { createNudgeEngine, DEFAULTS } = require(`../nudge`);

// individual's profile — matches run-nudge.js
var profile = {
    interval: 10,
    insulinTimeMorning: `07:30`,
    insulinTimeEvening: `19:00`,
    carbsPerMmol: 4.4,
    insulinCounterFactor: 3.2,
    overnightPullRate: 2.5,
    overnightDrop: 3.5
};

// run a scenario through the engine and return the nudges with metadata
async function runScenario(scenarioFile)
{
    var scenario = JSON.parse(fs.readFileSync(path.join(__dirname, `scenarios`, scenarioFile), `utf8`));
    var engine = createNudgeEngine(Object.assign({}, profile));
    var nudges = [];
    var tzOffset = scenario.timezoneOffsetMinutes || 0;

    var mockSendNudge = async function (title, message)
    {
        nudges.push({ title, message, reading: scenario.readings[i].reading, time: scenario.readings[i].time });
    };

    for (var i = 0; i < scenario.readings.length; i++)
    {
        var entry = scenario.readings[i];
        var now = moment(entry.time).add(tzOffset, `minutes`);
        await engine.evaluate(entry.reading, mockSendNudge, now);
    }

    return nudges;
}

// --- suppression: one nudge per dip ---

test(`high-settle-then-dip: two separate dips produce exactly two nudges`, async () =>
{
    var nudges = await runScenario(`high-settle-then-dip.json`);
    assert.equal(nudges.length, 2, `expected 2 nudges (one per dip), got ${nudges.length}`);
});

test(`high-settle-then-dip: first nudge fires on the first dip`, async () =>
{
    var nudges = await runScenario(`high-settle-then-dip.json`);
    assert.ok(nudges[0].reading < 7.0, `first nudge should fire below target, fired at ${nudges[0].reading}`);
    assert.ok(nudges[0].time < `2026-04-10 10:30`, `first nudge should fire before the stable period`);
});

test(`high-settle-then-dip: second nudge fires on the second dip (not suppressed)`, async () =>
{
    var nudges = await runScenario(`high-settle-then-dip.json`);
    assert.ok(nudges[1].reading < 7.0, `second nudge should fire below target, fired at ${nudges[1].reading}`);
    assert.ok(nudges[1].time >= `2026-04-10 13:00`, `second nudge should fire after the stable period`);
});

// --- suppression: same dip does not double-nudge ---

test(`2026-04-09: crossing targetLow boundary on same dip does not double-nudge`, async () =>
{
    var nudges = await runScenario(`2026-04-09-full-day.json`);

    // find evening nudges (after 16:00 UTC)
    var eveningNudges = nudges.filter(n => n.time >= `2026-04-09 16:00`);
    assert.equal(eveningNudges.length, 1, `expected 1 evening nudge, got ${eveningNudges.length}`);
});

test(`2026-04-09: the single evening nudge fires at 7.4 (in-target), not at 6.9 (below)`, async () =>
{
    var nudges = await runScenario(`2026-04-09-full-day.json`);
    var eveningNudges = nudges.filter(n => n.time >= `2026-04-09 16:00`);
    assert.equal(eveningNudges[0].reading, 7.4, `expected nudge at 7.4, got ${eveningNudges[0].reading}`);
});

// --- quiet scenarios: no false positives ---

test(`stable-in-range: no nudges when BG stays in target`, async () =>
{
    var nudges = await runScenario(`stable-in-range.json`);
    assert.equal(nudges.length, 0, `expected no nudges for stable in-range, got ${nudges.length}`);
});

test(`dawn-phenomenon: no nudges during dawn rise`, async () =>
{
    var nudges = await runScenario(`dawn-phenomenon.json`);
    assert.equal(nudges.length, 0, `expected no nudges during dawn window, got ${nudges.length}`);
});

test(`overnight-quiet: no nudges during quiet hours`, async () =>
{
    var nudges = await runScenario(`overnight-quiet.json`);
    assert.equal(nudges.length, 0, `expected no nudges during quiet hours, got ${nudges.length}`);
});

// --- breakfast nudge ---

test(`breakfast-low-starting-bg: suggests full carb room when BG is below target`, async () =>
{
    var nudges = await runScenario(`breakfast-low-starting-bg.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected a breakfast nudge`);
    assert.ok(breakfast.message.includes(`room for`), `below-target breakfast should mention room for carbs`);
});

test(`breakfast-above-target: suggests low-carb breakfast when BG is above target`, async () =>
{
    var nudges = await runScenario(`breakfast-above-target.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected a breakfast nudge`);
    assert.ok(breakfast.message.includes(`low-carb`), `above-target breakfast should suggest low-carb`);
});

test(`breakfast-well-above-target: suggests skipping carbs when BG is very high`, async () =>
{
    var nudges = await runScenario(`breakfast-well-above-target.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected a breakfast nudge`);
    assert.ok(breakfast.message.includes(`skip carbs`), `very high breakfast should suggest skipping carbs`);
});
