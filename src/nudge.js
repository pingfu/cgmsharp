const moment = require(`moment`);

// --- target range ---
const NUDGE_TARGET_LOW = 7.0; // lower bound of "top half of green" (mmol/L). p25 of historical data is 7.4 — 19% of readings fall below this.
const NUDGE_TARGET_HIGH = 10.0; // upper bound of target range (mmol/L). Median is 9.4, so roughly half of readings are in or above this.
const NUDGE_ABOVE_THRESHOLD = 11.0; // only nudge about high sugar above this level. Historical data shows 43% of readings above 10.0 — nudging at 10.0 would be constant noise.

// --- biphasic insulin curve: rapid component (30% of premixed dose, e.g. NovoMix 30) ---
// these are manufacturer numbers — may need shifting later for this user (older patients often absorb more slowly)
const INSULIN_RAPID_ONSET_MIN = 15; // minutes post-injection before rapid component begins acting
const INSULIN_RAPID_PEAK_START_MIN = 60; // start of peak rapid-acting effect
const INSULIN_RAPID_PEAK_END_MIN = 90; // end of peak rapid-acting effect
const INSULIN_RAPID_TAIL_MIN = 240; // rapid component fully worn off (4 hours)

// --- biphasic insulin curve: intermediate component (70% of premixed dose) ---
// broader, slower curve — this is what provides background coverage between meals
const INSULIN_INTERMEDIATE_ONSET_MIN = 90; // minutes post-injection before intermediate component begins
const INSULIN_INTERMEDIATE_PEAK_START_MIN = 240; // start of peak intermediate effect (4 hours)
const INSULIN_INTERMEDIATE_PEAK_END_MIN = 480; // end of peak intermediate effect (8 hours)
const INSULIN_INTERMEDIATE_TAIL_MIN = 960; // intermediate fully worn off (16 hours)

// component weights (must sum to 1.0) — reflects the 30/70 split of premixed insulin
const INSULIN_RAPID_WEIGHT = 0.30;
const INSULIN_INTERMEDIATE_WEIGHT = 0.70;

// insulin is considered "meaningfully active" above this threshold (0.0-1.0 scale).
// at 0.25, creates distinct active/inactive windows. lower values (e.g. 0.15) would mean insulin
// is considered active nearly 24/7 with twice-daily dosing, making the non-insulin code paths dead code.
const INSULIN_ACTIVE_THRESHOLD = 0.25;

// --- dawn phenomenon window ---
// historical data shows mean BG of 12.15 during 4-8 AM vs 9.1 overnight,
// and the spike persists through late morning (8-noon mean is 10.83), so the window extends to 10 AM.
const DAWN_PHENOMENON_START_HOUR = 4;
const DAWN_PHENOMENON_END_HOUR = 10;

// how far ahead to project glucose (minutes). uses linear extrapolation from current rate of change.
// 30 min is roughly 3 ticks — enough lead time to act, without projecting so far that accuracy degrades.
const NUDGE_PROJECTION_MINUTES = 30;

// --- meal window ---
// biphasic insulin is injected with a meal. for this period after each injection time,
// assume a meal is being digested and suppress carb-suggesting nudges. tonight's data showed the
// full eat-peak-settle cycle took ~2 hours (dinner at 19:30, peak at 20:00 at 8.8, settled at 21:00).
const MEAL_WINDOW_MINUTES = 120;

// --- observed carb sensitivity ---
// 18g carbs produced a 4.1 mmol/L rise (4.7 → 8.8 on 2026-04-06).
// that's ~4.4g per 1 mmol/L. this is the key per-individual tuning knob.
const CARBS_PER_MMOL = 4.4;

// --- overnight quiet hours ---
// nudges are fully silent during this window. she's asleep and can't act on them.
// low glucose alarms on the alert channel handle emergencies separately.
const NUDGE_QUIET_START_HOUR = 0; // midnight
const NUDGE_QUIET_END_HOUR = 6; // 6 AM

