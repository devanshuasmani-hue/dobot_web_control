"""Program storage. Files are {"tool": ..., "steps": [...]} exactly like the old script,
so existing recordings/*.json load unchanged and new ones still run in dobot_teach_v3.py."""
import json
import os
import re
import time

from .settings import RECORDINGS

ALIASES = {"on": "close", "off": "open"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _\-]{0,63}$")


def safe_name(name):
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise ValueError("Program name: 1-64 letters, digits, spaces, '-' or '_'.")
    return name


def path_for(name):
    return RECORDINGS / f"{safe_name(name)}.json"


def normalize_steps(steps):
    """Validate (same rules as load() in the old script) and canonicalise on/off -> close/open."""
    if not isinstance(steps, list):
        raise ValueError("Steps must be a list.")
    out = []
    for i, s in enumerate(steps, 1):
        if not isinstance(s, dict):
            raise ValueError(f"Step {i}: not an object.")
        if "move" in s:
            m = s["move"]
            if (not isinstance(m, (list, tuple)) or len(m) != 4
                    or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in m)):
                raise ValueError(f"Step {i}: bad point {m}.")
            step = {"move": [round(float(v), 1) for v in m]}
            nm = s.get("name")
            if nm is not None:
                step = {"name": str(nm)[:40], **step}
            out.append(step)
        elif "tool" in s:
            a = ALIASES.get(s["tool"], s["tool"])
            if a not in ("open", "close", "stop"):
                raise ValueError(f"Step {i}: bad tool action '{s['tool']}'.")
            out.append({"tool": a})
        elif "wait" in s:
            try:
                w = float(s["wait"])
            except (TypeError, ValueError):
                raise ValueError(f"Step {i}: bad wait time.")
            if not 0 <= w <= 3600:
                raise ValueError(f"Step {i}: wait must be 0-3600 s.")
            out.append({"wait": round(w, 2)})
        else:
            raise ValueError(f"Step {i}: unknown step type.")
    return out


def list_programs():
    out = []
    if not RECORDINGS.exists():
        return out
    for p in sorted(RECORDINGS.glob("*.json"), key=lambda p: p.stem.lower()):
        item = {"name": p.stem, "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime))}
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            steps = data.get("steps", [])
            item.update(tool=data.get("tool", "suction"), steps=len(steps),
                        points=sum(1 for s in steps if "move" in s), valid=True)
        except Exception:
            item.update(tool="?", steps=0, points=0, valid=False)
        out.append(item)
    return out


def load(name):
    path = path_for(name)
    if not path.exists():
        raise ValueError(f"No program called '{name}'.")
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"name": path.stem,
            "tool": data.get("tool", "suction") if data.get("tool") in ("suction", "gripper") else "suction",
            "steps": normalize_steps(data.get("steps", []))}


def save(name, tool, steps, overwrite=False):
    path = path_for(name)
    steps = normalize_steps(steps)
    if not any("move" in s for s in steps):
        raise ValueError("No points were recorded, nothing saved.")
    if path.exists() and not overwrite:
        raise FileExistsError(f"'{path.stem}' already exists.")
    RECORDINGS.mkdir(exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"tool": tool, "steps": steps}, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return path.stem


def delete(name):
    path = path_for(name)
    if not path.exists():
        raise ValueError(f"No program called '{name}'.")
    path.unlink()
