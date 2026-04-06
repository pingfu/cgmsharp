const { InfluxDB, Point } = require('@influxdata/influxdb-client');

let writeApi = null;

function initialise(log)
{
    try
    {
        const url = process.env.INFLUX_DB_URL;
        const token = process.env.INFLUX_DB_TOKEN;
        const org = process.env.INFLUX_DB_ORG;
        const bucket = process.env.INFLUX_DB_BUCKET;

        if (url && token && org && bucket)
        {
            const client = new InfluxDB({ url: url, token: token });
            writeApi = client.getWriteApi(org, bucket);
            log(`database: influxdb state: configured for ${url}`);
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

async function writeGlucoseReading(glucoseReading, log)
{
    if (!writeApi) return;

    try
    {
        const point = new Point('glucose')
            .floatField('value', glucoseReading)
            .timestamp(new Date());

        writeApi.writePoint(point);
        await writeApi.flush();
    }
    catch (error)
    {
        console.error('Error writing to influxdb:', error);

        const errorMessage = error.message.toLowerCase();

        if (errorMessage.includes('timeout') || errorMessage.includes('connection'))
        {
            await writeApi.close();
            writeApi = null;

            console.log('Attempting to re-initalise influxdb client due to connection issue...');
            initialise(log);
        }
    }
}

module.exports = { initialise, writeGlucoseReading };
