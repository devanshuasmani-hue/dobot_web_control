const $ = (id) => document.getElementById(id);

let socket = null;
let joystickHeld = false;
let joystickButton = null;
let currentStepNumber = 1;

function log(message, type = "info") {
    const box = $("logs");
    if (!box) return;

    const line = document.createElement("div");
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    line.className = `log-${type}`;
    box.prepend(line);
}

async function request(url, method = "GET", body = null) {
    const options = {
        method,
        headers: { "Content-Type": "application/json" }
    };

    if (body !== null) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.detail || data.message || `Request failed (${response.status})`);
    }

    return data;
}

async function safeRequest(url, method = "GET", body = null) {
    try {
        return await request(url, method, body);
    } catch (error) {
        log(error.message, "error");
        alert(error.message);
        return null;
    }
}

// ---------------- STATUS ----------------

function updateStatus(data) {
    if (!data) return;

    const connected = data.connected ?? data.is_connected ?? false;

    if ($("connectionStatus")) {
        $("connectionStatus").textContent =
            connected ? "CONNECTED" : "DISCONNECTED";
    }

    if ($("robotInfo")) {
        $("robotInfo").textContent = connected
            ? "Dobot Magician connected"
            : "No robot connected";
    }

    const pose = data.pose || data.position || {};

    const values = {
        posX: pose.x ?? data.x,
        posY: pose.y ?? data.y,
        posZ: pose.z ?? data.z,
        posR: pose.r ?? data.r
    };

    Object.entries(values).forEach(([id, value]) => {
        if ($(id) && value !== undefined && value !== null) {
            $(id).textContent = Number(value).toFixed(1);
        }
    });

    if ($("toolStatus")) {
        $("toolStatus").textContent = data.tool || "Unknown";
    }

    if ($("movementStatus")) {
        $("movementStatus").textContent =
            data.moving ? "MOVING" : "IDLE";
    }

    if ($("robotState")) {
        $("robotState").textContent =
            data.estop ? "EMERGENCY STOP" :
            data.fault ? "FAULT" :
            data.homing ? "HOMING" :
            data.homed ? "READY" :
            connected ? "CONNECTED" : "OFFLINE";
    }
}

async function refreshStatus() {
    const data = await safeRequest("/api/status");
    if (data) updateStatus(data);
}

// ---------------- CONNECTION ----------------

async function refreshPorts() {
    const data = await safeRequest("/api/ports");
    if (!data) return;

    const select = $("port");
    if (!select) return;

    select.innerHTML = "";

    const ports = data.ports || data;

    if (!Array.isArray(ports) || ports.length === 0) {
        select.add(new Option("No ports found", ""));
        return;
    }

    ports.forEach(port => {
        const name = typeof port === "string" ? port : port.device;
        if (name) select.add(new Option(name, name));
    });
}

async function connectRobot() {
    const port = $("port")?.value;

    if (!port) {
        alert("Select a COM port first.");
        return;
    }

    const data = await safeRequest("/api/connect", "POST", { port });

    if (data) {
        log(`Connection requested on ${port}`);
        await refreshStatus();
    }
}

async function disconnectRobot() {
    const data = await safeRequest("/api/disconnect", "POST");

    if (data) {
        log("Robot disconnected");
        await refreshStatus();
    }
}

// ---------------- MANUAL MOVEMENT ----------------

async function moveRobot() {
    const position = {
        x: Number($("x")?.value),
        y: Number($("y")?.value),
        z: Number($("z")?.value),
        r: Number($("r")?.value)
    };

    if (Object.values(position).some(v => !Number.isFinite(v))) {
        alert("Enter valid X, Y, Z and R values.");
        return;
    }

    if (!confirm(
        `Move Dobot to:\nX: ${position.x}\nY: ${position.y}\nZ: ${position.z}\nR: ${position.r}\n\nEnsure the workspace is clear.`
    )) return;

    const data = await safeRequest("/api/move", "POST", position);
    if (data) log("Movement command sent");
}

async function toolAction(action) {
    const data = await safeRequest("/api/tool", "POST", { action });
    if (data) log(`Tool action: ${action}`);
}

async function homeRobot() {
    if (!confirm("Home the robot? Check that the workspace is clear first.")) return;

    const data = await safeRequest("/api/home", "POST");
    if (data) log("Home command sent");
}

// ---------------- JOYSTICK ----------------

