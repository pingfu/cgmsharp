require(`dotenv`).config();

const cron = require(`node-cron`);
const moment = require(`moment`);
const { SendAlert, SendCanary, SendNudge, SendStartup, isPushoverEnabled } = require(`./notifications`);
const { createAlarmEngine } = require(`./alarms`);
const { createNudgeEngine } = require(`./nudge`);
const { createLibreLinkUpClient } = require(`./librelinkup`);
const influxdb = require(`./influxdb`);

const CANARY = `0 9 * * *`;
const INTERVAL = 10; // minutes between glucose readings

let lastReading = null; // most recent glucose value for canary messages

const libre = createLibreLinkUpClient({
    username: process.env.LIBRE_USERNAME,
    password: process.env.LIBRE_PASSWORD,
    clientVersion: process.env.LIBRE_AGENT_VERSION
});

const alarms = createAlarmEngine({
    window: 6,
    interval: INTERVAL,
    criticalLow: 3.5,
    criticalHigh: 22
});

const nudge = createNudgeEngine({
    interval: INTERVAL,
    insulinTimeMorning: process.env.INSULIN_TIME_MORNING,
    insulinTimeEvening: process.env.INSULIN_TIME_EVENING
});

function log(message)
{
    console.log(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + message);
}

async function Tick()
{
    try
    {
        var result = await libre.getReading();

        lastReading = result.value;

        if (result.recovered)
        {
            await SendAlert(`GCM monitoring`, `Error state cleared, monitoring resumed`);
        }

        log(`glucose reading received: ${result.value} mmol/L`);

        await influxdb.writeGlucoseReading(result.value, log);
        await alarms.evaluate(result.value, SendAlert);
        await nudge.evaluate(result.value, SendNudge);
    }
    catch (error)
    {
        log(error.message || error);

        if (error.fatal)
        {
            log(`fatal error, terminating process`);
            try { await SendAlert(`GCM monitoring`, error.message); } catch (e) { log(`Failed to send alert: ${e}`); }
            process.exit(1);
        }

        if (error.errorCount > 0 && error.errorCount % 6 === 0)
        {
            try
            {
                await SendAlert(`GCM monitoring`, `Monitoring disrupted due to consecutive errors. ` + error.message);
            }
            catch (e)
            {
                throw e;
            }
        }

        // quietly fail this tick cycle
        return;
    }
}

async function main()
{
    log(`init`);

    if (!process.env.LIBRE_USERNAME || !process.env.LIBRE_PASSWORD || !process.env.LIBRE_AGENT_VERSION)
    {
        log(`missing required environment variables: LIBRE_USERNAME, LIBRE_PASSWORD, and LIBRE_AGENT_VERSION must all be set`);
        process.exit(1);
    }

    log(`using librelinkup username: ${process.env.LIBRE_USERNAME}`);
    log(`using librelinkup password: ********* (${process.env.LIBRE_PASSWORD.length})`);
    log(`using librelinkup agent version: ${process.env.LIBRE_AGENT_VERSION}`);
    log(`using ntfy topics: alert=${process.env.NTFY_TOPIC_ALERT}, canary=${process.env.NTFY_TOPIC_CANARY}, nudge=${process.env.NTFY_TOPIC_NUDGE}`);
    log(`pushover alert channel: ${isPushoverEnabled() ? `enabled` : `disabled`}`);
    log(`nudge engine: ${process.env.NTFY_TOPIC_NUDGE ? `enabled` : `disabled (no NTFY_TOPIC_NUDGE set)`}`);
    log(`insulin times: morning=${nudge.state.insulinTimes.morning || `not set`}, evening=${nudge.state.insulinTimes.evening || `not set`}`);

    if (process.env.NTFY_TOPIC_NUDGE && (!nudge.state.insulinTimes.morning || !nudge.state.insulinTimes.evening))
    {
        log(`nudge: warning - insulin times not fully configured, nudge engine will operate without insulin activity awareness`);
    }

    influxdb.initialise(log);

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

    const canary = cron.schedule(`${CANARY}`, async function ()
    {
        try
        {
            var readingStr = lastReading !== null ? `${lastReading} mmol/L` : `no reading available`;
            await SendCanary(`Heartbeat`, `Daily Canary. Last reading: ${readingStr}`);
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

        var readingStr = lastReading !== null ? `${lastReading} mmol/L` : `no reading available`;
        await SendStartup(`Heartbeat`, `Scheduler started. Current reading: ${readingStr}`);
    }
    catch (error)
    {
        console.error(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + error.message);
        canary.stop();
        process.exit(1);
    }
}

main();
