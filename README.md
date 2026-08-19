# Steam Cast & Control (Node.js, connect-code version)

Same tool as the Python version, rebuilt with Node.js. Streams the Steam
window from one PC to a browser page (same PC or another device on your
network), lets you control it back. Double-click the video to take
control, press **F1** to release it.

## How it works

- `server.js` runs on the PC that has Steam open. It:
  - auto-finds the Steam window and streams it as a live JPEG feed,
  - prints a short **connect code** (encodes this PC's IP + port),
  - executes mouse/keyboard commands it receives, for real, via nut-js.
- `index.html` is a standalone page — just double-click it to open, no
  server needed to host it. Type `connect <code>` in its on-page console.

Wire protocol is identical to the Python version, so `index.html` is
literally the same file either way.

## Setup

1. Install [Node.js](https://nodejs.org) (LTS).
2. Open a terminal in this folder:
   ```
   npm install
   npm start
   ```
   `sharp`, `node-window-manager`, and `@nut-tree-fork/nut-js` have native
   modules — if install fails, install the Visual Studio Build Tools it
   points you to, then retry.
3. It'll print something like:
   ```
   CONNECT CODE:  KVLG-6UQP-QVMR-CAI
   ```
4. Open `index.html` (double-click it — any device on the same network,
   including this PC).
5. In the console at the bottom, type:
   ```
   connect KVLG-6UQP-QVMR-CAI
   ```
   You'll see *"IP 192.168.1.23 will cast their device to you"* and the
   video will start.
6. **Double-click** the video to take control. Press **F1** to release it.

## What the "connect code" actually is

Just the helper's IP and port, base32-encoded — a friendlier alternative
to typing a raw IP. It is not internet-wide pairing: the viewing device
still needs to reach the host PC directly (same Wi-Fi/LAN, or a VPN).

## Security

While `server.js` is running, anyone who has the code and can reach that
IP can see and control that PC. Share the code only with people/devices
you trust, and stop the server (Ctrl+C) when you're done.

## Known limitations

- ~8 fps JPEG streaming — fine for navigating Steam's UI, not fast-paced
  gameplay.
- Windows display scaling above 100% can throw off click accuracy.
- `node-window-manager` window detection works best on Windows/macOS.
- `F1` is hard-coded client-side as the release key.
- For controlling Steam from a phone specifically, Valve's own **Steam
  Link** app is the official, more polished option.
