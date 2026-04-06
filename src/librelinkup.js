const { LibreLinkUpClient } = require(`@diakem/libre-link-up-api-client`);

function createLibreLinkUpClient(config)
{
    var errorCounter = 0;

    async function getReading()
    {
        try
        {
            const { read } = LibreLinkUpClient({
                username: config.username,
                password: config.password,
                clientVersion: config.clientVersion
            });

            const response = await read();

            var wasInError = errorCounter > 0;
            errorCounter = 0;

            return { value: response.current.value, recovered: wasInError };
        }
        catch (error)
        {
            errorCounter++;

            // HTTP 401 from LibreLinkUp is treated as fatal — usually means Abbott's EULA
            // needs re-accepting in the LibreLinkUp mobile app
            var isFatal = error.isAxiosError && error.response && error.response.status === 401;

            throw { message: `LibreLinkUpClient ` + error, fatal: isFatal, errorCount: errorCounter };
        }
    }

    return { getReading };
}

module.exports = { createLibreLinkUpClient };
