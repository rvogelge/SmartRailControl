# SmartRailControl

SmartRailControl is a small Raspberry Pi web app for controlling a model railway locomotive connected to an Intellibox first generation command station via a USB serial adapter.

## Features

- One page with a burger menu (top right): **Settings**, **Layout** (edit the track plan), **Run** (operate it), **Locomotives** and **Decoder test**
- Locomotive control window that appears in run mode: locomotive dropdown, vertical speed slider (shown as % of the locomotive's max speed), light (F0) and function buttons F1–F4, direction, stop and emergency stop; it can be dragged anywhere and closed
- Locomotives page (menu → *Locomotives*): list of locomotives with name, decoder address and max speed (highest speed step of 126 the throttle sends); add, edit and remove. Renaming or removing a locomotive updates the block it occupies
- Settings dialog: serial port and baud rate, user interface language (English / Deutsch), data location
- Controllers, layout, rules and settings are stored on the Pi in one file (default `data/settings.json`, folder selectable), so every browser sees the same setup and it survives restarts
- Track layout editor to draw a simple track plan on a square grid
- Decoder test page (menu → *Decoder test*): switch any accessory address red/green to find out which turnout, signal or uncoupler it drives, see which layout element uses it, and keep a note per address. Accessory decoders only receive commands, so the Intellibox cannot list which ones are connected.
- Logic rules editor in a separate window ("if contact 5 turns on, set turnout 12 to diverging"), run by the server
- Block signalling: a contact track can start a block (edit mode → *Block start* → right / left; an arrow in the symbol shows the direction). A block runs in arrow direction up to the next block-start contact or turnout (turnouts belong to no block; a train leaving over a turnout still frees its block and takes its name along when it reaches the next block-start contact). When the contact fires, its block turns light red as occupied, the block the train came from becomes free, and the locomotive name moves along. If several occupied blocks lead into it, the one whose locomotive is running (speed > 0) is freed, whatever the turnout positions; a locomotive can be in one block only; it is shown on the middle straight track of the block. In run mode, click a track of a block to occupy it with a locomotive, as unknown train, or to free it.
- Blocks page (menu → *Blocks*): every block found from the block-start contacts gets a stable number (B1, B2, …), with its start contact, the blocks it leads to and its occupancy. *Fahrstraßen* group blocks into a fixed sequence (optionally a loop) and show whether consecutive blocks are connected by track. Automated operation of a Fahrstraße follows one locomotive: whenever it is in a block of the sequence, the turnouts on the way to the next block are set if that block is free; if it is occupied, the locomotive is stopped in its block (restart it with the throttle once the block is free). At the end of a sequence, or if the locomotive leaves it, the locomotive is stopped
- Actor decoder addresses (turnouts, signals, uncouplers) can be marked *inverted* when a drive switches the opposite way
- Works on phones and desktop browsers on the local network

## Requirements

- Raspberry Pi running a recent Linux distribution
- Node.js 18 or later
- USB-to-serial adapter connected to the Intellibox serial interface
- Serial port exposed as `/dev/ttyUSB0` by default

## Install

```bash
cd ~/SmartRailControl
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

## Settings dialog

Open it with **Settings** in the burger menu (or click the status chip).

- **Interface:** serial port and baud rate, applied with *Apply interface*.
- **Language:** English or Deutsch. The choice is saved on the server, so it applies to all pages and all browsers; other open windows (layout, logic rules) switch right away. Error messages that come from the server stay in English.
- **Data storage:** shows the data file and whether it is persistent:
  - *on disk* — normal installation,
  - *on a mounted volume* — container with a volume, survives re-creating the container,
  - *inside the container only* — lost when the container is removed (shown in orange),
  - *in memory (tmpfs)* — lost on restart.

  *Change folder…* opens a folder browser on the server. Pick a folder or type a new path (it is created) and click *Use this folder*: the current data is copied there and used from then on; the old file stays where it was. If the folder already contains SmartRailControl data, you choose between *Load the data from there* (the page reloads with that data) and *Overwrite it with the current data*.

  The chosen folder is remembered in `data/location.json` next to the app. `SMARTRAILCONTROL_SETTINGS_FILE` overrides everything; the dialog then shows the path but cannot change it.

**Containers:** to keep the data, mount a volume — either at `/app/data` (then the default folder is already persistent), or anywhere else and choose it in the dialog. In the second case `/app/data` must be persistent too, because that is where the choice is remembered; the dialog warns if it is not. The simplest setup is:

```bash
podman run -d --name smartrailcontrol -p 3000:3000 -v smartrailcontrol-data:/app/data smartrailcontrol
```

## App behavior

Choose **Run** in the menu (or press `E`) and the locomotive control window appears over the layout; drag it by its title bar, close it with ✕ and bring it back with *🚂 Loco control* in the toolbar. Pick the locomotive in the dropdown at the top; ✎ next to it edits its name and decoder address and adds or deletes locomotives.

Moving the slider or changing the direction sends a command right away. F1–F4 switch the locomotive's functions (P50X `XFunc`, legacy P50 function command; F5–F8 are sent as off). Selecting another locomotive does not send anything; the locomotive is only driven once you move its slider. Interface settings saved in the dialog take precedence over `SERIAL_PORT` / `SERIAL_BAUD_RATE` on the next start. Delete the data file (see *Settings dialog → Data storage*) to reset everything.

## Track layout editor

Choose **Layout** in the menu. Every element fills exactly one grid square and snaps to the grid.

The page has two modes, switched with **Layout / Run** in the menu, **Edit / Run** in the toolbar or the `E` key. `/#edit` and `/#run` open a mode directly (`/layout.html` forwards to `/#edit`).

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
- **Zoom:** `−` / `+` / *Fit* in the toolbar, the keys `-` `+` `0`, or `Ctrl`/`⌘` + mouse wheel. The grid always fills the layout pane: zooming out shows more squares, zooming in fewer and larger ones (the pane scrolls if the placed elements no longer fit). *Fit* zooms so that all placed elements fill the pane and follows window size changes. The zoom is remembered per browser.
- **Grid size:** follows the zoom (see above); only the area the elements use is saved. *Clear all* asks for a second click.

The layout is saved automatically in `data/settings.json`.

## Logic rules

Click **⚡ Logic rules** in the layout toolbar to open the rules editor in a separate window (`/rules.html`). The left side lists every device of the layout — contact tracks (sensors), turnouts, signals and uncouplers — with decoder address, position, live state and how many rules use it. Click a device to show only the rules that use it.

A rule reads like a sentence:

```text
WHEN    Contact track #5 turns on (occupied)
AND IF  Signal #20 is stop (red)            ← optional, any number, all must hold
THEN    set Turnout left #12 to diverging   after 0 s
AND THEN set Signal #20 to go (green)       after 2 s
```

- **Trigger:** a contact track turning *on* (occupied) or *off* (free). A rule fires only when the contact changes.
- **Conditions:** the current state of a turnout, signal or other contact track.
- **Actions:** switch a turnout, three-way turnout, crossover switch or signal, or trigger an uncoupler. Actions run in order; the delay is the wait before each action. They send the same commands as a click in run mode.
- Rules can be switched off, duplicated and deleted (delete asks for a second click). Rules are saved automatically in `data/settings.json` and run on the server, so they work with no browser open.
- Rules that point at an element that was removed from the layout, or at a contact without a number, are marked in orange; the server skips the missing parts.
- The **Activity** list shows what the rules did, including commands that could not be sent.

**Sensors:** contact tracks follow the s88 feedback modules connected to the Intellibox (see *Feedback modules* below). The status at the top of the device list says whether they are read. You can also press a contact by hand to test rules without a train: click it in run mode or click its *on/off* chip in the rules window. It works like a button, not a switch: the contact turns on (orange) for 2 seconds and then off again, so both the *turns on* and the *turns off* rules run, like a passing train. Pressing again while it is on restarts the 2 seconds; a report from the real s88 contact ends the press. Actions never change contacts, so rules cannot trigger each other in a loop.

## Feedback modules (s88)

The server reads the s88 modules through the Intellibox and sets the contact tracks with the matching contact number. Numbering runs across modules: module 1 = contacts 1–16, module 2 = 17–32, and so on.

- **P50X:** after connecting, every module is read once (`XSensor`, `0x58 0x98 <module>`). Contacts already occupied at that moment are taken over without firing rules. After that the server asks for events every 150 ms (`XEvent`, `0x58 0xC8`) and, when a sensor changed, fetches the changed modules (`XEvtSen`, `0x58 0xCB`). The Intellibox collects changes between two polls, so short pulses are not lost.
- **Legacy P50** (`INTELLIBOX_PROTOCOL=P50`): modules 1…n are read on every poll (`0x80 + n`, two bytes per module).
- By default the server reads as many modules as the highest contact number in the layout needs. The Intellibox must be set up to scan at least that many s88 modules; see its manual for the s88 module setting.
- The polling traffic is not logged. Contact changes are logged as `[s88] contact 5 on`, and fired rules as `[rules] …`. If the Intellibox stops answering, the server retries every 2 s and reads all modules again.
- Replies from the Intellibox are now matched to their commands in order, so turnout and locomotive replies are logged with the command they belong to (`{"reply":"XTrnt","status":"OK"}`).

Environment variables:

- `S88_FEEDBACK=false` – do not read feedback modules
- `S88_MODULES` – number of modules to read (default: from the layout)
- `S88_POLL_MS` – pause between polls in ms (default `50`; at 2400 baud a poll itself takes another ~90 ms)
- `S88_DEBUG=1` – log every s88 reply from the Intellibox with a timestamp, and the poll cycle times once a minute

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

The new state is saved even if the command could not be sent (no address, serial port not open); the status line then says *not sent* and why. Each command and the Intellibox reply are logged in the terminal (`[Intellibox TX]` / `[Intellibox RX]`). Contact tracks are inputs and send nothing; clicking one in run mode presses it for 2 seconds to test the logic rules.

## File overview

- `server.js` – HTTP server and API endpoints
- `serialService.js` – serial device wrapper and packet builder
- `settingsStore.js` – stores controllers, interface settings, layout and logic rules in `data/settings.json`
- `ruleEngine.js` – runs the logic rules when a sensor changes
- `dataLocation.js` – where the data file lives, folder browser, persistence check
- `feedbackPoller.js` – reads the s88 feedback modules through the Intellibox
- `public/index.html` – main page: track layout, locomotive control window, settings dialog
- `public/layout.js` – track layout editor (edit and run mode)
- `public/throttle.js` – locomotive control window
- `public/settings.js` – settings dialog and interface status
- `public/menu.js` – burger menu in the top bar
- `public/decoders.html`, `public/decoders.js` – decoder test page
- `public/rules.html`, `public/rules.js` – logic rules editor (separate window)
- `public/trackCatalog.js` – element types, states, addresses and footprints (shared by browser and server)
- `public/i18n.js` – user interface texts (English, German)
- `public/styles.css` – styling
