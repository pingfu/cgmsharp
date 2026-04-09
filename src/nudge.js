const moment = require(`moment`);

// =============================================================================
// nudge engine
// =============================================================================
//
// objective
// ---------
// designed for a type 1 diabetic on twice-daily premixed (biphasic) insulin.
// gently coach the user into making smaller, earlier corrective food choices so
// their blood sugar stays in range more often — without needing to understand
// the underlying science. every message sent must be actionable. if there's
// nothing to do, stay quiet.
//
// type 1 context: the user produces no insulin of their own. the injected
// biphasic insulin is the only insulin in their system. this means:
// - no natural insulin reduction when BG drops (the injection keeps working)
// - overnight hypo risk is acute — the intermediate component peaks at 4-8h
//   post-injection and will pull BG down regardless of the current level
// - dawn phenomenon is uncompensated liver glucose output with no natural
//   insulin response — the morning injection has to cover it
//
// how it works
// ------------
// each tick (10 min), the engine receives a new glucose reading. it maintains
// its own sliding window of recent readings (6 readings, 60 min) and evaluates
// whether to send a nudge on the ntfy nudge channel.
//
// the decision uses five inputs:
//
//   1. zone — where the reading sits relative to the target range (7.0-10.0):
//      - below target: suggest carbs (amount depends on gap, trend, insulin)
//      - in target (lower half, <7.5): preemptive nudge if falling + insulin active
//      - in target (upper half): quiet — comfortable
//      - above target: quiet — not the nudge engine's job (alerts handle highs)
//
//   2. trend — two-timescale slope analysis:
//      - long-term rate: slope across the full 60-min window (overall direction)
//      - short-term rate: slope across the last 20 min (what's happening now)
//      - acceleration: difference between short and long term rates.
//        negative acceleration = the drop is getting steeper.
//        this distinguishes "been gently falling all hour" from "was stable,
//        now suddenly crashing" — the latter needs emergency sugar, not yoghurt.
//
//   3. insulin activity — biphasic curve model of premixed insulin (e.g. NovoMix 30):
//      - 30% rapid-acting: peaks 60-90 min, gone by 4 hours
//      - 70% intermediate: peaks 4-8 hours, tails off by 16 hours
//      - piecewise linear interpolation, combined weighted activity 0.0-1.0
//      - "meaningfully active" above 0.25 threshold
//      - when insulin is active and BG is falling, carb suggestions are increased
//        because the drop will likely continue
//
//   4. suppression gates — prevent noise and fatigue:
//      - meal window (120 min after injection): assume a meal is being digested,
//        don't suggest more food on top of dinner
//      - overnight quiet hours (midnight-6am): fully silent, she's asleep
//      - dawn phenomenon (4-10am): suppress nudges for rising BG that's normal
//        morning cortisol, not diet-related
//      - expected-response tracking: when we suggest "eat 5g", we calculate where
//        BG should end up. suppress re-nudging until either the advice worked
//        (BG reached expected level) or the situation has meaningfully worsened
//        (carb estimate jumped by 3g+). prevents repeating "have a pear" every
//        20 min during a slow drift.
//
//   5. breakfast nudge — one proactive message per morning (07:00-07:30 local):
//      - calculates how many carbs would keep post-breakfast peak below targetHigh
//      - uses availableRoom = targetHigh - reading, scaled by carbsPerMmol
//      - if BG is already above target, suggests low-carb breakfast (eggs, yoghurt)
//      - if BG is well above target (>14), suggests skipping carbs entirely
//      - fires once per morning at injection time, before eating
//
//   6. bedtime nudge — one proactive message per evening (21:00-22:00 local):
//      - calculates a bedtime target: targetLow + expected overnight drop (3.5 mmol/L)
//      - if reading is below the target, suggests carbs to top up for the night
//      - if reading is above the target, sends a reassuring "looking good" message
//      - waits for BG to be stable (not still settling from dinner)
//      - fires once per evening, then the regular engine takes over until quiet hours
//
//   7. food selection — three categories:
//      - normal suggestions: healthy UK foods with specific portions (yoghurt,
//        oatcakes, fruit, toast). used for gentle corrections.
//      - emergency suggestions: fast-acting sugar (jelly babies, glucose tablets,
//        orange juice). used when the trend is urgent — dropping fast and/or
//        accelerating towards hypo. these raise BG within 5-10 minutes.
//
// carb estimation
// ---------------
// the amount of carbs to suggest is calculated from:
//   - gap between current reading and target (7.0) + 0.5 mmol/L buffer
//   - multiplied by carbsPerMmol (observed: 4.4g per 1 mmol/L rise)
//   - adjusted up for acceleration, rapid drops, and insulin counteraction
//     (scaled proportionally by insulin activity — not a binary on/off)
//   - adjusted down if rising
//   - clamped to 5-20g range (below 5g has no measurable BG effect)
//
// the carbsPerMmol ratio is the single most important tuning knob. it was
// calibrated from one evening data point (18g carbs → 4.1 mmol/L rise). it
// will vary by time of day, activity, and meal composition. the test harness
// allows overriding it per scenario to explore different sensitivities.
//
// projection
// ----------
// glucose is projected 30 min forward using the short-term rate + acceleration
// (basic kinematics). this catches situations where BG is currently in range
// but heading out the bottom — enabling preemptive nudges before she actually
// goes low.
//
// =============================================================================

