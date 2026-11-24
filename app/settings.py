"""Persistent, validated settings (settings.json next to run.py)."""
import copy
import json
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORDINGS = ROOT / "recordings"          # same folder name the old script used
SETTINGS_FILE = ROOT / "settings.json"
STATIC = ROOT / "static"

DEFAULTS = {
    "port": "",
    "tool": "gripper",                    # default tool type for new programs
    "playback_speed": 40,                 # percent
    "jog": {"speed": 30, "increment": 5.0},
    "limits": {                           # CHECK THESE against your table / fixtures
        "x": [-320.0, 320.0],
        "y": [-320.0, 320.0],
        "z": [-30.0, 170.0],
        "r": [-135.0, 135.0],
        "min_radius": 100.0,              # distance from the base axis (XY plane)
        "max_radius": 330.0,
    },
    "grip_time": 1.0,                     # seconds to wait after open / close
    "arrive_mm": 1.5,                     # within this distance = "arrived"
    "move_timeout": 30.0,                 # seconds before a move is treated as stuck
    "jump_warn_mm": 250.0,                # warn on big jumps between points
    "client_lost_grace_s": 3.0,           # pause playback if no browser for this long
}


def _merge(base, new):
    for k, v in new.items():
        if k not in base:
            continue
        if isinstance(base[k], dict) and isinstance(v, dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


class Settings:
    def __init__(self):
        self._lock = threading.Lock()
        self.data = copy.deepcopy(DEFAULTS)
        if SETTINGS_FILE.exists():
            try:
                _merge(self.data, json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
            except Exception:
                pass

    def get(self):
        return copy.deepcopy(self.data)

    def update(self, patch):
        with self._lock:
            new = copy.deepcopy(self.data)
            _merge(new, patch)
            self._validate(new)
            self.data = new
            SETTINGS_FILE.write_text(json.dumps(new, indent=2), encoding="utf-8")

    @staticmethod
    def _validate(d):
        lim = d["limits"]
        for k in ("x", "y", "z", "r"):
            lo, hi = float(lim[k][0]), float(lim[k][1])
            if lo >= hi:
                raise ValueError(f"Limit {k.upper()}: min must be below max.")
            lim[k] = [lo, hi]
        lim["min_radius"] = float(lim["min_radius"])
        lim["max_radius"] = float(lim["max_radius"])
        if lim["min_radius"] < 0 or lim["min_radius"] >= lim["max_radius"]:
            raise ValueError("Radius: min must be 0 or more and below max.")
        if d["tool"] not in ("gripper", "suction"):
            raise ValueError("Tool must be gripper or suction.")
        d["playback_speed"] = int(max(1, min(100, int(d["playback_speed"]))))
        d["jog"]["speed"] = int(max(1, min(100, int(d["jog"]["speed"]))))
        d["jog"]["increment"] = float(max(0.5, min(20.0, float(d["jog"]["increment"]))))
        for k, lo, hi in (("grip_time", 0, 30), ("arrive_mm", 0.3, 10),
                          ("move_timeout", 3, 300), ("jump_warn_mm", 20, 700),
                          ("client_lost_grace_s", 0.5, 60)):
            d[k] = float(max(lo, min(hi, float(d[k]))))
