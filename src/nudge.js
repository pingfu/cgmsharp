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
//   3. insulin activity — biphasic curve model of premixed insulin (Humulin M3):
//      - 30% soluble (regular human): peaks 2-4 hours, gone by 6-8 hours
//      - 70% NPH (isophane): peaks 4-10 hours, tails off by 18 hours
//      - piecewise linear interpolation, combined weighted activity 0.0-1.0
//      - "meaningfully active" above 0.18 threshold
//      - when insulin is active and BG is falling, carb suggestions are increased
//        because the drop will likely continue
//
//   4. suppression gates — prevent noise and fatigue:
//      - meal window (150 min after injection): assume a meal is being digested,
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
//      - calculates a bedtime target: targetLow + estimated overnight drop
//        (integrates insulin activity curve over 8 hours, not a static value)
//      - if reading is below the target, suggests starchy carbs to top up
//      - if reading is above target but drop will still pull her low, suggests
//        a conservative amount with explanation of why food is needed despite
//        being high now
//      - if reading is high enough to survive the drop, sends "looking good"
//      - messages include timing advice (eat around half ten) and food order
//        advice (eat cheese/PB first, then the carbs — delays absorption 1-3h)
//      - waits for BG to be stable (not still settling from dinner)
//      - fires once per evening, then the regular engine takes over until quiet hours
//
//   7. food selection — five categories:
//      - normal (`CARB_SUGGESTIONS`): healthy UK foods with specific portions
//        (yoghurt, oatcakes, fruit, toast). used for gentle daytime corrections.
//      - emergency (`EMERGENCY_SUGGESTIONS`): fast-acting sugar (jelly babies,
//        honey, jam). used when the trend is urgent — dropping fast and/or
//        accelerating towards hypo. these raise BG within 5-10 minutes.
//      - bedtime (`BEDTIME_SUGGESTIONS`): slow-release starchy carbs paired with
//        fat/protein (toast+cheese, oatcakes+PB, porridge). oatcake carbs based
//        on Nairn's Rough Oatcakes (5.8g/oatcake). used for bedtime top-ups and
//        as follow-up after emergency sugar when insulin is active.
//      - breakfast (`BREAKFAST_SUGGESTIONS`): breakfast-appropriate carb foods
//        (porridge, toast, crumpets, Weetabix, banana). used when the breakfast
//        nudge calculates room for carbs.
//      - low-carb breakfast (`LOW_CARB_BREAKFAST_SUGGESTIONS`): zero/minimal carb
//        options (eggs, yoghurt, cheese, omelette). used when BG is already above
//        target at breakfast and carbs should be avoided.
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
    targetLow: 6.0, // lower bound of comfortable range (mmol/L). 6.0 is safe — gives 4 mmol/L of quiet zone (6-10) and reduces unnecessary nudges in the 6-7 range.
    hypoFloor: 5.0, // below this, always use emergency foods regardless of trend. clinical hypo territory for type 1.
    targetHigh: 10.0, // upper bound of target range. Median is 9.4.
    aboveThreshold: 11.0, // only nudge about high sugar above this. 43% of readings above 10.0 — nudging there would be constant noise.

    // =========================================================================
    // INSULIN ACTIVITY CURVE — HUMULIN M3 (30% SOLUBLE + 70% NPH/ISOPHANE)
    // =========================================================================
    // Timing parameters calibrated to Humulin M3 pharmacokinetics per NHS /
    // manufacturer literature:
    //   Soluble (regular human insulin): onset ~30 min, peak 2-4h, duration 6-8h
    //   NPH (isophane):                  onset 1-2h, peak 4-10h, duration 12-18h
    //
    // The 30/70 weight split matches both Humulin M3 and NovoMix-style rapid
    // analogue premixes. Only the timing differs between products.
    //
    // NOTE: the empirical constants `insulinCounterFactor` (3.2) and
    // `overnightPullRate` (2.5) were originally fit against a rapid-analogue
    // curve. They have NOT been recalibrated under this corrected timing —
    // see todo.md "Recalibrate insulin empirical constants". The values may
    // overestimate or underestimate the true effect until recalibration.
    // =========================================================================

    // biphasic insulin curve: soluble component (30% of premixed dose) — regular human insulin
    rapidOnset: 30, // minutes post-injection before soluble begins absorbing
    rapidPeakStart: 120, // start of peak soluble effect (2 hours)
    rapidPeakEnd: 180, // end of peak soluble effect (3 hours — midpoint of literature 2-4h range)
    rapidTail: 420, // soluble fully worn off (7 hours — midpoint of literature 6-8h)

    // biphasic insulin curve: NPH (isophane) component (70% of premixed dose)
    intermediateOnset: 90, // minutes post-injection before NPH begins absorbing (within 60-120 min literature range)
    intermediatePeakStart: 240, // start of peak NPH effect (4 hours)
    intermediatePeakEnd: 600, // end of peak NPH effect (10 hours — upper literature bound)
    intermediateTail: 1080, // NPH fully worn off (18 hours — upper literature bound)

    // component weights (must sum to 1.0) — reflects 30/70 split of Humulin M3.
    rapidWeight: 0.30,
    intermediateWeight: 0.70,

    // insulin is considered "meaningfully active" above this threshold (0.0-1.0 scale).
    // under the Humulin M3 curve, combined activity at 90 min post-injection is ~0.20
    // (soluble ramping to peak, NPH barely onsetting), so a threshold of 0.25 would
    // miss the ramp-up window where insulin is clearly working. 0.18 puts the
    // active/inactive boundary at ~85 min post-injection — the first ~85 min stay
    // inactive (soluble not yet measurable) and everything from there through the
    // next injection counts as active. under twice-daily dosing this yields two
    // ~85-minute inactive windows per day (07:30–08:55 and 19:00–20:25), with the
    // rest of the day above threshold.
    insulinActiveThreshold: 0.18,

    // dawn phenomenon window — historical mean BG 12.15 during 4-8 AM vs 9.1 overnight,
    // spike persists through late morning (8-noon mean 10.83), so window extends to 10 AM.
    dawnStartHour: 4,
    dawnEndHour: 10,

    // how far ahead to project glucose (minutes). uses short-term rate + acceleration.
    projectionMinutes: 30,

    // meal window — insulin is injected with a meal. suppress carb nudges for this period.
    // observed eat-peak-settle cycle took ~2 hours on 2026-04-06 under a rapid-analogue
    // assumption. extended to 150 min under the Humulin M3 curve: soluble peaks 2-4h
    // (midpoint 3h) so the real eat-peak-settle cycle runs closer to 2.5h. 150 is the
    // conservative upper bound — 180 would completely eclipse the bedtime nudge window
    // (19:00 injection + 180 = 22:00 = bedtime window end). at 150 the bedtime window
    // still has 30 min (21:30-22:00) where proactive nudges can fire. safety override
    // (see evaluateReactive) still lets clinical hypos through regardless.
    mealWindowMinutes: 150,

    // observed carb sensitivity: 18g carbs raised BG by 4.1 mmol/L (4.7 → 8.8).
    // ~4.4g per 1 mmol/L. the single most important per-individual tuning knob.
    carbsPerMmol: 4.4,

    // insulin counteraction factor: at peak insulin activity (1.0), how many mmol/L
    // will insulin pull BG down during the ~30 min food absorption window?
    // observed: 20g bedtime snack from 7.7 peaked at 10.3 (+2.6) vs expected +4.5.
    // insulin activity was ~0.6, so insulin counteracted ~1.9 mmol/L. at activity 1.0
    // that's ~3.2 mmol/L. we use this to add extra carbs when insulin is fighting the food.
    //
    // CALIBRATION CAVEAT: the 1.9 mmol/L observation is still valid, but the
    // "activity was ~0.6" was originally computed against the rapid-analogue curve.
    // Under the corrected Humulin M3 curve, activity at the same moment would be
    // lower (soluble onsets at 30 min, not 15), meaning the true counter-factor
    // is larger than 3.2. Not yet recalculated — see todo.md.
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

    // breakfast carb target: minimum grams of carbs needed to cover the soluble
    // component of the morning dose (12u Humulin M3 → 3.6u soluble). at 1u:~5g
    // acute coverage this lands around 18g, but dawn phenomenon provides some
    // endogenous glucose so the base is tuned slightly lower. adjusted in
    // evaluateBreakfast() for starting BG and current trend direction.
    breakfastCarbTarget: 15,

    // dinner nudge window — one proactive nudge to guide carb intake at the
    // evening injection. the soluble component of Humulin M3 is committed at
    // injection time and will pull BG down over the next 2-4 hours — without
    // matching dinner carbs, a post-injection hypo is near-certain (observed
    // 2026-04-10: zero-carb dinner → 5.1 hypo at 90 min post-injection).
    dinnerWindowStart: 18.75, // 18:45 local (15 min before 19:00 injection)
    dinnerWindowEnd: 19.25, // 19:15 local (15 min after)

    // dinner carb target: minimum grams of carbs needed to cover the soluble
    // component of the evening dose. derived from the observation that skipping
    // dinner carbs produces a ~4-5 mmol/L drop in the first 2h post-injection
    // — at 4.4g/mmol that's ~18-22g just to hold BG flat. base of 20g with
    // adjustments in evaluateDinner() for starting BG.
    dinnerCarbTarget: 20,

    bedtimeWindowStart: 21, // 21:00 local
    bedtimeWindowEnd: 22, // 22:00 local

    // overnight insulin pull rate: mmol/L per hour at peak insulin activity (1.0).
    // this is lower than insulinCounterFactor because overnight there's no incoming
    // food for the insulin to metabolise — the pull rate is the basal glucose-lowering
    // effect. calibrated from historical data:
    //   Apr 20: 17.1 → 5.1 over ~7h (drop 12.0, avg ~1.7/h)
    //   Jul 22: 15.8 → 2.9 over ~6h (drop 12.9, avg ~2.2/h)
    //   Sep 15: 7.2 → 2.8 over ~3h (drop 4.4, avg ~1.5/h)
    //
    // originally calibrated to 2.5 against a rapid-analogue curve. recalibrated
    // to 2.15 against the Humulin M3 curve (Phase 3) so the 8-hour bedtime drop
    // estimate remains consistent with the same historical observations. math:
    //   old curve integral over 8h from bedtime (120→600 min post-inj): 306.3 min·activity
    //   new curve integral over same window: 356.4 min·activity
    //   ratio: 306.3/356.4 = 0.859
    //   new pullRate = 2.5 × 0.859 = 2.15
    // this is a 14% reduction to compensate for the 16% larger integral under
    // the longer/later NPH curve. the drop estimate for a given bedtime is
    // materially unchanged, so bedtime nudge decisions remain stable.
    overnightPullRate: 2.15, // mmol/L per hour at activity 1.0 (recalibrated for Humulin M3)

    // fallback static overnight drop if insulin times not configured
    overnightDrop: 3.5, // mmol/L

    // overnight quiet hours — fully silent. alerts handle emergencies separately.
    // window runs 23:00-07:00 local, which wraps across midnight. chosen to match
    // the user's actual sleep window (late bedtime snack around 22:30, wake-up
    // ~07:00-07:30 for morning injection). the engine still updates its readings
    // buffer through this window so trend/state is correct when nudges resume.
    // the alert channel (alarms.js) is independent and still fires at clinical
    // thresholds (≤3.5, ≥22.0) through the quiet window.
    quietStartHour: 23, // 11 PM
    quietEndHour: 7, // 7 AM

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
//
// carb values sourced from: Warburtons wholemeal (14g/slice), Warburtons crumpet (20g),
// Weetabix 18g biscuit (13g), Nairn's Rough Oatcake (5.8g), Ryvita Original (4.3g),
// semi-skimmed milk (4.7g per 100ml), plain natural yoghurt (~6g per 125g pot),
// bananas (small 80g ≈ 18g, half ≈ 9g), apples (small 100g ≈ 12g, medium 180g ≈ 20g),
// satsumas (small 50g ≈ 7g), grapes (~0.16g each), raisins (~0.7g each, 14g tbsp ≈ 10g),
// rice cakes plain (7g each), porridge oats dry (~0.6g carb per 1g dry ≈ 18g per 30g serving),
// jacket potato (small 150g ≈ 30g carbs), pitta wholemeal (60g ≈ 27g carbs),
// baked beans (30g tbsp ≈ 5g), hummus (2g per 15g tbsp), cottage cheese 100g (3g).
const CARB_SUGGESTIONS = [
    // no 2g tier — amounts that small have no measurable BG effect. minimum useful correction is 5g.
    { grams: 5, ideas: [
        { food: `a 125g pot of plain natural yoghurt`, carbs: 6 },
        { food: `3 strawberries with a tablespoon of natural yoghurt`, carbs: 4 },
        { food: `a small glass (100ml) of semi-skimmed milk`, carbs: 5 },
        { food: `1 small satsuma`, carbs: 7 },
        { food: `10 cashew nuts`, carbs: 4 },
        { food: `a 125g pot of Greek natural yoghurt with 3 strawberries`, carbs: 7 }
    ]},
    { grams: 7, ideas: [
        { food: `1 small apple (about the size of a tennis ball)`, carbs: 8 },
        { food: `1 tablespoon of hummus with 3 carrot sticks`, carbs: 5 },
        { food: `a 125g pot of natural yoghurt with 5 or 6 blueberries`, carbs: 7 },
        { food: `1 oatcake with a thin slice of cheddar`, carbs: 6 },
        { food: `2 Ryvita with a tablespoon of cream cheese`, carbs: 9 },
        { food: `a 100g pot of cottage cheese with 2 tinned pineapple chunks`, carbs: 6 }
    ]},
    { grams: 10, ideas: [
        { food: `half a small banana`, carbs: 9 },
        { food: `1 tablespoon of raisins`, carbs: 10 },
        { food: `about 12 grapes with 5 almonds`, carbs: 10 },
        { food: `2 oatcakes with a thin slice of cheddar`, carbs: 12 },
        { food: `half a crumpet with butter`, carbs: 10 },
        { food: `2 tablespoons of trail mix`, carbs: 11 },
        { food: `1 small satsuma and a 125g pot of natural yoghurt`, carbs: 12 }
    ]},
    { grams: 15, ideas: [
        { food: `1 slice of wholemeal toast with butter`, carbs: 14 },
        { food: `1 slice of wholemeal toast with a teaspoon of peanut butter`, carbs: 15 },
        { food: `a glass (200ml) of semi-skimmed milk and 1 small satsuma`, carbs: 16 },
        { food: `half a small jacket potato with a knob of butter`, carbs: 15 },
        { food: `half a wholemeal pitta with 2 tablespoons of hummus`, carbs: 17 },
        { food: `2 plain rice cakes with butter`, carbs: 14 },
        { food: `1 small pear`, carbs: 15 },
        { food: `a 20g bowl of bran flakes with 100ml semi-skimmed milk`, carbs: 17 }
    ]},
    { grams: 20, ideas: [
        { food: `1 crumpet with butter`, carbs: 20 },
        { food: `half a cheese and pickle sandwich on wholemeal bread`, carbs: 20 },
        { food: `1 small banana (about 15cm long)`, carbs: 18 },
        { food: `1 medium apple with a teaspoon of peanut butter`, carbs: 21 },
        { food: `1 Weetabix with 100ml of semi-skimmed milk`, carbs: 18 },
        { food: `3 tablespoons (30g dry) of porridge oats made with water`, carbs: 18 }
    ]}
];