async function jogLoop(button) {
    while (joystickHeld && joystickButton === button) {
        const axis = button.dataset.axis;
        const direction = Number(button.dataset.dir);
        const step = Number($("jogStep")?.value || 5);
        const speed = Number($("jogSpeed")?.value || 20);

        try {
            await request("/api/jog", "POST", {
                axis,
                direction,
                step,
                speed
            });
        } catch (error) {
            if (joystickHeld) log(`Joystick: ${error.message}`, "error");
            break;
        }
    }
}

function startJoystick(button) {
    if (joystickHeld) return;

    joystickHeld = true;
    joystickButton = button;
    button.classList.add("active");

    jogLoop(button);
}

async function stopJoystick() {
    const wasHeld = joystickHeld;

    joystickHeld = false;

    if (joystickButton) {
        joystickButton.classList.remove("active");
    }

    joystickButton = null;

    if (wasHeld) {
        try {
            await request("/api/jog/stop", "POST");
        } catch (error) {
            log(`Joystick stop: ${error.message}`, "error");
        }
    }
}

function setupJoystick() {
    document.querySelectorAll("[data-axis]").forEach(button => {
        button.addEventListener("pointerdown", event => {
            event.preventDefault();
            startJoystick(button);
        });

        button.addEventListener("contextmenu", event => {
            event.preventDefault();
        });
    });

    window.addEventListener("pointerup", stopJoystick);
    window.addEventListener("pointercancel", stopJoystick);
    window.addEventListener("blur", stopJoystick);

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopJoystick();
    });
}

// ---------------- TEACHING ----------------

async function refreshTeachingSession() {
    const data = await safeRequest("/api/teach/session");
    if (!data) return;

    const steps = data.steps || [];

    if ($("teachStatus")) {
        $("teachStatus").textContent =
            data.active ? "Teaching session active" : "No active session";
    }

    if ($("teachSteps")) {
        $("teachSteps").innerHTML = "";

        steps.forEach((step, index) => {
            const item = document.createElement("div");
            item.className = "teach-step";

            let description = `${index + 1}. ${step.type}`;

            if (step.type === "move") {
                description += ` — X:${step.x}, Y:${step.y}, Z:${step.z}, R:${step.r}`;
            } else if (step.type === "tool") {
                description += ` — ${step.action}`;
            } else if (step.type === "wait") {
                description += ` — ${step.seconds} seconds`;
            }

            item.textContent = description;
            $("teachSteps").appendChild(item);
        });

        currentStepNumber = steps.length + 1;
    }
}

async function startTeaching() {
    const name = $("teachName")?.value.trim();
    const tool = $("teachTool")?.value || "suction";

    if (!name) {
        alert("Enter a program name first.");
        return;
    }

    if (!confirm(
        "Start a new teaching session?\nMake sure the robot is connected and the workspace is safe."
    )) return;

    const data = await safeRequest("/api/teach/start", "POST", {
        name,
        tool,
        overwrite: false
    });

    if (data) {
        log(`Teaching started: ${name}`);
        await refreshTeachingSession();
    }
}

async function cancelTeaching() {
    if (!confirm("Cancel this teaching session? Unsaved steps will be lost.")) return;

    const data = await safeRequest("/api/teach/cancel", "POST");

    if (data) {
        log("Teaching session cancelled");
        await refreshTeachingSession();
    }
}

async function recordPoint() {
    const name = $("pointName")?.value.trim() ||
        `Point ${currentStepNumber}`;

    const data = await safeRequest("/api/teach/record", "POST", { name });

    if (data) {
        log(`Recorded: ${name}`);
        if ($("pointName")) {
            $("pointName").value = `Point ${currentStepNumber + 1}`;
        }
        await refreshTeachingSession();
    }
}

async function teachAction(action) {
    const data = await safeRequest("/api/teach/action", "POST", { action });

    if (data) {
        log(`Teaching tool action: ${action}`);
        await refreshTeachingSession();
    }
}

async function addWait() {
    const seconds = Number($("waitSeconds")?.value);

    if (!Number.isFinite(seconds) || seconds <= 0) {
        alert("Enter a valid wait time.");
        return;
    }

    const data = await safeRequest("/api/teach/wait", "POST", { seconds });

    if (data) {
        log(`Added wait: ${seconds} seconds`);
        await refreshTeachingSession();
    }
}

async function undoTeach() {
    const data = await safeRequest("/api/teach/undo", "POST");

    if (data) {
        log("Last teaching step removed");
        await refreshTeachingSession();
    }
}

