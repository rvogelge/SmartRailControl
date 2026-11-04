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

If the port differs, use the actual port name instead. The Intellibox (1st generation) serial interface supports 2400–38400 baud with 8N2 and RTS/CTS handshake. BirdRail defaults to 19200 baud; set the same value in the Intellibox interface menu, with the protocol set to P50X.

## 5. Start the app

Run the application with the port set explicitly:

```bash
SERIAL_PORT=/dev/ttyUSB0 SERIAL_BAUD_RATE=19200 npm start
```

If the port is `/dev/ttyAMA0`, use:

```bash
SERIAL_PORT=/dev/ttyAMA0 SERIAL_BAUD_RATE=19200 npm start
```

The server starts on port 3000 by default.

## 5a. Deploy with Podman

If you want to run BirdRail in a Podman container, build the image from the project directory and pass through the USB serial device from the host.

Create a `Containerfile` in the project root:

```dockerfile
FROM docker.io/library/node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
```

Then build the image explicitly from that file and verify it exists before starting the container:

```bash
podman build -f Containerfile -t birdrail .
podman images | grep birdrail
```

If the image is present, start the container:

```bash
podman run --rm -d \
  --name birdrail \
  -p 3000:3000 \
  --device /dev/ttyUSB0:/dev/ttyUSB0 \
  -e PORT=3000 \
  -e SERIAL_PORT=/dev/ttyUSB0 \
  birdrail
```

If your adapter uses a different serial path, replace `/dev/ttyUSB0` with the proper device such as `/dev/ttyAMA0` or a `/dev/serial/by-id/...` path.

### Layout-only Podman deployment for testing the UI

If you only want to test the layout and interface behavior in Podman without any USB serial hardware, disable the serial interface in the container:

```bash
podman build -f Containerfile -t birdrail .
podman run --rm -d \
  --name birdrail-layout \
  -p 3000:3000 \
  -e PORT=3000 \
  -e BIRDRAIL_SERIAL_DISABLED=true \
  birdrail
```

This starts the web app in a layout-only mode. The page loads normally, but any locomotive command is rejected because no serial device is configured. This is useful for testing the interface, layout, and browser interactions without a USB adapter on the host.

> If Podman tries to pull `docker.io/library/birdrail:latest`, the local image was not built successfully yet. Fix the build error first, then rerun the `podman run` command.

If you see `Error: stat /dev/ttyUSB0: no such file or directory`, the host does not have that serial device at that exact path. Check the device on the host before starting the container:

```bash
ls -l /dev/ttyUSB* /dev/ttyAMA* /dev/serial/by-id/*
```

If no device appears, reconnect the USB serial adapter or use the actual path reported by the system, such as `/dev/ttyAMA0` or a symlink under `/dev/serial/by-id`.

For Podman on macOS, note that USB serial devices are usually not directly exposed from the Mac host into the Podman VM. In practice, a reliable Podman deployment of BirdRail is best on a Linux host with direct access to the USB serial adapter.

If you are using a rootless Podman setup, make sure the user has access to the serial device and that the device node is available inside the container. The app should then be reachable at:

```text
http://localhost:3000
```

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

### Command sent but no locomotive response

When the app is running, the terminal shows each transmitted and received serial packet in hex. Look for lines starting with `[Intellibox TX]` and `[Intellibox RX]`.

If a command appears in TX but there is no RX traffic, the adapter, port, or Intellibox serial wiring is likely not communicating correctly. If the TX bytes are wrong or missing, check the port name, baud rate, and decoder ID before retrying.

## Notes

This app is intended for a Raspberry Pi connected to an Intellibox command station through a USB serial adapter. The serial interface is configured in the application settings and the command generation logic lives in the serial service module.

The interface is designed for a simple local control workflow and can be adapted further for additional locomotive functions or a more advanced dashboard.