// emergency food suggestions — fast-acting carbs for rapid/accelerating drops.
// these raise BG within 5-10 minutes. used when trend is urgent.
// everything here must be fat-free and sugar-based — fat slows absorption.
// no chocolate, biscuits, cereal bars, or milk.
//
// carb values sourced from: Bassett's jelly baby ~5g, 1 level tsp honey ~6g,
// 1 level tsp jam ~4g, 1 level tsp sugar ~4g. 1 level tbsp honey ~17g,
// 1 level tbsp jam ~13g.
const EMERGENCY_SUGGESTIONS = [
    { grams: 5, ideas: [
        { food: `1 jelly baby`, carbs: 5 },
        { food: `1 level teaspoon of honey`, carbs: 6 },
        { food: `1 level teaspoon of jam`, carbs: 4 },
        { food: `1 level teaspoon of sugar dissolved in water`, carbs: 4 }
    ]},
    { grams: 10, ideas: [
        { food: `2 jelly babies`, carbs: 10 },
        { food: `2 level teaspoons of honey`, carbs: 12 },
        { food: `2 level teaspoons of jam`, carbs: 8 },
        { food: `2 level teaspoons of sugar dissolved in water`, carbs: 8 }
    ]},
    { grams: 15, ideas: [
        { food: `3 jelly babies`, carbs: 15 },
        { food: `1 level tablespoon of honey`, carbs: 17 },
        { food: `1 level tablespoon of jam`, carbs: 13 },
        { food: `4 level teaspoons of sugar dissolved in water`, carbs: 16 }
    ]}
    // no 20g tier — rule of 15: treat with 15g fast-acting, wait 15 min, repeat if still low.
    // overtreating hypos causes rebound spikes. let the engine re-evaluate after absorption.
];

