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

let values = []; // store received glucose values
let libreLinkUpErrorCounter = 0;
let libreLinkUpLatestError = "";
let influxWriteApi;

let pusher = new pushover({
    user: process.env.PUSHOVER_USER,
    token: process.env.PUSHOVER_TOKEN,
});

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
        const { read } = LibreLinkUpClient(
            {
                username: process.env.LIBRE_USERNAME, 
                password: process.env.LIBRE_PASSWORD,
                version: process.env.LIBRE_VERSION
            });

        const response = await read();

        // reset LibreLinkupError counter to zero after a successful read() operation
        if (libreLinkUpErrorCounter > 0)
        {
            PushNotification(`GCM monitoring`, `Error state cleared, monitoring resumed`);

            libreLinkUpErrorCounter = 0;
            libreLinkUpLatestError = ``;
        }

        return response.current.value;
    }
    catch (error)
    {
        var msg = `LibreLinkUpClient ` + error;
        libreLinkUpErrorCounter = libreLinkUpErrorCounter++;
        libreLinkUpLatestError = msg;
        throw new Error(msg);
    }
}

function AlarmMin(currentReading) {
    PushAlarm(`Extended Low Glucose Alarm`, `${moment().format(`YYYY-MM-DD HH:mm:ss`)} ${currentReading} mmol/L over last ${NUMBER_OF_LAST_READINGS_TO_EXAMINE} readings, ${INTERVAL} min intervals.`);
}

function AlarmMax(currentReading) {
    PushAlarm(`Extended High Glucose Alarm`, `${moment().format(`YYYY-MM-DD HH:mm:ss`)} ${currentReading} mmol/L over last ${NUMBER_OF_LAST_READINGS_TO_EXAMINE} readings, ${INTERVAL} min intervals.`);
}

function PushNotification(title, message) {
    log(`pushing notification '${title}': '${moment().format(`YYYY-MM-DD HH:mm:ss`)} ${message}'`);

    var msg = {
        title: title,
        message: message,
        priority: -1, // low priority, no sounds or vibrations
    };

    pusher.send(msg, function(error)
    {
        if (error) { throw error; }
    });
}

function PushAlarm(title, message) {
    log(`pushing alarm '${title}': '${message}'`);

    var msg = {
        title: title,
        message: message,
        priority: 2, // emergency priority code (require user acknowledgement)
        retry: 30, // retry to get user acknowledgement every n (seconds)
        expire: 300 // give up attempting to solicit user acknowledgment after n (seconds)
    };

    pusher.send(msg, function(error)
    {
        if (error) { throw error; }
    });
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
                AlarmMin(reading);
            }
            else if (allAboveMaximum)
            {
                AlarmMax(reading);
            }
        }
    }
    catch (error)
    {
        log(error);

        if (libreLinkUpErrorCounter === 6)
        {
            PushNotification(`GCM monitoring`, `Monitoring disrupted due to consecutive errors. ` + libreLinkUpLatestError);
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
            console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
            monitor.stop();
            process.exit(1);
        }
    });

    // canary notifications to show the monitor is running
    const canary = cron.schedule(`${CANARY}`, function ()
    {
        try 
        {
            PushNotification(`Heartbeat`, `Daily Canary 🐦`);
        }
        catch (error)
        {
            console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
            canary.stop();
            process.exit(1);
        }
    });

    try
    {
        log(`scheduler started`);

        await Tick();
        
        PushNotification(`Heartbeat`, `Scheduler started, current glucose reading ${values[0]} mmol/L 🐦`);
    }
    catch (error)
    {
        console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
        process.exit(1);
    }
}

main();