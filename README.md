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

**Run mode** shows only the layout and operates the real accessories: every click sends the matching command to the Intellibox (see *Switching accessories* below). Click a turnout, crossover switch, signal or uncoupler to operate it: turnouts switch between straight and diverging, the crossover switch between straight and turning routes, and signals between red and green. The active route is drawn bright, the other route dimmed. States are saved with the layout.

**Edit mode** — elements: Straight, Diagonal, Curve 45° left/right, Curve 90° R1, Curve 90° R2 (parallel), Turnout left/right, Three-way turnout, Crossover switch (double slip), Crossing 45°, Crossing 90°, Buffer stop, Signal, Contact track, Uncoupler.

**Parallel curves:** *Curve 90° R2* has radius 150 and takes a 2×2 block, of which it uses three squares. Put a *Curve 90° R1* into the free inner square (same rotation) and the two curves run exactly one track apart — use this for parallel loops.

**Decoder addresses:** every element with an action — turnouts, three-way turnout, crossover switch, signals, uncouplers and contact tracks — has decoder address fields (1–2048). Select the element in edit mode; the fields appear above the grid (double-click an element to jump there). Three-way turnouts have two drives, so they get two addresses; the crossover switch has only two states (straight / turning) and needs one address. The address is shown as a badge on the element; `?` marks a missing address. For contact tracks the number is the feedback contact.

**Address check:** an address may only be used once. Turnouts, signals and uncouplers share the accessory address range; contact tracks use the separate feedback contact numbers. Entering an address that is already taken is refused with a message naming the element that uses it, and the server refuses to save duplicates. *Check* lists all conflicts and elements without address — click an entry to select the elements. Conflicting elements are outlined in red.

Track geometry: elements connect at the edge midpoints of a square and, for 45° track, at its corners. Turnouts branch off at 45° into a corner, the crossover switch crosses a straight track with a 45° diagonal. Use *Diagonal* and the 45° curves to continue a branch: two 45° curves (via a corner) make a 90° turn.

- **Add:** pick an element in the element list, then click a square. Clicking the active element again (or pressing `R`) rotates it by 90°.
- **Select:** choose *Select / move* and click an element. `Shift`/`Ctrl`/`⌘`-click adds or removes elements; dragging on an empty area draws a selection frame; `Ctrl`/`⌘`+`A` selects everything.
- **Move:** drag a selected element — all selected elements move together — or nudge the selection with the arrow keys. Moves that would overlap other elements or leave the grid are refused.
- **Remove:** select elements and press `Del` / *Remove*, or use the *Eraser* tool.
- **Rotate:** select elements and press `R` / *Rotate*; a group rotates as a whole by 90°.
- **Zoom:** `−` / `+` / *Fit* in the toolbar, the keys `-` `+` `0`, or `Ctrl`/`⌘` + mouse wheel. *Fit* scales the layout to the screen and follows window size changes. The zoom is remembered per browser.
- **Grid size:** change *Cols* / *Rows* (4–60 × 4–40). *Clear all* asks for a second click.

The layout is saved automatically in `data/settings.json`.

## Switching accessories

In run mode, switching a turnout, three-way turnout, crossover switch or signal, or triggering an uncoupler, sends the command to the decoder address(es) stored for that element. The browser only tells the server which element changed; the server looks up the addresses in the saved layout.

- Protocol: P50X `XTrnt` — `0x58 0x90 <address low> <flags | address high>`, bit 7 = green, bit 6 = output on. With `INTELLIBOX_PROTOCOL=P50` the legacy commands `33`/`34` + address and `32` (off) are used.
- Every output is switched on and, after `ACCESSORY_SWITCH_TIME_MS` (default 250 ms), off again — like pressing a key on the keyboard. Commands are sent one after another.
- Green = straight / go, red = diverging / stop:

| Element | State → outputs |
|---|---|
| Turnout left/right | straight → green, diverging → red |
| Signal | go → green, stop → red |
| Three-way turnout | straight → drive 1 green, drive 2 green · left → drive 2 green, then drive 1 red · right → drive 1 green, then drive 2 red |
| Crossover switch | straight → green, turning → red |
| Uncoupler | short pulse on green |

The new state is saved even if the command could not be sent (no address, serial port not open); the status line then says *not sent* and why. Each command and the Intellibox reply are logged in the terminal (`[Intellibox TX]` / `[Intellibox RX]`). Contact tracks are inputs and send nothing.

## File overview

- `server.js` – HTTP server and API endpoints
- `serialService.js` – serial device wrapper and packet builder
- `settingsStore.js` – stores controllers and interface settings in `data/settings.json`
- `public/index.html` – locomotive control page
- `public/layout.html`, `public/layout.js` – track layout editor
- `public/trackCatalog.js` – element types, states, addresses and footprints (shared by browser and server)
- `public/app.js` – browser-side control logic
- `public/styles.css` – styling