// bedtime food suggestions — slow-release carbs that absorb over 2-3 hours.
// the goal is sustained glucose overnight, not a fast spike. starchy carbs with
// protein or fat slow digestion and provide a trickle of glucose that matches
// the intermediate insulin's sustained pull. no fruit, juice, or fast-acting sugar.
// oatcake carb counts based on Nairn's Rough Oatcakes: 5.8g carb per oatcake.
// 1 oatcake ≈ 6g, 2 oatcakes ≈ 12g, 3 oatcakes ≈ 17g, 4 oatcakes ≈ 23g.
// porridge oats dry: ~0.6g carb per 1g dry weight (18g per 30g serving).
// wholemeal toast slice: ~14g. crumpet: ~20g. Weetabix biscuit: ~13g.
const BEDTIME_SUGGESTIONS = [
    { grams: 5, ideas: [
        { food: `1 oatcake with a thin slice of cheddar`, carbs: 6 },
        { food: `half a slice of wholemeal toast with butter`, carbs: 7 },
        { food: `1 tablespoon (10g dry) of porridge oats made with water`, carbs: 6 },
        { food: `1 plain rice cake with butter`, carbs: 7 }
    ]},
    { grams: 7, ideas: [
        { food: `1 oatcake with a teaspoon of peanut butter`, carbs: 7 },
        { food: `half a slice of wholemeal toast with a thin slice of cheddar`, carbs: 7 },
        { food: `2 Ryvita with a tablespoon of cream cheese`, carbs: 9 },
        { food: `1 plain rice cake with peanut butter`, carbs: 8 }
    ]},
    { grams: 10, ideas: [
        { food: `2 oatcakes with a thin slice of cheddar`, carbs: 12 },
        { food: `half a crumpet with butter`, carbs: 10 },
        { food: `2 tablespoons (20g dry) of porridge oats made with water`, carbs: 12 },
        { food: `2 oatcakes with butter`, carbs: 12 }
    ]},
    { grams: 15, ideas: [
        { food: `1 slice of wholemeal toast with a thin slice of cheddar`, carbs: 14 },
        { food: `1 slice of wholemeal toast with butter`, carbs: 14 },
        { food: `2 oatcakes with cheddar and a teaspoon of peanut butter`, carbs: 13 },
        { food: `1 slice of wholemeal toast with a tablespoon of peanut butter`, carbs: 17 },
        { food: `2 tablespoons (20g dry) porridge oats with 100ml semi-skimmed milk`, carbs: 17 },
        { food: `3 oatcakes with butter`, carbs: 17 }
    ]},
    { grams: 20, ideas: [
        { food: `1 crumpet with butter`, carbs: 20 },
        { food: `1 Weetabix with 100ml of semi-skimmed milk`, carbs: 18 },
        { food: `3 tablespoons (30g dry) of porridge oats made with water`, carbs: 18 },
        { food: `3 oatcakes with a tablespoon of peanut butter`, carbs: 20 }
    ]},
    { grams: 25, ideas: [
        { food: `2 oatcakes with cheddar and 1 slice of wholemeal toast with butter`, carbs: 26 },
        { food: `3 tablespoons (30g dry) of porridge oats made with 100ml semi-skimmed milk`, carbs: 23 },
        { food: `4 tablespoons (40g dry) of porridge oats made with water`, carbs: 24 },
        { food: `1 Weetabix and 1 slice of wholemeal toast with butter`, carbs: 27 },
        { food: `half a wholemeal bagel with butter`, carbs: 24 }
    ]},
    { grams: 30, ideas: [
        { food: `3 oatcakes with cheddar and 1 slice of wholemeal toast with butter`, carbs: 31 },
        { food: `2 slices of wholemeal toast with cheddar`, carbs: 28 },
        { food: `4 tablespoons (40g dry) porridge oats with 100ml semi-skimmed milk`, carbs: 29 },
        { food: `1 slice of wholemeal toast and 1 Weetabix with 100ml semi-skimmed milk`, carbs: 32 }
    ]}
];

