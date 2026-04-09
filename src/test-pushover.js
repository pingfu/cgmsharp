require('dotenv').config();
const { isPushoverEnabled } = require('./notifications');
const pushover = require('pushover-notifications');

(async () => {
    console.log('Pushover enabled:', isPushoverEnabled());
    if (!isPushoverEnabled()) {
        console.error('PUSHOVER_USER and PUSHOVER_TOKEN must be set in .env');
        process.exit(1);
    }
    try {
        const pusher = new pushover({ user: process.env.PUSHOVER_USER, token: process.env.PUSHOVER_TOKEN });
        await new Promise((resolve, reject) => {
            pusher.send({ title: 'Test Alert', message: 'This is a test alarm from cgmsharp.', priority: 1 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        console.log('Test alert sent successfully.');
    } catch (err) {
        console.error('Failed to send:', err);
        process.exit(1);
    }
})();