// --- absorption-aware suppression ---
// after recommending carbs, suppress further carb nudges until the food has had time to show in BG.
// not an arbitrary cooldown — tied to the physiology of what we just recommended.
const ABSORPTION_WINDOW_SMALL = 20; // minutes for ≤7g carbs to show in BG
const ABSORPTION_WINDOW_LARGE = 35; // minutes for >7g carbs to show in BG

// carb suggestion lookup: each tier has a gram target and a list of food ideas to rotate through
const CARB_SUGGESTIONS = [
    { grams: 2, ideas: [`a few grapes`, `a couple of dried apricots`, `a small handful of blueberries`] },
    { grams: 5, ideas: [`a small pot of natural yoghurt`, `half a small banana`, `a couple of strawberries with a spoon of yoghurt`, `a few cherry tomatoes with a thin slice of cheese`] },
    { grams: 7, ideas: [`a small apple`, `a tablespoon of hummus with a few carrot sticks`, `a small pot of yoghurt with berries`] },
    { grams: 10, ideas: [`a slice of wholemeal toast`, `a small banana`, `a digestive biscuit with a cup of tea`, `a small bowl of porridge`, `a handful of grapes with a few nuts`] },
    { grams: 15, ideas: [`a slice of toast with peanut butter`, `a glass of milk and a piece of fruit`, `a small bowl of cereal`, `a couple of oatcakes with cheese`] },
    { grams: 20, ideas: [`a sandwich half with lean filling`, `a bowl of porridge with a banana`, `a glass of orange juice and a biscuit`] }
];

