/**
 * =============================================================================
 * DOBOT MAGICIAN • SMART ROBOTICS CONTROL SYSTEM
 * CORE SCADA TELEMETRY & MOTION CONTROLLER (app.js)
 * =============================================================================
 */

const $ = (id) => document.getElementById(id);

let socket = null;
let joystickHeld = false;
let joystickButton = null;
let currentStepNumber = 1;

// Virtual touch joystick state
let vjoyActive = false;
let vjoyAxis = null;
let vjoyDir = 0;
let vjoyLoopTimer = null;

// =============================================================================
// LOGGING & SYSTEM CONSOLE
// =============================================================================

function log(message, type = "info") {
    const box = $("logs");
    if (!box) return;

    const line = document.createElement("div");
    const timestamp = new Date().toLocaleTimeString();
    line.textContent = `[${timestamp}] ${message}`;
    line.className = `log-${type}`;
    box.prepend(line);

    // Limit log retention to 100 entries to maintain high performance
    while (box.children.length > 100) {
        box.removeChild(box.lastChild);
    }
}

function clearEventLogs() {
    const box = $("logs");
    if (!box) return;
    box.innerHTML = `<div class="log-info">[${new Date().toLocaleTimeString()}] Event log buffer cleared by operator.</div>`;
}

// =============================================================================
// HTTP API REQUEST WRAPPERS
// =============================================================================

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

// =============================================================================
// KINEMATIC STATUS & SCADA HUD
// =============================================================================

function updateStatus(data) {
    if (!data) return;

    const connected = data.connected ?? data.is_connected ?? false;

    // 1. Connection Status Badge & LED
    const connEl = $("connectionStatus");
    const connLed = $("connectionLed");
    if (connEl) {
        connEl.textContent = connected ? "CONNECTED" : "DISCONNECTED";
        connEl.style.color = connected ? "var(--emerald)" : "var(--crimson)";
    }
    if (connLed) {
        connLed.className = connected ? "led-dot led-connected" : "led-dot led-disconnected";
    }

    // 2. Hardware Info
    if ($("robotInfo")) {
        $("robotInfo").textContent = connected
            ? "Dobot Magician serial link active • Ready"
            : "No robot connected. Check port & cable.";
    }

    // 3. Coordinates (X, Y, Z, R)
    const pose = data.pose || data.position || {};
    const values = {
        posX: pose.x ?? data.x,
        posY: pose.y ?? data.y,
        posZ: pose.z ?? data.z,
        posR: pose.r ?? data.r
    };

    let curX = 0, curY = 0, curZ = 0, curR = 0;

    Object.entries(values).forEach(([id, value]) => {
        if ($(id) && value !== undefined && value !== null) {
            const num = Number(value);
            $(id).textContent = num.toFixed(1);
            if (id === "posX") curX = num;
            if (id === "posY") curY = num;
            if (id === "posZ") curZ = num;
            if (id === "posR") curR = num;
        }
    });

    // 4. Update Graphic Gauge Bars
    updateBarGauge("barX", curX, 100, 320);
    updateBarGauge("barY", curY, -200, 200);
    updateBarGauge("barZ", curZ, -50, 150);
    updateBarGauge("barR", curR, -180, 180);

    // 5. Update 2D Envelope Radar Canvas
    drawEnvelopeRadar(curX, curY);

    // 6. Tool Status
    if ($("toolStatus")) {
        const toolStr = String(data.tool || "Unknown").toUpperCase();
        $("toolStatus").textContent = toolStr;
        if (toolStr.includes("OPEN") || toolStr.includes("SUCTION")) {
            $("toolStatus").style.color = "var(--cyan)";
        } else if (toolStr.includes("CLOSE")) {
            $("toolStatus").style.color = "var(--emerald)";
        } else {
            $("toolStatus").style.color = "var(--text-secondary)";
        }
    }

    // 7. Motion Status
    const isMoving = Boolean(data.moving);
    const moveEl = $("movementStatus");
    const motionLed = $("motionLed");
    if (moveEl) {
        moveEl.textContent = isMoving ? "MOVING" : "IDLE";
        moveEl.style.color = isMoving ? "var(--cyan)" : "var(--text-secondary)";
    }
    if (motionLed) {
        motionLed.className = isMoving ? "led-dot led-moving" : "led-dot";
    }

    // 8. Robot State
    const stateEl = $("robotState");
    const stateLed = $("stateLed");
    let stateText = "OFFLINE";
    let stateColor = "var(--text-muted)";

    if (data.estop) {
        stateText = "EMERGENCY STOP";
        stateColor = "var(--crimson)";
    } else if (data.fault) {
        stateText = "FAULT";
        stateColor = "var(--crimson)";
    } else if (data.homing) {
        stateText = "HOMING";
        stateColor = "var(--amber)";
    } else if (data.homed) {
        stateText = "READY";
        stateColor = "var(--emerald)";
    } else if (connected) {
        stateText = "CONNECTED";
        stateColor = "var(--cyan)";
    }

    if (stateEl) {
        stateEl.textContent = stateText;
        stateEl.style.color = stateColor;
    }
    if (stateLed) {
        if (stateText === "EMERGENCY STOP" || stateText === "FAULT") {
            stateLed.className = "led-dot led-disconnected";
        } else if (stateText === "READY") {
            stateLed.className = "led-dot led-connected";
        } else if (stateText === "HOMING") {
            stateLed.className = "led-dot led-moving";
        } else {
            stateLed.className = "led-dot";
        }
    }
}