// breakfast carb suggestions — breakfast-appropriate foods with specific portions.
// same tiered structure as CARB_SUGGESTIONS but only foods you'd eat at breakfast.
const BREAKFAST_SUGGESTIONS = [
    { grams: 5, ideas: [
        { food: `a small glass (100ml) of semi-skimmed milk`, carbs: 5 },
        { food: `a 125g pot of plain natural yoghurt`, carbs: 6 },
        { food: `a 125g pot of Greek natural yoghurt with a few blueberries`, carbs: 7 },
        { food: `a 125g pot of natural yoghurt with 2 strawberries`, carbs: 5 }
    ]},
    { grams: 7, ideas: [
        { food: `1 oatcake with a thin slice of cheddar`, carbs: 6 },
        { food: `a 125g pot of natural yoghurt with 5 or 6 blueberries`, carbs: 7 },
        { food: `1 oatcake with butter`, carbs: 6 },
        { food: `1 small apple`, carbs: 8 }
    ]},
    { grams: 10, ideas: [
        { food: `half a crumpet with butter`, carbs: 10 },
        { food: `half a small banana`, carbs: 9 },
        { food: `2 oatcakes with butter`, carbs: 12 },
        { food: `1 tablespoon of raisins`, carbs: 10 }
    ]},
    { grams: 15, ideas: [
        { food: `1 slice of wholemeal toast with butter`, carbs: 14 },
        { food: `1 slice of wholemeal toast with a teaspoon of peanut butter`, carbs: 15 },
        { food: `2 tablespoons (20g dry) porridge oats with 100ml semi-skimmed milk`, carbs: 17 },
        { food: `2 plain rice cakes with peanut butter`, carbs: 17 }
    ]},
    { grams: 20, ideas: [
        { food: `1 crumpet with butter`, carbs: 20 },
        { food: `1 small banana (about 15cm long)`, carbs: 18 },
        { food: `1 Weetabix with 100ml semi-skimmed milk`, carbs: 18 },
        { food: `3 tablespoons (30g dry) of porridge oats made with water`, carbs: 18 },
        { food: `a 20g bowl of bran flakes with 100ml semi-skimmed milk`, carbs: 19 }
    ]}
];

// low-carb breakfast suggestions — for mornings when BG is already above target.
// zero/minimal carb options to avoid stacking carbs on top of dawn phenomenon.
// flat array (no gram tiers) — every entry must be at or below 5g carbs.
const LOW_CARB_BREAKFAST_SUGGESTIONS = [
    { food: `scrambled eggs`, carbs: 1 },
    { food: `a boiled egg`, carbs: 0 },
    { food: `poached eggs on their own`, carbs: 1 },
    { food: `a couple of slices of cheese`, carbs: 0 },
    { food: `scrambled eggs with a slice of cheese`, carbs: 1 },
    { food: `plain omelette`, carbs: 1 },
    { food: `a 100g pot of cottage cheese`, carbs: 3 },
    { food: `a 125g pot of full-fat Greek yoghurt`, carbs: 4 }
];

// dinner carb suggestions — dinner-appropriate carb sides keyed by gram target.
// different from CARB_SUGGESTIONS (snacks) and BEDTIME_SUGGESTIONS (starchy +
// fat/protein combos for sustained overnight absorption). dinner sides are
// the carbs you'd eat ON THE PLATE alongside protein and veg.
//
// carb values sourced from: NHS carb counting (medium baked jacket potato 180g ≈ 30g carbs),
// boiled new potatoes (~6g each, 15g/100g flesh), cooked rice (~4-5g per tablespoon),
// dry pasta (~73% carb by weight), Warburtons wholemeal pitta (27g), wholemeal bread (14g/slice).
const DINNER_SUGGESTIONS = [
    { grams: 10, ideas: [
        { food: `2 tablespoons of cooked rice`, carbs: 9 },
        { food: `2 boiled new potatoes`, carbs: 11 },
        { food: `half a small wholemeal pitta`, carbs: 9 },
        { food: `1 small boiled potato`, carbs: 10 }
    ]},
    { grams: 15, ideas: [
        { food: `1 slice of wholemeal bread with your meal`, carbs: 14 },
        { food: `half a wholemeal pitta`, carbs: 14 },
        { food: `3 tablespoons of cooked rice`, carbs: 13 },
        { food: `3 boiled new potatoes`, carbs: 15 },
        { food: `half a small jacket potato`, carbs: 15 }
    ]},
    { grams: 20, ideas: [
        { food: `4 tablespoons of cooked rice`, carbs: 18 },
        { food: `4 boiled new potatoes`, carbs: 21 },
        { food: `a small portion of pasta (30g dry weight)`, carbs: 22 },
        { food: `half a medium jacket potato with butter`, carbs: 18 }
    ]},
    { grams: 25, ideas: [
        { food: `1 small jacket potato with butter`, carbs: 25 },
        { food: `1 wholemeal pitta`, carbs: 27 },
        { food: `6 tablespoons of cooked rice`, carbs: 27 },
        { food: `a small portion of pasta (35g dry weight)`, carbs: 25 }
    ]}
];

