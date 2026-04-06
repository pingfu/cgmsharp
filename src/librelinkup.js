const { LibreLinkUpClient } = require(`@diakem/libre-link-up-api-client`);

function createLibreLinkUpClient(config)
{
    var errorCounter = 0;
    var latestError = ``;

    async function getReading(log, sendAlert)
    {
        try
        {
            const { read } = LibreLinkUpClient({
                username: config.username,
                password: config.password,
                clientVersion: config.clientVersion
            });

            const response = await read();

            // reset error counter after a successful read
            if (errorCounter > 0)
            {
                try
                {
                    await sendAlert(`GCM monitoring`, `Error state cleared, monitoring resumed`);
                }
                catch (error)
                {
                    throw error;
                }

                errorCounter = 0;
                latestError = ``;
            }

            return response.current.value;
        }
        catch (error)
        {
            var msg = `LibreLinkUpClient ` + error;

            // HTTP 401 from LibreLinkUp is treated as fatal — usually means Abbott's EULA
            // needs re-accepting in the LibreLinkUp mobile app
            if (error.isAxiosError && error.response && error.response.status === 401)
            {
                var fatal = "non-recoverable error (" + error + ") terminating process.";

                log(fatal);

                try
                {
                    await sendAlert(`GCM monitoring`, fatal);
                }
                catch (notificationError)
                {
                    log(`Failed to send push notification: ${notificationError}`);
                }

                process.exit(1);
            }

            errorCounter++;
            latestError = msg;

            throw new Error(msg);
        }
    }

    function getErrorCounter() { return errorCounter; }
    function getLatestError() { return latestError; }

    return { getReading, getErrorCounter, getLatestError };
}

module.exports = { createLibreLinkUpClient };
