const { LibreLinkUpClient } = require('@diakem/libre-link-up-api-client');

async function main()
{
    const { readRaw } = LibreLinkUpClient(
        {
            username: 'user@email.com', 
            password: 'password'
        });

    const response = await readRaw();

    console.log(response);
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