// default profile — current values calibrated from historical data (Apr-Oct 2025, 21,777 readings)
// and observed carb sensitivity (2026-04-06 evening session)
const DEFAULTS = {
    // target range
    targetLow: 7.0, // lower bound of "top half of green" (mmol/L). p25 of historical data is 7.4.
    hypoFloor: 5.0, // below this, always use emergency foods regardless of trend. clinical hypo territory for type 1.
    targetHigh: 10.0, // upper bound of target range. Median is 9.4.
    aboveThreshold: 11.0, // only nudge about high sugar above this. 43% of readings above 10.0 — nudging there would be constant noise.

    // biphasic insulin curve: rapid component (30% of premixed dose, e.g. NovoMix 30)
    // manufacturer numbers — may need shifting for older patients who absorb more slowly
    rapidOnset: 15, // minutes post-injection before rapid component begins
    rapidPeakStart: 60, // start of peak rapid-acting effect
    rapidPeakEnd: 90, // end of peak rapid-acting effect
    rapidTail: 240, // rapid component fully worn off (4 hours)

    // biphasic insulin curve: intermediate component (70% of premixed dose)
    // broader, slower curve — background coverage between meals
    intermediateOnset: 90, // minutes post-injection before intermediate begins
    intermediatePeakStart: 240, // start of peak intermediate effect (4 hours)
    intermediatePeakEnd: 480, // end of peak intermediate effect (8 hours)
    intermediateTail: 960, // intermediate fully worn off (16 hours)

    // component weights (must sum to 1.0) — reflects 30/70 split of premixed insulin
    rapidWeight: 0.30,
    intermediateWeight: 0.70,

    // insulin is considered "meaningfully active" above this threshold (0.0-1.0 scale).
    // at 0.25, creates distinct active/inactive windows with twice-daily dosing.
    insulinActiveThreshold: 0.25,

    // dawn phenomenon window — historical mean BG 12.15 during 4-8 AM vs 9.1 overnight,
    // spike persists through late morning (8-noon mean 10.83), so window extends to 10 AM.
    dawnStartHour: 4,
    dawnEndHour: 10,

    // how far ahead to project glucose (minutes). uses short-term rate + acceleration.
    projectionMinutes: 30,

    // meal window — insulin is injected with a meal. suppress carb nudges for this period.
    // observed eat-peak-settle cycle took ~2 hours on 2026-04-06.
    mealWindowMinutes: 120,

    // observed carb sensitivity: 18g carbs raised BG by 4.1 mmol/L (4.7 → 8.8).
    // ~4.4g per 1 mmol/L. the single most important per-individual tuning knob.
    carbsPerMmol: 4.4,

    // insulin counteraction factor: at peak insulin activity (1.0), how many mmol/L
    // will insulin pull BG down during the ~30 min food absorption window?
    // observed: 20g bedtime snack from 7.7 peaked at 10.3 (+2.6) vs expected +4.5.
    // insulin activity was ~0.6, so insulin counteracted ~1.9 mmol/L. at activity 1.0
    // that's ~3.2 mmol/L. we use this to add extra carbs when insulin is fighting the food.
    insulinCounterFactor: 3.2,

    // bedtime nudge window — one proactive nudge to position BG for the overnight insulin peak.
    // fires once per evening during this window if the reading is stable.
    // set 1.5-2h before typical bedtime so slow-release food has time to absorb
    // before the intermediate insulin peaks (4-8h post evening injection).
    // all times are local (container TZ=Europe/London handles BST/GMT automatically).
    // breakfast nudge window — one proactive nudge to guide carb intake based on current BG.
    // fires once per morning during this window (injection time, before eating).
    // all times are local (container TZ=Europe/London handles BST/GMT automatically).
    breakfastWindowStart: 7, // 07:00 local
    breakfastWindowEnd: 7.5, // 07:30 local

    bedtimeWindowStart: 21, // 21:00 local
    bedtimeWindowEnd: 22, // 22:00 local

    // overnight insulin pull rate: mmol/L per hour at peak insulin activity (1.0).
    // this is lower than insulinCounterFactor because overnight there's no incoming
    // food for the insulin to metabolise — the pull rate is the basal glucose-lowering
    // effect. calibrated from historical data:
    //   Apr 20: 17.1 → 5.1 over ~7h (drop 12.0, avg ~1.7/h)
    //   Jul 22: 15.8 → 2.9 over ~6h (drop 12.9, avg ~2.2/h)
    //   Sep 15: 7.2 → 2.8 over ~3h (drop 4.4, avg ~1.5/h)
    // accounting for insulin activity curve (not constant), 2.5/h at peak fits the data.
    // 1.8 was too low — Apr 20 (17.1→5.1) and Jul 22 (15.8→2.9) show actual pulls of 12-13.
    overnightPullRate: 2.5, // mmol/L per hour at activity 1.0

    // fallback static overnight drop if insulin times not configured
    overnightDrop: 3.5, // mmol/L

    // overnight quiet hours — fully silent. alerts handle emergencies separately.
    quietStartHour: 0, // midnight
    quietEndHour: 6, // 6 AM

    // absorption suppression — after recommending carbs, suppress further carb nudges
    // until the food has had time to show in BG. tied to physiology, not arbitrary.
    absorptionSmall: 20, // minutes for ≤7g carbs
    absorptionLarge: 35, // minutes for >7g carbs

    // trend thresholds in mmol/L per minute. historical data: median tick-to-tick change is 0.0,
    // p25/p75 ±0.04/min, p5/p95 ±0.14-0.15/min. 0.07 "rapidly" catches ~10-15% of movements.
    trendFlatThreshold: 0.01,
    trendSlowThreshold: 0.05,
    trendRapidThreshold: 0.07,

    // acceleration thresholds — how fast the rate of change is itself changing.
    // negative acceleration means the drop is getting steeper.
    accelerationThreshold: -0.003, // mmol/L per min² — below this, drop is accelerating meaningfully
    urgentShortRate: -0.07, // mmol/L per min — short-term rate below this is "dropping fast"

    // readings buffer size
    maxReadings: 6 // 60 min at 10-min intervals
};

