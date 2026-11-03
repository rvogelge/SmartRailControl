# BirdRail installation guide

This document explains how to install and run the BirdRail Raspberry Pi web app for controlling a model railway locomotive through an Intellibox first-generation command station connected via a USB serial adapter.

## Requirements

- Raspberry Pi running Raspberry Pi OS or another Linux distribution
- Node.js 20 or newer
- Access to the USB serial adapter connected to the command station
- A browser on the same network or on the Raspberry Pi itself

## 1. Install Node.js

Run the following commands on the Raspberry Pi:

```bash
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 2. Download the project from GitHub

Clone the repository directly to the Raspberry Pi:

```bash
cd ~
git clone https://github.com/rvogelge/bird_rail.git
cd bird_rail
```

If you already have the project files in a folder, you can copy them instead. In that case, make sure you are inside the project directory before continuing.

## 3. Install dependencies

```bash
npm install
```

## 4. Check the serial port

Find the serial interface for the USB adapter:

```bash
ls /dev/ttyUSB*
ls /dev/ttyAMA*
ls /dev/serial/by-id/*
```

The usual port is:

```bash
/dev/ttyUSB0
```

If the port differs, use the actual port name instead. The Intellibox serial interface is normally configured for 57600 baud unless your adapter or setup is non-standard.

## 5. Start the app

Run the application with the port set explicitly:

```bash
SERIAL_PORT=/dev/ttyUSB0 SERIAL_BAUD_RATE=57600 npm start
```

If the port is `/dev/ttyAMA0`, use:

```bash
SERIAL_PORT=/dev/ttyAMA0 SERIAL_BAUD_RATE=57600 npm start
```

The server starts on port 3000 by default.

## 6. Open the web interface

From a browser on the same local network, open:

```text
http://<raspberry-pi-ip>:3000
```

Example:

```text
http://192.168.1.50:3000
```

## 7. Use the app

Once the page opens, you can:

- enter the locomotive decoder ID
- select forward or reverse direction
- adjust the speed with the slider
- stop the locomotive immediately

## 8. Troubleshooting

### The app shows offline

This normally means the serial device cannot be opened.

Check:

```bash
ls -l /dev/ttyUSB0
```

If the port is not present, reconnect the USB adapter and check again.

### No serial device found

Try:

```bash
dmesg | tail -n 50
```

This helps confirm whether the system detected the USB serial adapter.

### Different port name

If the adapter appears under a different path, start the app with that value:

```bash
SERIAL_PORT=/dev/ttyS0 npm start
```

## Notes

This app is intended for a Raspberry Pi connected to an Intellibox command station through a USB serial adapter. The serial interface is configured in the application settings and the command generation logic lives in the serial service module.

The interface is designed for a simple local control workflow and can be adapted further for additional locomotive functions or a more advanced dashboard.