function updateBarGauge(barId, val, min, max) {
    const el = $(barId);
    if (!el) return;
    const clamped = Math.max(min, Math.min(max, val));
    const percent = ((clamped - min) / (max - min)) * 100;
    el.style.width = `${Math.max(5, Math.min(100, percent))}%`;
}

function drawEnvelopeRadar(x, y) {
    const canvas = $("envelopeCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const originX = w / 2;
    const originY = h - 15;
    const maxRadius = 110; // represents 320mm reach

    // Draw coordinate grid arcs
    ctx.strokeStyle = "rgba(0, 240, 255, 0.15)";
    ctx.lineWidth = 1;

    [0.33, 0.66, 1.0].forEach(ratio => {
        ctx.beginPath();
        ctx.arc(originX, originY, maxRadius * ratio, Math.PI, 0);
        ctx.stroke();
    });

    // Radial guide lines
    [-60, -30, 0, 30, 60].forEach(deg => {
        const rad = (deg - 90) * (Math.PI / 180);
        ctx.beginPath();
        ctx.moveTo(originX, originY);
        ctx.lineTo(originX + maxRadius * Math.cos(rad), originY + maxRadius * Math.sin(rad));
        ctx.stroke();
    });

    // Robot arm base
    ctx.fillStyle = "#0284c7";
    ctx.beginPath();
    ctx.arc(originX, originY, 6, 0, Math.PI * 2);
    ctx.fill();

    // Map Cartesian (X forward, Y lateral) to Canvas (x horizontal, y vertical)
    // Scale: 320mm = maxRadius
    const scale = maxRadius / 320;
    const targetCanvasX = originX + (y * scale);
    const targetCanvasY = originY - (x * scale);

    // Arm Link Vector
    ctx.strokeStyle = "rgba(0, 240, 255, 0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(targetCanvasX, targetCanvasY);
    ctx.stroke();

    // End effector target point
    ctx.fillStyle = "#00f0ff";
    ctx.shadowColor = "#00f0ff";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(targetCanvasX, targetCanvasY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0; // reset

    if ($("radarCoords")) {
        $("radarCoords").textContent = `X: ${x.toFixed(1)} | Y: ${y.toFixed(1)}`;
    }
}

async function refreshStatus() {
    const data = await safeRequest("/api/status");
    if (data) updateStatus(data);
}

// =============================================================================
// SERIAL CONNECTION
// =============================================================================

async function refreshPorts() {
    const data = await safeRequest("/api/ports");
    if (!data) return;

    const select = $("port");
    if (!select) return;

    select.innerHTML = "";

    const ports = data.ports || data;

    if (!Array.isArray(ports) || ports.length === 0) {
        select.add(new Option("No COM ports found", ""));
        return;
    }

    ports.forEach(port => {
        const name = typeof port === "string" ? port : (port.device || port.port);
        if (name) select.add(new Option(name, name));
    });

    log(`Serial port enumeration: ${ports.length} port(s) detected`);
}

async function connectRobot() {
    const port = $("port")?.value;

    if (!port) {
        alert("Select a valid COM port from the dropdown first.");
        return;
    }

    log(`Initiating serial handshake on ${port}...`);
    const data = await safeRequest("/api/connect", "POST", { port });

    if (data) {
        log(`Connection established on ${port}`);
        await refreshStatus();
    }
}

async function disconnectRobot() {
    const data = await safeRequest("/api/disconnect", "POST");

    if (data) {
        log("Robot serial interface disconnected");
        await refreshStatus();
    }
}

// =============================================================================
// CARTESIAN POSITIONING & END EFFECTOR
// =============================================================================

function nudgeInput(inputId, delta) {
    const el = $(inputId);
    if (!el) return;
    const current = Number(el.value || 0);
    el.value = current + delta;
}

function applyPreset(x, y, z, r) {
    if ($("x")) $("x").value = x;
    if ($("y")) $("y").value = y;
    if ($("z")) $("z").value = z;
    if ($("r")) $("r").value = r;
    log(`Preset applied: X=${x}, Y=${y}, Z=${z}, R=${r}`);
}

async function moveRobot() {
    const position = {
        x: Number($("x")?.value),
        y: Number($("y")?.value),
        z: Number($("z")?.value),
        r: Number($("r")?.value)
    };

    if (Object.values(position).some(v => !Number.isFinite(v))) {
        alert("Please enter valid finite numeric values for X, Y, Z, and R.");
        return;
    }

    if (!confirm(
        `Execute trajectory to:\nX: ${position.x} mm\nY: ${position.y} mm\nZ: ${position.z} mm\nR: ${position.r}°\n\nEnsure Dobot workspace is clear.`
    )) return;

    log(`Executing motion to [X:${position.x}, Y:${position.y}, Z:${position.z}, R:${position.r}]`);
    const data = await safeRequest("/api/move", "POST", position);
    if (data) log("Movement command accepted by motion controller");
}

async function toolAction(action) {
    const data = await safeRequest("/api/tool", "POST", { action });
    if (data) log(`End effector actuation: ${action.toUpperCase()}`);
}

async function homeRobot() {
    if (!confirm("Initiate robotic homing calibration sequence?\nWorkspace must be unobstructed.")) return;

    log("Homing sequence initiated...");
    const data = await safeRequest("/api/home", "POST");
    if (data) log("Robot returned to home datum point");
}

// =============================================================================
// INDUSTRIAL JOG & JOYSTICK ENGINE
// =============================================================================

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
            if (joystickHeld) log(`Joystick jog error: ${error.message}`, "error");
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
    const wasHeld = joystickHeld || vjoyActive;

    joystickHeld = false;
    vjoyActive = false;

    if (joystickButton) {
        joystickButton.classList.remove("active");
    }
    joystickButton = null;

    if (vjoyLoopTimer) {
        clearInterval(vjoyLoopTimer);
        vjoyLoopTimer = null;
    }

    // Reset touch puck to center
    const puck = $("vjoyPuck");
    if (puck) {
        puck.style.transform = "translate(-50%, -50%)";
    }

    if (wasHeld) {
        try {
            await request("/api/jog/stop", "POST");
            log("Jog motion halted");
        } catch (error) {
            log(`Jog stop failed: ${error.message}`, "error");
        }
    }
}

function setupJoystick() {
    // 1. D-Pad & Rocker Buttons
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

    // 2. Interactive Tablet Touch Joystick Puck
    setupVirtualJoystick();

    // 3. Slider to Input Two-Way Bindings
    setupSpeedSliders();
}

function setupVirtualJoystick() {
    const stage = $("vjoyStage");
    const puck = $("vjoyPuck");
    if (!stage || !puck) return;

    const maxRadius = 45; // max drag radius in px

    const handlePointerMove = (e) => {
        if (!vjoyActive) return;
        const rect = stage.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let dx = e.clientX - centerX;
        let dy = e.clientY - centerY;
        const dist = Math.hypot(dx, dy);

        if (dist > maxRadius) {
            dx = (dx / dist) * maxRadius;
            dy = (dy / dist) * maxRadius;
        }

        puck.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

        // Determine dominant axis for robot jog
        const deadzone = 12;
        if (dist > deadzone) {
            if (Math.abs(dx) > Math.abs(dy)) {
                vjoyAxis = "X";
                vjoyDir = dx > 0 ? 1 : -1;
            } else {
                vjoyAxis = "Y";
                vjoyDir = dy < 0 ? 1 : -1; // screen up is Y+ forward
            }
        } else {
            vjoyAxis = null;
            vjoyDir = 0;
        }
    };

    stage.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        vjoyActive = true;
        stage.setPointerCapture?.(e.pointerId);
        handlePointerMove(e);

        if (!vjoyLoopTimer) {
            vjoyLoopTimer = setInterval(async () => {
                if (!vjoyActive || !vjoyAxis || vjoyDir === 0) return;
                const step = Number($("jogStep")?.value || 5);
                const speed = Number($("jogSpeed")?.value || 20);
                try {
                    await request("/api/jog", "POST", {
                        axis: vjoyAxis,
                        direction: vjoyDir,
                        step,
                        speed
                    });
                } catch (err) {
                    log(`Virtual jog: ${err.message}`, "error");
                }
            }, 180);
        }
    });

    stage.addEventListener("pointermove", handlePointerMove);
    stage.addEventListener("pointerup", (e) => {
        stopJoystick();
    });
    stage.addEventListener("pointercancel", (e) => {
        stopJoystick();
    });
}

