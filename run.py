
"""FastAPI server for the Dobot Magician web dashboard.

Run from the project root:
    py -3.9 run.py
"""

import asyncio
import threading
import time
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.settings import Settings, STATIC, RECORDINGS
from app.robot import Robot, RobotError
from app.hub import Hub
from app import programs


# -------------------------------------------------
# INITIALIZATION
# -------------------------------------------------

settings = Settings()
hub = Hub()
robot = Robot(settings, hub.emit)

app = FastAPI(title="Dobot Magician Web Control")

STATIC.mkdir(parents=True, exist_ok=True)
RECORDINGS.mkdir(parents=True, exist_ok=True)

app.mount(
    "/static",
    StaticFiles(directory=str(STATIC)),
    name="static"
)


# -------------------------------------------------
# APPLICATION STATE
# -------------------------------------------------

teach_lock = threading.RLock()

teach = {
    "active": False,
    "name": "",
    "tool": "gripper",
    "steps": []
}

play_lock = threading.Lock()

play_state = {
    "running": False,
    "stop": False,
    "name": "",
    "index": 0,
    "total": 0,
    "repeat": 1,
    "error": None
}

jog_lock = threading.Lock()


# -------------------------------------------------
# REQUEST MODELS
# -------------------------------------------------

class ConnectBody(BaseModel):
    port: str


class MoveBody(BaseModel):
    x: float
    y: float
    z: float
    r: float


class ToolBody(BaseModel):
    action: str
    tool: Optional[str] = None


class NameBody(BaseModel):
    name: str


class TeachStartBody(BaseModel):
    name: str
    tool: str = "gripper"
    overwrite: bool = False


class TeachActionBody(BaseModel):
    action: str


class WaitBody(BaseModel):
    seconds: float


class SaveBody(BaseModel):
    overwrite: bool = False


class PlayBody(BaseModel):
    name: str
    speed: int = 25
    repeat: int = 1
    confirmed: bool = False


class JogBody(BaseModel):
    axis: str
    direction: int
    step: float = 5.0
    speed: int = 30


# -------------------------------------------------
# HELPERS
# -------------------------------------------------

def raise_api_error(exc):
    raise HTTPException(
        status_code=400,
        detail=str(exc)
    )


def emit_status():
    hub.emit(
        "status",
        data=robot.snapshot()
    )


def wait_for_target(target, timeout=None):

    timeout = float(
        timeout or settings.data.get("move_timeout", 30)
    )

    tolerance = float(
        settings.data.get("arrive_mm", 1.5)
    )

    start = time.time()

    while time.time() - start < timeout:

        if play_state["stop"] or robot.estop:
            return False

        pose = robot.get_pose()

        if max(
            abs(pose[i] - target[i])
            for i in range(4)
        ) <= tolerance:

            return True

        time.sleep(0.15)

    raise RobotError(
        "Move timed out while waiting for target position."
    )


# -------------------------------------------------
# PLAYBACK ENGINE
# -------------------------------------------------

def playback_worker(program_data, speed, repeats):

    try:

        robot.set_speed(speed)
        robot.tool = program_data["tool"]

        steps = program_data["steps"]

        for repeat_index in range(repeats):

            for index, step in enumerate(steps):

                if play_state["stop"] or robot.estop:
                    break

                play_state["index"] = index + 1
                play_state["total"] = len(steps)

                hub.emit(
                    "playback",
                    data=dict(play_state)
                )

                # Movement step
                if "move" in step:

                    current = robot.get_pose()[:4]

                    robot.move_to(
                        step["move"],
                        current
                    )

                    if not wait_for_target(step["move"]):
                        break

                # Tool step
                elif "tool" in step:

                    robot.set_tool(
                        step["tool"],
                        program_data["tool"]
                    )

                    if step["tool"] != "stop":

                        time.sleep(
                            float(
                                settings.data.get("grip_time", 1.0)
                            )
                        )

                # Wait step
                elif "wait" in step:

                    end_time = time.time() + float(step["wait"])

                    while (
                        time.time() < end_time
                        and not play_state["stop"]
                    ):
                        time.sleep(0.1)

            if play_state["stop"] or robot.estop:
                break

    except Exception as exc:

        play_state["error"] = str(exc)

        hub.emit(
            "event",
            level="error",
            msg=f"Playback error: {exc}"
        )

    finally:

        with play_lock:
            play_state["running"] = False

        hub.emit(
            "playback",
            data=dict(play_state)
        )

        emit_status()


def stop_playback():

    play_state["stop"] = True
    robot.halt_motion()


def robot_fault_callback():
    stop_playback()


robot.on_fault = robot_fault_callback


# -------------------------------------------------
# MAIN PAGE
# -------------------------------------------------

@app.get("/")
def index():

    file_path = STATIC / "index.html"

    if not file_path.exists():

        raise HTTPException(
            status_code=404,
            detail="static/index.html not found."
        )

    return FileResponse(file_path)