// carb suggestion lookup: each tier has a gram target and food ideas to rotate through.
// UK supermarket staples, healthy where possible, practical for an elderly person.
// every suggestion is specific about food type and portion size.
const CARB_SUGGESTIONS = [
    // no 2g tier — amounts that small have no measurable BG effect. minimum useful correction is 5g.
    { grams: 5, ideas: [
        `a 125g pot of plain natural yoghurt`,
        `half a small banana`,
        `3 strawberries with a tablespoon of natural yoghurt`,
        `4 cherry tomatoes with a thin slice of cheddar`,
        `a small glass (100ml) of semi-skimmed milk`,
        `1 satsuma`,
        `1 tablespoon of raisins`,
        `2 plain rice cakes`,
        `1 small pear`,
        `10 cashew nuts`
    ]},
    { grams: 7, ideas: [
        `1 small apple (about the size of a tennis ball)`,
        `1 tablespoon of hummus with 3 carrot sticks`,
        `a 125g pot of natural yoghurt with 5 or 6 blueberries`,
        `1 oatcake with a thin slice of cheddar`,
        `3 pieces of dried mango`,
        `half a crumpet with a scrape of butter`,
        `2 Ryvita with a tablespoon of cream cheese`,
        `a 100g pot of cottage cheese with 2 tinned pineapple chunks`
    ]},
    { grams: 10, ideas: [
        `1 slice of wholemeal toast with butter`,
        `1 small banana (about 15cm long)`,
        `4 tablespoons of porridge oats made with water`,
        `about 10 grapes with 5 almonds`,
        `1 medium apple with a teaspoon of peanut butter`,
        `2 oatcakes with a thin slice of cheddar`,
        `1 crumpet with butter`,
        `1 Weetabix with 100ml of semi-skimmed milk`,
        `2 tablespoons of trail mix`
    ]},
    { grams: 15, ideas: [
        `1 slice of wholemeal toast with a teaspoon of peanut butter`,
        `a glass (200ml) of semi-skimmed milk and 1 satsuma`,
        `a 30g bowl of bran flakes with semi-skimmed milk`,
        `2 oatcakes with cheddar and 1 small apple`,
        `1 crumpet with a teaspoon of strawberry jam`,
        `half a small jacket potato with a knob of butter`,
        `4 tablespoons of porridge oats made with semi-skimmed milk and a drizzle of honey`,
        `half a wholemeal pitta with 2 tablespoons of hummus`,
        `3 tablespoons of baked beans on half a slice of wholemeal toast`
    ]},
    { grams: 20, ideas: [
        `half a cheese and pickle sandwich on wholemeal bread`,
        `4 tablespoons of porridge oats with semi-skimmed milk and half a banana`,
        `half a small jacket potato with 3 tablespoons of baked beans`,
        `2 crumpets with butter`,
        `1 slice of wholemeal toast with 4 tablespoons of baked beans`
    ]}
];

// emergency food suggestions — fast-acting carbs for rapid/accelerating drops.
// these raise BG within 5-10 minutes. used when trend is urgent.
// everything here must be fat-free and sugar-based — fat slows absorption.
// no chocolate, biscuits, cereal bars, or milk.
const EMERGENCY_SUGGESTIONS = [
    { grams: 5, ideas: [
        `1 jelly baby`,
        `1 teaspoon of honey`,
        `1 teaspoon of jam`,
        `1 teaspoon of sugar dissolved in water`
    ]},
    { grams: 10, ideas: [
        `2 jelly babies`,
        `2 teaspoons of honey`,
        `1 tablespoon of jam`,
        `2 teaspoons of sugar dissolved in water`
    ]},
    { grams: 15, ideas: [
        `3 jelly babies`,
        `1 tablespoon of honey`,
        `3 teaspoons of sugar dissolved in water`
    ]}
    // no 20g tier — rule of 15: treat with 15g fast-acting, wait 15 min, repeat if still low.
    // overtreating hypos causes rebound spikes. let the engine re-evaluate after absorption.
];

// bedtime food suggestions — slow-release carbs that absorb over 2-3 hours.
// the goal is sustained glucose overnight, not a fast spike. starchy carbs with
// protein or fat slow digestion and provide a trickle of glucose that matches
// the intermediate insulin's sustained pull. no fruit, juice, or fast-acting sugar.
// oatcake carb counts based on Nairn's Rough Oatcakes: 5.8g carb per oatcake.
// 1 oatcake ≈ 6g, 2 oatcakes ≈ 12g, 3 oatcakes ≈ 18g.
const BEDTIME_SUGGESTIONS = [
    { grams: 5, ideas: [
        `1 oatcake with a thin slice of cheddar`,
        `half a slice of wholemeal toast with butter`,
        `2 tablespoons of porridge oats made with water`,
        `1 plain rice cake with a teaspoon of peanut butter`
    ]},
    { grams: 7, ideas: [
        `1 oatcake with a teaspoon of peanut butter`,
        `half a slice of wholemeal toast with a thin slice of cheddar`,
        `2 tablespoons of porridge oats made with semi-skimmed milk`,
        `2 Ryvita with a tablespoon of cream cheese`
    ]},
    { grams: 10, ideas: [
        `1 slice of wholemeal toast with a thin slice of cheddar`,
        `2 oatcakes with cheddar`,
        `3 tablespoons of porridge oats made with semi-skimmed milk`,
        `1 Weetabix with 100ml of semi-skimmed milk`,
        `1 slice of wholemeal toast with butter`
    ]},
    { grams: 15, ideas: [
        `1 slice of wholemeal toast with cheddar`,
        `2 oatcakes with cheddar and a teaspoon of peanut butter`,
        `4 tablespoons of porridge oats made with semi-skimmed milk`,
        `1 slice of wholemeal toast with a tablespoon of peanut butter`,
        `half a wholemeal pitta with 2 tablespoons of hummus and a slice of cheddar`
    ]},
    { grams: 20, ideas: [
        `3 oatcakes with cheddar`,
        `1 slice of wholemeal toast with cheddar and a teaspoon of peanut butter`,
        `4 tablespoons of porridge oats made with semi-skimmed milk and 5 almonds`,
        `half a cheese sandwich on wholemeal bread`
    ]},
    { grams: 25, ideas: [
        `3 oatcakes with cheddar and a teaspoon of peanut butter`,
        `2 oatcakes with cheddar and 1 slice of wholemeal toast with butter`,
        `4 tablespoons of porridge oats made with semi-skimmed milk and a tablespoon of peanut butter`,
        `1 wholemeal pitta with 2 tablespoons of hummus and a slice of cheddar`
    ]},
    { grams: 30, ideas: [
        `3 oatcakes with cheddar and 1 slice of wholemeal toast with butter`,
        `4 tablespoons of porridge oats made with semi-skimmed milk and 1 slice of wholemeal toast with butter`,
        `2 slices of wholemeal toast with cheddar`,
        `1 wholemeal pitta with cheddar and a tablespoon of peanut butter`
    ]}
];