async function saveTeaching() {
    if (!confirm("Save this teaching program?")) return;

    let data = await safeRequest("/api/teach/save", "POST", {
        overwrite: false
    });

    if (!data) {
        // If the backend reports that the file already exists,
        // ask before attempting to overwrite it.
        const overwrite = confirm(
            "The program may already exist. Do you want to overwrite it?"
        );

        if (!overwrite) return;

        data = await safeRequest("/api/teach/save", "POST", {
            overwrite: true
        });
    }

    if (data) {
        log("Teaching program saved");
        await refreshPrograms();
        await refreshTeachingSession();
    }
}

// ---------------- PROGRAMS ----------------

async function refreshPrograms() {
    const data = await safeRequest("/api/programs");
    if (!data) return;

    const select = $("programSelect");
    if (!select) return;

    const programs = data.programs || data;

    select.innerHTML = "";

    if (!Array.isArray(programs) || programs.length === 0) {
        select.add(new Option("No saved programs", ""));
        return;
    }

    programs.forEach(program => {
        const name = typeof program === "string" ? program : program.name;
        if (name) select.add(new Option(name, name));
    });
}

async function loadProgram() {
    const name = $("programSelect")?.value;

    if (!name) {
        alert("Select a program first.");
        return;
    }

    const data = await safeRequest("/api/programs/load", "POST", { name });

    if (data) {
        log(`Loaded program: ${name}`);
        console.log("Loaded program:", data);
        alert(`Program "${name}" loaded. Check the console for its steps.`);
    }
}

async function playProgram() {
    const name = $("programSelect")?.value;
    const speed = Number($("playSpeed")?.value || 25);
    const repeat = Number($("playRepeat")?.value || 1);

    if (!name) {
        alert("Select a program first.");
        return;
    }

    const message =
        `Run program: ${name}\nSpeed: ${speed}%\nRepeats: ${repeat}\n\n` +
        "Ensure the robot workspace is clear and the program has been checked.";

    if (!confirm(message)) return;

    const data = await safeRequest("/api/play", "POST", {
        name,
        speed,
        repeat,
        confirmed: true
    });

    if (data) log(`Playback started: ${name}`);
}

async function stopPlayback() {
    const data = await safeRequest("/api/play/stop", "POST");
    if (data) log("Playback stop requested");
}

function updatePlayback(data) {
    if (!data) return;

    if ($("playStatus")) {
        $("playStatus").textContent =
            data.message ||
            (data.running ? "Program running" : "Playback idle");
    }

    if ($("playProgress")) {
        const current = Number(data.current || data.completed || 0);
        const total = Number(data.total || 0);
        const percent = total > 0 ? (current / total) * 100 : 0;

        $("playProgress").style.width = `${Math.min(100, percent)}%`;
    }
}

// ---------------- EMERGENCY STOP ----------------

async function emergencyStop() {
    if (!confirm(
        "EMERGENCY STOP\n\nThis sends a software stop command. It is NOT a replacement for the physical emergency stop.\n\nProceed?"
    )) return;

    await stopJoystick();

    const data = await safeRequest("/api/estop", "POST");

    if (data) {
        log("Software emergency stop activated", "error");
        await refreshStatus();
    }
}

async function resetStop() {
    if (!confirm("Reset software emergency stop? Ensure the robot is safe first.")) return;

    const data = await safeRequest("/api/reset-estop", "POST");

    if (data) {
        log("Software emergency stop reset");
        await refreshStatus();
    }
}

// ---------------- WEBSOCKET ----------------

function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);

    socket.onopen = () => {
        log("Live connection established");
    };

    socket.onmessage = event => {
        let message;

        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }

        if (message.type === "status") {
            updateStatus(message.data || message);
        } else if (message.type === "playback") {
            updatePlayback(message.data || message);
        } else if (message.type === "log") {
            log(message.message || "Backend update");
        }
    };

    socket.onclose = () => {
        log("Live connection lost. Reconnecting...");
        setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = () => {
        socket.close();
    };
}

// ---------------- INITIALIZATION ----------------

async function initialize() {
    setupJoystick();

    await refreshPorts();
    await refreshStatus();
    await refreshPrograms();
    await refreshTeachingSession();

    connectWebSocket();

    // Keep the dashboard status fresh even if WebSocket updates are missed.
    setInterval(refreshStatus, 2000);

    log("Dobot dashboard initialized");
}

initialize();