# -------------------------------------------------
# STATUS AND PORTS
# -------------------------------------------------

@app.get("/api/status")
def get_status():
    return robot.snapshot()


@app.get("/api/ports")
def get_ports():

    try:
        return {
            "ports": Robot.list_ports()
        }

    except Exception as exc:
        raise_api_error(exc)


# -------------------------------------------------
# ROBOT CONNECTION
# -------------------------------------------------

@app.post("/api/connect")
def connect_robot(body: ConnectBody):

    try:

        robot.connect(body.port)

        emit_status()

        return robot.snapshot()

    except Exception as exc:
        raise_api_error(exc)


@app.post("/api/disconnect")
def disconnect_robot():

    try:

        robot.disconnect()

        emit_status()

        return {"ok": True}

    except Exception as exc:
        raise_api_error(exc)


# -------------------------------------------------
# MANUAL MOVEMENT
# -------------------------------------------------

@app.post("/api/move")
def move_robot(body: MoveBody):

    try:

        current = robot.get_pose()[:4]

        robot.move_to(
            [body.x, body.y, body.z, body.r],
            current
        )

        return {"ok": True}

    except Exception as exc:
        raise_api_error(exc)


# -------------------------------------------------
# TOOL CONTROL
# -------------------------------------------------

@app.post("/api/tool")
def set_tool(body: ToolBody):

    try:

        robot.set_tool(
            body.action,
            body.tool
        )

        emit_status()

        return {
            "ok": True,
            "tool_state": robot.tool_state
        }

    except Exception as exc:
        raise_api_error(exc)


# -------------------------------------------------
# HOMING
# -------------------------------------------------

@app.post("/api/home")
def home_robot():

    try:

        robot.require_ready()

        if robot.homing:
            raise RobotError("Homing is already running.")

        threading.Thread(
            target=robot.home,
            daemon=True
        ).start()

        return {
            "ok": True,
            "message": "Homing started."
        }

    except Exception as exc:
        raise_api_error(exc)


# -------------------------------------------------
# EMERGENCY STOP
# -------------------------------------------------

@app.post("/api/estop")
def emergency_stop():

    robot.emergency_stop()

    stop_playback()

    emit_status()

    return {"ok": True}


@app.post("/api/reset-estop")
def reset_emergency_stop():

    robot.reset_estop()

    emit_status()

    return {"ok": True}


# -------------------------------------------------
# TEACHING MODE
# -------------------------------------------------

@app.post("/api/teach/start")
def start_teaching(body: TeachStartBody):

    try:

        programs.safe_name(body.name)

        if body.tool not in ("gripper", "suction"):
            raise ValueError(
                "Tool must be gripper or suction."
            )

        with teach_lock:

            if teach["active"]:
                raise ValueError(
                    "A teaching session is already active."
                )

            teach.update({
                "active": True,
                "name": body.name.strip(),
                "tool": body.tool,
                "steps": []
            })

        robot.tool = body.tool

        hub.emit(
            "teaching",
            data=dict(teach)
        )

        return {
            "ok": True,
            "session": dict(teach)
        }

    except Exception as exc:
        raise_api_error(exc)


@app.get("/api/teach/session")
def teaching_session():

    with teach_lock:
        return dict(teach)


@app.post("/api/teach/record")
def record_point(body: NameBody):

    try:

        if not teach["active"]:
            raise ValueError(
                "Start teaching first."
            )

        pose = robot.get_pose()

        step = {
            "name": body.name[:40],
            "move": [
                round(float(v), 1)
                for v in pose[:4]
            ]
        }

        with teach_lock:
            teach["steps"].append(step)

        hub.emit(
            "teaching",
            data=dict(teach)
        )

        return {
            "ok": True,
            "steps": teach["steps"]
        }

    except Exception as exc:
        raise_api_error(exc)


@app.post("/api/teach/action")
def teach_action(body: TeachActionBody):

    try:

        if not teach["active"]:
            raise ValueError(
                "Start teaching first."
            )

        robot.set_tool(
            body.action,
            teach["tool"]
        )

        with teach_lock:
            teach["steps"].append({
                "tool": body.action
            })

        hub.emit(
            "teaching",
            data=dict(teach)
        )

        return {"ok": True}

    except Exception as exc:
        raise_api_error(exc)


@app.post("/api/teach/wait")
def teach_wait(body: WaitBody):

    try:

        if not teach["active"]:
            raise ValueError(
                "Start teaching first."
            )

        if not 0 <= body.seconds <= 3600:
            raise ValueError(
                "Wait must be between 0 and 3600 seconds."
            )

        with teach_lock:
            teach["steps"].append({
                "wait": round(body.seconds, 2)
            })

        hub.emit(
            "teaching",
            data=dict(teach)
        )

        return {"ok": True}

    except Exception as exc:
        raise_api_error(exc)


