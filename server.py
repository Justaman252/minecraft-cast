"""
server.py — Steam cast/control helper (Python, no Node.js)

Run this on the PC that has Steam open. It:
  1. Finds the Steam window automatically and streams it as a live JPEG feed.
  2. Prints a short CONNECT CODE that encodes this PC's IP + port.
  3. Accepts mouse/keyboard commands from a connected client and executes
     them for real, via pyautogui.

Install once:
    pip install websockets pyautogui pygetwindow mss pillow

Run:
    python server.py

Then, on the viewing device, open index.html and type in its console:
    connect <the code printed here>

SECURITY WARNING: anyone who has this code (and can reach this PC's IP) can
both SEE and CONTROL this PC while the helper is running. Only share the
code with people/devices you trust, and only on networks you trust. There
is no internet-wide "magic pairing" here — the other device still needs to
be able to reach this PC's IP (same Wi-Fi/LAN, or a VPN). If they're not on
the same network, this won't work without extra network setup (e.g. port
forwarding), which isn't covered here on purpose.
"""

import asyncio
import base64
import io
import json
import socket
import subprocess

import websockets
import pyautogui
import mss
from PIL import Image

try:
    import pygetwindow as gw
except ImportError:
    gw = None

pyautogui.FAILSAFE = False

HOST = "0.0.0.0"   # listen on all interfaces so other devices can reach it
PORT = 8765
FPS = 8
JPEG_QUALITY = 55

clients = set()
monitors = []             # [{"id": int, "name": str, left, top, width, height}]
windows_list = []         # [{"id": int, "title": str}] snapshot of open windows
selected_monitor = None   # set = casting a full monitor
tracked_window_title = "steam"  # used when NOT casting a full monitor

KEY_MAP = {
    **{f"Key{c}": c.lower() for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    **{f"Digit{d}": d for d in "0123456789"},
    "ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right",
    "Enter": "enter", "Escape": "esc", "Space": "space", "Tab": "tab",
    "Backspace": "backspace", "Delete": "delete",
    "ShiftLeft": "shiftleft", "ShiftRight": "shiftright",
    "ControlLeft": "ctrlleft", "ControlRight": "ctrlright",
    "AltLeft": "altleft", "AltRight": "altright",
    "F2": "f2", "F3": "f3", "F4": "f4", "F5": "f5", "F6": "f6",
    "F7": "f7", "F8": "f8", "F9": "f9", "F10": "f10", "F11": "f11", "F12": "f12",
    # F1 intentionally NOT mapped — reserved client-side to release control
}


async def ask_for_control_approval(name):
    """Show a native Windows Yes/No dialog on the host; True if accepted.
    Runs the blocking subprocess call in a thread so it never freezes the
    frame stream while the host is deciding."""
    safe_name = str(name).replace('"', "").replace("'", "").replace("`", "").replace("$", "")
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        f"$r = [System.Windows.Forms.MessageBox]::Show(\"'{safe_name}' wants to take control of this PC. Allow?\", "
        "'Steam Cast & Control', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question); "
        "Write-Output $r"
    )

    def run():
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True, text=True, timeout=120
            )
            return result.stdout.strip() == "Yes"
        except Exception as e:
            print("Approval dialog failed:", e)
            return False

    return await asyncio.to_thread(run)


CONTROL_TYPES = {"move", "click", "dblclick", "scroll", "keydown", "keyup"}


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def make_code(ip, port):
    """Encode ip:port into a short, shareable base32 code."""
    raw = f"{ip}:{port}".encode()
    b32 = base64.b32encode(raw).decode().rstrip("=")
    return "-".join(b32[i:i + 4] for i in range(0, len(b32), 4))


def build_monitor_list():
    global monitors
    with mss.mss() as sct:
        # sct.monitors[0] is the combined virtual screen; [1:] are individual monitors
        monitors = [
            {"id": i, "name": f"Display {i + 1}", "left": m["left"], "top": m["top"],
             "width": m["width"], "height": m["height"]}
            for i, m in enumerate(sct.monitors[1:])
        ]


def refresh_windows_list():
    """Snapshot of currently open, visible windows with a decent size."""
    global windows_list
    windows_list = []
    if not gw:
        return windows_list
    try:
        wins = [w for w in gw.getAllWindows() if w.visible and w.title.strip() and w.width > 100 and w.height > 100]
        windows_list = [{"id": i, "title": w.title.strip()} for i, w in enumerate(wins)]
    except Exception as e:
        print("Could not list windows:", e)
    return windows_list


