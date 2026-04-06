require(`dotenv`).config();

const cron = require(`node-cron`);
const moment = require(`moment`);
const { LibreLinkUpClient } = require(`@diakem/libre-link-up-api-client`);
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const CANARY = `0 9 * * *`; // cron expression governing how often canary notifications are dispatched
const INTERVAL = 10; // interval between obtaining new glucose readings (minutes)
const NUMBER_OF_LAST_READINGS_TO_EXAMINE = 6; // number of glucose readings to hold in memory and examine for extended periods of high or low values
const GLUCOSE_CRITICAL_LOW = 3.5; // Minimum threshold
const GLUCOSE_CRITICAL_HIGH = 22; // Maximum threshold

const NTFY_SERVER = `https://ntfy.sh`;

const NUDGE_ENABLED = false;
const NUDGE_TARGET_LOW = 7.0; // lower bound of "top half of green" (mmol/L)
const NUDGE_TARGET_HIGH = 10.0; // upper bound of target range (mmol/L)

let values = []; // store received glucose values
let libreLinkUpErrorCounter = 0;
let libreLinkUpLatestError = "";
let influxWriteApi;

let nudgeState = {
    insulinTimes: {
        morning: process.env.INSULIN_TIME_MORNING || null,
        evening: process.env.INSULIN_TIME_EVENING || null
    },
    lastNudgeSent: null
};

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

function SendAlert(title, message)
{
    log(`pushing alert '${title}': '${message}'`);
    return ntfySend(process.env.NTFY_TOPIC_ALERT, title, message, 5, `rotating_light,warning`);
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

async function evaluateNudge(reading, readings)
{
    if (!NUDGE_ENABLED) return;

    // placeholder logic for future implementation:
    // 1. calculate trend from readings via getTrend()
    // 2. determine time since last insulin injection using nudgeState.insulinTimes
    // 3. project where glucose will be in 30-60 minutes based on trend
    // 4. if projected value exits target range (NUDGE_TARGET_LOW - NUDGE_TARGET_HIGH), send nudge
    // 5. rate-limit nudges using nudgeState.lastNudgeSent (no more than one per 30 minutes)
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