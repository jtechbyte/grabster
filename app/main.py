import os
import json
import asyncio
import logging
import mimetypes
import re
import shutil
import time
import uuid
from datetime import timedelta
from pathlib import Path
from typing import List, Optional

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, validator

from app.core.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    Token,
    create_access_token,
    get_current_user,
    get_password_hash,
    verify_password,
    validate_password,
    strength_report,
)
from app.core.config import SettingsModel, config
from app.core.db import db
from app.core.downloader import DownloadManager, DownloadJob, VideoInfo

logger = logging.getLogger("app.main")

# ---------------------------------------------------------------------------
# Environment configuration
# ---------------------------------------------------------------------------
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "uploads"))
CONVERT_DIR = Path(os.environ.get("CONVERT_DIR", "converted"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CONVERT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# FastAPI application – docs only exposed in DEBUG mode
# ---------------------------------------------------------------------------
app = FastAPI(
    title="GrabSter",
    version="1.0.0",
    docs_url="/docs" if DEBUG else None,
    redoc_url="/redoc" if DEBUG else None,
    openapi_url="/openapi.json" if DEBUG else None,
)

# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    # HSTS: only send when running over HTTPS (COOKIE_SECURE is a proxy for that)
    if COOKIE_SECURE:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https:; "
        "media-src 'self' blob:; "
        "connect-src 'self' ws: wss:;"
    )
    return response

# ---------------------------------------------------------------------------
# Allowed video conversion formats (allowlist)
# ---------------------------------------------------------------------------
ALLOWED_CONVERT_FORMATS = {"mp4", "mkv", "webm", "mp3", "m4a", "avi", "mov"}

# ---------------------------------------------------------------------------
# Simple in-memory rate limiter  {ip: [timestamp, ...]}
# ---------------------------------------------------------------------------
login_attempts: dict = {}

# ---------------------------------------------------------------------------
# Conversion job store  {job_id: {...}}
# ---------------------------------------------------------------------------
conversion_jobs: dict = {}


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------
class ConvertRequest(BaseModel):
    filename: str
    format: str

    @validator("format")
    def validate_format(cls, v):
        if v.lower() not in ALLOWED_CONVERT_FORMATS:
            raise ValueError(f"Unsupported format '{v}'. Allowed: {sorted(ALLOWED_CONVERT_FORMATS)}")
        return v.lower()


class FetchRequest(BaseModel):
    url: str


class QueueRequest(BaseModel):
    url: str
    format_id: str
    title: str
    thumbnail: Optional[str] = None


class LibraryMoveRequest(BaseModel):
    job_ids: List[str]
    in_library: bool = True
    in_downloads: bool = False


class LibraryAddRequest(BaseModel):
    job_ids: List[str]


class UserCreate(BaseModel):
    username: str
    password: str


class UserCreateAdmin(BaseModel):
    username: str
    password: str
    role: str = "user"


class UserUpdate(BaseModel):
    role: Optional[str] = None
    is_active: Optional[int] = None


class PasswordReset(BaseModel):
    password: str


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
async def get_current_admin(current_user=Depends(get_current_user)):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    return current_user


# ---------------------------------------------------------------------------
# WebSocket manager
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        dead = []
        for conn in self.active_connections:
            try:
                await conn.send_json(message)
            except Exception:
                dead.append(conn)
        for conn in dead:
            self.disconnect(conn)


ws_manager = ConnectionManager()
manager = DownloadManager()


async def broadcast_progress(data: dict):
    await ws_manager.broadcast(data)


manager.set_progress_callback(broadcast_progress)

# ---------------------------------------------------------------------------
# Static files & templates
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------
def sanitize_filename(filename: str) -> str:
    """Replace non-alphanumeric chars (except dots and dashes) with underscores."""
    return re.sub(r"[^\w.\-]", "_", filename)


def parse_time_str(time_str: str) -> float:
    """Parse HH:MM:SS.mm to seconds."""
    try:
        if not time_str or time_str == "N/A":
            return 0.0
        parts = time_str.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        return 0.0
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------
@app.get("/health", tags=["System"])
async def health_check():
    """Liveness probe – returns 200 when the app is running."""
    return {"status": "ok", "version": app.version}


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    from app.core.auth import get_current_user_optional
    user = await get_current_user_optional(request)
    if not user:
        return RedirectResponse(url="/login")
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/login", response_class=HTMLResponse)
@app.get("/register", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(
        "login.html",
        {"request": request, "enable_registration": config.get_settings().enable_registration},
    )


# ---------------------------------------------------------------------------
# Authentication endpoints
# ---------------------------------------------------------------------------
@app.post("/token", response_model=Token)
async def login_for_access_token(request: Request, form_data: OAuth2PasswordRequestForm = Depends()):
    client_ip = request.client.host
    now = time.time()

    # Clean up stale attempt timestamps
    login_attempts.setdefault(client_ip, [])
    login_attempts[client_ip] = [t for t in login_attempts[client_ip] if now - t < 60]

    # Rate limit: 5 attempts per minute
    if len(login_attempts[client_ip]) >= 5:
        wait_time = int(60 - (now - login_attempts[client_ip][0]))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {wait_time} seconds.",
        )

    user = db.get_user(form_data.username)
    if not user or not verify_password(form_data.password, user["password_hash"]):
        login_attempts[client_ip].append(now)
        await asyncio.sleep(0.5)  # Constant-time delay to mitigate timing attacks
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Successful login – clear attempt counter
    login_attempts.pop(client_ip, None)

    # Transparently re-hash old pbkdf2_sha256 hashes to Argon2
    from app.core.auth import pwd_context
    if pwd_context.needs_update(user["password_hash"]):
        db.change_password(user["id"], pwd_context.hash(form_data.password))
        logger.info("Re-hashed password for user '%s' to Argon2", user["username"])

    access_token = create_access_token(
        data={"sub": user["username"]},
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )

    response = JSONResponse(content={"access_token": access_token, "token_type": "bearer"})
    response.set_cookie(
        key="access_token",
        value=access_token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
        samesite="lax",
        httponly=True,
        secure=COOKIE_SECURE,
    )
    return response


@app.get("/api/auth/me")
async def read_users_me(current_user=Depends(get_current_user)):
    return {
        "id": current_user["id"],
        "username": current_user["username"],
        "role": current_user.get("role", "user"),
    }


class PasswordStrengthRequest(BaseModel):
    password: str
    username: Optional[str] = None


@app.post("/api/auth/password-strength")
async def check_password_strength(req: PasswordStrengthRequest):
    """
    Returns a strength score and feedback for a candidate password.
    The password is NEVER logged. No auth required (used during registration).
    """
    report = strength_report(req.password, username=req.username)
    # Also surface policy limits so the client can show inline guidance
    report["min_length"] = 14
    report["max_length"] = 128
    report["policy_met"] = report["score"] >= 3 and len(req.password) >= 14
    return report


@app.post("/auth/register")
async def register(user: UserCreate):
    if not config.get_settings().enable_registration:
        raise HTTPException(status_code=403, detail="Registration is disabled by administrator")

    if db.get_user(user.username):
        raise HTTPException(status_code=400, detail="Username already registered")

    # Enforce password policy
    try:
        validate_password(user.password, username=user.username)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    user_id = str(uuid.uuid4())
    pw_hash = get_password_hash(user.password)
    
    # The first registered user is automatically an admin
    role = "admin" if len(db.get_all_users()) == 0 else "user"
    
    success = db.create_user({"id": user_id, "username": user.username, "password_hash": pw_hash, "role": role})
    if not success:
        raise HTTPException(status_code=500, detail="Failed to create user")
    return {"status": "created", "username": user.username, "role": role}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Download / queue endpoints
# ---------------------------------------------------------------------------
@app.post("/api/fetch")
async def fetch_video_info(req: FetchRequest, current_user=Depends(get_current_user)):
    try:
        loop = asyncio.get_event_loop()
        info = await asyncio.wait_for(
            loop.run_in_executor(None, manager.fetch_info, req.url),
            timeout=30.0,
        )
        if not info:
            raise HTTPException(status_code=400, detail="Failed to fetch video info. Please check the URL.")
        return info
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Request timed out. The video may be unavailable or region-locked.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/queue/add")
async def add_to_queue(req: QueueRequest, background_tasks: BackgroundTasks, current_user=Depends(get_current_user)):
    job_id = manager.add_to_queue(req.url, req.format_id, req.title, user_id=current_user["username"], thumbnail=req.thumbnail)
    db.update_job_library_status([job_id], is_in_library=0, is_in_downloads=1)

    if config.get_settings().auto_start_queue:
        background_tasks.add_task(manager.start_download, job_id)
        return {"job_id": job_id, "status": "downloading"}
    return {"job_id": job_id, "status": "queued"}


@app.delete("/api/queue/{job_id}")
@app.delete("/api/delete/{job_id}")
async def delete_job(job_id: str, current_user=Depends(get_current_user)):
    success = manager.remove_job(job_id)
    if not success:
        db.delete_job(job_id)
    manager.reload_queue()
    return {"status": "deleted"}


@app.post("/api/queue/{job_id}/enqueue")
async def enqueue_job(job_id: str, background_tasks: BackgroundTasks, current_user=Depends(get_current_user)):
    job = manager.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "detected":
        job.status = "queued"
        db.update_job_status(job_id, "queued")
        if config.get_settings().auto_start_queue:
            background_tasks.add_task(manager.start_download, job_id)
            return {"status": "downloading"}
        return {"status": "queued"}
    return {"status": job.status}


@app.post("/api/queue/{job_id}/force_start")
async def force_start_job(job_id: str, background_tasks: BackgroundTasks, current_user=Depends(get_current_user)):
    job = manager.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.status = "queued"
    db.update_job_status(job_id, "queued")
    background_tasks.add_task(manager.start_download, job_id)
    return {"status": "started"}


@app.get("/api/queue")
async def get_queue(current_user=Depends(get_current_user)):
    jobs = db.get_all_jobs(user_id=None, only_downloads=True)
    for j in jobs:
        mem_job = manager.jobs.get(j["id"])
        if mem_job:
            j["progress"] = mem_job.progress
            j["speed"] = mem_job.speed
            j["eta"] = mem_job.eta
            j["status"] = mem_job.status
    return jobs


@app.post("/api/queue/{job_id}/cancel")
async def cancel_job(job_id: str, current_user=Depends(get_current_user)):
    success = manager.cancel_job(job_id)
    if not success:
        raise HTTPException(status_code=404, detail="Job not found or cannot be cancelled")
    return {"status": "cancelled"}


@app.post("/api/queue/start")
async def start_queue(background_tasks: BackgroundTasks, current_user=Depends(get_current_user)):
    queue = manager.get_queue(user_id=current_user["username"])
    started_count = 0
    for job in queue:
        if job.status == "queued":
            background_tasks.add_task(manager.start_download, job.id)
            started_count += 1
    return {"message": f"Started {started_count} downloads"}


# ---------------------------------------------------------------------------
# Library endpoints
# ---------------------------------------------------------------------------
@app.get("/api/library")
async def get_library(current_user=Depends(get_current_user)):
    return db.get_library_jobs(user_id=None)


@app.post("/api/library/move")
async def move_to_library(req: LibraryMoveRequest, current_user=Depends(get_current_user)):
    is_in_lib = 1 if req.in_library else 0
    is_in_dl = 0 if is_in_lib == 1 else (1 if req.in_downloads else 0)
    db.update_job_library_status(req.job_ids, is_in_library=is_in_lib, is_in_downloads=is_in_dl)
    manager.reload_queue()
    return {"status": "success", "message": "Jobs processed"}


@app.post("/api/library/add")
async def add_to_library(req: LibraryAddRequest, current_user=Depends(get_current_user)):
    if not req.job_ids:
        return {"status": "no_jobs_provided"}
    db.update_job_library_status(req.job_ids, is_in_library=1)
    manager.reload_queue()
    return {"status": "success", "added_count": len(req.job_ids)}


@app.post("/api/library/remove")
async def remove_from_library(req: LibraryAddRequest, current_user=Depends(get_current_user)):
    if not req.job_ids:
        return {"status": "no_jobs_provided"}
    db.update_job_library_status(req.job_ids, is_in_library=0)
    manager.reload_queue()
    return {"status": "success", "removed_count": len(req.job_ids)}


# ---------------------------------------------------------------------------
# System endpoints
# ---------------------------------------------------------------------------
@app.post("/api/system/clear-queue")
async def clear_queue(current_user=Depends(get_current_user)):
    db.clear_completed_jobs()
    db.clear_failed_jobs()
    manager.reload_queue(None)
    return {"status": "cleared"}


@app.post("/api/system/clear-completed")
async def clear_completed_queue(current_user=Depends(get_current_user)):
    db.clear_completed_jobs()
    manager.reload_queue(None)
    return {"status": "cleared_completed"}


@app.post("/api/system/clear-failed")
async def clear_failed_queue(current_user=Depends(get_current_user)):
    db.clear_failed_jobs()
    manager.reload_queue(None)
    return {"status": "cleared_failed"}


@app.post("/api/system/update-ytdlp")
async def update_ytdlp(background_tasks: BackgroundTasks, current_user=Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, manager.update_ytdlp)
    if result["status"] == "error":
        raise HTTPException(status_code=500, detail=result["output"])
    return result


@app.get("/api/settings")
async def get_settings():
    return config.get_settings()


@app.post("/api/settings")
async def update_settings(settings: SettingsModel, current_user=Depends(get_current_admin)):
    config.update_settings(settings)
    manager.download_dir = settings.download_dir
    os.makedirs(settings.download_dir, exist_ok=True)
    return {"status": "updated"}


@app.get("/api/logs")
async def get_logs(current_user=Depends(get_current_user)):
    return db.get_logs(limit=200)


# ---------------------------------------------------------------------------
# Video view tracking
# ---------------------------------------------------------------------------
@app.post("/api/video/{job_id}/view")
async def increment_video_view(job_id: str, request: Request):
    job_data = db.get_job(job_id)
    if not job_data:
        raise HTTPException(status_code=404, detail="Job not found")

    session_cookie_name = f"view_session_{job_id}"
    if not request.cookies.get(session_cookie_name):
        db.increment_view_count(job_id)

    db.update_last_played(job_id)

    updated_job = db.get_job(job_id)
    view_count = updated_job.get("view_count", 0)

    response = JSONResponse(content={"views": view_count, "status": "success"})
    response.set_cookie(
        key=session_cookie_name,
        value="active",
        max_age=1800,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
    )
    return response


@app.get("/api/video/{job_id}/views")
async def get_video_views(job_id: str):
    job_data = db.get_job(job_id)
    if not job_data:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"views": job_data.get("view_count", 0) or 0}


