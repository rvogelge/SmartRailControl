# BirdRail

BirdRail is a small Raspberry Pi web app for controlling a model railway locomotive connected to an Intellibox first generation command station via a USB serial adapter.

## Features

- Enter a decoder ID
- Set the speed with a slider
- Stop the locomotive
- Choose forward or reverse
- Use the web interface from a browser on the local network

## Requirements

- Raspberry Pi running a recent Linux distribution
- Node.js 18 or later
- USB-to-serial adapter connected to the Intellibox serial interface
- Serial port exposed as `/dev/ttyUSB0` by default

## Install

```bash
cd ~/bird_rail
npm install
```

## Run

```bash
npm start
```

Then open the app in a browser at:

```text
http://<raspberry-pi-ip>:3000
```

## Serial configuration

If the adapter is not exposed as `/dev/ttyUSB0`, set the port by environment variable:

```bash
SERIAL_PORT=/dev/ttyAMA0 npm start
```

The app is configured for a LocoNet-style serial interface and uses a 57600 baud serial connection. This matches the setup where the USB adapter is connected to the Intellibox serial side rather than sending raw DCC packets directly.

## App behavior

The web page sends a command to the server on each change. The server validates the decoder ID and transmits the command to the configured serial connection.

## File overview

- `server.js` – HTTP server and API endpoints
- `serialService.js` – serial device wrapper and packet builder
- `public/index.html` – web UI
- `public/app.js` – browser-side control logic
- `public/styles.css` – styling