function setupSpeedSliders() {
    // Jog Speed Slider <-> Input sync
    const jogSlider = $("jogSpeedSlider");
    const jogInput = $("jogSpeed");
    const jogValBadge = $("jogSpeedVal");

    if (jogSlider && jogInput) {
        jogSlider.addEventListener("input", () => {
            jogInput.value = jogSlider.value;
            if (jogValBadge) jogValBadge.textContent = jogSlider.value;
        });
        jogInput.addEventListener("input", () => {
            jogSlider.value = jogInput.value;
            if (jogValBadge) jogValBadge.textContent = jogInput.value;
        });
    }

    // Playback Speed Slider <-> Input sync
    const playSlider = $("playSpeedSlider");
    const playInput = $("playSpeed");
    const playValBadge = $("playSpeedVal");

    if (playSlider && playInput) {
        playSlider.addEventListener("input", () => {
            playInput.value = playSlider.value;
            if (playValBadge) playValBadge.textContent = playSlider.value;
        });
        playInput.addEventListener("input", () => {
            playSlider.value = playInput.value;
            if (playValBadge) playValBadge.textContent = playInput.value;
        });
    }
}

// =============================================================================
// TEACH & REPLAY SEQUENCING
// =============================================================================

async function refreshTeachingSession(sessionData = null) {
    const data = sessionData || await safeRequest("/api/teach/session");
    if (!data) return;

    const steps = data.steps || [];

    if ($("teachStatus")) {
        $("teachStatus").textContent = data.active
            ? "Teaching session active • Recording"
            : "No active teaching session";
        $("teachStatus").style.color = data.active ? "var(--cyan)" : "var(--amber)";
    }

    if ($("teachSteps")) {
        $("teachSteps").innerHTML = "";

        if (steps.length === 0) {
            $("teachSteps").innerHTML = '<div class="empty-timeline-hint">No steps recorded in current session.</div>';
        } else {
            steps.forEach((step, index) => {
                const item = document.createElement("div");
                item.className = "teach-step";

                let icon = "📍";
                let desc = `${index + 1}. `;

                if (step.move || step.type === "move") {
                    icon = "🎯";
                    const coords = Array.isArray(step.move)
                        ? `X:${step.move[0]} Y:${step.move[1]} Z:${step.move[2]} R:${step.move[3]}`
                        : `X:${step.x} Y:${step.y} Z:${step.z} R:${step.r}`;
                    const ptName = step.name ? `[${step.name}] ` : "";
                    desc += `${ptName}MOVE — ${coords}`;
                } else if (step.tool !== undefined || step.type === "tool") {
                    icon = "🔧";
                    const act = (step.tool || step.action || "").toUpperCase();
                    desc += `TOOL — ${act}`;
                } else if (step.wait !== undefined || step.type === "wait") {
                    icon = "⏱";
                    const w = step.wait !== undefined ? step.wait : step.seconds;
                    desc += `WAIT — Dwell ${w}s`;
                } else {
                    desc += JSON.stringify(step);
                }

                item.innerHTML = `<span><strong>${icon}</strong> ${desc}</span>`;
                $("teachSteps").appendChild(item);
            });
        }

        currentStepNumber = steps.length + 1;
    }
}

