require(`dotenv`).config();

const cron = require(`node-cron`);
const moment = require(`moment`);
const pushover = require(`pushover-notifications`);
const { LibreLinkUpClient } = require(`@diakem/libre-link-up-api-client`);
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const CANARY = `0 9 * * *`; // cron expression governing how often canary notifications are dispatched
const INTERVAL = 10; // interval between obtaining new glucose readings (minutes)
const NUMBER_OF_LAST_READINGS_TO_EXAMINE = 6; // number of glucose readings to hold in memory and examine for extended periods of high or low values
const GLUCOSE_CRITICAL_LOW = 3.5; // Minimum threshold
const GLUCOSE_CRITICAL_HIGH = 22; // Maximum threshold

const NTFY_SERVER = `https://ntfy.sh`;

const NUDGE_TARGET_LOW = 7.0; // lower bound of "top half of green" (mmol/L)
const NUDGE_TARGET_HIGH = 10.0; // upper bound of target range (mmol/L)

// biphasic insulin curve: rapid component (30% of premixed dose)
const INSULIN_RAPID_ONSET_MIN = 15;
const INSULIN_RAPID_PEAK_START_MIN = 60;
const INSULIN_RAPID_PEAK_END_MIN = 90;
const INSULIN_RAPID_TAIL_MIN = 240; // 4 hours

// biphasic insulin curve: intermediate component (70% of premixed dose)
const INSULIN_INTERMEDIATE_ONSET_MIN = 90;
const INSULIN_INTERMEDIATE_PEAK_START_MIN = 240; // 4 hours
const INSULIN_INTERMEDIATE_PEAK_END_MIN = 480; // 8 hours
const INSULIN_INTERMEDIATE_TAIL_MIN = 960; // 16 hours

// component weights (must sum to 1.0)
const INSULIN_RAPID_WEIGHT = 0.30;
const INSULIN_INTERMEDIATE_WEIGHT = 0.70;

// insulin is considered "meaningfully active" above this threshold
const INSULIN_ACTIVE_THRESHOLD = 0.15;

// dawn phenomenon window
const DAWN_PHENOMENON_START_HOUR = 4;
const DAWN_PHENOMENON_END_HOUR = 8;

// how far ahead to project glucose (minutes)
const NUDGE_PROJECTION_MINUTES = 30;

let values = []; // store received glucose values
let libreLinkUpErrorCounter = 0;
let libreLinkUpLatestError = "";
let influxWriteApi;

let nudgeState = {
    insulinTimes: {
        morning: process.env.INSULIN_TIME_MORNING || null,
        evening: process.env.INSULIN_TIME_EVENING || null
    },
    lastNudgeSent: null,
    lastNudgeCategory: null
};

let pusher = (process.env.PUSHOVER_USER && process.env.PUSHOVER_TOKEN)
    ? new pushover({ user: process.env.PUSHOVER_USER, token: process.env.PUSHOVER_TOKEN })
    : null;

function log(message)
{
    console.log(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + message);
}

function tryInitaliseDb() {
    try
    {
        const influxUrl = process.env.INFLUX_DB_URL;
        const influxToken = process.env.INFLUX_DB_TOKEN;
        const influxOrg = process.env.INFLUX_DB_ORG;
        const influxBucket = process.env.INFLUX_DB_BUCKET;
    
        if (influxUrl && influxToken && influxOrg && influxBucket)
        {
            const influxClient = new InfluxDB({ url: influxUrl, token: influxToken });
            
            influxWriteApi = influxClient.getWriteApi(influxOrg, influxBucket);
    
            log(`database: influxdb state: configured for ${influxUrl}`);
        }
        else
        {
            log(`database: influxdb state: not configured`);
        }
    }
    catch (error)
    {
        console.error('Error initialising influxdb client: ', error);
    }
}

