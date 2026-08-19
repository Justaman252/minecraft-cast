// server.js — Steam cast/control helper (Node.js version)
//
// Run this on the PC that has Steam open. It:
//   1. Finds the Steam window automatically and streams it as a live JPEG feed.
//   2. Prints a short CONNECT CODE that encodes this PC's IP + port.
//   3. Accepts mouse/keyboard commands from a connected client and executes
//      them for real, via nut-js.
//
// Install once:
//   npm install
// Run:
//   npm start
//
// Then, on the viewing device, open index.html and type in its console:
//   connect <the code printed here>
//
// SECURITY WARNING: anyone who has this code (and can reach this PC's IP)
// can both SEE and CONTROL this PC while this is running. Only share the
// code with people/devices you trust, on networks you trust. This does not
// do internet-wide "magic pairing" — the other device still needs to be
// able to reach this PC's IP (same Wi-Fi/LAN, or a VPN).

const os = require("os");
const { execSync, execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const { mouse, keyboard, Key, Button, Point } = require("@nut-tree-fork/nut-js");
const screenshot = require("screenshot-desktop");
const sharp = require("sharp");

let windowManager = null;
try {
  windowManager = require("node-window-manager").windowManager;
} catch {
  console.warn("node-window-manager not available — will always stream the full screen.");
}

mouse.config.mouseSpeed = 3000;

const PORT = 8765;
const FPS = 8;
const JPEG_QUALITY = 55;

const clients = new Set();

// Map JS KeyboardEvent.code -> nut-js Key enum (same mapping the browser sends)
const KEY_MAP = {
  KeyA: Key.A, KeyB: Key.B, KeyC: Key.C, KeyD: Key.D, KeyE: Key.E,
  KeyF: Key.F, KeyG: Key.G, KeyH: Key.H, KeyI: Key.I, KeyJ: Key.J,
  KeyK: Key.K, KeyL: Key.L, KeyM: Key.M, KeyN: Key.N, KeyO: Key.O,
  KeyP: Key.P, KeyQ: Key.Q, KeyR: Key.R, KeyS: Key.S, KeyT: Key.T,
  KeyU: Key.U, KeyV: Key.V, KeyW: Key.W, KeyX: Key.X, KeyY: Key.Y, KeyZ: Key.Z,
  Digit0: Key.Num0, Digit1: Key.Num1, Digit2: Key.Num2, Digit3: Key.Num3,
  Digit4: Key.Num4, Digit5: Key.Num5, Digit6: Key.Num6, Digit7: Key.Num7,
  Digit8: Key.Num8, Digit9: Key.Num9,
  ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
  Enter: Key.Enter, Escape: Key.Escape, Space: Key.Space, Tab: Key.Tab,
  Backspace: Key.Backspace, Delete: Key.Delete,
  ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
  ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
  F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  // F1 intentionally NOT mapped — reserved client-side to release control
};

// Uses .NET's Screen.AllScreens (via a one-off PowerShell call) to get each
// monitor's real on-screen offset/size, which screenshot-desktop alone
// doesn't expose but nut-js's mouse coordinates need.
function getMonitorBounds() {
  try {
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
      '"$($_.DeviceName)|$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)" }';
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`).toString();
    return out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, x, y, w, h, primary] = line.trim().split("|");
        return { name, x: Number(x), y: Number(y), width: Number(w), height: Number(h), primary: primary === "True" };
      });
  } catch (err) {
    console.warn("Could not enumerate monitors via PowerShell:", err.message);
    return [];
  }
}

let monitors = []; // [{id, name, x, y, width, height, primary}]
let selectedMonitor = null; // set = casting a full monitor
let windowsList = []; // [{id, title}] snapshot of open windows, refreshed on request
let trackedWindowTitle = "steam"; // used when NOT casting a full monitor

function refreshWindowsList() {
  windowsList = [];
  if (!windowManager) return windowsList;
  try {
    const wins = windowManager.getWindows();
    windowsList = wins
      .filter((w) => {
        try {
          const b = w.getBounds();
          return w.isVisible() && w.getTitle().trim().length > 0 && b.width > 100 && b.height > 100;
        } catch {
          return false;
        }
      })
      .map((w, i) => ({ id: i, title: w.getTitle().trim() }));
  } catch (err) {
    console.warn("Could not list windows:", err.message);
  }
  return windowsList;
}

function findTrackedWindowRegion() {
  if (!windowManager) return null;
  try {
    const wins = windowManager.getWindows();
    const match = wins.find((w) => {
      try {
        return w.isVisible() && w.getTitle().toLowerCase().includes(trackedWindowTitle.toLowerCase()) && w.getBounds().width > 100;
      } catch {
        return false;
      }
    });
    if (match) {
      const b = match.getBounds();
      return { left: b.x, top: b.y, width: b.width, height: b.height };
    }
  } catch {
    // fall through
  }
  return null;
}

function buildMonitorList() {
  const bounds = getMonitorBounds();
  monitors = bounds.map((b, i) => ({
    id: String(i),
    name: b.primary ? `${b.name} (primary)` : b.name,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  }));
  if (monitors.length === 0) {
    console.warn("No monitors detected via PowerShell — 'monitor <n>' selection won't work; Steam-window tracking still will.");
  }
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

// Minimal RFC4648 base32 encoder (no padding), matching server.py's format
function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    let chunk = bits.substr(i, 5);
    if (chunk.length < 5) chunk = chunk.padEnd(5, "0");
    out += alphabet[parseInt(chunk, 2)];
  }
  return out;
}

function makeCode(ip, port) {
  const raw = Buffer.from(`${ip}:${port}`, "utf8");
  const b32 = base32Encode(raw);
  return b32.match(/.{1,4}/g).join("-");
}

async function captureFrame() {
  if (selectedMonitor) {
    // Cast the whole chosen monitor, full frame, no cropping.
    const pngBuffer = await screenshot({ screen: selectedMonitor.id, format: "png" });
    const jpeg = await sharp(pngBuffer).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    return {
      region: {
        left: selectedMonitor.x,
        top: selectedMonitor.y,
        width: selectedMonitor.width,
        height: selectedMonitor.height,
      },
      jpeg,
    };
  }

  // Default: auto-track whichever window matches trackedWindowTitle (any app, not just Steam).
  const pngBuffer = await screenshot({ format: "png" });
  const meta = await sharp(pngBuffer).metadata();

  let region = findTrackedWindowRegion();
  if (!region) {
    region = { left: 0, top: 0, width: meta.width, height: meta.height };
  }
  const left = Math.max(0, Math.min(region.left, meta.width - 1));
  const top = Math.max(0, Math.min(region.top, meta.height - 1));
  const width = Math.max(1, Math.min(region.width, meta.width - left));
  const height = Math.max(1, Math.min(region.height, meta.height - top));

  const jpeg = await sharp(pngBuffer)
    .extract({ left, top, width, height })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return { region: { left, top, width, height }, jpeg };
}

// Shows a native Windows Yes/No dialog on the host and resolves to true/false.
// Runs via execFile (non-blocking) so it doesn't freeze the frame stream
// while the host decides.
function askForControlApproval(name) {
  return new Promise((resolve) => {
    const safeName = String(name).replace(/["'`$]/g, "");
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      `$r = [System.Windows.Forms.MessageBox]::Show("'${safeName}' wants to take control of this PC. Allow?", ` +
      '"Steam Cast & Control", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question); ' +
      "Write-Output $r";
    execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 120000 }, (err, stdout) => {
      if (err) {
        console.warn("Approval dialog failed:", err.message);
        resolve(false);
        return;
      }
      resolve(stdout.trim() === "Yes");
    });
  });
}