async function startTeaching() {
    const name = $("teachName")?.value.trim();
    const tool = $("teachTool")?.value || "suction";

    if (!name) {
        alert("Enter a program name identifier first.");
        return;
    }

    if (!confirm(
        `Start new teaching session for "${name}"?\nEnsure robot workspace is clear and safe.`
    )) return;

    const data = await safeRequest("/api/teach/start", "POST", {
        name,
        tool,
        overwrite: false
    });

    if (data) {
        log(`Teach session started: ${name} (Tool: ${tool})`);
        await refreshTeachingSession();
    }
}

async function cancelTeaching() {
    if (!confirm("Cancel active teaching session? Unsaved waypoints will be discarded.")) return;

    const data = await safeRequest("/api/teach/cancel", "POST");

    if (data) {
        log("Teaching session cancelled");
        await refreshTeachingSession();
    }
}

async function recordPoint() {
    const name = $("pointName")?.value.trim() || `Point ${currentStepNumber}`;

    const data = await safeRequest("/api/teach/record", "POST", { name });

    if (data) {
        log(`Waypoint recorded: ${name}`);
        if ($("pointName")) {
            $("pointName").value = `Point ${currentStepNumber + 1}`;
        }
        await refreshTeachingSession();
    }
}

async function teachAction(action) {
    const data = await safeRequest("/api/teach/action", "POST", { action });

    if (data) {
        log(`Injected tool action: ${action.toUpperCase()}`);
        await refreshTeachingSession();
    }
}

