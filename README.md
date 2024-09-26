# cgmsharp

## Install dependencies

```
npm install
```

Or

```
npm i github:marcbarry/libre-link-up-api-client
npm i @influxdata/influxdb-client
npm i @babel/runtime
npm i dotenv
```

## Configure environment variables

```
$ touch .env
NODE_ENV=production

LIBRE_USERNAME=your_libre_username
LIBRE_PASSWORD=your_libre_password
LIBRE_AGENT_VERSION=4.9.0

PUSHOVER_USER=your_pushover_user
PUSHOVER_TOKEN=your_pushover_token

INFLUX_DB_URL=your_INFLUX_DB_url
INFLUX_DB_TOKEN=your_INFLUX_DB_token
INFLUX_DB_ORG=your_INFLUX_DB_org
INFLUX_DB_BUCKET=your_INFLUX_DB_bucket
```

## Run gcm-monitor

### Node.js

```
$ cd ./src
$ node app.js
```

### Docker Compose

With environment variables

```
version: '3.8'
services:
  app:
    image: ghcr.io/pingfu/cgmsharp/cgmsharp:latest
    container_name: cgmsharp
    environment:
      - NODE_ENV=production
      - LIBRE_USERNAME=your_libre_username
      - LIBRE_PASSWORD=your_libre_password
      - LIBRE_AGENT_VERSION=4.9.0
      - PUSHOVER_USER=your_pushover_user
      - PUSHOVER_TOKEN=your_pushover_token
      - INFLUX_DB_URL=your_INFLUX_DB_url
      - INFLUX_DB_TOKEN=your_INFLUX_DB_token
      - INFLUX_DB_ORG=your_INFLUX_DB_org
      - INFLUX_DB_BUCKET=your_INFLUX_DB_bucket
```

## See also

- https://github.com/timoschlueter/nightscout-librelink-up
- https://github.com/DiaKEM/libre-link-up-api-client
- https://gist.github.com/khskekec/6c13ba01b10d3018d816706a32ae8ab2
- https://github.com/creepymonster/GlucoseDirect
- https://httptoolkit.com/

## Troubleshooting

Occasionally Abbott update their [End User License Agreement](https://api.libreview.io/document/toullu?lang=en-gb), which until accepted (using the LibreLinkUp app) can cause the API to mysteriously start returning HTTP `401` error codes. If this happens you'll need to logout of all of devices and then log back in again using the LibreLinkUp mobile app in order for you to be presented with an option to accept the latest terms. Once accepted, the `401` responses from the API should go away.