@app.get("/api/video/{job_id}/live")
async def get_live_video_stats(job_id: str):
    job = manager.jobs.get(job_id)
    url = job.url if job else (db.get_job(job_id) or {}).get("url")
    if not url:
        raise HTTPException(status_code=404, detail="Job not found")
    stats = await manager.fetch_live_metadata(url)
    return stats


# ---------------------------------------------------------------------------
# Video streaming
# ---------------------------------------------------------------------------
@app.get("/api/stream/{job_id}")
async def stream_video(job_id: str, request: Request):
    """Stream video with HTTP 206 range support for seeking."""
    job = manager.jobs.get(job_id)
    job_data = job.dict() if job else db.get_job(job_id)

    if not job_data:
        raise HTTPException(status_code=404, detail="Job not found")
    if job_data.get("status") != "completed":
        raise HTTPException(status_code=400, detail="Video not ready")

    file_path = job_data.get("filename", "")
    if not os.path.isabs(file_path):
        candidate = os.path.join(manager.download_dir, file_path)
        if os.path.exists(candidate):
            file_path = candidate

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found on server")

    file_size = os.path.getsize(file_path)
    content_type, _ = mimetypes.guess_type(file_path)
    content_type = content_type or "video/mp4"
    range_header = request.headers.get("range")

    if range_header:
        from fastapi.responses import StreamingResponse

        range_match = range_header.replace("bytes=", "").split("-")
        start = int(range_match[0]) if range_match[0] else 0
        end = int(range_match[1]) if len(range_match) > 1 and range_match[1] else file_size - 1
        start = max(0, min(start, file_size - 1))
        end = max(start, min(end, file_size - 1))
        content_length = end - start + 1

        def iter_file():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = f.read(min(8192, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            iter_file(),
            status_code=206,
            media_type=content_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
            },
        )

    return FileResponse(
        path=file_path,
        media_type=content_type,
        filename=os.path.basename(file_path),
        headers={"Accept-Ranges": "bytes"},
    )


