
"""Dobot Magician hardware controller.

This module is imported by run.py. Do not execute robot.py directly.
"""

import math
import threading
import time


ALIASES = {"on": "close", "off": "open"}
TOOL_STATE = {"close": "HOLD", "open": "RELEASE", "stop": "OFF"}

POLL_S = 0.2
FAULT_AT = 3
DROP_AT = 8


class RobotError(Exception):
    pass


def suggest_port(ports):
    keys = ("CH340", "CP210", "FTDI", "USB")
    good = [
        p["device"] for p in ports
        if any(k in p.get("description", "").upper() for k in keys)
    ]
    found = good or [p["device"] for p in ports]
    return found[0] if len(found) == 1 else None


class Robot:

    def __init__(self, settings, emit):
        self.settings = settings
        self.emit = emit

        self.lock = threading.RLock()

        self.dev = None
        self.port = None

        self.pose = None
        self.pose_time = 0.0
        self.last_motion = 0.0

        self.tool = settings.data.get("tool", "gripper")
        self.tool_state = "UNKNOWN"

        self.homing = False
        self.homed = False
        self.estop = False
        self.fault = False

        self.comm_errors = 0
        self.last_error = ""

        self.on_fault = None

        self._gen = 0
        self._speed = None

    # -------------------------------------------------
    # LOGGING
    # -------------------------------------------------

    def log(self, level, msg):
        if level == "error":
            self.last_error = str(msg)

        self.emit("event", level=level, msg=str(msg))

    # -------------------------------------------------
    # PORTS
    # -------------------------------------------------

    @staticmethod
    def list_ports():
        try:
            from serial.tools.list_ports import comports
        except ImportError as exc:
            raise RobotError(
                "pyserial is not installed. Install requirements.txt."
            ) from exc

        ports = [
            {
                "device": p.device,
                "description": p.description or ""
            }
            for p in comports()
        ]

        return sorted(ports, key=lambda p: p["device"])

    @property
    def connected(self):
        return self.dev is not None

    def require_connected(self):
        if self.dev is None:
            raise RobotError("Robot is not connected.")

    def require_ready(self):
        self.require_connected()

        if self.estop:
            raise RobotError("Emergency stop is active.")

        if self.fault:
            raise RobotError("Communication fault. Reconnect the robot.")

        if self.homing:
            raise RobotError("Robot is homing.")

    # -------------------------------------------------
    # RAW DOBOT COMMAND
    # -------------------------------------------------

    def _raw(self, msg_id, ctrl, params):
        from pydobot.message import Message

        message = Message()
        message.id = msg_id
        message.ctrl = ctrl
        message.params = bytearray(params)

        self.dev._send_command(message)

    # -------------------------------------------------
    # CONNECT / DISCONNECT
    # -------------------------------------------------

    def connect(self, port):

        if not port:
            raise RobotError("Select a COM port first.")

        with self.lock:

            if self.dev:
                raise RobotError("Already connected.")

            try:
                from pydobot import Dobot

                device = Dobot(port=port)
                pose = [float(v) for v in device.pose()[:8]]

            except Exception as exc:
                try:
                    device.close()
                except Exception:
                    pass

                raise RobotError(
                    f"Could not connect on {port}: {exc}"
                ) from exc

            self.dev = device
            self.port = port
            self.pose = pose
            self.pose_time = time.time()

            self.comm_errors = 0
            self.fault = False
            self.estop = False
            self.homed = False
            self.homing = False

            self.tool_state = "UNKNOWN"
            self._speed = None

            self._gen += 1
            generation = self._gen

        try:
            self.settings.update({"port": port})
        except Exception:
            pass

        self._start_poller(generation)

        self.log("info", f"Connected on {port}.")

    def disconnect(self):

        with self.lock:

            if not self.dev:
                return

            try:
                self._stop_pump(self.tool)
            except Exception:
                pass

            try:
                self.dev.close()
            except Exception:
                pass

            self._drop_state()

        self.log("info", "Disconnected.")

    def _drop_state(self):

        self.dev = None
        self.port = None
        self.pose = None
        self.tool_state = "UNKNOWN"
        self.homing = False

        self._gen += 1

    # -------------------------------------------------
    # LIVE POSE POLLING
    # -------------------------------------------------

    def _start_poller(self, generation):

        threading.Thread(
            target=self._poll_loop,
            args=(generation,),
            daemon=True
        ).start()

    def _poll_loop(self, generation):

        previous = None

        while generation == self._gen and self.dev:

            time.sleep(POLL_S)

            if self.homing or generation != self._gen:
                continue

            try:
                current = self.read_pose()

            except RobotError:
                continue

            if previous is not None:

                if any(
                    abs(a - b) > 0.15
                    for a, b in zip(current, previous)
                ):
                    self.last_motion = time.time()

            previous = current

    def read_pose(self):

        with self.lock:

            self.require_connected()

            try:
                values = [
                    float(v)
                    for v in self.dev.pose()[:8]
                ]

            except Exception as exc:

                self._comm_failure(exc)

                raise RobotError(
                    f"Communication error: {exc}"
                ) from exc

            if self.comm_errors:

                self.comm_errors = 0

                if self.fault:
                    self.fault = False

                    self.log(
                        "info",
                        "Communication restored. Check robot before continuing."
                    )

            self.pose = values
            self.pose_time = time.time()

            return list(values)

    def get_pose(self, max_age=0.3):

        if (
            self.pose is not None
            and time.time() - self.pose_time <= max_age
        ):
            return list(self.pose)

        return self.read_pose()

    def _comm_failure(self, exc):

        self.comm_errors += 1

        if self.comm_errors in (1, FAULT_AT, DROP_AT):

            self.log(
                "error",
                f"Serial error #{self.comm_errors}: {exc}"
            )

        try:
            self.dev.ser.reset_input_buffer()
        except Exception:
            pass

        if self.comm_errors == FAULT_AT and not self.fault:

            self.fault = True

            self.log(
                "error",
                "Communication unreliable. Motion stopped."
            )

            self.halt_motion()

            if self.on_fault:
                self.on_fault()

        if self.comm_errors >= DROP_AT and self.dev:

            self.log(
                "error",
                "Communication lost. Connection closed."
            )

            try:
                self._stop_pump(self.tool)
                self.dev.close()
            except Exception:
                pass

            self._drop_state()

    # -------------------------------------------------
    # WORKSPACE LIMITS
    # -------------------------------------------------

    def limit_violations(self, target, current=None):

        limits = self.settings.data["limits"]
        errors = []

        def excess(value, low, high):
            return max(low - value, value - high, 0.0)

        for i, axis in enumerate("XYZR"):

            low, high = limits[axis.lower()]
            amount = excess(target[i], low, high)

            if amount > 0:

                if current is not None:

                    old = excess(current[i], low, high)

                    if amount <= old + 1e-6:
                        continue

                errors.append(
                    f"{axis}={target[i]:.1f} outside [{low}, {high}]"
                )

        radius = math.hypot(target[0], target[1])

        amount = excess(
            radius,
            limits["min_radius"],
            limits["max_radius"]
        )

        if amount > 0:

            old_radius = None

            if current is not None:
                old_radius = math.hypot(current[0], current[1])

            if old_radius is None or amount > excess(
                old_radius,
                limits["min_radius"],
                limits["max_radius"]
            ) + 1e-6:

                errors.append(
                    f"Reach {radius:.1f} mm outside "
                    f"[{limits['min_radius']}, {limits['max_radius']}]"
                )

        return errors

    # -------------------------------------------------
    # STOP / EMERGENCY STOP
    # -------------------------------------------------

    def halt_motion(self):

        acquired = self.lock.acquire(timeout=0.5)

        try:

            if not self.dev:
                return

            for message_id in (242, 245, 240):

                try:
                    self._raw(message_id, 0x01, [])

                except Exception as exc:

                    self.log(
                        "error",
                        f"Could not halt motion: {exc}"
                    )

                    break

        finally:

            if acquired:
                self.lock.release()

    def emergency_stop(self):

        self.estop = True

        self.halt_motion()

        acquired = self.lock.acquire(timeout=0.5)

        try:

            if self.dev:
                self._stop_pump(self.tool)
                self.tool_state = "OFF"

        finally:

            if acquired:
                self.lock.release()

        self.log(
            "error",
            "SOFTWARE EMERGENCY STOP. Use physical E-stop for real emergencies."
        )

    def reset_estop(self):

        if self.estop:
            self.estop = False
            self.log("info", "Emergency stop reset.")

    # -------------------------------------------------
    # SPEED AND MOVEMENT
    # -------------------------------------------------

    def set_speed(self, pct):

        pct = int(max(1, min(100, pct)))

        if pct == self._speed:
            return

        self.require_ready()

        with self.lock:

            try:
                self.dev.speed(pct, pct)

            except Exception as exc:

                self._comm_failure(exc)

                raise RobotError(
                    f"Could not set speed: {exc}"
                ) from exc

        self._speed = pct

    def move_to(self, pos, current=None):

        self.require_ready()

        try:
            x, y, z, r = [float(v) for v in pos]

        except Exception as exc:
            raise RobotError(
                "Invalid target position. Provide X, Y, Z and R."
            ) from exc

        target = (x, y, z, r)

        errors = self.limit_violations(target, current)

        if errors:
            raise RobotError(
                "Target outside workspace limits: "
                + "; ".join(errors)
            )

        with self.lock:

            try:
                self.dev.move_to(
                    x, y, z, r,
                    wait=False
                )

            except Exception as exc:

                self._comm_failure(exc)

                raise RobotError(
                    f"Move failed: {exc}"
                ) from exc

    # -------------------------------------------------
    # TOOL CONTROL
    # -------------------------------------------------

    def _stop_pump(self, tool):

        try:
            self._raw(
                63 if tool == "gripper" else 62,
                0x03,
                [0x00, 0x00]
            )

        except Exception as exc:

            self.log(
                "error",
                f"Could not stop tool directly: {exc}"
            )

            try:

                if tool == "gripper":
                    self.dev.grip(False)
                else:
                    self.dev.suck(False)

            except Exception:
                pass

    def set_tool(self, action, tool=None):

        action = ALIASES.get(action, action)
        tool = tool or self.tool

        if action not in TOOL_STATE:
            raise RobotError(
                f"Unknown tool action: {action}"
            )

        if action == "stop":
            self.require_connected()
        else:
            self.require_ready()

        with self.lock:

            try:

                if action == "stop":
                    self._stop_pump(tool)

                elif tool == "gripper":
                    self.dev.grip(action == "close")

                elif tool == "suction":
                    self.dev.suck(action == "close")

                else:
                    raise RobotError(
                        "Tool must be gripper or suction."
                    )

            except RobotError:
                raise

            except Exception as exc:

                self._comm_failure(exc)

                raise RobotError(
                    f"Tool command failed: {exc}"
                ) from exc

        self.tool_state = TOOL_STATE[action]

    # -------------------------------------------------
    # HOMING
    # -------------------------------------------------

    def home(self, timeout=60):

        self.require_ready()

        self.homing = True
        self.homed = False

        self.log(
            "info",
            "Homing started. The arm will move."
        )

        try:

            with self.lock:
                self._raw(31, 0x03, [0, 0, 0, 0])

            time.sleep(3)

            start = time.time()
            previous = None
            still_since = None

            while time.time() - start < timeout:

                if self.estop:
                    raise RobotError("Homing aborted by emergency stop.")

                if not self.dev:
                    raise RobotError("Connection lost while homing.")

                try:

                    with self.lock:
                        values = [
                            float(v)
                            for v in self.dev.pose()[:8]
                        ]

                except Exception:

                    try:
                        self.dev.ser.reset_input_buffer()
                    except Exception:
                        pass

                    still_since = None
                    time.sleep(1)
                    continue

                self.pose = values
                self.pose_time = time.time()

                rounded = tuple(round(v, 1) for v in values)

                if rounded == previous:

                    still_since = still_since or time.time()

                    if time.time() - still_since >= 3:

                        self.homed = True

                        self.log(
                            "info",
                            f"Homed. Pose: {values[:4]}"
                        )

                        return

                else:
                    still_since = None

                previous = rounded
                time.sleep(0.5)

            raise RobotError(
                "Homing timed out. Check the arm and home it in DobotLab."
            )

        finally:
            self.homing = False

    # -------------------------------------------------
    # STATUS FOR WEB DASHBOARD
    # -------------------------------------------------

    def snapshot(self):

        p = self.pose if self.dev else None

        pose = None

        if p:
            pose = dict(
                zip(
                    ("x", "y", "z", "r", "j1", "j2", "j3", "j4"),
                    p
                )
            )

        moving = (
            self.dev is not None
            and time.time() - self.last_motion < 0.6
        )

        return {
            "connected": self.dev is not None,
            "port": self.port,
            "pose": pose,
            "pose_age": (
                round(time.time() - self.pose_time, 2)
                if p else None
            ),
            "moving": moving,
            "tool": self.tool,
            "tool_state": self.tool_state,
            "homed": self.homed,
            "homing": self.homing,
            "estop": self.estop,
            "fault": self.fault,
            "comm_errors": self.comm_errors,
            "last_error": self.last_error
        }
