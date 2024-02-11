# cgmsharp



## Install dependencies

```
npm install
```

Or

```
npm i github:marcbarry/libre-link-up-api-client
npm i @babel/runtime
npm i dotenv
```

## Configure environment variables

```
$ touch .env
LIBRE_USERNAME=email
LIBRE_PASSWORD=secret
LIBRE_VERSION=4.9.0
PUSHOVER_USER=secret
PUSHOVER_TOKEN=secret
```

## Run gcm-monitor

### Node.js

```
node readCgmData.js
```

### Docker Compose

With environment variables

```
version: '3.8'
services:
  app:
    container_name: gcm-monitor
    build: .
    environment:
      - LIBRE_USERNAME=your_libre_username
      - LIBRE_PASSWORD=your_libre_password
      - LIBRE_VERSION=4.9.0
      - PUSHOVER_USER=your_pushover_user
      - PUSHOVER_TOKEN=your_pushover_token
      - NODE_ENV=production
```

With .env file

```
version: '3.8'
services:
  app:
    container_name: gcm-monitor
    build: .
    env_file: 
      - ./src/.env
    environment:
      - NODE_ENV=production
```


## See also

- https://github.com/timoschlueter/nightscout-librelink-up
- https://github.com/DiaKEM/libre-link-up-api-client
- https://gist.github.com/khskekec/6c13ba01b10d3018d816706a32ae8ab2
- https://github.com/creepymonster/GlucoseDirect
- https://httptoolkit.com/