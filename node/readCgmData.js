require('dotenv').config();

const { LibreLinkUpClient } = require('@diakem/libre-link-up-api-client');

async function main()
{
    //console.log('Username', process.env.LIBRE_USERNAME);
    //console.log('Password', process.env.LIBRE_PASSWORD);

    //const { readRaw } = LibreLinkUpClient();
    //const response = await readRaw();

    const { read } = LibreLinkUpClient(
        {
            username: process.env.LIBRE_USERNAME, 
            password: process.env.LIBRE_PASSWORD,
            version: process.env.LIBRE_VERSION
        });

    const response = await read();

    console.log(response.current);
}

main().catch(error => 
{
    if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.error('Error Data:', error.response.data);
        console.error('Error Status:', error.response.status);
        console.error('Error Headers:', error.response.headers);
    } else if (error.request) {
        // The request was made but no response was received
        console.error('Error Request:', error.request);
    } else {
        // Something happened in setting up the request that triggered an Error
        console.error('Error Message:', error.message);
    }
    console.error('Error Config:', error.config);
});


/* see also
    https://github.com/timoschlueter/nightscout-librelink-up
    https://github.com/DiaKEM/libre-link-up-api-client
    https://gist.github.com/khskekec/6c13ba01b10d3018d816706a32ae8ab2
    https://github.com/creepymonster/GlucoseDirect

    https://httptoolkit.com/
*/