"""AFRi Studio backend.

Binds to localhost by default. Exposing it beyond the machine requires setting
AFRI_ALLOW_PUBLIC=1 explicitly -- it never happens by accident.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api import routes, routes_extra
from backend.app.core.config import ALLOW_PUBLIC, ensure_dirs, find_blender
from backend.app.database.db import init_db
from backend.app.events.bus import bus
from backend.app.jobs import manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    from backend.app.versions import store
    store.ensure_default_project()
    manager.start_workers()
    b = find_blender()
    bus.publish("system.ready", {
        "blender": b.version if b.available else None,
        "blender_available": b.available,
        "blender_error": b.error})
    yield
    manager.stop_workers()


app = FastAPI(title="AFRi Studio", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if ALLOW_PUBLIC else
    ["http://localhost:5173", "http://127.0.0.1:5173",
     "http://localhost:4173", "http://127.0.0.1:4173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)
app.include_router(routes_extra.router)


@app.get("/health")
def health():
    b = find_blender()
    return {"ok": True, "blender": b.available}
