const moment = require(`moment`);

function createAlarmEngine(config)
{
    var readings = [];

    async function evaluate(reading, sendAlert)
    {
        if (readings.length >= config.window) readings.shift();
        readings.push(reading);

        if (readings.length < config.window) return;

        var allBelowMinimum = readings.every(val => val < config.criticalLow);
        var allAboveMaximum = readings.every(val => val > config.criticalHigh);

        if (allBelowMinimum)
        {
            await sendAlert(`Extended Low Glucose Alarm`, `${moment().format(`YYYY-MM-DD HH:mm:ss`)} ${reading} mmol/L over last ${config.window} readings, ${config.interval} min intervals.`);
        }
        else if (allAboveMaximum)
        {
            await sendAlert(`Extended High Glucose Alarm`, `${moment().format(`YYYY-MM-DD HH:mm:ss`)} ${reading} mmol/L over last ${config.window} readings, ${config.interval} min intervals.`);
        }
    }

    return { evaluate };
}

module.exports = { createAlarmEngine };