# ---------------------------------------------------------------------------
# Video player page
# ---------------------------------------------------------------------------
@app.get("/player/{job_id}", response_class=HTMLResponse)
async def video_player_page(job_id: str, request: Request, current_user=Depends(get_current_user)):
    try:
        job = manager.jobs.get(job_id)
        job_data = job.dict() if job else db.get_job(job_id)

        if not job_data:
            return RedirectResponse(url="/?error=JobNotFound")
        if job_data.get("status") != "completed":
            return RedirectResponse(url="/?error=VideoNotReady")

        # Enrich from .info.json if DB fields are missing
        if not job_data.get("view_count"):
            filename = job_data.get("filename")
            if filename:
                base, _ = os.path.splitext(filename)
                info_path = base + ".info.json"
                if os.path.exists(info_path):
                    try:
                        with open(info_path, "r", encoding="utf-8") as f:
                            info = json.load(f)
                        job_data.setdefault("view_count", info.get("view_count"))
                        job_data.setdefault("description", info.get("description"))
                        job_data.setdefault("upload_date", info.get("upload_date"))
                        job_data.setdefault("duration", info.get("duration_string") or info.get("duration"))
                    except Exception:
                        pass

        # Format upload_date: YYYYMMDD → YYYY-MM-DD
        ud = job_data.get("upload_date", "")
        if ud and len(ud) == 8 and ud.isdigit():
            job_data["upload_date"] = f"{ud[:4]}-{ud[4:6]}-{ud[6:]}"

        return templates.TemplateResponse("video_player.html", {"request": request, "job": job_data})
    except Exception:
        logger.exception("Unhandled error rendering player for job %s", job_id)
        raise HTTPException(status_code=500, detail="Internal server error")