async function tryWriteGlucoseReading(glucoseReading) {
    if (influxWriteApi)
    {
        try
        {
            const point = new Point('glucose')
                .floatField('value', glucoseReading)
                .timestamp(new Date());

            await influxWriteApi.writePoint(point);
        } 
        catch (error)
        {
            console.error('Error writing to influxdb:', error);

            // check for specific error conditions that indicate a need to reinitialize
            const errorMessage = error.message.toLowerCase();

            if (errorMessage.includes('timeout') || errorMessage.includes('connection'))
            {
                await influxWriteApi.close();

                influxWriteApi = null;

                console.log('Attempting to re-initalise influxdb client due to connection issue...');
                tryInitaliseDb();
            }
        }
    }
}

async function GetLibreLinkUpData()
{
    try
    {
        const { read } = LibreLinkUpClient({
            username: process.env.LIBRE_USERNAME, 
            password: process.env.LIBRE_PASSWORD,
            clientVersion: process.env.LIBRE_AGENT_VERSION
        });

        const response = await read();

        // reset LibreLinkupError counter to zero after a successful read() operation
        if (libreLinkUpErrorCounter > 0)
        {
            try
            {
                await SendAlert(`GCM monitoring`, `Error state cleared, monitoring resumed`);
            }
            catch (error)
            {
                throw error;
            }

            libreLinkUpErrorCounter = 0;
            libreLinkUpLatestError = ``;
        }

        return response.current.value;
    }
    catch (error)
    {
        var msg = `LibreLinkUpClient ` + error;

        if (error.isAxiosError && error.response && error.response.status === 401)
        {
            var fatal = "non-recoverable error (" + error + ") terminating process.";

            log(fatal);

            try
            {
                await SendAlert(`GCM monitoring`, fatal);
            }
            catch (notificationError)
            {
                log(`Failed to send push notification: ${notificationError}`);
            }

            process.exit(1);
        }
    
        libreLinkUpErrorCounter++;
        libreLinkUpLatestError = msg;

        throw new Error(msg);
    }
}

async function AlarmMin(currentReading) {
    await SendAlert(`Extended Low Glucose Alarm`, `${moment().format(`YYYY-MM-DD HH:mm:ss`)} ${currentReading} mmol/L over last ${NUMBER_OF_LAST_READINGS_TO_EXAMINE} readings, ${INTERVAL} min intervals.`);
}

async function AlarmMax(currentReading) {
    await SendAlert(`Extended High Glucose Alarm`, `${moment().format(`YYYY-MM-DD HH:mm:ss`)} ${currentReading} mmol/L over last ${NUMBER_OF_LAST_READINGS_TO_EXAMINE} readings, ${INTERVAL} min intervals.`);
}

async function ntfySend(topic, title, message, priority, tags)
{
    var headers = {
        'Title': title,
        'Priority': String(priority),
        'Tags': tags || ``
    };

    var response = await fetch(`${NTFY_SERVER}/${topic}`, {
        method: 'POST',
        headers: headers,
        body: message
    });

    if (!response.ok)
    {
        throw new Error(`ntfy returned ${response.status}: ${response.statusText}`);
    }
}