// breakfast carb suggestions — breakfast-appropriate foods with specific portions.
// same tiered structure as CARB_SUGGESTIONS but only foods you'd eat at breakfast.
const BREAKFAST_SUGGESTIONS = [
    { grams: 5, ideas: [
        `half a small banana`,
        `a 125g pot of plain natural yoghurt`,
        `a small glass (100ml) of semi-skimmed milk`,
        `1 tablespoon of raisins`,
        `2 plain rice cakes with butter`
    ]},
    { grams: 7, ideas: [
        `half a crumpet with a scrape of butter`,
        `a 125g pot of natural yoghurt with 5 or 6 blueberries`,
        `2 tablespoons of porridge oats made with water`,
        `1 oatcake with a thin slice of cheddar`
    ]},
    { grams: 10, ideas: [
        `1 slice of wholemeal toast with butter`,
        `1 small banana (about 15cm long)`,
        `4 tablespoons of porridge oats made with water`,
        `1 crumpet with butter`,
        `1 Weetabix with 100ml of semi-skimmed milk`
    ]},
    { grams: 15, ideas: [
        `1 slice of wholemeal toast with a teaspoon of peanut butter`,
        `a 30g bowl of bran flakes with semi-skimmed milk`,
        `1 crumpet with a teaspoon of strawberry jam`,
        `4 tablespoons of porridge oats made with semi-skimmed milk and a drizzle of honey`,
        `1 Weetabix with semi-skimmed milk and half a small banana`
    ]},
    { grams: 20, ideas: [
        `4 tablespoons of porridge oats with semi-skimmed milk and half a banana`,
        `2 crumpets with butter`,
        `1 slice of wholemeal toast with a teaspoon of peanut butter and half a banana`,
        `2 Weetabix with semi-skimmed milk`
    ]}
];

// low-carb breakfast suggestions — for mornings when BG is already above target.
// zero/minimal carb options to avoid stacking carbs on top of dawn phenomenon.
// no gram tiers needed — these are used when carbs should be avoided entirely.
const LOW_CARB_BREAKFAST_SUGGESTIONS = [
    `scrambled eggs`,
    `a boiled egg`,
    `poached eggs on their own`,
    `a 125g pot of plain natural yoghurt with a few berries`,
    `a couple of slices of cheese`,
    `scrambled eggs with a slice of cheese`,
    `plain omelette`
];