const INCLUDE_FOOD_EXAMPLES = false;

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
        dinnerNudgeSentDate: null, // date string (YYYY-MM-DD) of last dinner nudge — one per evening
        bedtimeNudgeSentDate: null // date string (YYYY-MM-DD) of last bedtime nudge — one per evening
    };

    function hint(text) { return INCLUDE_FOOD_EXAMPLES ? text : ``; }

    // long-term rate: slope across the full readings buffer (~60 min). overall direction.
    function getLongTermRate()
    {
        if (readings.length < 4) return null;
        var newest = readings[readings.length - 1];
        var oldest = readings[0];
        return (newest - oldest) / ((readings.length - 1) * interval);
    }

    // 3 readings rather than 2 to smooth single-tick CGM noise.
    function getShortTermRate()
    {
        if (readings.length < 3) return null;
        var newest = readings[readings.length - 1];
        var recent = readings[readings.length - 3];
        return (newest - recent) / (2 * interval);
    }

    // negative = drop getting steeper. positive = drop levelling off (or rise accelerating).
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

        // urgent stays true when a fast fall is clinically dangerous. two cases qualify:
        //   (a) reading is already near or below target (targetLow + 1.0) — no projection
        //       needed, the current BG is the concern
        //   (b) the 30-min projection crosses hypoFloor — even if current BG is comfortably
        //       above target, a rapid accelerating drop heading to hypo is urgent
        // a rapid drop from 13 to 9 with stable BG projection stays non-urgent (still in range).
        if (urgent && direction === `falling`)
        {
            var projectedBG = reading + (shortRate * p.projectionMinutes);
            var nearTarget = reading <= p.targetLow + 1.0;
            var projectedHypo = projectedBG <= p.hypoFloor;
            if (!nearTarget && !projectedHypo) urgent = false;
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
        // quiet window can wrap across midnight (e.g. 23-7). handle both forms:
        //   start < end  → simple range (e.g. 0-6): hour is in [start, end)
        //   start >= end → wrap-around (e.g. 23-7): hour is >= start OR < end
        if (p.quietStartHour < p.quietEndHour)
        {
            return hour >= p.quietStartHour && hour < p.quietEndHour;
        }
        return hour >= p.quietStartHour || hour < p.quietEndHour;
    }

    function isDawnPhenomenonWindow(now)
    {
        var hour = now.hour();
        return hour >= p.dawnStartHour && hour < p.dawnEndHour;
    }

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
        // size the correction to where BG is HEADING in 30 min, not where it currently is.
        // a rapid drop at 7.3 means the user will be at ~3.5 in 30 min — the carb need is
        // sized against that future state. if no projection is available (insufficient
        // history), fall back to the current reading.
        var projected = projectGlucose(reading, trend);
        var effectiveBG = projected !== null ? projected : reading;

        var gap = p.targetLow - effectiveBG;
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
        base = Math.min(base, 20); // max per dose; Rule of 15 + next-tick re-evaluation handles escalation

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
        return { grams: best.grams, suggestion: idea.food, carbs: idea.carbs };
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

    // post-nudge suppression: after we send a carb suggestion, silence further nudges
    // unless the situation has clearly worsened. two phases:
    //
    // 1. absorption window (hard silence): food is still being digested, can't know
    //    if the user actioned the first message. alerts handle clinical emergencies.
    //
    // 2. post-absorption: re-nudge only if BG has meaningfully dropped since the
    //    nudge fired (> 0.5 mmol worse). small fluctuations or stability count as
    //    "status quo" — the food is probably balancing insulin. a real escalation
    //    (situation deteriorating) shows up as a materially lower reading.
    //
    // NOTE: the old logic compared the current reading to lastNudgeExpectedReading
    // (reading + carbs/carbsPerMmol) and escalated on carb-delta >= 3. both were
    // broken under the projection-based formula: expected was unreachable because
    // insulin pulls against food, and carbs clamps at 20g so delta can't grow. the
    // BG-delta check works in both directions and doesn't depend on dose sizing.
    function shouldSuppressNudge(reading, carbs, category, now)
    {
        if (state.lastNudgeSent === null || state.lastNudgeReading === null) return false;

        var minutesSinceLastNudge = (now.valueOf() - state.lastNudgeSent) / 60000;
        var absorptionWindow = state.lastNudgeCarbs !== null && state.lastNudgeCarbs <= 7 ? p.absorptionSmall : p.absorptionLarge;

        // still within absorption window — food hasn't had time to work yet
        if (minutesSinceLastNudge < absorptionWindow) return true;

        // post-absorption: re-nudge only if BG is materially worse than when we nudged.
        // "materially worse" = dropped more than 0.5 mmol below the nudge-time reading.
        if (reading < state.lastNudgeReading - 0.5) return false;

        return true;
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
        return LOW_CARB_BREAKFAST_SUGGESTIONS[Math.floor(Math.random() * LOW_CARB_BREAKFAST_SUGGESTIONS.length)].food;
    }

    function isInDinnerWindow(now)
    {
        var hour = now.hour() + (now.minute() / 60);
        return hour >= p.dinnerWindowStart && hour < p.dinnerWindowEnd;
    }

    function hasDinnerNudgeBeenSentToday(now)
    {
        if (state.dinnerNudgeSentDate === null) return false;
        return state.dinnerNudgeSentDate === now.format(`YYYY-MM-DD`);
    }

    function getDinnerSuggestion(grams)
    {
        return getSuggestionFromTable(DINNER_SUGGESTIONS, grams);
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
    //
    // note: the "your morning rise is already underway" phrasing in the messages
    // below refers to dawn phenomenon, not insulin action. Under the Humulin M3
    // curve, soluble onset is 30 min — insulin activity during the 07:00-07:30
    // window is effectively zero, so any upward drift at that hour is cortisol-
    // driven liver glucose output, not food or insulin.
    async function evaluateBreakfast(reading, trend, sendNudge, now)
    {
        if (!isInBreakfastWindow(now)) return false;
        if (hasBreakfastNudgeBeenSentToday(now)) return false;

        // wait until BG is stable — don't send while still bouncing from overnight
        if (trend.description === `dropping fast` || trend.description === `dropping fast and accelerating`) return false;

        var title = null;
        var message = null;

        if (reading > 14.0)
        {
            // well above target — skip carbs entirely
            var lowCarbFood = getLowCarbBreakfastSuggestion();
            title = `Breakfast`;
            message = `Your sugar is ${reading} — your morning rise has pushed it up. Skip carbs at breakfast today and let your insulin bring it down${hint(`. Have ${lowCarbFood}`)}.`;
        }
        else if (reading > p.targetHigh)
        {
            // above target — low-carb breakfast (insulin has work to do already)
            var lowCarbFood = getLowCarbBreakfastSuggestion();
            title = `Breakfast`;
            message = `Your sugar is ${reading} — already high from the morning rise. Have a low-carb breakfast today${hint(` — ${lowCarbFood}`)}.${hint(` Save the porridge for a morning when your sugar is lower.`)}`;
        }
        else
        {
            // in-target or below-target: anchor to insulin cover, adjust for BG and trend.
            // base target = breakfastCarbTarget (cover the morning soluble dose).
            // below targetLow: add recovery carbs.
            // falling trend (rare pre-breakfast): increase — need more to prevent post-injection hypo.
            // rising trend (dawn phenomenon): NO reduction. dawn contributes minor glucose over
            // short term, but the multi-hour soluble peak still needs full cover. under-sizing
            // for dawn caused the observed 2026-04-10 mid-morning hypo (BG 7.7 → 10g → 6.9 @ 10:30).
            var carbs = p.breakfastCarbTarget;

            if (reading < p.targetLow) carbs = carbs + 5;

            if (trend.description !== `stable` && trend.direction === `falling`)
            {
                carbs = carbs + 5;
            }

            var food = getBreakfastSuggestion(carbs);
            title = `Breakfast`;

            if (reading < p.targetLow)
            {
                message = `Your sugar is ${reading} — below target heading into breakfast. Have about ${food.grams}g of carbs to lift it back up and cover your morning insulin${hint(` — try ${food.suggestion}`)}.`;
            }
            else if (trend.direction === `rising`)
            {
                message = `Your sugar is ${reading} and ${trend.description} — your morning rise is underway. Have about ${food.grams}g of carbs at breakfast to cover your insulin${hint(` — try ${food.suggestion}`)}.`;
            }
            else if (trend.direction === `falling`)
            {
                message = `Your sugar is ${reading} and ${trend.description}. Have about ${food.grams}g of carbs at breakfast to cover your morning insulin and stop the drop${hint(` — try ${food.suggestion}`)}.`;
            }
            else
            {
                message = `Your sugar is ${reading}. Have about ${food.grams}g of carbs at breakfast to cover your morning insulin${hint(` — try ${food.suggestion}`)}.`;
            }
        }

        await sendNudge(title, message);
        state.breakfastNudgeSentDate = now.format(`YYYY-MM-DD`);
        return true;
    }

    // dinner nudge: one proactive message per evening to guide carb intake at
    // the evening injection (19:00 local). the soluble component of Humulin M3
    // is committed at injection time and will pull BG down over 2-4 hours with
    // whatever carbs are on board. without matching dinner carbs, a post-injection
    // hypo is near-certain — observed 2026-04-10: zero-carb dinner → 5.1 hypo at
    // 90 min post-injection. this nudge tells the user how much to eat based on
    // current BG, so she can plan the meal before or as she injects.
    // returns true if a dinner nudge was sent (so the regular evaluate can skip).
    async function evaluateDinner(reading, trend, sendNudge, now)
    {
        if (!isInDinnerWindow(now)) return false;
        if (hasDinnerNudgeBeenSentToday(now)) return false;

        // wait until BG is stable — don't send while crashing
        if (trend.description === `dropping fast` || trend.description === `dropping fast and accelerating`) return false;

        var carbs = p.dinnerCarbTarget;
        var title = null;
        var message = null;

        // trend helpers for cleaner branching below.
        // dinner operates on a 3-4 hour horizon (until the next soluble peak ends),
        // so slow drift (<=0.05 mmol/min, i.e. 'slowly rising'/'slowly falling') is noise
        // and shouldn't move the base carb target — only meaningful rates get adjustments.
        var trendMeaningful = trend.shortRate !== null && Math.abs(trend.shortRate) >= p.trendSlowThreshold;
        var trendRising = trendMeaningful && trend.direction === `rising`;
        var trendFalling = trendMeaningful && trend.direction === `falling`;

        if (reading > 14.0 || (reading > p.targetHigh && trendRising))
        {
            // well above target, OR above target and still climbing — skip carbs entirely.
            // insulin has plenty to do without stacking more glucose on top.
            var lowCarbFood = getLowCarbBreakfastSuggestion();
            title = `Dinner`;
            if (reading > 14.0)
            {
                message = `Your sugar is ${reading} — no need for carbs at dinner tonight, your insulin will bring it down. Have a protein-heavy meal${hint(` — ${lowCarbFood}`)}.`;
            }
            else
            {
                message = `Your sugar is ${reading} and ${trend.description}, already above target and climbing. Skip dinner carbs and let your evening insulin bring it down. Have a protein-heavy meal${hint(` — ${lowCarbFood}`)}.`;
            }
        }
        else if (reading > p.targetHigh)
        {
            // above target, stable or falling: small starchy portion
            carbs = Math.max(10, carbs - 10);
            var food = getDinnerSuggestion(carbs);
            title = `Dinner`;
            if (trendFalling)
            {
                message = `Your sugar is ${reading} and ${trend.description}, above target heading into dinner. Alongside your protein and veg, about ${food.grams}g of starchy carbs will cover your insulin without stacking onto the descent${hint(` — try ${food.suggestion}`)}.`;
            }
            else
            {
                message = `Your sugar is ${reading} — above target. Alongside your protein and veg, about ${food.grams}g of starchy carbs will cover your insulin without pushing the spike too high${hint(` — try ${food.suggestion}`)}.`;
            }
        }
        else if (reading >= p.targetLow)
        {
            // in target — base 20g, adjust for trend direction.
            // falling: +5 (insulin will pull harder than food absorbs). rising: -5 (something's already driving BG up).
            if (trendFalling) carbs = carbs + 5;
            else if (trendRising) carbs = Math.max(carbs - 5, 10);

            var food = getDinnerSuggestion(carbs);
            title = `Dinner`;
            if (trendFalling)
            {
                message = `Your sugar is ${reading} and ${trend.description}. Alongside your protein and veg, your evening insulin needs about ${food.grams}g of starchy carbs to keep your sugar steady${hint(` — try ${food.suggestion}`)}. Protein and veg alone won't cover the insulin.`;
            }
            else if (trendRising)
            {
                message = `Your sugar is ${reading} and ${trend.description}. Alongside your protein and veg, about ${food.grams}g of starchy carbs covers your evening insulin without stacking onto the rise${hint(` — try ${food.suggestion}`)}.`;
            }
            else
            {
                message = `Your sugar is ${reading}. Alongside your protein and veg, your evening insulin needs about ${food.grams}g of starchy carbs to keep your sugar steady through the evening${hint(` — try ${food.suggestion}`)}. Protein and veg alone won't cover the insulin.`;
            }
        }
        else
        {
            // below target — bump carbs to recover and cover insulin.
            // falling: already at the 25g max of the dinner tiers, no further increase possible.
            // rising: she's recovering on her own, stay at +5 (don't subtract — still below target).
            carbs = carbs + 5;

            var food = getDinnerSuggestion(carbs);
            title = `Dinner`;
            if (trendFalling)
            {
                message = `Your sugar is ${reading} and ${trend.description}, below target heading into dinner. Alongside your protein and veg, about ${food.grams}g of starchy carbs will lift it back to target and stop the drop${hint(` — try ${food.suggestion}`)}.`;
            }
            else if (trendRising)
            {
                message = `Your sugar is ${reading} and ${trend.description}, below target but recovering. Alongside your protein and veg, about ${food.grams}g of starchy carbs will lift it back to target and cover your evening insulin${hint(` — try ${food.suggestion}`)}.`;
            }
            else
            {
                message = `Your sugar is ${reading} — below target heading into dinner. Alongside your protein and veg, about ${food.grams}g of starchy carbs will lift it back to target and cover your evening insulin${hint(` — try ${food.suggestion}`)}.`;
            }
        }

        await sendNudge(title, message);
        state.dinnerNudgeSentDate = now.format(`YYYY-MM-DD`);
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
            title = `Bedtime`;
            message = `Your sugar is ${reading} heading towards bed. That should be enough to see you through the night — no snack needed.`;
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
                message = `Your sugar is ${reading} — too low for bed. Have ${emergency.grams}g of fast sugar now${hint(` — ${emergency.suggestion}`)}. Give it 15 minutes to work, then have about ${starchy.grams}g of something starchy${hint(` like ${starchy.suggestion}`)} to carry you through overnight. If your sugar hasn't come up in 15 minutes, have another ${emergency.grams}g of fast sugar before the starchy food.`;
            }
            else if (reading < p.targetLow && trend.direction === `falling`)
            {
                // below target and dropping — starchy alone won't absorb fast enough
                var emergency = getEmergencySuggestion(10);
                var starchy = getBedtimeSuggestion(carbs);
                title = `Bedtime top-up`;
                message = `Your sugar is ${reading} and ${trend.description} heading towards bed. Have ${emergency.grams}g of fast sugar now${hint(` — ${emergency.suggestion}`)} — to stop the drop. Give it 15 minutes to work, then have about ${starchy.grams}g of something starchy${hint(` like ${starchy.suggestion}`)} for overnight. If your sugar hasn't come up in 15 minutes, have another ${emergency.grams}g of fast sugar before the starchy food.`;
            }
            else if (reading < p.targetLow)
            {
                // below target but stable — starchy has time to absorb (bedtime window is 2h before insulin peak)
                var food = getBedtimeSuggestion(carbs);
                title = `Bedtime top-up`;
                message = `Your sugar is ${reading} — below target for bed. Have about ${food.grams}g of something starchy around 10:30pm${hint(` — ${food.suggestion}`)}.`;
            }
            else if (reading > p.targetHigh)
            {
                // above target: the default logic is "overnight insulin will pull her low, so
                // add a conservative starchy snack to hedge". but if BG is still RISING at
                // bedtime, something is actively pushing it up (late snack, stress, illness) —
                // adding more carbs would stack onto the rise and blow past the overnight drop.
                // mirror `isDescendingFromHigh` pattern from the reactive branch: let the insulin
                // do its job without interference.
                if (trend.description !== `stable` && trend.direction === `rising`)
                {
                    title = `Bedtime`;
                    message = `Your sugar is ${reading} and ${trend.description}, above target heading towards bed. Let your overnight insulin bring it down — no snack needed tonight.`;
                }
                else
                {
                    var conservativeCarbs = Math.min(carbs, 15);
                    var food = getBedtimeSuggestion(conservativeCarbs);
                    title = `Bedtime top-up`;
                    message = `Your sugar is ${reading} heading towards bed. That's above target now but your overnight insulin will bring it down. Have about ${food.grams}g of something starchy around 10:30pm to carry you through to morning${hint(` — ${food.suggestion}`)}.`;
                }
            }
            else
            {
                var food = getBedtimeSuggestion(carbs);
                title = `Bedtime top-up`;
                message = `Your sugar is ${reading} heading towards bed. Have about ${food.grams}g of something starchy around 10:30pm${hint(` — ${food.suggestion}`)}.`;
            }
        }

        await sendNudge(title, message);
        state.bedtimeNudgeSentDate = now.format(`YYYY-MM-DD`);
        return true;
    }

    // reactive nudge: the fourth kind of nudge, fired when BG is drifting below
    // target or crashing in-target. unlike the three proactive nudges (breakfast,
    // dinner, bedtime) this fires at any time of day in response to the trend
    // and current reading. handles below-target, in-target-falling, and the
    // meal window safety override.
    async function evaluateReactive(reading, trend, sendNudge, now)
    {
        var minutesSinceInjection = getMinutesSinceLastInjection(now);
        var insulinActivity = getInsulinActivity(minutesSinceInjection);
        var insulinActive = insulinActivity !== null && insulinActivity >= p.insulinActiveThreshold;
        var mealWindow = isInMealWindow(now);
        var projected = projectGlucose(reading, trend);

        var title = null;
        var message = null;
        var category = null;
        var carbs = null;
        var food = null;

        if (reading < p.targetLow)
        {
            category = `below`;

            // meal window suppresses minor descents during digestion, but NOT clear
            // clinical risk. if BG is at hypoFloor, trend is urgent, or we're
            // projected to hypo soon, the "meal is digesting" assumption is wrong
            // and the engine must nudge for safety. canonical case: zero-carb dinner
            // — insulin injected, no carbs eaten, engine would otherwise stay silent
            // because it thinks the meal is covering — until clinical hypo arrives.
            var urgentDuringMeal = reading <= p.hypoFloor
                                || trend.urgent
                                || (projected !== null && projected <= p.hypoFloor);
            if (mealWindow && !urgentDuringMeal) return;
            if (trend.direction === `rising`) return;

            carbs = estimateCarbsNeeded(reading, trend, insulinActivity);

            // clinical hypo territory or urgent trend — always emergency foods
            if (reading <= p.hypoFloor || trend.urgent)
            {
                food = getEmergencySuggestion(carbs);
                title = `Fast sugar now`;
                if (insulinActive)
                {
                    var followUp = getBedtimeSuggestion(10);
                    message = `Your sugar is ${reading} and ${trend.description}. Have ${food.grams}g of fast-acting sugar now${hint(` — ${food.suggestion}`)}. Give it 15 minutes to work, then have ${INCLUDE_FOOD_EXAMPLES ? `${followUp.suggestion} (about 10g)` : `about 10g of something starchy`} to bridge your active insulin. If your sugar hasn't come up in 15 minutes, have another ${food.grams}g of fast sugar first.`;
                }
                else
                {
                    message = `Your sugar is ${reading} and ${trend.description}. Have ${food.grams}g of fast-acting sugar now${hint(` — ${food.suggestion}`)}. Give it 15 minutes to work, then check again — if your sugar hasn't come up, have another ${food.grams}g of fast sugar.`;
                }
            }
            // below target with insulin actively pulling — use fast-acting food
            // because slow food won't absorb before the insulin drops her further
            else if (insulinActive && trend.direction === `falling`)
            {
                food = getEmergencySuggestion(carbs);
                title = `Fast sugar now`;
                var followUp = getBedtimeSuggestion(10);
                message = `Your sugar is ${reading} and ${trend.description}. Your insulin is still working so it may keep dropping. Have ${food.grams}g of fast-acting sugar now${hint(` — ${food.suggestion}`)}. Give it 15 minutes to work, then have ${INCLUDE_FOOD_EXAMPLES ? `${followUp.suggestion} (about 10g)` : `about 10g of something starchy`} to stop it dropping again. If your sugar hasn't come up in 15 minutes, have another ${food.grams}g of fast sugar first.`;
            }
            else
            {
                food = getCarbSuggestion(carbs);

                if (trend.direction === `falling`)
                {
                    title = `Sugar falling below target`;
                    message = `Your sugar is ${reading} and ${trend.description}. Have about ${food.grams}g of slower-acting carbs (low GI) to steady it${hint(` — try ${food.suggestion}`)}.`;
                }
                else
                {
                    title = `Sugar below target`;
                    message = `Your sugar is ${reading} and ${trend.description}, below target. Have about ${food.grams}g of slower-acting carbs (low GI) to steady it${hint(` — try ${food.suggestion}`)}.`;
                }
            }
        }
        else if (reading <= p.targetHigh)
        {
            // meal window suppresses typical in-target descents during digestion,
            // but NOT rapid/urgent descents or a projected hypo. same rationale
            // as the below-target branch above.
            var urgentInTargetDuringMeal = trend.urgent || (projected !== null && projected <= p.hypoFloor);
            if (mealWindow && !urgentInTargetDuringMeal) return;

            // if BG was above target recently, this descent is insulin working — don't interrupt
            if (isDescendingFromHigh() && trend.direction === `falling`) return;

            carbs = estimateCarbsNeeded(reading, trend, insulinActivity);

            // urgent drops in target — emergency foods, act now
            if (trend.urgent)
            {
                food = getEmergencySuggestion(carbs);
                category = `in-target-falling`;
                title = `Fast sugar now`;
                message = `Your sugar is ${reading} and ${trend.description}. Have ${food.grams}g of fast-acting sugar now${hint(` — ${food.suggestion}`)}. Give it 15 minutes to work, then check again — if your sugar hasn't come up, have another ${food.grams}g of fast sugar.`;
            }
            else
            {
                food = getCarbSuggestion(carbs);

                // only nudge when close to the lower boundary — above 7.5 is comfortable even if falling
                if (trend.direction === `falling` && insulinActive && reading < p.targetLow + 0.5)
                {
                    category = `in-target-falling`;
                    title = `Sugar drifting down`;
                    message = `Your sugar is ${reading} and ${trend.description}. Your insulin is still working so it may drift lower. Have about ${food.grams}g of slower-acting carbs (low GI) to steady it${hint(` — try ${food.suggestion}`)}.`;
                }
                else if (trend.description === `dropping fast` || trend.description === `dropping fast and accelerating` || trend.description === `falling and picking up pace`)
                {
                    category = `in-target-falling`;
                    title = `Sugar dropping fast`;
                    message = `Your sugar is ${reading} and ${trend.description}. Have about ${food.grams}g of slower-acting carbs (low GI) to level it off${hint(` — try ${food.suggestion}`)}.`;
                }
                else if (projected !== null && projected < p.targetLow)
                {
                    category = `in-target-falling`;
                    title = `Sugar heading below target`;
                    message = `Your sugar is ${reading} and ${trend.description} — heading below target within half an hour. Have about ${food.grams}g of slower-acting carbs (low GI) to keep it steady${hint(` — try ${food.suggestion}`)}.`;
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

        if (carbs !== null && shouldSuppressNudge(reading, carbs, category, now)) return;

        await sendNudge(title, message);
        state.lastNudgeSent = now.valueOf();
        state.lastNudgeCategory = category;
        state.lastNudgeCarbs = carbs;
        state.lastNudgeReading = reading;
        // calculate where we expect BG to be if she eats the suggested carbs
        state.lastNudgeExpectedReading = carbs !== null ? reading + (carbs / p.carbsPerMmol) : null;
    }

    // main entry point. dispatches to one of the four nudge types — three
    // proactive (breakfast, dinner, bedtime) which fire once per day in their
    // respective windows, and one reactive which catches anything else.
    // now is optional — defaults to moment(). pass a moment instance to
    // control time in tests.
    async function evaluate(reading, sendNudge, now)
    {
        if (readings.length >= p.maxReadings) readings.shift();
        readings.push(reading);

        if (readings.length < 2) return;

        now = now || moment();

        if (isQuietHours(now)) return;

        // state reset after recovery: clear the "last nudge" context once BG has
        // comfortably returned to a safe zone. without a reset, the engine carries
        // the old nudge context forever and can suppress a legitimate new dip hours
        // later. two conditions qualify as "recovered":
        //   (a) BG has risen at least 1.0 mmol/L since the nudge fired, OR
        //   (b) BG is comfortably above targetLow (>= targetLow + 2.0, i.e. ≥ 8.0)
        // the 8.0 threshold ensures a brief bounce above 7.0 during oscillation
        // doesn't falsely reset state; only a real return to mid-target range does.
        if (state.lastNudgeSent !== null && state.lastNudgeReading !== null)
        {
            var recoveredFromNudge = reading >= state.lastNudgeReading + 1.0;
            var comfortablyInTarget = reading >= p.targetLow + 2.0;
            if (recoveredFromNudge || comfortablyInTarget)
            {
                state.lastNudgeSent = null;
                state.lastNudgeCategory = null;
                state.lastNudgeCarbs = null;
                state.lastNudgeReading = null;
                state.lastNudgeExpectedReading = null;
            }
        }

        var trend = getTrend(reading);

        // the four nudge types. proactive windows take priority — if any fire,
        // we're done. reactive catches any descent outside those windows.
        if (await evaluateBreakfast(reading, trend, sendNudge, now)) return;
        if (await evaluateDinner(reading, trend, sendNudge, now)) return;
        if (await evaluateBedtime(reading, trend, sendNudge, now)) return;
        await evaluateReactive(reading, trend, sendNudge, now);
    }

    return { evaluate: evaluate, state: state, profile: p, _test: { getInsulinActivity: getInsulinActivity } };
}

module.exports = { createNudgeEngine, INCLUDE_FOOD_EXAMPLES, DEFAULTS, CARB_SUGGESTIONS, EMERGENCY_SUGGESTIONS, BEDTIME_SUGGESTIONS, BREAKFAST_SUGGESTIONS, LOW_CARB_BREAKFAST_SUGGESTIONS, DINNER_SUGGESTIONS };