# ---------------------------------------------------------------------------
# Directory browser (admin/settings use)
# ---------------------------------------------------------------------------
@app.get("/api/browse-directory")
async def browse_directory(path: str = None, current_user=Depends(get_current_user)):
    """Browse filesystem directories for the folder picker."""
    try:
        current_path = Path(path).resolve() if path else Path.home()

        if not current_path.exists() or not current_path.is_dir():
            raise HTTPException(status_code=400, detail="Invalid directory")

        directories = []
        try:
            for item in current_path.iterdir():
                if item.is_dir():
                    try:
                        list(item.iterdir())
                        directories.append({"name": item.name, "path": str(item)})
                    except PermissionError:
                        continue
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")

        directories.sort(key=lambda x: x["name"].lower())
        parent_path = str(current_path.parent) if current_path.parent != current_path else None

        drives = []
        if os.name == "nt" and str(current_path) == current_path.anchor:
            import string
            for letter in string.ascii_uppercase:
                drive = f"{letter}:\\"
                if Path(drive).exists():
                    drives.append({"name": drive, "path": drive})

        return {
            "current_path": str(current_path),
            "parent_path": parent_path,
            "directories": directories,
            "drives": drives,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in browse_directory")
        raise HTTPException(status_code=500, detail="Internal server error")


# ---------------------------------------------------------------------------
# File conversion endpoints
# ---------------------------------------------------------------------------
@app.post("/api/convert/upload")
async def upload_file(file: UploadFile = File(...)):
    safe_filename = sanitize_filename(file.filename)
    file_path = UPLOAD_DIR / safe_filename
    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        logger.error("Upload error: %s", e)
        raise HTTPException(status_code=500, detail="Upload failed")
    return {"filename": safe_filename}


@app.post("/api/convert/start")
async def start_conversion(request: ConvertRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    conversion_jobs[job_id] = {
        "status": "pending",
        "progress": 0,
        "filename": request.filename,
        "format": request.format,
        "error": "",
    }
    background_tasks.add_task(process_conversion, job_id, request.filename, request.format)
    return {"job_id": job_id, "status": "started"}


@app.get("/api/convert/status/{job_id}")
async def get_conversion_status(job_id: str):
    job = conversion_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/convert/download/{filename}")
async def download_converted_file(filename: str):
    # Prevent path traversal
    safe_name = Path(filename).name
    file_path = CONVERT_DIR / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path=file_path, filename=safe_name, media_type="application/octet-stream")


async def process_conversion(job_id: str, input_filename: str, target_format: str):
    try:
        conversion_jobs[job_id]["status"] = "processing"
        conversion_jobs[job_id]["progress"] = 0

        input_path = UPLOAD_DIR / input_filename
        output_path = CONVERT_DIR / f"{input_path.stem}.{target_format}"

        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            bin_ffmpeg = os.path.join(os.getcwd(), "bin", "ffmpeg.exe")
            if os.path.exists(bin_ffmpeg):
                ffmpeg_path = bin_ffmpeg
        if not ffmpeg_path:
            raise RuntimeError("FFmpeg not found")

        total_duration = 0.0
        ffprobe_path = str(ffmpeg_path).replace("ffmpeg", "ffprobe")
        if os.path.exists(ffprobe_path):
            try:
                proc = await asyncio.create_subprocess_exec(
                    ffprobe_path,
                    "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    str(input_path),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await proc.communicate()
                total_duration = float(stdout.decode().strip())
            except Exception:
                pass

        cmd = [
            str(ffmpeg_path), "-y",
            "-progress", "pipe:2",
            "-nostats",
            "-i", str(input_path),
            str(output_path),
        ]

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )

        while True:
            line_bytes = await process.stderr.readline()
            if not line_bytes:
                break
            line = line_bytes.decode("utf-8", errors="ignore").strip()
            if line.startswith("out_time=") and total_duration > 0:
                current_seconds = parse_time_str(line.split("=", 1)[1].strip())
                percent = min(99, max(0, (current_seconds / total_duration) * 100))
                conversion_jobs[job_id]["progress"] = round(percent, 1)

        await process.wait()
        if process.returncode != 0:
            raise RuntimeError(f"FFmpeg exited with code {process.returncode}")

        conversion_jobs[job_id]["status"] = "completed"
        conversion_jobs[job_id]["progress"] = 100
        conversion_jobs[job_id]["output_file"] = output_path.name
        logger.info("Conversion complete: %s", output_path.name)

    except Exception as e:
        logger.exception("Conversion failed for job %s", job_id)
        conversion_jobs[job_id]["status"] = "error"
        conversion_jobs[job_id]["error"] = str(e)


# ---------------------------------------------------------------------------
# Folder open (Desktop convenience – only meaningful on the host OS)
# ---------------------------------------------------------------------------
@app.post("/api/queue/{job_id}/open")
async def open_job_folder(job_id: str, current_user=Depends(get_current_user)):
    manager.open_folder(job_id)
    return {"status": "opened"}


@app.post("/api/open_downloads")
async def open_downloads_folder(current_user=Depends(get_current_user)):
    manager.open_folder()
    return {"status": "opened"}


# ---------------------------------------------------------------------------
# User management (admin only)
# ---------------------------------------------------------------------------
@app.get("/api/users")
async def get_all_users(current_user=Depends(get_current_admin)):
    return db.get_all_users()


@app.post("/api/users")
async def create_user_admin(user: UserCreateAdmin, current_user=Depends(get_current_admin)):
    if db.get_user(user.username):
        raise HTTPException(status_code=400, detail="Username already registered")

    # Enforce password policy
    try:
        validate_password(user.password, username=user.username)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    user_id = str(uuid.uuid4())
    pw_hash = get_password_hash(user.password)
    success = db.create_user({"id": user_id, "username": user.username, "password_hash": pw_hash, "role": user.role, "is_active": 1})
    if not success:
        raise HTTPException(status_code=500, detail="Failed to create user")
    return {"status": "created", "username": user.username, "role": user.role}


@app.put("/api/users/{user_id}")
async def update_user(user_id: str, update: UserUpdate, current_user=Depends(get_current_admin)):
    if user_id == current_user["id"]:
        if update.is_active == 0:
            raise HTTPException(status_code=400, detail="Cannot deactivate your own account")
        if update.role and update.role != "admin":
            raise HTTPException(status_code=400, detail="Cannot remove your own admin status")
    db.update_user(user_id, role=update.role, is_active=update.is_active)
    return {"status": "updated"}


@app.post("/api/users/{user_id}/reset-password")
async def reset_user_password(user_id: str, reset: PasswordReset, current_user=Depends(get_current_admin)):
    # Look up target user so we can check username containment
    all_users = db.get_all_users()
    target = next((u for u in all_users if u["id"] == user_id), None)
    target_username = target["username"] if target else None

    try:
        validate_password(reset.password, username=target_username)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    pw_hash = get_password_hash(reset.password)
    db.change_password(user_id, pw_hash)
    return {"status": "password_reset"}


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str, current_user=Depends(get_current_admin)):
    if user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    db.delete_user(user_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_event():
    from app.core.logger import setup_logging
    setup_logging()

    settings = config.get_settings()
    lib_dir = Path(settings.library_dir).resolve()
    old_dl_dir = Path("yt-dlp-downloads").resolve()
    lib_dir.mkdir(parents=True, exist_ok=True)

    if old_dl_dir.exists() and old_dl_dir.is_dir() and old_dl_dir != lib_dir:
        logger.info("Migrating files from %s to %s", old_dl_dir, lib_dir)
        for item in old_dl_dir.iterdir():
            if item.is_file():
                dest = lib_dir / item.name
                try:
                    if not dest.exists():
                        shutil.move(str(item), str(dest))
                    else:
                        item.unlink()
                except Exception as e:
                    logger.warning("Error migrating %s: %s", item.name, e)
        try:
            shutil.rmtree(str(old_dl_dir))
        except Exception as e:
            logger.warning("Could not remove old download dir: %s", e)


@app.on_event("shutdown")
async def shutdown_event():
    pass