def find_tracked_window_region():
    """Return {left, top, width, height} of the window whose title contains
    tracked_window_title, or the primary monitor if none matches."""
    if gw:
        try:
            wins = [w for w in gw.getAllWindows()
                    if tracked_window_title.lower() in w.title.lower() and w.visible and w.width > 100]
            if wins:
                w = wins[0]
                return {"left": w.left, "top": w.top,
                        "width": max(w.width, 1), "height": max(w.height, 1)}
        except Exception:
            pass
    with mss.mss() as sct:
        mon = sct.monitors[1]
        return {"left": mon["left"], "top": mon["top"],
                "width": mon["width"], "height": mon["height"]}


async def capture_loop():
    interval = 1 / FPS
    with mss.mss() as sct:
        while True:
            if clients:
                region = (
                    {"left": selected_monitor["left"], "top": selected_monitor["top"],
                     "width": selected_monitor["width"], "height": selected_monitor["height"]}
                    if selected_monitor else find_tracked_window_region()
                )
                shot = sct.grab(region)
                img = Image.frombytes("RGB", shot.size, shot.rgb)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=JPEG_QUALITY)
                b64 = base64.b64encode(buf.getvalue()).decode()
                payload = json.dumps({
                    "type": "frame",
                    "left": region["left"], "top": region["top"],
                    "w": region["width"], "h": region["height"],
                    "data": b64
                })
                dead = set()
                for ws in list(clients):
                    try:
                        await ws.send(payload)
                    except Exception:
                        dead.add(ws)
                clients.difference_update(dead)
            await asyncio.sleep(interval)


async def handle(ws):
    global selected_monitor, tracked_window_title
    clients.add(ws)
    ws.has_control = False  # must be explicitly granted via "takecontrol" before input is forwarded
    print("Client connected:", ws.remote_address)

    refresh_windows_list()
    await ws.send(json.dumps({
        "type": "sources",
        "monitors": [{"id": m["id"], "name": m["name"]} for m in monitors],
        "windows": windows_list,
        "current": (f"monitor:{selected_monitor['id']}" if selected_monitor
                    else f"window:{tracked_window_title}"),
    }))

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = msg.get("type")
            if t in CONTROL_TYPES and not getattr(ws, "has_control", False):
                continue  # ignore input from a device that hasn't been granted control
            try:
                if t == "request_control":
                    requester_name = msg.get("name") or (ws.remote_address[0] if ws.remote_address else "Unknown device")
                    print(f"Control requested by: {requester_name}")
                    approved = await ask_for_control_approval(requester_name)
                    ws.has_control = approved
                    await ws.send(json.dumps({"type": "control_granted" if approved else "control_denied"}))
                    print(f"Control {'granted to' if approved else 'denied to'} {requester_name}")
                elif t == "select_monitor":
                    match = next((m for m in monitors if m["id"] == msg.get("id")), None)
                    if match:
                        selected_monitor = match
                        print(f"Now casting monitor: {match['name']}")
                elif t == "select_window":
                    selected_monitor = None
                    refresh_windows_list()
                    by_id = next((w for w in windows_list if w["id"] == msg.get("id")), None)
                    tracked_window_title = by_id["title"] if by_id else str(msg.get("name", tracked_window_title))
                    print(f'Now casting window matching: "{tracked_window_title}"')
                elif t == "select_steam":
                    selected_monitor = None
                    tracked_window_title = "steam"
                    print("Now casting: Steam window (auto-tracked)")
                elif t == "move":
                    pyautogui.moveTo(msg["x"], msg["y"])
                elif t == "click":
                    button = {0: "left", 1: "middle", 2: "right"}.get(msg.get("button", 0), "left")
                    pyautogui.click(x=msg["x"], y=msg["y"], button=button)
                elif t == "dblclick":
                    pyautogui.doubleClick(x=msg["x"], y=msg["y"])
                elif t == "scroll":
                    pyautogui.scroll(-int(msg["dy"]))
                elif t == "keydown":
                    k = KEY_MAP.get(msg.get("code"))
                    if k:
                        pyautogui.keyDown(k)
                elif t == "keyup":
                    k = KEY_MAP.get(msg.get("code"))
                    if k:
                        pyautogui.keyUp(k)
            except Exception as e:
                print("Input error:", e)
    finally:
        clients.discard(ws)
        print("Client disconnected")


async def main():
    build_monitor_list()
    ip = get_local_ip()
    code = make_code(ip, PORT)
    print("=" * 55)
    print(f"  CONNECT CODE:  {code}")
    print(f"  (manual fallback — IP: {ip}  Port: {PORT})")
    print("  On the other device, open index.html and type:")
    print(f"      connect {code}")
    print("=" * 55)

    async with websockets.serve(handle, HOST, PORT, max_size=None):
        await capture_loop()


if __name__ == "__main__":
    asyncio.run(main())