function createNudgeEngine(config)
{
    // merge config over defaults — config values win, missing values fall back to defaults
    var p = {};
    for (var key in DEFAULTS) p[key] = config[key] !== undefined ? config[key] : DEFAULTS[key];

    var interval = config.interval;

    // nudge engine maintains its own readings history, independent of other modules
    var readings = [];

    var state = {
        insulinTimes: {
            morning: config.insulinTimeMorning || null,
            evening: config.insulinTimeEvening || null
        },
        lastNudgeSent: null,
        lastNudgeCategory: null,
        lastNudgeCarbs: null,
        lastNudgeReading: null,
        lastNudgeExpectedReading: null, // where we expect BG to be once the suggested food absorbs
        breakfastNudgeSentDate: null, // date string (YYYY-MM-DD) of last breakfast nudge — one per morning
        bedtimeNudgeSentDate: null // date string (YYYY-MM-DD) of last bedtime nudge — one per evening
    };

    // long-term rate: slope across the full readings buffer (~60 min). overall direction.
    function getLongTermRate()
    {
        if (readings.length < 4) return null;
        var newest = readings[readings.length - 1];
        var oldest = readings[0];
        return (newest - oldest) / ((readings.length - 1) * interval);
    }

    // short-term rate: slope across last 3 readings (~20 min). what's happening right now.
    // uses 3 readings to smooth out single-tick CGM noise.
    function getShortTermRate()
    {
        if (readings.length < 3) return null;
        var newest = readings[readings.length - 1];
        var recent = readings[readings.length - 3];
        return (newest - recent) / (2 * interval);
    }

    // acceleration: difference between short-term and long-term rate.
    // negative = drop is getting steeper. positive = drop is levelling off (or rise accelerating).
    function getAcceleration()
    {
        var longRate = getLongTermRate();
        var shortRate = getShortTermRate();
        if (longRate === null || shortRate === null) return null;
        return shortRate - longRate;
    }

    function getTrend(reading)
    {
        var longRate = getLongTermRate();
        var shortRate = getShortTermRate();
        var acceleration = getAcceleration();

        // fall back to simple 2-reading rate if we don't have enough history
        if (shortRate === null)
        {
            if (readings.length < 2) return { rate: null, shortRate: null, acceleration: null, direction: `unknown`, description: `insufficient data`, urgent: false };
            var simpleRate = (readings[readings.length - 1] - readings[readings.length - 2]) / interval;
            var dir = simpleRate > 0 ? `rising` : simpleRate < 0 ? `falling` : `flat`;
            return { rate: simpleRate, shortRate: simpleRate, acceleration: null, direction: dir, description: Math.abs(simpleRate) < p.trendFlatThreshold ? `stable` : `slowly ${dir}`, urgent: false };
        }

        // use short-term rate for direction classification — it's what's happening now
        var absShort = Math.abs(shortRate);
        var direction = shortRate > 0 ? `rising` : shortRate < 0 ? `falling` : `flat`;

        // build description incorporating acceleration
        var description;
        var urgent = false;

        if (absShort < p.trendFlatThreshold)
        {
            description = `stable`;
        }
        else if (absShort < p.trendSlowThreshold)
        {
            description = `slowly ${direction}`;
        }
        else if (absShort < p.trendRapidThreshold)
        {
            if (acceleration !== null && direction === `falling` && acceleration < p.accelerationThreshold)
            {
                description = `falling and picking up pace`;
            }
            else
            {
                description = direction;
            }
        }
        else
        {
            // short-term rate is rapid
            if (direction === `falling`)
            {
                if (acceleration !== null && acceleration < p.accelerationThreshold)
                {
                    description = `dropping fast and accelerating`;
                }
                else
                {
                    description = `dropping fast`;
                }
                urgent = true;
            }
            else
            {
                description = `rising quickly`;
            }
        }

        // urgent only when falling AND already close to or below target.
        // a rapid drop from 13 to 9 is not urgent — she's still in range.
        if (urgent && direction === `falling`)
        {
            if (reading > p.targetLow + 1.0) urgent = false;
        }

        return {
            rate: longRate || shortRate,
            shortRate: shortRate,
            acceleration: acceleration,
            direction: direction,
            description: description,
            urgent: urgent
        };
    }

    function getInsulinComponentActivity(minutesSinceInjection, onset, peakStart, peakEnd, tail)
    {
        if (minutesSinceInjection < onset) return 0;
        if (minutesSinceInjection < peakStart) return (minutesSinceInjection - onset) / (peakStart - onset);
        if (minutesSinceInjection <= peakEnd) return 1.0;
        if (minutesSinceInjection < tail) return 1.0 - (minutesSinceInjection - peakEnd) / (tail - peakEnd);
        return 0;
    }

    function getMinutesSinceLastInjection(now)
    {
        var candidates = [];

        [state.insulinTimes.morning, state.insulinTimes.evening].forEach(function (timeStr)
        {
            if (!timeStr) return;

            var parts = timeStr.split(`:`);
            var injectionToday = moment(now).startOf(`day`).add(parseInt(parts[0]), `hours`).add(parseInt(parts[1]), `minutes`);

            if (injectionToday.isAfter(now))
            {
                injectionToday.subtract(1, `day`);
            }

            candidates.push(now.diff(injectionToday, `minutes`));
        });

        if (candidates.length === 0) return null;

        return Math.min.apply(null, candidates);
    }

    function getInsulinActivity(minutesSinceInjection)
    {
        if (minutesSinceInjection === null) return null;

        var rapid = getInsulinComponentActivity(minutesSinceInjection, p.rapidOnset, p.rapidPeakStart, p.rapidPeakEnd, p.rapidTail);
        var intermediate = getInsulinComponentActivity(minutesSinceInjection, p.intermediateOnset, p.intermediatePeakStart, p.intermediatePeakEnd, p.intermediateTail);

        return (rapid * p.rapidWeight) + (intermediate * p.intermediateWeight);
    }

    function isInMealWindow(now)
    {
        var minutesSince = getMinutesSinceLastInjection(now);
        return minutesSince !== null && minutesSince <= p.mealWindowMinutes;
    }

    function isQuietHours(now)
    {
        var hour = now.hour();
        return hour >= p.quietStartHour && hour < p.quietEndHour;
    }

    function isDawnPhenomenonWindow(now)
    {
        var hour = now.hour();
        return hour >= p.dawnStartHour && hour < p.dawnEndHour;
    }

    // projection uses short-term rate + acceleration for more accurate forecasting.
    // if drop is accelerating, the projection is worse than linear — basic kinematics.
    function projectGlucose(reading, trend)
    {
        if (trend.shortRate === null) return null;
        var projected = reading + (trend.shortRate * p.projectionMinutes);
        if (trend.acceleration !== null && trend.acceleration < 0)
        {
            projected = projected + (0.5 * trend.acceleration * p.projectionMinutes);
        }
        return projected;
    }

    function estimateCarbsNeeded(reading, trend, insulinActivity)
    {
        var gap = p.targetLow - reading;
        if (gap < 0) gap = 0;

        var targetGap = gap + 0.5;

        // when insulin is active, the food has to overcome the insulin's BG-lowering effect
        // in addition to raising BG. scale the counter-effect by current insulin activity level.
        if (insulinActivity !== null && insulinActivity > 0)
        {
            targetGap = targetGap + (insulinActivity * p.insulinCounterFactor * (p.projectionMinutes / 60));
        }

        var base = Math.round(targetGap * p.carbsPerMmol);

        // factor in acceleration — accelerating drops need more carbs
        if (trend.urgent) base = base + Math.round(p.carbsPerMmol * 1.0);
        else if (trend.description === `dropping fast`) base = base + Math.round(p.carbsPerMmol * 0.5);
        else if (trend.direction === `rising`) base = Math.max(base - Math.round(p.carbsPerMmol * 0.5), 2);

        base = Math.max(base, 5); // minimum useful correction — below 5g has no measurable BG effect
        base = Math.min(base, 20);

        return base;
    }

    function getSuggestionFromTable(table, grams)
    {
        var best = table[0];
        var bestDiff = Math.abs(grams - best.grams);

        for (var i = 1; i < table.length; i++)
        {
            var diff = Math.abs(grams - table[i].grams);
            if (diff < bestDiff)
            {
                best = table[i];
                bestDiff = diff;
            }
        }

        var idea = best.ideas[Math.floor(Math.random() * best.ideas.length)];
        return { grams: best.grams, suggestion: idea };
    }

    function getCarbSuggestion(grams)
    {
        return getSuggestionFromTable(CARB_SUGGESTIONS, grams);
    }

    function getEmergencySuggestion(grams)
    {
        return getSuggestionFromTable(EMERGENCY_SUGGESTIONS, grams);
    }

    function getBedtimeSuggestion(grams)
    {
        return getSuggestionFromTable(BEDTIME_SUGGESTIONS, grams);
    }

    function getBreakfastSuggestion(grams)
    {
        return getSuggestionFromTable(BREAKFAST_SUGGESTIONS, grams);
    }

    // expected-response suppression: when we send a carb suggestion, we calculate where BG
    // should be once the food absorbs. suppress further nudges until either:
    // a) the reading has reached or exceeded the expected level (advice worked — stay quiet)
    // b) enough time has passed AND the reading is below expected (advice wasn't enough — escalate)
    // c) the carb tier has jumped (situation worsened beyond what original advice covers)
    function shouldSuppressNudge(reading, carbs, category, now)
    {
        if (state.lastNudgeSent === null || state.lastNudgeCarbs === null) return false;

        var minutesSinceLastNudge = (now.valueOf() - state.lastNudgeSent) / 60000;
        var absorptionWindow = state.lastNudgeCarbs <= 7 ? p.absorptionSmall : p.absorptionLarge;

        // category changed (e.g. was in-target-falling, now below) — different situation, don't suppress
        if (category !== state.lastNudgeCategory) return false;

        // still within absorption window — food hasn't had time to work yet
        if (minutesSinceLastNudge < absorptionWindow)
        {
            // unless carb tier has jumped significantly (situation rapidly worsening)
            if (carbs >= state.lastNudgeCarbs + 5) return false;
            return true;
        }

        // absorption window has passed — check if the advice worked
        if (state.lastNudgeExpectedReading !== null)
        {
            // reading has reached or exceeded expected level — advice worked, stay quiet
            if (reading >= state.lastNudgeExpectedReading) return true;

            // reading is below expected — but only re-nudge if the carb estimate has jumped
            // meaningfully (at least 3g more). small increases from 5→6→7 are estimation noise,
            // not a materially worse situation.
            if (carbs < state.lastNudgeCarbs + 3) return true;
        }

        return false;
    }

    // return-to-range detection: if any reading in the buffer was above target,
    // the current descent is insulin bringing BG back down — not a new low to correct.
    function isDescendingFromHigh()
    {
        for (var i = 0; i < readings.length; i++)
        {
            if (readings[i] > p.targetHigh) return true;
        }
        return false;
    }

    function isInBreakfastWindow(now)
    {
        var hour = now.hour() + (now.minute() / 60);
        return hour >= p.breakfastWindowStart && hour < p.breakfastWindowEnd;
    }

    function hasBreakfastNudgeBeenSentToday(now)
    {
        if (state.breakfastNudgeSentDate === null) return false;
        return state.breakfastNudgeSentDate === now.format(`YYYY-MM-DD`);
    }

    function getLowCarbBreakfastSuggestion()
    {
        return LOW_CARB_BREAKFAST_SUGGESTIONS[Math.floor(Math.random() * LOW_CARB_BREAKFAST_SUGGESTIONS.length)];
    }

    function isInBedtimeWindow(now)
    {
        var hour = now.hour() + (now.minute() / 60);
        return hour >= p.bedtimeWindowStart && hour < p.bedtimeWindowEnd;
    }

    function hasBedtimeNudgeBeenSentToday(now)
    {
        if (state.bedtimeNudgeSentDate === null) return false;
        return state.bedtimeNudgeSentDate === now.format(`YYYY-MM-DD`);
    }

    // estimate total BG drop overnight by integrating the insulin activity curve
    // across the next 8 hours. this replaces the static overnightDrop constant —
    // the actual drop depends on where we are in the insulin cycle at bedtime.
    function estimateOvernightDrop(now)
    {
        var minutesSince = getMinutesSinceLastInjection(now);
        if (minutesSince === null) return p.overnightDrop; // fallback if no insulin times configured

        var totalDrop = 0;
        for (var m = 0; m < 480; m += 10) // 8 hours in 10-min steps
        {
            var activity = getInsulinActivity(minutesSince + m);
            if (activity === null) return p.overnightDrop;
            totalDrop += activity * p.overnightPullRate * (10 / 60);
        }
        return totalDrop;
    }

    // breakfast nudge: one proactive message per morning to guide carb intake.
    // fires in the 07:00-07:30 local window (injection time). the breakfast spike
    // is determined by starting BG — same food from different starting BGs produces
    // wildly different peaks. this nudge tells the user how much room they have.
    // returns true if a breakfast nudge was sent (so the regular evaluate can skip).
    async function evaluateBreakfast(reading, trend, sendNudge, now)
    {
        if (!isInBreakfastWindow(now)) return false;
        if (hasBreakfastNudgeBeenSentToday(now)) return false;

        // wait until BG is stable — don't send while still bouncing from overnight
        if (trend.description === `dropping fast` || trend.description === `dropping fast and accelerating`) return false;

        var availableRoom = p.targetHigh - reading;
        var breakfastCarbs = Math.max(0, Math.round(availableRoom * p.carbsPerMmol));

        var title = null;
        var message = null;

        if (reading > 14.0)
        {
            // well above target — skip carbs entirely
            var lowCarbFood = getLowCarbBreakfastSuggestion();
            title = `Good morning`;
            message = `Your sugar is ${reading} — your morning rise has pushed it up. Best to skip carbs at breakfast today and let your insulin bring it down. ${lowCarbFood} would be good.`;
        }
        else if (reading > p.targetHigh)
        {
            // above target — low-carb breakfast
            var lowCarbFood = getLowCarbBreakfastSuggestion();
            title = `Good morning`;
            message = `Your sugar is ${reading} — already high from the morning rise. A low-carb breakfast would help today — ${lowCarbFood}. Save the porridge for a morning when your sugar is lower.`;
        }
        else if (reading >= p.targetLow)
        {
            // in target — reduced carbs with explanation
            var food = getBreakfastSuggestion(breakfastCarbs);
            title = `Good morning`;
            message = `Your sugar is ${reading}. About ${food.grams}g of carbs at breakfast would be a good amount — ${food.suggestion}. Your morning rise is already underway so a smaller portion helps keep the spike down.`;
        }
        else
        {
            // below target — full carb room
            var food = getBreakfastSuggestion(breakfastCarbs);
            title = `Good morning`;
            message = `Your sugar is ${reading}. You've got room for about ${food.grams}g of carbs at breakfast — ${food.suggestion}.`;
        }

        await sendNudge(title, message);
        state.breakfastNudgeSentDate = now.format(`YYYY-MM-DD`);
        return true;
    }

    // bedtime nudge: one proactive message per evening to position BG for overnight.
    // returns true if a bedtime nudge was sent (so the regular evaluate can skip).
    async function evaluateBedtime(reading, trend, sendNudge, now)
    {
        if (!isInBedtimeWindow(now)) return false;
        if (hasBedtimeNudgeBeenSentToday(now)) return false;

        // don't send bedtime nudge while dinner is still being digested
        if (isInMealWindow(now)) return false;

        // wait until BG is stable — don't send while still settling from dinner
        if (trend.description === `dropping fast` || trend.description === `dropping fast and accelerating`) return false;

        var overnightDrop = estimateOvernightDrop(now);
        var bedtimeTarget = p.targetLow + overnightDrop;
        var gap = bedtimeTarget - reading;

        var title = null;
        var message = null;

        if (gap <= 0)
        {
            title = `Looking good for bed`;
            message = `Your sugar is ${reading} heading towards bed (11pm). That should see you through comfortably — no snack needed. Sleep well.`;
        }
        else
        {
            var carbs = Math.round(gap * p.carbsPerMmol);
            carbs = Math.max(carbs, 5);
            carbs = Math.min(carbs, 30);

            if (reading <= p.hypoFloor)
            {
                // dangerously low at bedtime — fast sugar to rescue, then starchy to sustain
                var emergency = getEmergencySuggestion(15);
                var starchy = getBedtimeSuggestion(carbs);
                title = `Low at bedtime`;
                message = `Your sugar is ${reading} — too low for bed (11pm). Have ${emergency.grams}g of fast sugar first (${emergency.suggestion}), then once it comes up, have something starchy like ${starchy.suggestion} to keep you going overnight.`;
            }
            else if (reading < p.targetLow && trend.direction === `falling`)
            {
                // below target and dropping — starchy alone won't absorb fast enough
                var emergency = getEmergencySuggestion(10);
                var starchy = getBedtimeSuggestion(carbs);
                title = `Bedtime top-up`;
                message = `Your sugar is ${reading} and ${trend.description} heading towards bed (11pm). Have ${emergency.grams}g of fast sugar (${emergency.suggestion}) to stop the drop, then have something starchy like ${starchy.suggestion} for overnight.`;
            }
            else if (reading < p.targetLow)
            {
                // below target but stable — starchy has time to absorb (bedtime window is 2h before insulin peak)
                var food = getBedtimeSuggestion(carbs);
                title = `Bedtime top-up`;
                message = `Your sugar is ${reading} — a bit low for bed (11pm). Have about ${food.grams}g of something starchy around half ten — ${food.suggestion}. If there's cheese or peanut butter, eat that bit first — it helps the carbs absorb more slowly overnight.`;
            }
            else if (reading > p.targetHigh)
            {
                // above target but overnight drop will still pull her low — conservative suggestion
                // with explanation of why she needs food despite being high now
                var conservativeCarbs = Math.min(carbs, 15);
                var food = getBedtimeSuggestion(conservativeCarbs);
                title = `Bedtime top-up`;
                message = `Your sugar is ${reading} heading towards bed (11pm). That looks comfortable now but your overnight insulin will bring it down. A small starchy snack around half ten would help you through to morning — ${food.suggestion}. If there's cheese or peanut butter, eat that bit first.`;
            }
            else
            {
                var food = getBedtimeSuggestion(carbs);
                title = `Bedtime top-up`;
                message = `Your sugar is ${reading} heading towards bed (11pm). About ${food.grams}g of something starchy around half ten would help — ${food.suggestion}. If there's cheese or peanut butter, eat that bit first — it slows everything down and keeps it working longer overnight.`;
            }
        }

        await sendNudge(title, message);
        state.bedtimeNudgeSentDate = now.format(`YYYY-MM-DD`);
        return true;
    }

    // now is optional — defaults to moment(). pass a moment instance to control time in tests.
    async function evaluate(reading, sendNudge, now)
    {
        if (readings.length >= p.maxReadings) readings.shift();
        readings.push(reading);

        if (readings.length < 2) return;

        now = now || moment();

        if (isQuietHours(now)) return;

        var trend = getTrend(reading);

        // breakfast nudge — one proactive message per morning with carb guidance
        if (await evaluateBreakfast(reading, trend, sendNudge, now)) return;

        // bedtime nudge — one proactive message per evening, takes priority over regular logic
        if (await evaluateBedtime(reading, trend, sendNudge, now)) return;

        var minutesSinceInjection = getMinutesSinceLastInjection(now);
        var insulinActivity = getInsulinActivity(minutesSinceInjection);
        var insulinActive = insulinActivity !== null && insulinActivity >= p.insulinActiveThreshold;
        var mealWindow = isInMealWindow(now);
        var projected = projectGlucose(reading, trend);
        var isDawn = isDawnPhenomenonWindow(now);

        var title = null;
        var message = null;
        var category = null;
        var carbs = null;
        var food = null;

        if (reading < p.targetLow)
        {
            category = `below`;

            if (mealWindow) return;
            if (trend.direction === `rising`) return;

            carbs = estimateCarbsNeeded(reading, trend, insulinActivity);

            // clinical hypo territory or urgent trend — always emergency foods
            if (reading <= p.hypoFloor || trend.urgent)
            {
                food = getEmergencySuggestion(carbs);
                title = `Have some fast sugar now`;
                if (insulinActive)
                {
                    var followUp = getBedtimeSuggestion(10);
                    message = `Your sugar is ${reading} and ${trend.description}. Have ${food.grams}g of fast-acting sugar — ${food.suggestion}. Once it comes back up, follow with about 10g of something starchy like ${followUp.suggestion} — your insulin is still working and will pull it back down.`;
                }
                else
                {
                    message = `Your sugar is ${reading} and ${trend.description}. Have ${food.grams}g of fast-acting sugar — ${food.suggestion}.`;
                }
            }
            // below target with insulin actively pulling — use fast-acting food
            // because slow food won't absorb before the insulin drops her further
            else if (insulinActive && trend.direction === `falling`)
            {
                food = getEmergencySuggestion(carbs);
                title = `Time for some fast sugar`;
                var followUp = getBedtimeSuggestion(10);
                message = `Your sugar is ${reading} and ${trend.description}. Your insulin is still working so it may keep dropping. Have ${food.grams}g of fast-acting sugar — ${food.suggestion}. Follow with about 10g of something starchy like ${followUp.suggestion} to stop it dropping again.`;
            }
            else
            {
                food = getCarbSuggestion(carbs);

                if (trend.direction === `falling`)
                {
                    title = `A little top-up might help`;
                    message = `Your sugar is ${reading} and ${trend.description}. About ${food.grams}g of slower-acting carbs (low GI) should help steady things — for example, ${food.suggestion}.`;
                }
                else
                {
                    title = `Sugar update`;
                    message = `Your sugar is ${reading} and ${trend.description}, sitting just below target. A small top-up of about ${food.grams}g of slower-acting carbs (low GI) would give it a nudge — try ${food.suggestion}.`;
                }
            }
        }
        else if (reading <= p.targetHigh)
        {
            if (mealWindow) return;

            // if BG was above target recently, this descent is insulin working — don't interrupt
            if (isDescendingFromHigh() && trend.direction === `falling`) return;

            carbs = estimateCarbsNeeded(reading, trend, insulinActivity);

            // urgent drops in target — emergency foods, act now
            if (trend.urgent)
            {
                food = getEmergencySuggestion(carbs);
                category = `in-target-falling`;
                title = `Have some fast sugar now`;
                message = `Your sugar is ${reading} and ${trend.description}. Have ${food.grams}g of fast-acting sugar — ${food.suggestion}.`;
            }
            else
            {
                food = getCarbSuggestion(carbs);

                // only nudge when close to the lower boundary — above 7.5 is comfortable even if falling
                if (trend.direction === `falling` && insulinActive && reading < p.targetLow + 0.5)
                {
                    category = `in-target-falling`;
                    title = `Thinking ahead`;
                    message = `Your sugar is ${reading} and ${trend.description}. Your insulin is still working so it may drift lower. About ${food.grams}g of slower-acting carbs (low GI) would help — something like ${food.suggestion}.`;
                }
                else if (trend.description === `dropping fast` || trend.description === `dropping fast and accelerating` || trend.description === `falling and picking up pace`)
                {
                    category = `in-target-falling`;
                    title = `Worth a small snack`;
                    message = `Your sugar is ${reading} and ${trend.description}. About ${food.grams}g of slower-acting carbs (low GI) would help it level off — try ${food.suggestion}.`;
                }
                else if (projected !== null && projected < p.targetLow)
                {
                    category = `in-target-falling`;
                    title = `Gentle heads-up`;
                    message = `Your sugar is ${reading} and ${trend.description}. At this pace it might dip a little below target over the next half hour. About ${food.grams}g of slower-acting carbs (low GI) would keep things steady — try ${food.suggestion}.`;
                }
                else
                {
                    return;
                }
            }
        }
        else
        {
            // above target — not the nudge engine's job. alerts handle dangerous highs separately.
            return;
        }

        if (title === null || message === null) return;

        // urgent trends bypass suppression — if she's crashing, a previous nudge is irrelevant
        if (!trend.urgent && carbs !== null && shouldSuppressNudge(reading, carbs, category, now)) return;

        await sendNudge(title, message);
        state.lastNudgeSent = now.valueOf();
        state.lastNudgeCategory = category;
        state.lastNudgeCarbs = carbs;
        state.lastNudgeReading = reading;
        // calculate where we expect BG to be if she eats the suggested carbs
        state.lastNudgeExpectedReading = carbs !== null ? reading + (carbs / p.carbsPerMmol) : null;
    }

    return { evaluate: evaluate, state: state, profile: p };
}

module.exports = { createNudgeEngine, DEFAULTS, CARB_SUGGESTIONS, EMERGENCY_SUGGESTIONS, BEDTIME_SUGGESTIONS, BREAKFAST_SUGGESTIONS, LOW_CARB_BREAKFAST_SUGGESTIONS };
