# Web-Based Teaching Interface for Dobot Magician

## 1. Project Overview

This project presents the development of a web-based teaching and control interface for the Dobot Magician robotic arm. The system provides a browser-based platform through which users can connect to and operate the physical robot, record movement sequences, and execute predefined programs.

The interface is designed to make robot operation more accessible through a simple and organised control environment. It uses a Python-based backend developed with FastAPI and a frontend developed using HTML, CSS and JavaScript.

The application can be accessed through a desktop, laptop, tablet or mobile browser when the device and host computer are connected to the same local network.

## 2. Features

### Robot Connection and Control
- Connect to the Dobot Magician through the backend.
- Control the robot using Cartesian coordinates (X, Y, Z and R).
- Perform individual axis movements using jogging controls.
- Control the robot's end effector and supported tool functions.
- View robot connection and operating status.

### Teaching and Program Recording
- Record robot positions as waypoints.
- Create movement sequences for repetitive tasks.
- Undo previously recorded steps.
- Insert waiting steps between movements.
- Save, load and delete recorded programs.

### Program Execution
- Execute saved teaching programs.
- Adjust playback speed.
- Set program repetition.
- Stop program execution when required.

### Monitoring and Interface
- View robot status and feedback.
- Monitor control activities through the interface.
- Receive live updates through WebSocket communication.
- Access the interface through a web browser.

## 3. Technology Stack

| Component | Technology |
|---|---|
| Backend | Python |
| Backend Framework | FastAPI |
| Frontend | HTML, CSS, JavaScript |
| Communication | HTTP REST API and WebSocket |
| Robot | Dobot Magician |
| Server | Uvicorn |
| Interface | Web Browser |

## 4. System Architecture

The application follows a client-server architecture.

1. **Frontend:** The browser-based interface provides controls for robot movement, teaching, program management and monitoring.
2. **Backend:** The FastAPI server processes requests received from the frontend and manages robot communication.
3. **Robot Communication:** The backend communicates with the physical Dobot Magician and handles the corresponding control operations.
4. **Real-Time Updates:** WebSocket communication is used to send status and activity updates to the frontend.

## 5. Project Structure

The project is organised into the following main components. The exact filenames may vary depending on the final repository structure.

```text
dobot_web_control/
│
├── run.py
│
├── static/
│   ├── index.html
│   ├── style.css
│   └── script.js
│
├── static_backup/
│
├── requirements.txt
│
└── README.md
```

## 6. Installation and Setup

### Prerequisites

- Python 3.9
- Dobot Magician robotic arm
- USB connection between the robot and host computer
- A web browser
- Computer and client device connected to the same local network

### Step 1: Clone the Repository

```bash
git clone YOUR_GITHUB_REPOSITORY_LINK
```

Navigate to the project directory:

```bash
cd dobot_web_control
```

### Step 2: Create a Virtual Environment

```bash
python -m venv venv
```

Activate the environment on Windows:

```bash
venv\Scripts\activate
```

### Step 3: Install Dependencies

```bash
pip install -r requirements.txt
```

If a requirements file is not available, install the required packages:

```bash
pip install fastapi uvicorn
```

Install any additional dependencies required by the robot communication module.

## 7. Running the Application

Start the FastAPI server using:

```bash
python -m uvicorn run:app --host 0.0.0.0 --port 8000
```

Once the server starts, open the following address in a browser on the host computer:

```text
http://localhost:8000
```

To access the interface from another device on the same network, use:

```text
http://HOST_COMPUTER_IP:8000
```

Replace `HOST_COMPUTER_IP` with the local IPv4 address of the computer running the application.

## 8. Operating Procedure

1. Connect the Dobot Magician to the host computer using USB.
2. Start the web application.
3. Open the interface through a browser.
4. Establish communication with the robot.
5. Use the manual controls to move the robot.
6. Open the teaching section to record required positions.
7. Arrange the recorded steps into a program.
8. Save the program for future use.
9. Execute the program using the playback controls.
10. Monitor the robot and stop execution when necessary.

## 9. Safety Considerations

- Ensure that the robot's workspace is clear before operation.
- Keep hands and objects away from moving joints and the end effector.
- Verify the robot's position before executing a recorded program.
- Use the stop control whenever program execution needs to be interrupted.
- The software stop function is not a replacement for the physical emergency stop.
- Operate the robot under appropriate supervision.

## 10. Limitations and Future Scope

The current implementation focuses on browser-based control and teaching of a single Dobot Magician robotic arm. The web-based interface and the digital twin are separate software components in the current implementation.

Future development may include integration with the digital twin, virtual preview of recorded programs, improved robot monitoring, support for multiple robotic arms and more advanced automated task execution.

## 11. Project Information

**Project:** Design and Development of a Digital Twin and Teaching Interface for the Dobot Magician

**Component:** Web-Based Teaching Interface

**Institution:** Indian Institute of Technology Bombay

**Purpose:** Academic Project / B.Tech Project

---

*This repository contains the source code for the web-based teaching interface developed as part of the project.*
