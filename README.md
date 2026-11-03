# BirdRail

BirdRail is a small Raspberry Pi web app for controlling a model railway locomotive connected to an Intellibox first generation command station via a USB serial adapter.

## Features

- Several saved locomotive controllers, selectable from a list (add, rename, delete)
- Each controller keeps its decoder ID, speed and direction
- Live speed slider, forward/reverse toggle, stop and emergency stop
- Interface settings (serial port, baud rate) in a separate dialog (gear icon)
- Controllers and interface settings are stored on the Pi in `data/settings.json`, so every browser sees the same setup and it survives restarts
- Track layout page (`/layout.html`, "Layout" tab) to draw a simple track plan on a square grid
- Works on phones and desktop browsers on the local network

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

The app talks to the Intellibox using the **P50X binary protocol (P50Xb)**. Every locomotive command is sent as an XLok command:

```text
0x58 ('X')  0x80  <addr low>  <addr high>  <speed>  <flags>
```

- speed: `0` = stop, `1` = emergency stop, `2..127` = speed (the UI slider 1–126 maps to 2–127)
- flags: bit 5 = direction (1 = forward), bit 4 = light (F0)
- the Intellibox answers with one status byte, `0x00` = OK

Serial settings: **8 data bits, 2 stop bits, no parity, RTS/CTS handshake**. The first-generation Intellibox supports 2400, 4800, 9600, 19200 and 38400 baud. The app defaults to 19200. Set the same rate in the Intellibox menu (interface settings) and set the interface protocol to P50X (or P50+P50X).

Environment variables:

- `SERIAL_BAUD_RATE` – baud rate (default `19200`)
- `SERIAL_RTSCTS=false` – turn off hardware handshake if your USB adapter does not wire CTS
- `INTELLIBOX_PROTOCOL=P50` – use the legacy 6050-compatible P50 protocol (addresses 1–80, 14 speed steps)

## App behavior

Moving the slider or changing the direction sends a command right away. Selecting another controller does not send anything; the locomotive is only driven once you move its slider. Interface settings saved in the dialog take precedence over `SERIAL_PORT` / `SERIAL_BAUD_RATE` on the next start. Delete `data/settings.json` to reset everything.

## Track layout editor

Open the **Layout** tab. Every element fills exactly one grid square and snaps to the grid.

The page has two modes, switched with **Edit / Run** in the toolbar (or the `E` key). `layout.html#edit` and `layout.html#run` open a mode directly.

**Run mode** shows only the layout. Click a turnout, crossover switch or signal to change it: turnouts switch between straight and diverging, the crossover switch between straight and turning routes, and signals between red and green. The active route is drawn bright, the other route dimmed. States are saved with the layout.

**Edit mode** — elements: Straight, Curve, Turnout left, Turnout right, Crossover switch (double slip), Crossing, Buffer stop, Signal.

- **Add:** pick an element in the element list, then click a square. Clicking the active element again (or pressing `R`) rotates it by 90°.
- **Move:** choose *Select / move*, then drag an element to another free square.
- **Remove:** select an element and press `Del` / *Remove*, or use the *Eraser* tool.
- **Rotate:** select an element and press `R` / *Rotate*.
- **Grid size:** change *Cols* / *Rows* (4–60 × 4–40). *Clear all* asks for a second click.

The layout is saved automatically in `data/settings.json`.

## File overview

- `server.js` – HTTP server and API endpoints
- `serialService.js` – serial device wrapper and packet builder
- `settingsStore.js` – stores controllers and interface settings in `data/settings.json`
- `public/index.html` – locomotive control page
- `public/layout.html`, `public/layout.js` – track layout editor
- `public/app.js` – browser-side control logic
- `public/styles.css` – styling