async function addWait() {
    const seconds = Number($("waitSeconds")?.value);

    if (!Number.isFinite(seconds) || seconds <= 0) {
        alert("Enter a valid positive wait time in seconds.");
        return;
    }

    const data = await safeRequest("/api/teach/wait", "POST", { seconds });

    if (data) {
        log(`Injected dwell wait: ${seconds} second(s)`);
        await refreshTeachingSession();
    }
}

async function undoTeach() {
    const data = await safeRequest("/api/teach/undo", "POST");

    if (data) {
        log("Last teaching step removed (Undo)");
        await refreshTeachingSession();
    }
}

async function saveTeaching() {
    if (!confirm("Commit and save this teaching program to storage?")) return;

    let data = await safeRequest("/api/teach/save", "POST", {
        overwrite: false
    });

    if (!data) {
        const overwrite = confirm(
            "A program with this name already exists. Overwrite existing program?"
        );

        if (!overwrite) return;

        data = await safeRequest("/api/teach/save", "POST", {
            overwrite: true
        });
    }

    if (data) {
        log("Teaching sequence program successfully saved");
        await refreshPrograms();
        await refreshTeachingSession();
    }
}

// =============================================================================
// PROGRAM REPLAY ENGINE
// =============================================================================

async function refreshPrograms() {
    const data = await safeRequest("/api/programs");
    if (!data) return;

    const select = $("programSelect");
    if (!select) return;

    const programs = data.programs || data;

    select.innerHTML = "";

    if (!Array.isArray(programs) || programs.length === 0) {
        select.add(new Option("No saved programs found", ""));
        return;
    }

    programs.forEach(program => {
        const name = typeof program === "string" ? program : (program.name || program.title);
        if (name) select.add(new Option(name, name));
    });

    log(`Program directory: ${programs.length} saved program(s)`);
}

async function loadProgram() {
    const name = $("programSelect")?.value;

    if (!name) {
        alert("Select a saved program from the dropdown first.");
        return;
    }

    const data = await safeRequest("/api/programs/load", "POST", { name });

    if (data) {
        log(`Program "${name}" loaded`);
        console.log("Loaded program:", data);
        alert(`Program "${name}" loaded successfully.`);
    }
}

