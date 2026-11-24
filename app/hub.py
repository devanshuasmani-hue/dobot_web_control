"""WebSocket hub. emit() is safe to call from any thread."""
import asyncio
import json
import time
from collections import deque


class Hub:
    def __init__(self):
        self.clients = set()
        self.loop = None
        self.log = deque(maxlen=100)
        self.on_all_gone = None            # called after the grace period with no browser
        self.grace = lambda: 3.0
        self._gone_handle = None

    # ---- thread-safe publish
    def emit(self, type_, **payload):
        msg = {"type": type_, **payload}
        if type_ == "event":
            msg["ts"] = time.strftime("%H:%M:%S")
            self.log.append(msg)
        if self.loop is None or not self.clients:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast(msg), self.loop)
        except RuntimeError:
            pass

    async def _broadcast(self, msg):
        text = json.dumps(msg)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # ---- connection management (event-loop thread)
    async def connect(self, ws, initial):
        await ws.accept()
        self.clients.add(ws)
        if self._gone_handle:
            self._gone_handle.cancel()
            self._gone_handle = None
        for m in initial:
            await ws.send_text(json.dumps(m))
        for m in list(self.log):
            await ws.send_text(json.dumps(m))

    def disconnect(self, ws):
        self.clients.discard(ws)
        if not self.clients and self.loop and self.on_all_gone:
            if self._gone_handle:
                self._gone_handle.cancel()
            self._gone_handle = self.loop.call_later(self.grace(), self._check_gone)

    def _check_gone(self):
        self._gone_handle = None
        if not self.clients and self.on_all_gone:
            self.on_all_gone()
