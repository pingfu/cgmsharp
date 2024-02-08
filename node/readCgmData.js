require(`dotenv`).config();

const cron = require(`node-cron`);
const moment = require(`moment`);
const pushover = require(`pushover-notifications`);

const { LibreLinkUpClient } = require(`@diakem/libre-link-up-api-client`);

const CANARY = `0 9 * * *`; // cron expression governing how often canary notifications are dispatched
const INTERVAL = 10; // interval between obtaining new glucose readings (minutes)
const GLUCOSE_READINGS_WINDOW_SIZE = 10; // total number of glucose readings to hold in memory, size of sliding window (e.g. 10)
const NUMBER_OF_LAST_READINGS_TO_EXAMINE = 3; // number of glucose readings to examine when looking for extended period of high or low values
const GLUCOSE_CRITICAL_LOW = 3.5; // Minimum threshold
const GLUCOSE_CRITICAL_HIGH = 22; // Maximum threshold

let values = []; // store received glucose values

let pusher = new pushover({
    user: process.env.PUSHOVER_USER,
    token: process.env.PUSHOVER_TOKEN,
});

function log(message)
{
    console.log(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + message);
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

        return response.current.value; //return Math.random() * 100;
    }
    catch (error)
    {
        throw new Error(`LibreLinkUpClient client error: ` + error);
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
    // get the current glucose reading
    const reading = await GetLibreLinkUpData();

    // remove the oldest glucose reading
    if (values.length >= GLUCOSE_READINGS_WINDOW_SIZE) values.shift(); 

    // store the latest glucose value
    values.push(reading);

    log(`glucose reading received: ${reading} mmol/L. latest readings: [` + values.join(` mmol/L, `) + `]`);

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

async function main()
{
    log(`init`);
    log(`using librelinkup username: ${process.env.LIBRE_USERNAME}`);
    log(`using librelinkup password: ********* (${process.env.LIBRE_PASSWORD.length})`);

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
    }
    catch (error)
    {
        console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
        process.exit(1);
    }
}

main();