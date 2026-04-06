const moment = require(`moment`);
const pushover = require(`pushover-notifications`);

function log(message)
{
    console.log(moment().format(`YYYY-MM-DD HH:mm:ss`) + `: ` + message);
}

const NTFY_SERVER = `https://ntfy.sh`;

let pusher = (process.env.PUSHOVER_USER && process.env.PUSHOVER_TOKEN)
    ? new pushover({ user: process.env.PUSHOVER_USER, token: process.env.PUSHOVER_TOKEN })
    : null;

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
    return ntfySend(process.env.NTFY_TOPIC_NUDGE, title, message, 3, `thought_balloon`);
}

function isPushoverEnabled()
{
    return pusher !== null;
}

module.exports = { SendAlert, SendCanary, SendNudge, isPushoverEnabled };