function pushoverSend(title, message, priority)
{
    return new Promise(function (resolve, reject)
    {
        pusher.send({ title: title, message: message, priority: priority }, function (error)
        {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function SendAlert(title, message)
{
    log(`pushing alert '${title}': '${message}'`);

    var promises = [];

    if (process.env.NTFY_TOPIC_ALERT)
    {
        promises.push(ntfySend(process.env.NTFY_TOPIC_ALERT, title, message, 5, `rotating_light,warning`));
    }

    if (pusher)
    {
        promises.push(pushoverSend(title, message, 2));
    }

    await Promise.all(promises);
}

function SendCanary(title, message)
{
    log(`pushing canary '${title}': '${message}'`);
    return ntfySend(process.env.NTFY_TOPIC_CANARY, title, message, 2, `bird,green_circle`);
}

function SendNudge(title, message)
{
    log(`pushing nudge '${title}': '${message}'`);
    return ntfySend(process.env.NTFY_TOPIC_NUDGE, title, message, 3, `thought_balloon,syringe`);
}

function calculateRateOfChange(readings)
{
    if (readings.length < 2) return null;

    var newest = readings[readings.length - 1];
    var oldest = readings[0];
    var timeSpanMinutes = (readings.length - 1) * INTERVAL;

    return (newest - oldest) / timeSpanMinutes; // mmol/L per minute
}

function getTrend(readings)
{
    var rate = calculateRateOfChange(readings);
    if (rate === null) return { rate: null, direction: `unknown`, description: `insufficient data` };

    var absRate = Math.abs(rate);
    var direction = rate > 0 ? `rising` : rate < 0 ? `falling` : `flat`;

    if (absRate < 0.01) return { rate, direction: `flat`, description: `stable` };
    if (absRate < 0.05) return { rate, direction, description: `slowly ${direction}` };
    if (absRate < 0.10) return { rate, direction, description: direction };
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

    [nudgeState.insulinTimes.morning, nudgeState.insulinTimes.evening].forEach(function (timeStr)
    {
        if (!timeStr) return;

        var parts = timeStr.split(`:`);
        var injectionToday = moment(now).startOf(`day`).add(parseInt(parts[0]), `hours`).add(parseInt(parts[1]), `minutes`);

        // if injection time is in the future, use yesterday's occurrence
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

// carb suggestion lookup: each tier has a gram target and a list of food ideas to rotate through
const CARB_SUGGESTIONS = [
    { grams: 2, ideas: [`a few grapes`, `a couple of dried apricots`, `a small handful of blueberries`] },
    { grams: 5, ideas: [`a small pot of natural yoghurt`, `half a small banana`, `a couple of strawberries with a spoon of yoghurt`, `a few cherry tomatoes with a thin slice of cheese`] },
    { grams: 7, ideas: [`a small apple`, `a tablespoon of hummus with a few carrot sticks`, `a small pot of yoghurt with berries`] },
    { grams: 10, ideas: [`a slice of wholemeal toast`, `a small banana`, `a digestive biscuit with a cup of tea`, `a small bowl of porridge`, `a handful of grapes with a few nuts`] },
    { grams: 15, ideas: [`a slice of toast with peanut butter`, `a glass of milk and a piece of fruit`, `a small bowl of cereal`, `a couple of oatcakes with cheese`] },
    { grams: 20, ideas: [`a sandwich half with lean filling`, `a bowl of porridge with a banana`, `a glass of orange juice and a biscuit`] }
];

function estimateCarbsNeeded(reading, trend, insulinActive)
{
    // estimate how many grams of carbs would help based on how far below target and trend
    var gap = NUDGE_TARGET_LOW - reading; // positive when below target
    var base = 0;

    if (gap > 3.0) base = 20;
    else if (gap > 2.0) base = 15;
    else if (gap > 1.0) base = 10;
    else if (gap > 0) base = 7;
    else base = 5; // in-target but falling

    // adjust for trend
    if (trend.description === `rapidly falling`) base = Math.min(base + 5, 20);
    else if (trend.direction === `rising`) base = Math.max(base - 3, 2);

    // insulin still active means more likely to keep dropping
    if (insulinActive) base = Math.min(base + 3, 20);

    return base;
}

function getCarbSuggestion(grams)
{
    // find the closest tier
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

    // pick a random idea from the tier
    var idea = best.ideas[Math.floor(Math.random() * best.ideas.length)];
    return { grams: best.grams, suggestion: idea };
}

async function evaluateNudge(reading, readings)
{
    if (!process.env.NTFY_TOPIC_NUDGE) return;
    if (readings.length < 2) return;

    var now = moment();
    var trend = getTrend(readings);
    var minutesSinceInjection = getMinutesSinceLastInjection(now);
    var insulinActivity = getInsulinActivity(minutesSinceInjection);
    var insulinActive = insulinActivity !== null && insulinActivity >= INSULIN_ACTIVE_THRESHOLD;
    var projected = projectGlucose(reading, trend.rate, NUDGE_PROJECTION_MINUTES);
    var isDawn = isDawnPhenomenonWindow(now);

    var title = null;
    var message = null;
    var category = null;

    if (reading < NUDGE_TARGET_LOW)
    {
        category = `below`;
        var carbs = estimateCarbsNeeded(reading, trend, insulinActive);
        var food = getCarbSuggestion(carbs);

        if (trend.direction === `falling` && insulinActive)
        {
            title = `Have a snack soon`;
            message = `Your sugar is ${reading} and ${trend.description}. Your insulin is still active so it will likely keep dropping. Aim for about ${food.grams}g of carbs to bring it back up — something like ${food.suggestion}. The ${food.grams}g is because you're below target and still falling with insulin on board.`;
        }
        else if (trend.direction === `falling`)
        {
            title = `Sugar is dropping`;
            message = `Your sugar is ${reading} and ${trend.description}. About ${food.grams}g of carbs should help steady it — for example, ${food.suggestion}. That amount suits a ${trend.description} trend when you're a bit below where you want to be.`;
        }
        else if (trend.direction === `rising`)
        {
            title = `Sugar is low but coming up`;
            message = `Your sugar is ${reading}, which is below target, but it is ${trend.description} so it may come back on its own. Keep an eye on it over the next 10-20 minutes.`;
        }
        else
        {
            title = `Sugar is a bit low`;
            message = `Your sugar is ${reading} and ${trend.description} below target. A small top-up of about ${food.grams}g of carbs would help nudge it up — try ${food.suggestion}.`;
        }
    }
    else if (reading <= NUDGE_TARGET_HIGH)
    {
        var carbs = estimateCarbsNeeded(reading, trend, insulinActive);
        var food = getCarbSuggestion(carbs);

        if (trend.direction === `falling` && insulinActive)
        {
            category = `in-target-falling`;
            title = `Might need a small snack`;
            message = `Your sugar is ${reading} and ${trend.description}. You're in range now but your insulin is still active, which means it will likely keep dropping. About ${food.grams}g of carbs would help stay ahead of it — something like ${food.suggestion}.`;
        }
        else if (trend.description === `rapidly falling`)
        {
            category = `in-target-falling`;
            title = `Sugar dropping quickly`;
            message = `Your sugar is ${reading} and ${trend.description}. At this pace it could drop below target soon. About ${food.grams}g of carbs should help steady it — try ${food.suggestion}.`;
        }
        else if (projected !== null && projected < NUDGE_TARGET_LOW)
        {
            category = `in-target-falling`;
            title = `Sugar may drop soon`;
            message = `Your sugar is ${reading} and ${trend.description}. At this rate it could dip below ${NUDGE_TARGET_LOW} in the next half hour. A small top-up of around ${food.grams}g of carbs should help — something like ${food.suggestion}.`;
        }
        else
        {
            return;
        }
    }
    else
    {
        if (trend.direction === `rising`)
        {
            category = `above`;

            if (isDawn)
            {
                title = `Morning sugar rise`;
                message = `Your sugar is ${reading} and ${trend.description}. This often happens in the early morning (dawn phenomenon) and usually settles on its own. Best to hold off on snacks for now and see where it goes.`;
            }
            else if (projected !== null && projected > NUDGE_TARGET_HIGH + 2.0)
            {
                title = `Sugar is climbing`;
                message = `Your sugar is ${reading} and ${trend.description}. At this rate it could reach ${projected.toFixed(1)} in the next half hour. Best to hold off on any snacks or carbs for now and let it come back down.`;
            }
            else
            {
                title = `Sugar is a bit high`;
                message = `Your sugar is ${reading} and ${trend.description}. It's above target so best to hold off on snacks for the moment and let it settle.`;
            }
        }
        else
        {
            return;
        }
    }

    if (title !== null && message !== null)
    {
        await SendNudge(title, message);
        nudgeState.lastNudgeSent = Date.now();
        nudgeState.lastNudgeCategory = category;
    }
}

async function Tick()
{
    try
    {
        // get the current glucose reading
        const reading = await GetLibreLinkUpData();

        log(`glucose reading received: ${reading} mmol/L. latest readings: [` + values.join(` mmol/L, `) + `]`);

        tryWriteGlucoseReading(reading);

        // remove the oldest glucose reading
        if (values.length >= NUMBER_OF_LAST_READINGS_TO_EXAMINE) values.shift();

        // store the latest glucose value
        values.push(reading);

        // check we've received enough glucose readings to examine for trends over time
        if (values.length >= NUMBER_OF_LAST_READINGS_TO_EXAMINE)
        {
            // check the last n stored glucose values (by NUMBER_OF_LAST_READINGS_TO_EXAMINE) against the critical glucose thresholds
            const dataset = values.slice(-NUMBER_OF_LAST_READINGS_TO_EXAMINE);

            // determine if the values in the evaluated sliding window are either all above, or all below a critical threshold
            const allBelowMinimum = dataset.every(val => val < GLUCOSE_CRITICAL_LOW);
            const allAboveMaximum = dataset.every(val => val > GLUCOSE_CRITICAL_HIGH);

            if (allBelowMinimum)
            {
                await AlarmMin(reading);
            }
            else if (allAboveMaximum)
            {
                await AlarmMax(reading);
            }
        }

        // nudge engine evaluation
        await evaluateNudge(reading, values);
    }
    catch (error)
    {
        log(error);

        if (libreLinkUpErrorCounter === 6)
        {
            try
            {
                await SendAlert(`GCM monitoring`, `Monitoring disrupted due to consecutive errors. ` + libreLinkUpLatestError);
            }
            catch (error)
            {
                throw error;
            }
        }

        // quietly fail this tick cycle
        return;
    }
}

async function main()
{
    log(`init`);
    log(`using librelinkup username: ${process.env.LIBRE_USERNAME}`);
    log(`using librelinkup password: ********* (${process.env.LIBRE_PASSWORD.length})`);
    log(`using librelinkup agent version: ${process.env.LIBRE_AGENT_VERSION}`);
    log(`using ntfy server: ${NTFY_SERVER}`);
    log(`using ntfy topics: alert=${process.env.NTFY_TOPIC_ALERT}, canary=${process.env.NTFY_TOPIC_CANARY}, nudge=${process.env.NTFY_TOPIC_NUDGE}`);
    log(`pushover alert channel: ${pusher ? `enabled` : `disabled`}`);
    log(`nudge engine: ${process.env.NTFY_TOPIC_NUDGE ? `enabled` : `disabled (no NTFY_TOPIC_NUDGE set)`}, target range: ${NUDGE_TARGET_LOW}-${NUDGE_TARGET_HIGH} mmol/L`);
    log(`insulin times: morning=${nudgeState.insulinTimes.morning || `not set`}, evening=${nudgeState.insulinTimes.evening || `not set`}`);

    if (process.env.NTFY_TOPIC_NUDGE && (!nudgeState.insulinTimes.morning || !nudgeState.insulinTimes.evening))
    {
        log(`nudge: warning - insulin times not fully configured, nudge engine will operate without insulin activity awareness`);
    }

    tryInitaliseDb();

    // periodic schedule to collect blood glucose readings and dispatch alarms when extended high or low trends are detected
    const monitor = cron.schedule(`*/${INTERVAL} * * * *`, async () => 
    {
        try
        {
            await Tick();
        }
        catch (error)
        {
            // die if we can't CRON tick without error
            console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
            monitor.stop();
            process.exit(1);
        }
    });

    // canary notifications to show the monitor is running
    const canary = cron.schedule(`${CANARY}`, async function ()
    {
        try
        {
            await SendCanary(`Heartbeat`, `Daily Canary`);
        }
        catch (error)
        {
            // die if we can't push daily canary notifications without error
            console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
            canary.stop();
            process.exit(1);
        }
    });

    try
    {
        log(`scheduler started`);

        await Tick();
        
        await SendCanary(`Heartbeat`, `Scheduler started, current glucose reading ${values[0]} mmol/L`);
    }
    catch (error)
    {
        // die if we can't push startup notification without error
        console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
        canary.stop();
        process.exit(1);
    }
}

main();