const CONTROL_TYPES = new Set(["move", "click", "dblclick", "scroll", "keydown", "keyup"]);

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.hasControl = false; // must be explicitly granted via "takecontrol" before input is forwarded
  console.log("Client connected");

  // Ask the newly connected device which screen/window to cast.
  refreshWindowsList();
  ws.send(
    JSON.stringify({
      type: "sources",
      monitors: monitors.map((m) => ({ id: m.id, name: m.name })),
      windows: windowsList.map((w) => ({ id: w.id, title: w.title })),
      current: selectedMonitor ? `monitor:${selectedMonitor.id}` : `window:${trackedWindowTitle}`,
    })
  );

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (CONTROL_TYPES.has(msg.type) && !ws.hasControl) {
        return; // ignore input from a device that hasn't been granted control
      }
      switch (msg.type) {
        case "request_control": {
          const requesterName = msg.name || ws._socket?.remoteAddress || "Unknown device";
          console.log(`Control requested by: ${requesterName}`);
          const approved = await askForControlApproval(requesterName);
          ws.hasControl = approved;
          ws.send(JSON.stringify({ type: approved ? "control_granted" : "control_denied" }));
          console.log(approved ? `Control granted to ${requesterName}` : `Control denied to ${requesterName}`);
          break;
        }
        case "select_monitor": {
          const m = monitors.find((mm) => mm.id === String(msg.id));
          if (m) {
            selectedMonitor = m;
            console.log(`Now casting monitor: ${m.name}`);
          }
          break;
        }
        case "select_window": {
          selectedMonitor = null;
          const list = refreshWindowsList();
          const byId = list.find((w) => w.id === Number(msg.id));
          trackedWindowTitle = byId ? byId.title : String(msg.name || trackedWindowTitle);
          console.log(`Now casting window matching: "${trackedWindowTitle}"`);
          break;
        }
        case "select_steam":
          selectedMonitor = null;
          trackedWindowTitle = "steam";
          console.log("Now casting: Steam window (auto-tracked)");
          break;
        case "move":
          await mouse.setPosition(new Point(msg.x, msg.y));
          break;
        case "click": {
          const button = msg.button === 2 ? Button.RIGHT : msg.button === 1 ? Button.MIDDLE : Button.LEFT;
          await mouse.setPosition(new Point(msg.x, msg.y));
          await mouse.click(button);
          break;
        }
        case "dblclick":
          await mouse.setPosition(new Point(msg.x, msg.y));
          await mouse.doubleClick(Button.LEFT);
          break;
        case "scroll":
          if (msg.dy > 0) await mouse.scrollDown(Math.abs(Math.round(msg.dy)));
          else await mouse.scrollUp(Math.abs(Math.round(msg.dy)));
          break;
        case "keydown": {
          const k = KEY_MAP[msg.code];
          if (k !== undefined) await keyboard.pressKey(k);
          break;
        }
        case "keyup": {
          const k = KEY_MAP[msg.code];
          if (k !== undefined) await keyboard.releaseKey(k);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("Input error:", err.message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("Client disconnected");
  });
});

async function broadcastLoop() {
  const interval = 1000 / FPS;
  while (true) {
    if (clients.size > 0) {
      try {
        const { region, jpeg } = await captureFrame();
        const payload = JSON.stringify({
          type: "frame",
          left: region.left,
          top: region.top,
          w: region.width,
          h: region.height,
          data: jpeg.toString("base64"),
        });
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) ws.send(payload);
        }
      } catch (err) {
        console.error("Capture error:", err.message);
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

buildMonitorList();

const ip = getLocalIp();
const code = makeCode(ip, PORT);
console.log("=".repeat(55));
console.log(`  CONNECT CODE:  ${code}`);
console.log(`  (manual fallback — IP: ${ip}  Port: ${PORT})`);
console.log("  On the other device, open index.html and type:");
console.log(`      connect ${code}`);
console.log("=".repeat(55));

broadcastLoop();
