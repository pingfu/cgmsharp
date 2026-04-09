require('dotenv').config();

(async () => {
    const topic = process.env.NTFY_TOPIC_ALERT || process.env.NTFY_TOPIC_CANARY || process.env.NTFY_TOPIC_NUDGE;
    if (!topic) {
        console.error('At least one NTFY_TOPIC_* must be set in .env (NTFY_TOPIC_ALERT, NTFY_TOPIC_CANARY, or NTFY_TOPIC_NUDGE)');
        process.exit(1);
    }
    console.log('Using ntfy topic:', topic);
    try {
        const response = await fetch('https://ntfy.sh/' + topic, {
            method: 'POST',
            headers: {
                'Title': 'Test Notification',
                'Priority': '3',
                'Tags': 'test_tube'
            },
            body: 'This is a test notification from cgmsharp.'
        });
        if (!response.ok) {
            throw new Error('ntfy returned ' + response.status + ': ' + response.statusText);
        }
        console.log('Test notification sent successfully.');
    } catch (err) {
        console.error('Failed to send:', err);
        process.exit(1);
    }
})();