@app.post("/api/teach/undo")
def undo_teaching():

    with teach_lock:

        if teach["steps"]:
            teach["steps"].pop()

        result = list(teach["steps"])

    hub.emit(
        "teaching",
        data=dict(teach)
    )

    return {
        "ok": True,
        "steps": result
    }


@app.post("/api/teach/save")
def save_teaching(body: SaveBody):

    try:

        with teach_lock:

            if not teach["active"]:
                raise ValueError(
                    "No active teaching session."
                )

            saved_name = programs.save(
                teach["name"],
                teach["tool"],
                teach["steps"],
                overwrite=body.overwrite
            )

            teach.update({
                "active": False,
                "name": "",
                "steps": []
            })

        hub.emit(
            "teaching",
            data=dict(teach)
        )

        return {
            "ok": True,
            "name": saved_name
        }

    except Exception as exc:
        raise_api_error(exc)


@app.post("/api/teach/cancel")
def cancel_teaching():

    with teach_lock:

        teach.update({
            "active": False,
            "name": "",
            "steps": []
        })

    hub.emit(
        "teaching",
        data=dict(teach)
    )

    return {"ok": True}


# -------------------------------------------------
# SAVED PROGRAMS
# -------------------------------------------------

@app.get("/api/programs")
def get_programs():

    return {
        "programs": programs.list_programs()
    }


@app.post("/api/programs/load")
def load_program(body: NameBody):

    try:
        return programs.load(body.name)

    except Exception as exc:
        raise_api_error(exc)


@app.delete("/api/programs/{name}")
def delete_program(name: str):

    try:

        programs.delete(name)

        return {"ok": True}

    except Exception as exc:
        raise_api_error(exc)


# -------------------------------------------------
# PROGRAM PLAYBACK
# -------------------------------------------------

@app.post("/api/play")
def play_program(body: PlayBody):

    try:

        if not body.confirmed:
            raise ValueError(
                "Confirm that the robot workspace is clear."
            )

        if not 1 <= body.repeat <= 100:
            raise ValueError(
                "Repeat must be between 1 and 100."
            )

        robot.require_ready()

        data = programs.load(body.name)

        with play_lock:

            if play_state["running"]:
                raise ValueError(
                    "Playback is already running."
                )

            play_state.update({
                "running": True,
                "stop": False,
                "name": body.name,
                "index": 0,
                "total": len(data["steps"]),
                "repeat": body.repeat,
                "error": None
            })

        thread = threading.Thread(
            target=playback_worker,
            args=(
                data,
                max(1, min(100, body.speed)),
                body.repeat
            ),
            daemon=True
        )

        thread.start()

        return {"ok": True}

    except Exception as exc:
        raise_api_error(exc)


@app.post("/api/play/stop")
def stop_program():

    stop_playback()

    return {"ok": True}


@app.get("/api/play/status")
def playback_status():

    return dict(play_state)


# -------------------------------------------------
# JOYSTICK / JOG
# -------------------------------------------------

@app.post("/api/jog")
def jog_robot(body: JogBody):

    try:

        robot.require_ready()

        axis = body.axis.upper()

        if axis not in ("X", "Y", "Z", "R"):
            raise ValueError(
                "Jog axis must be X, Y, Z or R."
            )

        if body.direction not in (-1, 1):
            raise ValueError(
                "Jog direction must be -1 or 1."
            )

        if not 0.5 <= body.step <= 20:
            raise ValueError(
                "Jog step must be between 0.5 and 20 mm."
            )

        if not 1 <= body.speed <= 100:
            raise ValueError(
                "Jog speed must be between 1 and 100."
            )

        if not jog_lock.acquire(blocking=False):
            raise ValueError(
                "Previous jog command is still running."
            )

        try:

            robot.set_speed(body.speed)

            current = robot.get_pose()[:4]

            target = list(current)

            axis_index = "XYZR".index(axis)

            target[axis_index] += (
                body.direction * body.step
            )

            robot.move_to(
                target,
                current
            )

        finally:
            jog_lock.release()

        return {
            "ok": True,
            "target": target
        }

    except Exception as exc:
        raise_api_error(exc)


@app.post("/api/jog/stop")
def stop_jog():

    robot.halt_motion()

    return {"ok": True}


# -------------------------------------------------
# WEBSOCKET
# -------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):

    hub.loop = asyncio.get_running_loop()

    hub.grace = lambda: float(
        settings.data.get(
            "client_lost_grace_s",
            3.0
        )
    )

    initial_messages = [
        {
            "type": "status",
            "data": robot.snapshot()
        },
        {
            "type": "playback",
            "data": dict(play_state)
        },
        {
            "type": "teaching",
            "data": dict(teach)
        }
    ]

    await hub.connect(
        websocket,
        initial_messages
    )

    try:

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        hub.disconnect(websocket)

# -------------------------------------------------
# START SERVER
# -------------------------------------------------

if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        "run:app",
        host="0.0.0.0",
        port=8000,
        reload=False
    )