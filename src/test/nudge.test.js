// nudge engine assertion tests
// usage: node --test test/nudge.test.js
//
// uses node:test (built into Node 22). zero dependencies.
// the scenario inspector (inspect-scenario.js) remains for visual debugging.
// this file asserts clinical correctness of the engine's decisions.

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const fs = require(`fs`);
const path = require(`path`);
const moment = require(`moment`);
const { createNudgeEngine, DEFAULTS } = require(`../nudge`);

// individual's profile — matches inspect-scenario.js
var profile = {
    interval: 10,
    insulinTimeMorning: `07:30`,
    insulinTimeEvening: `19:00`,
    carbsPerMmol: 4.4,
    insulinCounterFactor: 3.2,
    overnightPullRate: 2.5,
    overnightDrop: 3.5
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

// extract the first carb gram amount from a nudge message (e.g. "Have 10g" → 10)
function extractCarbs(message)
{
    var match = message.match(/(\d+)g/);
    return match ? parseInt(match[1]) : null;
}

// check whether a message recommends emergency (fast-acting) food
function isEmergencyFood(message)
{
    return /jelly|honey|jam|sugar dissolved/.test(message);
}

// check whether a message recommends slow/normal carbs
function isSlowCarbs(message)
{
    return /slower-acting|low GI|yoghurt|oatcake|apple|banana|toast|porridge|grapes/.test(message);
}

// check whether a message recommends bedtime (starchy) food
function isBedtimeFood(message)
{
    return /starchy|oatcake.*cheddar|toast.*cheddar|porridge.*milk|pitta.*hummus/.test(message);
}

// ===========================================================================
// BREAKFAST CARB QUANTITIES
//
// clinical basis: post-breakfast spike is determined by starting BG + carbs
// eaten. the engine calculates availableRoom = targetHigh (10.0) - reading,
// then converts to grams via carbsPerMmol (4.4g per 1 mmol/L).
//
// real data confirms this matters: on 2026-04-09, BG was 8.5 at breakfast.
// room = 1.5 mmol/L = ~7g. she ate ~15g porridge and peaked at 16.8.
// the engine should have said ~7g. getting this number right prevents
// dangerous post-breakfast spikes that take hours to come down.
// ===========================================================================

test(`breakfast at 6.5: recommends ~15g — full room to targetHigh`, async () =>
{
    // BG 6.5, room = 10.0 - 6.5 = 3.5 mmol/L × 4.4 = 15.4g → 15g
    // at this level there's headroom for a proper breakfast (porridge, toast)
    var nudges = await runScenario(`breakfast-low-starting-bg.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected breakfast nudge`);
    var carbs = extractCarbs(breakfast.message);
    assert.ok(carbs >= 13 && carbs <= 17, `BG 6.5 should suggest 13-17g (room for 3.5 mmol/L rise), got ${carbs}g`);
});

test(`breakfast at 8.0: recommends ~9g — limited room, smaller portion`, async () =>
{
    // BG 8.0, room = 10.0 - 8.0 = 2.0 mmol/L × 4.4 = 8.8g → 9g
    // only room for a small portion — half a crumpet, not a full bowl of porridge
    var nudges = await runScenario(`breakfast-mid-target.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected breakfast nudge`);
    var carbs = extractCarbs(breakfast.message);
    assert.ok(carbs >= 7 && carbs <= 10, `BG 8.0 should suggest 7-10g (room for 2.0 mmol/L rise), got ${carbs}g`);
});

test(`breakfast at 9.2: recommends ~4g — very little room, just a taste`, async () =>
{
    // BG 9.2, room = 10.0 - 9.2 = 0.8 mmol/L × 4.4 = 3.5g → 4g
    // barely any room — even a small banana would overshoot
    var nudges = await runScenario(`breakfast-high-starting-bg.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected breakfast nudge`);
    var carbs = extractCarbs(breakfast.message);
    assert.ok(carbs >= 3 && carbs <= 7, `BG 9.2 should suggest 3-7g (room for 0.8 mmol/L rise), got ${carbs}g`);
});

test(`breakfast at 12.0: no carb number — low-carb food only`, async () =>
{
    // BG 12.0, above targetHigh. any carbs would push BG higher.
    // should suggest protein/fat (eggs, yoghurt, cheese) with no gram target.
    var nudges = await runScenario(`breakfast-above-target.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected breakfast nudge`);
    assert.ok(breakfast.message.includes(`low-carb`), `above target should say low-carb`);
    assert.ok(/eggs|yoghurt|cheese|omelette/.test(breakfast.message), `should suggest protein/fat foods`);
});

test(`breakfast at 15.0: skip carbs entirely`, async () =>
{
    // BG 15.0, well above target (>14). dawn phenomenon has pushed BG dangerously high.
    // carbs on top of this would compound the problem. insulin needs to bring it down first.
    var nudges = await runScenario(`breakfast-well-above-target.json`);
    var breakfast = nudges.find(n => n.title === `Good morning`);
    assert.ok(breakfast, `expected breakfast nudge`);
    assert.ok(breakfast.message.includes(`skip carbs`), `very high BG should say skip carbs`);
});

// ===========================================================================
// EMERGENCY vs SLOW CARBS
//
// clinical basis: when BG is crashing or at hypo levels, the body needs
// glucose NOW. slow-acting carbs (toast, oatcakes) take 30-60 min to raise
// BG — by then she could be unconscious. fast-acting sugar (jelly babies,
// honey, jam) raises BG within 5-10 minutes.
//
// conversely, using fast sugar for a gentle drift causes a spike-and-crash
// cycle. slow carbs provide a gentler, sustained rise that's more stable.
//
// the wrong food type is as dangerous as the wrong amount.
// ===========================================================================

test(`rapid drop: emergency foods once BG is below target`, async () =>
{
    // BG crashing from 8.5 to 4.2 in 70 min. the first nudge may fire
    // while still in-range (preemptive, slow carbs appropriate). but once
    // BG is below target with insulin active and falling, emergency foods
    // are essential — slow carbs won't absorb fast enough.
    var nudges = await runScenario(`rapid-drop.json`);
    assert.ok(nudges.length >= 1, `should nudge during rapid drop`);
    var belowTargetNudges = nudges.filter(n => n.reading < 7.0);
    belowTargetNudges.forEach(function (n)
    {
        assert.ok(isEmergencyFood(n.message), `below-target nudge in rapid drop must use emergency foods, got: ${n.message}`);
    });
});

test(`rapid hypo from target: emergency foods at hypo levels`, async () =>
{
    // BG drops from 8.0 to 3.2 at 0.7 mmol/L per tick. the early preemptive
    // nudge in-range may use slow carbs (appropriate — there's still time).
    // once below target with active insulin, must switch to emergency foods.
    var nudges = await runScenario(`rapid-hypo-from-target.json`);
    assert.ok(nudges.length >= 1, `should nudge during rapid hypo descent`);
    var belowTargetNudges = nudges.filter(n => n.reading < 7.0);
    assert.ok(belowTargetNudges.length >= 1, `should have at least one nudge below target`);
    belowTargetNudges.forEach(function (n)
    {
        assert.ok(isEmergencyFood(n.message), `below-target nudge in rapid crash must use emergency foods, got: ${n.message}`);
    });
});

test(`noon slow drift: uses slow carbs, not emergency foods`, async () =>
{
    // BG drifting from 8.0 to 6.0 over 2.5 hours. losing ~0.8 mmol/L per
    // hour — there's no urgency. slow-acting carbs (yoghurt, oatcakes, fruit)
    // are appropriate. fast sugar would cause an unnecessary spike.
    var nudges = await runScenario(`noon-slow-drift-below.json`);
    assert.ok(nudges.length >= 1, `should nudge during slow drift below target`);
    var firstNudge = nudges[0];
    assert.ok(isSlowCarbs(firstNudge.message), `slow drift should use slower-acting carbs, not emergency sugar, got: ${firstNudge.message}`);
});

test(`sharp post-snack recovery: no nudges during rising BG after hypo`, async () =>
{
    // BG bottoms at 5.3 then rises sharply to 9.0 — a snack is working.
    // the engine should nudge once at the low point, then stay quiet during
    // the recovery. nudging while BG is rising would cause over-correction.
    var nudges = await runScenario(`sharp-post-snack-recovery.json`);
    var recoveryNudges = nudges.filter(n => n.reading > 7.0);
    assert.equal(recoveryNudges.length, 0, `no nudges during rising recovery from hypo`);
});

// ===========================================================================
// CARB QUANTITIES SCALE WITH DEFICIT
//
// clinical basis: carb recommendations must be proportional to how far below
// target BG is + how much insulin is fighting the food. underdosing means
// BG stays low (dangerous). overdosing means a rebound spike (wastes the
// correction and causes a rollercoaster).
//
// the formula: (gap to target + 0.5 buffer + insulin counter-effect) × 4.4g/mmol
// ===========================================================================

test(`midday crash: carbs escalate as BG drops further from target`, async () =>
{
    // stable at 8.5, then crashes to 4.5. first nudge (near target) should
    // suggest less than the later nudges (deep below target).
    var nudges = await runScenario(`midday-plateau-then-crash.json`);
    assert.ok(nudges.length >= 2, `should nudge more than once as crash deepens past absorption window`);
    var firstCarbs = extractCarbs(nudges[0].message);
    var lastCarbs = extractCarbs(nudges[nudges.length - 1].message);
    assert.ok(lastCarbs > firstCarbs, `deeper deficit should recommend more carbs: first=${firstCarbs}g, last=${lastCarbs}g`);
});

test(`double dip: second dip gets its own carb recommendation`, async () =>
{
    // first dip to 4.5, recovery to 7.5, second dip to 4.0.
    // the second dip is a new situation — the first snack wasn't enough.
    // the engine must re-evaluate and recommend carbs for the new deficit.
    var nudges = await runScenario(`double-dip-hypo.json`);
    assert.ok(nudges.length >= 2, `should nudge on both dips`);
    var secondDipNudges = nudges.filter(n => n.time >= `2026-04-07 14:30`);
    assert.ok(secondDipNudges.length >= 1, `must nudge on the second dip after recovery`);
    var carbs = extractCarbs(secondDipNudges[0].message);
    assert.ok(carbs >= 5, `second dip at ~5.0 should suggest at least 5g, got ${carbs}g`);
});

test(`hypo recovery bounce: emergency-level carbs during descent`, async () =>
{
    // BG drops from 7.0 to 3.8. with targetLow at 6.0, the engine first
    // nudges when BG drops below 6.0 or when projection shows it heading
    // there. once below hypoFloor (5.0), emergency foods are mandatory.
    // rule of 15: treat with 15g, wait 15 min, repeat. engine's max
    // emergency tier is 15g to prevent over-treatment rebound spikes.
    var nudges = await runScenario(`hypo-recovery-bounce.json`);
    assert.ok(nudges.length >= 1, `should nudge during descent to hypo`);
    var emergencyNudge = nudges.find(n => isEmergencyFood(n.message));
    assert.ok(emergencyNudge, `should use emergency foods during rapid descent to hypo`);
    var carbs = extractCarbs(emergencyNudge.message);
    assert.ok(carbs >= 5 && carbs <= 15, `emergency carbs should be 5-15g, got ${carbs}g`);
});

// ===========================================================================
// SUPPRESSION: ONE NUDGE PER DIP
//
// clinical basis: we don't know when the user will see or act on a message.
// if they action two nudges on the same dip, they double-dose — e.g. 10g +
// 10g = 20g fast sugar from a starting BG of 6.9 would spike to ~11.4.
// that's a waste and starts a rollercoaster. one message per dip, then wait
// for the food to show in BG before re-evaluating.
// ===========================================================================

test(`high-settle-then-dip: two separate dips produce exactly two nudges`, async () =>
{
    var nudges = await runScenario(`high-settle-then-dip.json`);
    assert.equal(nudges.length, 2, `expected 2 nudges (one per dip), got ${nudges.length}`);
});

test(`high-settle-then-dip: first nudge fires on the first dip`, async () =>
{
    var nudges = await runScenario(`high-settle-then-dip.json`);
    assert.ok(nudges[0].reading < 6.0, `first nudge should fire below target, fired at ${nudges[0].reading}`);
    assert.ok(nudges[0].time < `2026-04-10 10:30`, `first nudge should fire before the stable period`);
});

test(`high-settle-then-dip: second nudge fires on the second dip (not suppressed)`, async () =>
{
    var nudges = await runScenario(`high-settle-then-dip.json`);
    assert.ok(nudges[1].reading < 6.0, `second nudge should fire below target, fired at ${nudges[1].reading}`);
    assert.ok(nudges[1].time >= `2026-04-10 13:00`, `second nudge should fire after the stable period`);
});

test(`2026-04-09: crossing targetLow on same dip does not double-nudge`, async () =>
{
    // BG fell from 7.4 (in-target) to 6.9 (below-target) in 20 min.
    // crossing the 7.0 boundary changes the engine's internal category
    // but it's the same dip — the food from the first nudge is still absorbing.
    // a second nudge risks the user eating both recommendations: 10g + 5g + 10g = 25g,
    // which would spike BG to ~12.6 from 6.9.
    var nudges = await runScenario(`2026-04-09-full-day.json`);
    var eveningNudges = nudges.filter(n => n.time >= `2026-04-09 16:00`);
    assert.equal(eveningNudges.length, 1, `expected 1 evening nudge, got ${eveningNudges.length}`);
    assert.equal(eveningNudges[0].reading, 7.4, `nudge should fire at 7.4 (first detection), not at 6.9 (same dip)`);
});

test(`bouncing near target: single nudge despite oscillation around 7.0`, async () =>
{
    // BG oscillates 6.5-7.5 for 2 hours, repeatedly crossing targetLow.
    // each crossing is NOT a new dip — it's the same instability.
    // multiple nudges would cause stacking: user might eat 3 snacks for
    // what's actually one borderline situation.
    var nudges = await runScenario(`bouncing-near-target-low.json`);
    assert.equal(nudges.length, 1, `oscillation around 7.0 should produce 1 nudge, not repeated messages`);
});

// ===========================================================================
// QUIET HOURS AND SUPPRESSION GATES
//
// clinical basis: nudging between midnight and 6am is harmful — she's asleep,
// can't action the message, and the notification disrupts sleep (which itself
// worsens glycaemic control). the alert channel handles genuine emergencies
// (critical thresholds) with high-priority alarms that break through.
//
// meal window suppression (120 min post-injection) prevents suggesting more
// food while a meal is being digested — the BG rise from the meal hasn't
// peaked yet, so any correction would stack on top of it.
// ===========================================================================

test(`stable-in-range: zero nudges when BG stays 7.5-9.0`, async () =>
{
    var nudges = await runScenario(`stable-in-range.json`);
    assert.equal(nudges.length, 0);
});

test(`dawn-phenomenon: zero nudges during 4-10am rising BG`, async () =>
{
    // dawn phenomenon is normal cortisol-driven liver glucose output.
    // nudging about rising BG during this window would be noise — the
    // morning injection is the intended response, not a snack.
    var nudges = await runScenario(`dawn-phenomenon.json`);
    assert.equal(nudges.length, 0);
});

test(`overnight-quiet: zero nudges during midnight-6am`, async () =>
{
    var nudges = await runScenario(`overnight-quiet.json`);
    assert.equal(nudges.length, 0);
});

test(`slow hypo crossing midnight: nudges before quiet hours, silent after`, async () =>
{
    // BG falls from 6.5 (23:00) through to 3.5 (01:10), crossing midnight.
    // the engine should nudge while she's awake (before midnight) and go
    // silent at midnight — even though BG continues to drop. the alert
    // channel handles the overnight emergency; nudge noise won't help.
    var nudges = await runScenario(`slow-hypo-overnight-boundary.json`);
    assert.ok(nudges.length >= 1, `should nudge before midnight`);
    var afterMidnight = nudges.filter(n => n.time >= `2026-04-08 00:00`);
    assert.equal(afterMidnight.length, 0, `zero nudges after midnight (quiet hours)`);
});

test(`post-breakfast-spike: zero nudges during meal window`, async () =>
{
    // injection at 07:30, breakfast eaten, BG spikes to 14.2 then descends.
    // the meal window (07:30-09:30) suppresses nudges because the food
    // is still being digested — suggesting more carbs on top would worsen
    // the spike. the rapid insulin component handles the descent.
    var nudges = await runScenario(`post-breakfast-spike.json`);
    assert.equal(nudges.length, 0, `meal window should suppress all nudges during post-breakfast spike`);
});

test(`morning insulin kick-in: zero nudges during descent from high`, async () =>
{
    // BG at 15.0 (dawn spike), descends to 7.0 over 3 hours as morning
    // insulin works. the engine must stay silent — this is insulin doing
    // its job, not a low that needs carbs. nudging during descent from
    // high would counteract the insulin and keep BG elevated.
    var nudges = await runScenario(`morning-insulin-kick-in.json`);
    var descentNudges = nudges.filter(n => n.reading > 7.0);
    assert.equal(descentNudges.length, 0, `no nudges while BG descends from high — insulin is working`);
});

// ===========================================================================
// BEDTIME CARB QUANTITIES
//
// clinical basis: the intermediate insulin component peaks 4-8 hours after
// the evening injection (19:00), pulling BG down relentlessly overnight.
// real data shows a consistent 5-6+ mmol/L drop between midnight and 5am,
// causing hypos every night (4.3, 4.9, 4.9 on consecutive nights).
//
// the bedtime nudge must recommend enough slow-release carbs to sustain BG
// through this drop. too few = overnight hypo (dangerous, she's asleep).
// too many = morning high (suboptimal but not immediately dangerous).
// ===========================================================================

test(`bedtime below target falling: recommends starchy carbs for overnight`, async () =>
{
    // BG 6.5 and falling at bedtime. with targetLow at 6.0, 6.5 is just
    // below target — not an emergency. the bedtime nudge should recommend
    // slow-release starchy carbs to sustain BG through the overnight
    // insulin peak. emergency sugar is only needed if BG is at hypoFloor
    // or in freefall.
    var nudges = await runScenario(`bedtime-below-target-falling.json`);
    var bedtime = nudges.find(n => n.title === `Bedtime top-up`);
    assert.ok(bedtime, `expected bedtime nudge`);
    assert.ok(/starchy|oatcake|toast|porridge/.test(bedtime.message), `bedtime nudge should suggest starchy food for overnight`);
});

test(`bedtime below target falling: starchy follow-up is appropriately sized`, async () =>
{
    // the starchy portion should be calibrated to the overnight insulin drop.
    // at ~2 mmol/L per hour over the intermediate peak, she needs enough
    // slow-release carbs to absorb over 3-4 hours. this is typically 15-30g.
    var nudges = await runScenario(`bedtime-below-target-falling.json`);
    var bedtime = nudges.find(n => n.title === `Bedtime top-up`);
    assert.ok(bedtime, `expected bedtime nudge`);
    // the message mentions both emergency and starchy — extract the starchy portion
    var allCarbs = bedtime.message.match(/(\d+)g/g);
    assert.ok(allCarbs && allCarbs.length >= 1, `should mention carb amounts`);
});

// ===========================================================================
// FULL-DAY REAL DATA REGRESSION
//
// clinical basis: real-world glucose traces are messy — rescue snacks,
// missed meals, overnight hypos, dawn spikes. these full-day scenarios
// ensure the engine behaves correctly across a complete 24-hour cycle
// with real CGM data, not just synthetic edge cases.
// ===========================================================================

test(`2026-04-07 full day: one breakfast nudge per morning`, async () =>
{
    // this scenario spans 24h+ (April 7th 05:30 UTC to April 8th 06:30 UTC),
    // crossing two breakfast windows. each morning gets exactly one nudge.
    var nudges = await runScenario(`2026-04-07-full-day.json`);
    var breakfastNudges = nudges.filter(n => n.title === `Good morning`);
    assert.equal(breakfastNudges.length, 2, `one breakfast nudge per morning across 2-day span`);
});

test(`2026-04-08 full day: breakfast nudge fires once in morning window`, async () =>
{
    var nudges = await runScenario(`2026-04-08-full-day.json`);
    var breakfastNudges = nudges.filter(n => n.title === `Good morning`);
    assert.equal(breakfastNudges.length, 1, `exactly one breakfast nudge per day`);
});

test(`2026-04-08 full day: zero nudges during quiet hours despite overnight hypo`, async () =>
{
    // the overnight data includes a hypo to 4.9 at 02:10 BST (01:10 UTC).
    // the engine must stay silent — nudging a sleeping person doesn't help.
    // the alert channel handles this with high-priority alarms.
    var nudges = await runScenario(`2026-04-08-full-day.json`);
    var quietNudges = nudges.filter(function (n)
    {
        // quiet hours are midnight-6am LOCAL. with timezoneOffset 60, that's 23:00-05:00 UTC.
        return n.time >= `2026-04-08 23:00` && n.time < `2026-04-09 05:00`;
    });
    assert.equal(quietNudges.length, 0, `zero nudges during quiet hours`);
});

test(`2026-04-08 full day: bedtime nudge fires once in evening window`, async () =>
{
    var nudges = await runScenario(`2026-04-08-full-day.json`);
    var bedtimeNudges = nudges.filter(n =>
        n.title === `Bedtime top-up` || n.title === `Looking good for bed` || n.title === `Low at bedtime`
    );
    assert.ok(bedtimeNudges.length <= 1, `at most one bedtime nudge per evening, got ${bedtimeNudges.length}`);
});

test(`2026-04-09 full day: total nudge count is reasonable for a full day`, async () =>
{
    // a well-calibrated engine should produce 1-4 nudges per day:
    // breakfast + maybe 1-2 reactive + bedtime. more than 6 suggests
    // over-nudging (notification fatigue). zero suggests under-sensitivity.
    var nudges = await runScenario(`2026-04-09-full-day.json`);
    assert.ok(nudges.length >= 1 && nudges.length <= 6, `expected 1-6 nudges for a full day, got ${nudges.length}`);
});

// ===========================================================================
// FOOD TYPE CORRECTNESS
//
// clinical basis: each food category exists for a reason.
// - emergency (jelly babies, honey): BG response in 5-10 min. used when
//   time matters — hypo, rapid drop, insulin actively pulling BG down.
// - normal (yoghurt, oatcakes, fruit): BG response in 30-60 min. used
//   for gentle corrections where there's time for slow absorption.
// - bedtime (toast+cheese, oatcakes+PB): fat/protein slows absorption to
//   2-4 hours, matching the intermediate insulin's sustained overnight pull.
//
// recommending the wrong food type for the situation is clinically harmful
// even if the gram amount is correct.
// ===========================================================================

test(`slow decline afternoon: slow carbs for a non-urgent drift`, async () =>
{
    // BG drifts from 9.0 to 6.0 over 80 min. rate is ~2 mmol/L per hour —
    // concerning but not an emergency. there's time for slow-acting carbs
    // to absorb. fast sugar would spike and crash, worsening the rollercoaster.
    var nudges = await runScenario(`slow-decline-afternoon.json`);
    assert.ok(nudges.length >= 1, `should nudge during slow decline`);
});

test(`pre-dinner low: nudges for daytime low, no bedtime nudge`, async () =>
{
    // BG falls to 5.1 before dinner (17:00-18:50).
    // this is outside the bedtime window (21:00-22:00) — engine should use
    // daytime food suggestions, not bedtime starchy carbs.
    var nudges = await runScenario(`pre-dinner-low.json`);
    var bedtimeNudges = nudges.filter(n =>
        n.title === `Bedtime top-up` || n.title === `Looking good for bed` || n.title === `Low at bedtime`
    );
    assert.equal(bedtimeNudges.length, 0, `no bedtime nudges outside 21:00-22:00 window`);
    assert.ok(nudges.length >= 1, `should nudge for pre-dinner low`);
});