async function playProgram() {
    const name = $("programSelect")?.value;
    const speed = Number($("playSpeed")?.value || 25);
    const repeat = Number($("playRepeat")?.value || 1);

    if (!name) {
        alert("Select a program from the dropdown first.");
        return;
    }

    const message =
        `COMMENCE AUTOMATED PLAYBACK:\nProgram: ${name}\nVelocity: ${speed}%\nCycles: ${repeat}\n\n` +
        "Ensure robot envelope is cleared before proceeding.";

    if (!confirm(message)) return;

    const data = await safeRequest("/api/play", "POST", {
        name,
        speed,
        repeat,
        confirmed: true
    });

    if (data) log(`Replay started: ${name} (${repeat} cycle(s) @ ${speed}%)`);
}

async function stopPlayback() {
    const data = await safeRequest("/api/play/stop", "POST");
    if (data) log("Replay execution halt requested");
}

function updatePlayback(data) {
    if (!data) return;

    const running = Boolean(data.running);
    const statusText = data.message || (running ? "Program running..." : "Playback idle.");

    if ($("playStatus")) {
        $("playStatus").textContent = statusText;
        $("playStatus").style.color = running ? "var(--cyan)" : "var(--text-secondary)";
    }

    const current = Number(data.current || data.completed || 0);
    const total = Number(data.total || 0);
    const percent = total > 0 ? (current / total) * 100 : 0;
    const boundedPercent = Math.min(100, Math.max(0, percent));

    if ($("playProgress")) {
        $("playProgress").value = boundedPercent;
        $("playProgress").style.width = `${boundedPercent}%`;
    }

    if ($("customProgressBar")) {
        $("customProgressBar").style.width = `${boundedPercent}%`;
    }

    if ($("playPercentVal")) {
        $("playPercentVal").textContent = `${boundedPercent.toFixed(0)}%`;
    }
}

// =============================================================================
// EMERGENCY CONTROLS
// =============================================================================

async function emergencyStop() {
    if (!confirm(
        "MASTER EMERGENCY STOP\n\nTrigger immediate software trajectory inhibit?\n\nProceed?"
    )) return;

    await stopJoystick();

    const data = await safeRequest("/api/estop", "POST");

    if (data) {
        log("CRITICAL: Software emergency stop activated!", "error");
        await refreshStatus();
    }
}

async function resetStop() {
    if (!confirm("Reset software emergency stop condition?\nEnsure robot hardware is safe.")) return;

    const data = await safeRequest("/api/reset-estop", "POST");

    if (data) {
        log("Emergency stop reset command issued");
        await refreshStatus();
    }
}

// =============================================================================
// WEBSOCKET TELEMETRY CLIENT
// =============================================================================

function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);

    socket.onopen = () => {
        log("Real-time WebSocket telemetry link established");
        if ($("commStatus")) {
            $("commStatus").textContent = "CONNECTED (WS)";
            $("commStatus").style.color = "var(--emerald)";
        }
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
        } else if (message.type === "teaching") {
            refreshTeachingSession(message.data || message);
        } else if (message.type === "event" || message.type === "log") {
            const text = message.msg || message.message || "Robot event received";
            const lvl = message.level || (message.type === "event" ? "info" : "info");
            log(text, lvl);
        }
    };

    socket.onclose = () => {
        log("WebSocket telemetry link disconnected. Reconnecting in 3s...", "error");
        if ($("commStatus")) {
            $("commStatus").textContent = "RECONNECTING...";
            $("commStatus").style.color = "var(--amber)";
        }
        setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = () => {
        socket.close();
    };
}

// =============================================================================
// SYSTEM CLOCK & INITIALIZATION
// =============================================================================

function startSystemClock() {
    const clockEl = $("systemClock");
    if (!clockEl) return;

    function tick() {
        const now = new Date();
        const hrs = String(now.getUTCHours()).padStart(2, "0");
        const mins = String(now.getUTCMinutes()).padStart(2, "0");
        const secs = String(now.getUTCSeconds()).padStart(2, "0");
        clockEl.textContent = `${hrs}:${mins}:${secs}`;
    }

    tick();
    setInterval(tick, 1000);
}

async function initialize() {
    startSystemClock();
    setupJoystick();

    await refreshPorts();
    await refreshStatus();
    await refreshPrograms();
    await refreshTeachingSession();

    connectWebSocket();

    // Secondary polling to guarantee telemetry freshness if WS packet dropped
    setInterval(refreshStatus, 2000);

    log("Dobot SCADA Smart Robotics Control Center online");
}

initialize();
