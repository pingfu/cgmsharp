const moment = require(`moment`);

// default profile — current values calibrated from historical data (Apr-Oct 2025, 21,777 readings)
// and observed carb sensitivity (2026-04-06 evening session)
const DEFAULTS = {
    // target range
    targetLow: 7.0, // lower bound of "top half of green" (mmol/L). p25 of historical data is 7.4.
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

    // how far ahead to project glucose (minutes). linear extrapolation from current rate.
    projectionMinutes: 30,

    // meal window — insulin is injected with a meal. suppress carb nudges for this period.
    // observed eat-peak-settle cycle took ~2 hours on 2026-04-06.
    mealWindowMinutes: 120,

    // observed carb sensitivity: 18g carbs raised BG by 4.1 mmol/L (4.7 → 8.8).
    // ~4.4g per 1 mmol/L. the single most important per-individual tuning knob.
    carbsPerMmol: 4.4,

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

    // readings buffer size
    maxReadings: 6 // 60 min at 10-min intervals
};

// carb suggestion lookup: each tier has a gram target and food ideas to rotate through
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
        lastNudgeReading: null
    };

    function calculateRateOfChange()
    {
        if (readings.length < 2) return null;

        var newest = readings[readings.length - 1];
        var oldest = readings[0];
        var timeSpanMinutes = (readings.length - 1) * interval;

        return (newest - oldest) / timeSpanMinutes;
    }

    function getTrend()
    {
        var rate = calculateRateOfChange();
        if (rate === null) return { rate: null, direction: `unknown`, description: `insufficient data` };

        var absRate = Math.abs(rate);
        var direction = rate > 0 ? `rising` : rate < 0 ? `falling` : `flat`;

        if (absRate < p.trendFlatThreshold) return { rate, direction: `flat`, description: `stable` };
        if (absRate < p.trendSlowThreshold) return { rate, direction, description: `slowly ${direction}` };
        if (absRate < p.trendRapidThreshold) return { rate, direction, description: direction };
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

    function projectGlucose(currentReading, ratePerMinute, minutes)
    {
        if (ratePerMinute === null) return null;
        return currentReading + (ratePerMinute * minutes);
    }

    function estimateCarbsNeeded(reading, trend, insulinActive)
    {
        var gap = p.targetLow - reading;
        if (gap < 0) gap = 0;

        var targetGap = gap + 0.5;
        var base = Math.round(targetGap * p.carbsPerMmol);

        if (trend.description === `rapidly falling`) base = base + Math.round(p.carbsPerMmol * 0.5);
        else if (trend.direction === `rising`) base = Math.max(base - Math.round(p.carbsPerMmol * 0.5), 2);

        if (insulinActive) base = base + Math.round(p.carbsPerMmol * 0.5);

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

    function isAbsorptionSuppressed(carbs, category, now)
    {
        if (state.lastNudgeSent === null || state.lastNudgeCarbs === null) return false;

        var absorptionWindow = state.lastNudgeCarbs <= 7 ? p.absorptionSmall : p.absorptionLarge;
        var minutesSinceLastNudge = (now.valueOf() - state.lastNudgeSent) / 60000;

        if (minutesSinceLastNudge >= absorptionWindow) return false;
        if (carbs >= state.lastNudgeCarbs + 5) return false;
        if (category !== state.lastNudgeCategory) return false;

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

        var trend = getTrend();
        var minutesSinceInjection = getMinutesSinceLastInjection(now);
        var insulinActivity = getInsulinActivity(minutesSinceInjection);
        var insulinActive = insulinActivity !== null && insulinActivity >= p.insulinActiveThreshold;
        var mealWindow = isInMealWindow(now);
        var projected = projectGlucose(reading, trend.rate, p.projectionMinutes);
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
        else if (reading <= p.targetHigh)
        {
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
            else if (projected !== null && projected < p.targetLow)
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
        else if (reading < p.aboveThreshold)
        {
            return;
        }
        else
        {
            if (trend.direction !== `rising`) return;
            if (isDawn) return;

            category = `above`;

            if (projected !== null && projected > p.aboveThreshold + 2.0)
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

        if (carbs !== null && isAbsorptionSuppressed(carbs, category, now)) return;

        await sendNudge(title, message);
        state.lastNudgeSent = now.valueOf();
        state.lastNudgeCategory = category;
        state.lastNudgeCarbs = carbs;
        state.lastNudgeReading = reading;
    }

    return { evaluate: evaluate, state: state, profile: p };
}

module.exports = { createNudgeEngine, DEFAULTS, CARB_SUGGESTIONS };