function createNudgeEngine(config)
{
    var interval = config.interval;

    // nudge engine maintains its own readings history, independent of other modules
    var readings = [];
    var maxReadings = 6; // 60 min at 10-min intervals — enough for trend analysis

    var state = {
        insulinTimes: {
            morning: config.insulinTimeMorning || null,
            evening: config.insulinTimeEvening || null
        },
        lastNudgeSent: null,
        lastNudgeCategory: null,
        lastNudgeCarbs: null,
        lastNudgeReading: null
    };

    function calculateRateOfChange()
    {
        if (readings.length < 2) return null;

        var newest = readings[readings.length - 1];
        var oldest = readings[0];
        var timeSpanMinutes = (readings.length - 1) * interval;

        return (newest - oldest) / timeSpanMinutes; // mmol/L per minute
    }

    function getTrend()
    {
        var rate = calculateRateOfChange();
        if (rate === null) return { rate: null, direction: `unknown`, description: `insufficient data` };

        var absRate = Math.abs(rate);
        var direction = rate > 0 ? `rising` : rate < 0 ? `falling` : `flat`;

        // thresholds in mmol/L per minute. historical data: median tick-to-tick change is 0.0,
        // p25/p75 are ±0.4 per 10 min (±0.04/min), p5/p95 are ±1.4-1.5 per 10 min (±0.14-0.15/min).
        // 0.07/min "rapidly" threshold catches ~10-15% of movements (previously 0.10 only caught ~5%).
        if (absRate < 0.01) return { rate, direction: `flat`, description: `stable` };
        if (absRate < 0.05) return { rate, direction, description: `slowly ${direction}` };
        if (absRate < 0.07) return { rate, direction, description: direction };
        return { rate, direction, description: `rapidly ${direction}` };
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

        var rapid = getInsulinComponentActivity(minutesSinceInjection, INSULIN_RAPID_ONSET_MIN, INSULIN_RAPID_PEAK_START_MIN, INSULIN_RAPID_PEAK_END_MIN, INSULIN_RAPID_TAIL_MIN);
        var intermediate = getInsulinComponentActivity(minutesSinceInjection, INSULIN_INTERMEDIATE_ONSET_MIN, INSULIN_INTERMEDIATE_PEAK_START_MIN, INSULIN_INTERMEDIATE_PEAK_END_MIN, INSULIN_INTERMEDIATE_TAIL_MIN);

        return (rapid * INSULIN_RAPID_WEIGHT) + (intermediate * INSULIN_INTERMEDIATE_WEIGHT);
    }

    function isInMealWindow(now)
    {
        var minutesSince = getMinutesSinceLastInjection(now);
        return minutesSince !== null && minutesSince <= MEAL_WINDOW_MINUTES;
    }

    function isQuietHours(now)
    {
        var hour = now.hour();
        return hour >= NUDGE_QUIET_START_HOUR && hour < NUDGE_QUIET_END_HOUR;
    }

    function isDawnPhenomenonWindow(now)
    {
        var hour = now.hour();
        return hour >= DAWN_PHENOMENON_START_HOUR && hour < DAWN_PHENOMENON_END_HOUR;
    }

    function projectGlucose(currentReading, ratePerMinute, minutes)
    {
        if (ratePerMinute === null) return null;
        return currentReading + (ratePerMinute * minutes);
    }

    function estimateCarbsNeeded(reading, trend, insulinActive)
    {
        // observed ratio from real data: 18g carbs raised BG by 4.1 mmol/L (4.7 → 8.8).
        // that's ~4.4g per 1 mmol/L. this is the single most important knob to tune per individual.
        var gap = NUDGE_TARGET_LOW - reading;
        if (gap < 0) gap = 0;

        // aim to bring reading back into target with a small margin, not to mid-target.
        // add 0.5 mmol/L buffer so she lands just inside the range, not right on the edge.
        var targetGap = gap + 0.5;

        var base = Math.round(targetGap * CARBS_PER_MMOL);

        // adjust for trend — steeper drops will continue eating into the correction
        if (trend.description === `rapidly falling`) base = base + Math.round(CARBS_PER_MMOL * 0.5);
        else if (trend.direction === `rising`) base = Math.max(base - Math.round(CARBS_PER_MMOL * 0.5), 2);

        // insulin still active means BG will likely keep dropping — small buffer
        if (insulinActive) base = base + Math.round(CARBS_PER_MMOL * 0.5);

        // clamp to sensible range
        base = Math.max(base, 2);
        base = Math.min(base, 20);

        return base;
    }

    function getCarbSuggestion(grams)
    {
        var best = CARB_SUGGESTIONS[0];
        var bestDiff = Math.abs(grams - best.grams);

        for (var i = 1; i < CARB_SUGGESTIONS.length; i++)
        {
            var diff = Math.abs(grams - CARB_SUGGESTIONS[i].grams);
            if (diff < bestDiff)
            {
                best = CARB_SUGGESTIONS[i];
                bestDiff = diff;
            }
        }

        var idea = best.ideas[Math.floor(Math.random() * best.ideas.length)];
        return { grams: best.grams, suggestion: idea };
    }

    function isAbsorptionSuppressed(carbs, category)
    {
        if (state.lastNudgeSent === null || state.lastNudgeCarbs === null) return false;

        var absorptionWindow = state.lastNudgeCarbs <= 7 ? ABSORPTION_WINDOW_SMALL : ABSORPTION_WINDOW_LARGE;
        var minutesSinceLastNudge = (Date.now() - state.lastNudgeSent) / 60000;

        if (minutesSinceLastNudge >= absorptionWindow) return false;

        // break through if situation has materially worsened (carb tier jumped by 5g+)
        if (carbs >= state.lastNudgeCarbs + 5) return false;

        // break through if category changed (e.g. was in-target-falling, now below)
        if (category !== state.lastNudgeCategory) return false;

        return true;
    }

    async function evaluate(reading, sendNudge)
    {
        // maintain own readings buffer
        if (readings.length >= maxReadings) readings.shift();
        readings.push(reading);

        if (readings.length < 2) return;

        var now = moment();

        // overnight quiet hours — fully silent
        if (isQuietHours(now)) return;

        var trend = getTrend();
        var minutesSinceInjection = getMinutesSinceLastInjection(now);
        var insulinActivity = getInsulinActivity(minutesSinceInjection);
        var insulinActive = insulinActivity !== null && insulinActivity >= INSULIN_ACTIVE_THRESHOLD;
        var mealWindow = isInMealWindow(now);
        var projected = projectGlucose(reading, trend.rate, NUDGE_PROJECTION_MINUTES);
        var isDawn = isDawnPhenomenonWindow(now);

        var title = null;
        var message = null;
        var category = null;
        var carbs = null;
        var food = null;

        if (reading < NUDGE_TARGET_LOW)
        {
            category = `below`;

            // meal window — food is being digested, don't suggest more
            if (mealWindow) return;

            // below target but rising — it's recovering on its own, stay quiet
            if (trend.direction === `rising`) return;

            carbs = estimateCarbsNeeded(reading, trend, insulinActive);
            food = getCarbSuggestion(carbs);

            if (trend.direction === `falling` && insulinActive)
            {
                title = `Time for a snack`;
                message = `Your sugar is ${reading} and ${trend.description}. Your insulin is still working, so it'll probably keep drifting down. About ${food.grams}g of carbs would help — something like ${food.suggestion}. That's a bit more than usual because your insulin is still active.`;
            }
            else if (trend.direction === `falling`)
            {
                title = `A little top-up might help`;
                message = `Your sugar is ${reading} and ${trend.description}. About ${food.grams}g of carbs should help steady things — for example, ${food.suggestion}. That amount suits a gentle ${trend.description} trend when you're a touch below target.`;
            }
            else
            {
                title = `Sugar update`;
                message = `Your sugar is ${reading} and ${trend.description}, sitting just below target. A small top-up of about ${food.grams}g of carbs would give it a nudge — try ${food.suggestion}.`;
            }
        }
        else if (reading <= NUDGE_TARGET_HIGH)
        {
            // meal window — in target, food is working, stay quiet
            if (mealWindow) return;

            carbs = estimateCarbsNeeded(reading, trend, insulinActive);
            food = getCarbSuggestion(carbs);

            if (trend.direction === `falling` && insulinActive)
            {
                category = `in-target-falling`;
                title = `Thinking ahead`;
                message = `Your sugar is ${reading} and ${trend.description}. You're in range but your insulin is still working, so it may keep drifting down. A small snack of about ${food.grams}g of carbs could help you stay comfortable — something like ${food.suggestion}.`;
            }
            else if (trend.description === `rapidly falling`)
            {
                category = `in-target-falling`;
                title = `Worth a small snack`;
                message = `Your sugar is ${reading} and coming down fairly quickly. About ${food.grams}g of carbs would help it level off — try ${food.suggestion}.`;
            }
            else if (projected !== null && projected < NUDGE_TARGET_LOW)
            {
                category = `in-target-falling`;
                title = `Gentle heads-up`;
                message = `Your sugar is ${reading} and ${trend.description}. At this pace it might dip a little below target over the next half hour. Something like ${food.suggestion} (about ${food.grams}g carbs) would keep things steady.`;
            }
            else
            {
                return;
            }
        }
        else if (reading < NUDGE_ABOVE_THRESHOLD)
        {
            // quiet zone between target high and above threshold — no nudge
            return;
        }
        else
        {
            // above threshold — only nudge if rising (and not dawn phenomenon)
            if (trend.direction !== `rising`) return;
            if (isDawn) return;

            category = `above`;

            if (projected !== null && projected > NUDGE_ABOVE_THRESHOLD + 2.0)
            {
                title = `Sugar update`;
                message = `Your sugar is ${reading} and ${trend.description}. At this pace it could reach about ${projected.toFixed(1)} over the next half hour. Probably best to skip snacks for a bit and let it come back down.`;
            }
            else
            {
                title = `Sugar update`;
                message = `Your sugar is ${reading} and ${trend.description}. It's a little above target so maybe hold off on snacks for now and let it drift back down.`;
            }
        }

        if (title === null || message === null) return;

        // absorption-aware suppression — only applies to carb-suggesting nudges
        if (carbs !== null && isAbsorptionSuppressed(carbs, category)) return;

        await sendNudge(title, message);
        state.lastNudgeSent = Date.now();
        state.lastNudgeCategory = category;
        state.lastNudgeCarbs = carbs;
        state.lastNudgeReading = reading;
    }

    return { evaluate: evaluate, state: state };
}

module.exports = { createNudgeEngine };
