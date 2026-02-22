

import yt_dlp
import subprocess
import os
import uuid
import asyncio
import sys
import re
from typing import List, Optional, Dict
import time
from pydantic import BaseModel
from enum import Enum
from pathlib import Path
from app.core.config import config

def strip_ansi_codes(text: str) -> str:
    """Remove ANSI escape codes from text."""
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

class DownloadStatus(str, Enum):
    QUEUED = "queued"
    DOWNLOADING = "downloading"
    COMPLETED = "completed"
    CANCELED = "canceled"
    ERROR = "error"
    DETECTED = "detected"

class Format(BaseModel):
    id: str
    ext: str
    res: str
    size: str
    note: Optional[str] = None

class VideoInfo(BaseModel):
    title: str
    thumbnail: str
    duration: str
    formats: List[Format]

class DownloadJob(BaseModel):
    id: str
    url: str
    title: str
    format_id: Optional[str] = None
    status: DownloadStatus = DownloadStatus.QUEUED
    progress: float = 0.0
    speed: str = ""
    eta: str = ""
    filename: str = ""
    error: Optional[str] = None
    user_id: Optional[str] = None
    timestamp_start: float = 0.0
    thumbnail: Optional[str] = None
    pid: Optional[int] = None
    sub_id: Optional[str] = None
    # Metadata
    view_count: Optional[int] = None
    description: Optional[str] = None
    duration: Optional[str] = None
    upload_date: Optional[str] = None
    is_in_library: int = 0
    is_in_downloads: int = 1
    last_played: Optional[str] = None

class DownloadManager:
    def __init__(self):
        # Load settings
        from app.core.config import config
        settings = config.get_settings()
        self.download_dir = settings.download_dir
        os.makedirs(self.download_dir, exist_ok=True)
        
        # Load jobs from DB
        from app.core.db import db
        self.jobs: Dict[str, DownloadJob] = {}
        self.progress_callback = None
        self.processes: Dict[str, asyncio.subprocess.Process] = {}
        
        db_jobs = db.get_all_jobs()
        for j in db_jobs:
            self.jobs[j['id']] = DownloadJob(
                id=j['id'],
                url=j['url'],
                title=j['title'],
                format_id=j['format_id'],
                status=j['status'],
                progress=j['progress'],
                filename=j['filename'],
                user_id=j.get('user_id'),
                timestamp_start=j.get('timestamp_start', 0.0),
                thumbnail=j.get('thumbnail', ''),
                sub_id=j.get('sub_id'),
                is_in_library=j.get('is_in_library', 0),
                is_in_downloads=j.get('is_in_downloads', 1),
                last_played=j.get('last_played')
            )
        
        # Concurrency Control
        self.semaphore = asyncio.Semaphore(settings.max_concurrent_downloads)

    def set_progress_callback(self, callback):
        self.progress_callback = callback


    async def fetch_live_metadata(self, url: str) -> dict:
        """Fetch live metadata for a URL without downloading."""
        def _fetch():
            ydl_opts = {
                'quiet': True,
                'skip_download': True,
                'no_warnings': True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(url, download=False)

        try:
            info = await asyncio.to_thread(_fetch)
            return {
                'view_count': info.get('view_count'),
                'like_count': info.get('like_count'),
                'title': info.get('title')
            }
        except Exception as e:
            print(f"[METADATA_FETCH] Error: {e}")
            return {}

    async def fetch_channel_metadata(self, url: str) -> dict:
        """Fetch channel metadata (avatar, name) for subscriptions."""
        def _fetch():
            ydl_opts = {
                'quiet': True,
                'skip_download': True,
                'extract_flat': 'in_playlist', # Fetch only playlist meta + 1st video
                'playlistend': 1,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                return info
        
        try:
            info = await asyncio.to_thread(_fetch)
            if not info:
                return None
            
            # Channel name is usually in 'uploader' or 'channel' or 'title'
            name = info.get('uploader') or info.get('channel') or info.get('title')
            
            # Avatar
            avatar_url = None
            if info.get('thumbnails'):
                avatar_url = info['thumbnails'][-1].get('url')
            
            return {
                'name': name,
                'avatar_url': avatar_url,
                'url': url
            }
        except Exception as e:
            print(f'[ERROR] Failed to fetch channel info: {e}')
            return None



    def fetch_info(self, url: str) -> Optional[VideoInfo]:
        try:
            from app.core.config import config
            settings = config.get_settings()
            
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'user_agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
                'extractor_args': {'youtube': {'player_client': ['android_creator']}},
                'ffmpeg_location': os.path.join(os.getcwd(), 'bin', 'ffmpeg.exe')
            }
            
            # Explicitly check for ffmpeg binary to avoid confusion
            import shutil
            ffmpeg_path = os.path.join(os.getcwd(), 'bin', 'ffmpeg.exe')
            if os.path.exists(ffmpeg_path):
                ydl_opts['ffmpeg_location'] = ffmpeg_path
            else:
                # Fallback to system PATH
                if shutil.which('ffmpeg'):
                    ydl_opts['ffmpeg_location'] = shutil.which('ffmpeg')

            # if settings.cookies_path and os.path.exists(settings.cookies_path):
            #     ydl_opts['cookiefile'] = settings.cookies_path
            # elif settings.cookies_browser:
            #     ydl_opts['cookiesfrombrowser'] = (settings.cookies_browser,)

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            
            # ... process info ...
            return self._process_info(info)

        except Exception as e:
            # Debug: print exact exception
            print(f"[DEBUG] Exception caught: type={type(e).__name__}, message={str(e)}")
            print(f"[DEBUG] 'cookie' in message: {'cookie' in str(e).lower()}")
            print(f"[DEBUG] cookies_path={settings.cookies_path}, cookies_browser={settings.cookies_browser}")
            
            # Fallback: Retry without cookies if cookies were used
            if (settings.cookies_path or settings.cookies_browser) and "cookie" in str(e).lower():
                 print(f"[WARNING] Cookie fetch failed ({e}). Retrying without cookies...")
                 print(f"[DEBUG] cookies_path: {settings.cookies_path}, cookies_browser: {settings.cookies_browser}")
                 try:
                     # Create fresh opts WITHOUT cookies
                     fallback_opts = {
                         'quiet': True,
                         'no_warnings': True,
                         'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                         'ffmpeg_location': ydl_opts.get('ffmpeg_location')
                     }
                     print(f"[DEBUG] Fallback opts: {fallback_opts}")
                     
                     with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                     print("[DEBUG] Fallback succeeded!")
                     return self._process_info(info)
                 except Exception as e2:
                     import traceback
                     print(f"[ERROR] Fallback failed: {e2}")
                     print(f"[ERROR] Fallback traceback: {traceback.format_exc()}")
            
            import traceback
            trace = traceback.format_exc()
            print(f"Error fetching info: {e}")
            print(f"[DEBUG_TRACE] {trace}")
            return None

    def _process_info(self, info):
            # Collect all mp4 video formats
            all_formats = []
            
            for f in info.get("formats", []):
                # Show ALL formats with video. We no longer skip webm, because
                # YouTube only provides 1440p and 4K in VP9/AV1 formats (often webm).
                if f.get("vcodec") != "none":
                    height = f.get("height")
                    width = f.get("width")
                    if not height or not width:
                        continue
                    
                    long_edge = max(height, width)
                    if long_edge >= 3840:
                        res_key = "2160p"
                    elif long_edge >= 2560:
                        res_key = "1440p"
                    elif long_edge >= 1920:
                        res_key = "1080p"
                    elif long_edge >= 1280:
                        res_key = "720p"
                    elif long_edge >= 854:
                        res_key = "480p"
                    elif long_edge >= 640:
                        res_key = "360p"
                    elif long_edge >= 426:
                        res_key = "240p"
                    else:
                        res_key = "144p"
                    size = f.get("filesize") or f.get("filesize_approx") or 0
                    has_audio = f.get("acodec") != "none"
                    
                    all_formats.append({
                        'format': f,
                        'res_key': res_key,
                        'size': size,
                        'has_audio': has_audio
                    })
            
            # Group by resolution and keep the best one
            from collections import defaultdict
            by_resolution = defaultdict(list)
            for item in all_formats:
                by_resolution[item['res_key']].append(item)
            
            # Keep best format per resolution
            formats = []
            for res_key, items in by_resolution.items():
                # Sort by: 1) H.264 codec (avc1) for max compatibility, 2) mp4 extension, 3) has audio, 4) filesize
                best = sorted(
                    items, 
                    key=lambda x: (
                        1 if x['format'].get('vcodec', '').startswith('avc') else 0,
                        1 if x['format'].get('ext') == 'mp4' else 0,
                        x['has_audio'], 
                        x['size']
                    ), 
                    reverse=True
                )[0]
                f = best['format']
                
                size_str = f"{round(best['size']/(1024*1024),1)}MiB" if best['size'] else "Unknown"
                
                # CRITICAL INTERVENTION: If the best format for this resolution lacks audio (e.g. 1080p+ DASH streams),
                # we MUST instruct yt-dlp to download the video track AND the best audio track and merge them.
                final_format_id = f["format_id"]
                if not best['has_audio']:
                    final_format_id = f"{f['format_id']}+bestaudio/best"
                
                formats.append(Format(
                    id=final_format_id,
                    ext=f["ext"],
                    res=res_key,
                    size=size_str,
                    note=f.get("format_note")
                ))
            
            formats.sort(key=lambda x: int(x.res.replace('p', '')), reverse=True)

            return VideoInfo(
                title=info.get("title", "Unknown"),
                thumbnail=info.get("thumbnail", ""),
                duration=str(info.get("duration", 0)),
                formats=formats
            )

    async def _emit_progress(self, job):
        if self.progress_callback:
            data = {
                "type": "progress", "job_id": job.id, "status": job.status,
                "progress": job.progress, "speed": job.speed, "eta": job.eta,
                "filename": job.filename, "title": job.title
            }
            try:
                if asyncio.iscoroutinefunction(self.progress_callback):
                    await self.progress_callback(data)
                else:
                    self.progress_callback(data)
            except: pass

    def add_to_queue(self, url: str, format_id: str, title: str, user_id: str = None, thumbnail: str = "", status: str = "queued", sub_id: str = None) -> str:
        from app.core.db import db
        import time
        
        job_id = str(uuid.uuid4())
        job = DownloadJob(
            id=job_id,
            url=url,
            title=title,
            format_id=format_id,
            user_id=user_id,
            timestamp_start=time.time(),
            thumbnail=thumbnail,
            status=status,
            sub_id=sub_id
        )
        self.jobs[job_id] = job
        db.add_job(job.dict())
        return job_id

    def remove_job(self, job_id: str):
        from app.core.db import db
        print(f"[DEBUG] remove_job called for {job_id}")
        
        job = self.jobs.get(job_id)
        filename = None
        
        if job:
            filename = job.filename
            if job.status == DownloadStatus.DOWNLOADING:
                self.cancel_job(job_id)
            del self.jobs[job_id]
        else:
            all_jobs = db.get_all_jobs()
            target = next((j for j in all_jobs if j['id'] == job_id), None)
            if target:
                filename = target.get('filename')

        if filename:
            try:
                if os.path.exists(filename):
                     os.remove(filename)
                
                path_in_dir = os.path.join(self.download_dir, filename)
                if os.path.exists(path_in_dir):
                    os.remove(path_in_dir)
            except Exception as e:
                print(f"Error deleting file {filename}: {e}")

        db.delete_job(job_id)
        return True

    def cancel_job(self, job_id: str):
        from app.core.db import db
        
        # Kill process if active
        if job_id in self.processes:
            try:
                proc = self.processes[job_id]
                proc.terminate()
            except:
                pass
            del self.processes[job_id]

        if job_id in self.jobs:
            job = self.jobs[job_id]
            job.status = DownloadStatus.CANCELED
            job.error = "Cancelled by user"
            db.update_job_status(job_id, "canceled", 0.0)
            return True
        return False

    def open_folder(self, job_id: str = None):
        # Default to opening the main downloads directory
        path_to_open = self.download_dir
        
        if job_id and job_id in self.jobs:
            job = self.jobs[job_id]
            # Resolve full path
            full_path = None
            if job.filename:
                if os.path.isabs(job.filename) and os.path.exists(job.filename):
                    full_path = job.filename
                elif os.path.exists(os.path.join(self.download_dir, job.filename)):
                    full_path = os.path.join(self.download_dir, job.filename)
            
            # If we found the file, open its PARENT directory
            if full_path:
                path_to_open = os.path.dirname(full_path)
                # If we want to highlight the file, explorer /select,path works on Windows
                if os.name == 'nt':
                    try:
                        subprocess.run(['explorer', '/select,', full_path])
                        return
                    except:
                        pass # Fallback to opening folder normally

        try:
            if os.name == 'nt':
                os.startfile(path_to_open)
            elif sys.platform == 'darwin':
                 subprocess.run(['open', path_to_open])
            else:
                 subprocess.run(['xdg-open', path_to_open])
        except Exception as e:
            print(f"Error opening folder: {e}")

    def get_queue(self, user_id: str = None) -> List[DownloadJob]:
        if user_id:
            jobs = [job for job in self.jobs.values() if job.user_id == user_id]
        else:
            jobs = list(self.jobs.values())
        
        jobs.sort(key=lambda x: x.timestamp_start, reverse=True)
        return jobs

    def reload_queue(self, user_id: str = None):
        """Reload jobs from database to sync in-memory state"""
        from app.core.db import db
        settings = config.get_settings()
        downloads_dir = Path(settings.download_dir).resolve()
        
        # Get all jobs from DB
        db_jobs = db.get_all_jobs()
        if user_id:
            db_jobs = [j for j in db_jobs if j.get('user_id') == user_id]
        
        # Get current job IDs from DB
        db_job_ids = {j['id'] for j in db_jobs}
        
        # Remove jobs from memory that are no longer in DB
        jobs_to_remove = []
        for job_id in self.jobs:
            job = self.jobs[job_id]
            if user_id and job.user_id != user_id:
                continue
            
            if job_id not in db_job_ids:
                jobs_to_remove.append(job_id)
        
        for job_id in jobs_to_remove:
            del self.jobs[job_id]
            print(f"[RELOAD] Removed job {job_id} from memory")
            
        # Update existing jobs in memory with new DB state + Hard Invariant
        for db_job in db_jobs:
            job_id = db_job['id']
            if job_id in self.jobs:
                job = self.jobs[job_id]
                job.is_in_library = db_job.get('is_in_library', 0)
                job.is_in_downloads = db_job.get('is_in_downloads', 1)
                job.filename = db_job.get('filename', job.filename)
                
                # 🔒 HARD RULE: NOT IN DOWNLOADS DIR == NOT A DOWNLOAD
                try:
                    if job.filename:
                        file_path = Path(job.filename).resolve()
                        if not file_path.is_relative_to(downloads_dir):
                            job.is_in_downloads = 0
                            print(f"[RELOAD] Hard Rule: Job {job_id} moved out of downloads, hiding.")
                except Exception:
                    # If path resolution fails (e.g. invalid chars), treat as not in downloads for safety
                    pass
                
                print(f"[RELOAD] Updated job {job_id} state: lib={job.is_in_library}, dl={job.is_in_downloads}")

    async def start_download(self, job_id: str):
        print(f"[DEBUG] start_download (thread-based) called for {job_id}")
        from app.core.db import db
        
        async with self.semaphore:
            job = self.jobs.get(job_id)
            if not job or job.status == DownloadStatus.CANCELED:
                return

            job.status = DownloadStatus.DOWNLOADING
            db.update_job_status(job_id, "downloading")
            
            # Run download in thread pool to avoid blocking
            loop = asyncio.get_event_loop()
            
            def download_with_ytdlp():
                """Download using yt-dlp Python API"""
                try:
                    settings = config.get_settings()
                    ffmpeg_dir = os.path.join(os.getcwd(), 'bin')
                    
                    # Progress hook for real-time updates
                    # Progress hook for real-time updates
                    def progress_hook(d):
                        # print(f"[DEBUG_HOOK] Status: {d.get('status')}")
                        if d['status'] == 'downloading':
                            # Parse progress
                            progress_updated = False
                            if 'downloaded_bytes' in d and 'total_bytes' in d:
                                try:
                                    progress = (d['downloaded_bytes'] / d['total_bytes']) * 100
                                    job.progress = round(progress, 1)
                                    progress_updated = True
                                except: pass
                            elif '_percent_str' in d:
                                try:
                                    clean_str = strip_ansi_codes(d['_percent_str'])
                                    percent_str = clean_str.strip().replace('%', '')
                                    job.progress = float(percent_str)
                                    progress_updated = True
                                except: pass
                            
                            # Parse speed
                            if 'speed' in d and d['speed']:
                                try:
                                    job.speed = f"{d['speed']/1024/1024:.1f}MiB/s"
                                except: pass
                            elif '_speed_str' in d:
                                job.speed = strip_ansi_codes(d['_speed_str'].strip())
                            
                            # Parse ETA
                            if 'eta' in d and d['eta']:
                                try:
                                    eta_sec = int(d['eta'])
                                    # Format seconds to MM:SS
                                    m, s = divmod(eta_sec, 60)
                                    h, m = divmod(m, 60)
                                    if h > 0:
                                        job.eta = f"{h}:{m:02d}:{s:02d}"
                                    else:
                                        job.eta = f"{m:02d}:{s:02d}"
                                except: 
                                    job.eta = str(d['eta'])
                            elif '_eta_str' in d:
                                job.eta = strip_ansi_codes(d['_eta_str'].strip())
                            
                            # Log what we parsed
                            # print(f"[DEBUG_HOOK] ID={job.id[:8]} Prog={job.progress} Speed={job.speed} ETA={job.eta}")
                            
                            # Update database periodically (every ~5%)
                            if progress_updated and int(job.progress) % 5 == 0:
                                db.update_job_status(job.id, "downloading", job.progress)
                            
                            # Emit progress update
                            try:
                                print(f"[PROGRESS_EMIT] {job.progress}% - {job.speed} - ETA: {job.eta}")
                                asyncio.run_coroutine_threadsafe(
                                    self._emit_progress(job),
                                    loop
                                )
                            except Exception as e:
                                print(f"[EMIT_ERROR] {e}")
                        
                        elif d['status'] == 'finished':
                            job.progress = 100.0
                            if 'filename' in d:
                                job.filename = os.path.basename(d['filename'])
                                print(f"[DOWNLOAD] Finished: {job.filename}")
                    
                    # Convert format_id to smart format selection for better YouTube compatibility
                    format_spec = job.format_id
                    
                    # Only override if format_id is missing or looks like "best" override needed (but here we trust user selection if specific)
                    # If format_id is None or empty, default to best compatible
                    if not format_spec:
                          if 'youtube.com' in job.url or 'youtu.be' in job.url:
                              format_spec = 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
                          else:
                              format_spec = 'best'

                    
                    # Client Fallback Chain strategy
                    CLIENT_CHAIN = ['android_creator', 'android']
                    last_error = None
                    info = None
                    download_success = False

                    import shutil
                    ffmpeg_path = os.path.join(os.getcwd(), 'bin', 'ffmpeg.exe')
                    if not os.path.exists(ffmpeg_path):
                        ffmpeg_path = shutil.which('ffmpeg')

                    # Base options common to all attempts
                    base_opts = {
                        'format': format_spec if format_spec else 'bestvideo+bestaudio/best',
                        'outtmpl': os.path.join(self.download_dir, '%(title)s.%(ext)s'),
                        'progress_hooks': [progress_hook],
                        'ffmpeg_location': ffmpeg_path,
                        'quiet': False,
                        'no_warnings': False,
                        'merge_output_format': 'mp4',
                        'force_ipv4': True,
                        'socket_timeout': 15,
                        'verbose': True
                    }

                    for client in CLIENT_CHAIN:
                        print(f"[DOWNLOAD] Attempting with client: {client}")
                        
                        # Clone opts and set client
                        current_opts = base_opts.copy()
                        current_opts['extractor_args'] = {'youtube': {'player_client': [client]}}
                        # Add user agent for android clients
                        current_opts['user_agent'] = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

                        try:
                            # 1. Metadata Check (Dry Run)
                            with yt_dlp.YoutubeDL(current_opts) as ydl:
                                meta = ydl.extract_info(job.url, download=False)
                            
                            if not meta:
                                raise ValueError("No metadata returned")

                            # 2. Resolution Guard (> 720p)
                            # Check 'height' from video format. 
                            # Note: meta might differ from final selected format, but gives good indication.
                            # Better: Check if *selected* format meets criteria? 
                            # The user requirement is: "If the resulting video is below 720p"
                            # We can trust 'best' selection, but if 'best' is 360p, we fail.
                            
                            # Find max height available
                            formats = meta.get('formats', [])
                            max_height = 0
                            for f in formats:
                                if f.get('height'):
                                    max_height = max(max_height, f['height'])
                            
                            print(f"[DOWNLOAD] Max resolution available: {max_height}p")
                            
                            if max_height < 720:
                                raise ValueError(f"Resolution too low ({max_height}p < 720p). Strictly enforcing HD.")

                            # 3. Actual Download
                            print(f"[DOWNLOAD] Quality check passed. Starting download...")
                            with yt_dlp.YoutubeDL(current_opts) as ydl:
                                info = ydl.extract_info(job.url, download=True)
                            
                            download_success = True
                            print(f"[DOWNLOAD] Success with client: {client}")
                            break

                        except Exception as e:
                            print(f"[WARNING] Client {client} failed: {e}")
                            last_error = e
                            continue
                    
                    if not download_success:
                        print(f"[ERROR] All clients failed. Last error: {last_error}")
                        raise RuntimeError(f"Download failed for all clients (Low Res or Error). Last error: {last_error}")

                    # Get successful filename
                    if 'requested_downloads' in info and info['requested_downloads']:
                        filepath = info['requested_downloads'][0]['filepath']
                        job.filename = os.path.basename(filepath)
                    elif '_filename' in info:
                        job.filename = os.path.basename(info['_filename'])
                    
                    # Success
                    job.status = DownloadStatus.COMPLETED
                    job.progress = 100.0
                    db.update_job_status(job.id, "completed", 100.0, filename=job.filename)
                    
                    # Save metadata
                    db.update_job_metadata(
                        job.id, 
                        view_count=0, # Initialize to 0 for local tracking
                        description=info.get('description'),
                        duration=info.get('duration_string'),
                        upload_date=info.get('upload_date')
                    )
                    
                    print(f"[DOWNLOAD] Completed: {job.filename}")
                    
                except Exception as e:
                    import traceback
                    trace = traceback.format_exc()
                    
                    # Create user-friendly error message
                    error_str = str(e)
                    if 'empty' in error_str.lower():
                        if 'youtube.com' in job.url or 'youtu.be' in job.url:
                            error_msg = "YouTube download failed. Please configure cookies in Settings (Cookies File Path or Browser Cookies)."
                        else:
                            error_msg = "Download failed: The file is empty. The video may be restricted or unavailable."
                    elif 'cookie' in error_str.lower():
                        error_msg = "Authentication required. Please configure cookies in Settings."
                    else:
                        # Show just the error message, not the full traceback
                        error_msg = f"Download failed: {str(e).split('ERROR:')[-1].strip() if 'ERROR:' in str(e) else str(e)}"
                    
                    print(f"[ERROR] {error_msg}")
                    print(f"[DEBUG TRACE] {trace}")  # Still log full trace for debugging
                    
                    if job.status != DownloadStatus.CANCELED:
                        job.status = DownloadStatus.ERROR
                        job.error = error_msg
                        db.update_job_status(job.id, "error", 0.0, error_msg=error_msg)
                
                # Final progress update
                asyncio.run_coroutine_threadsafe(
                    self._emit_progress(job),
                    loop
                )
            
            # Run in thread pool
            try:
                await loop.run_in_executor(None, download_with_ytdlp)
            except Exception as e:
                import traceback
                trace = traceback.format_exc()
                error_msg = f"Thread Error: {str(e)}\n{trace}"
                print(f"[CRITICAL ERROR] {error_msg}")
                job.status = DownloadStatus.ERROR
                job.error = error_msg
                db.update_job_status(job.id, "error", 0.0, error_msg=error_msg)
                await self._emit_progress(job)


    def _parse_progress(self, job, line):
        # [download]  23.4% of 100.0MiB at  2.5MiB/s ETA 00:35
        print(f"[_parse_progress] Called with line: {line}")
        
        # Regex for percentage
        percent_match = re.search(r'(\d+\.\d+)%', line)
        if percent_match:
            try:
                 job.progress = float(percent_match.group(1))
                 print(f"[_parse_progress] Set progress to {job.progress}%")
            except: pass
        
        # Regex for Speed
        speed_match = re.search(r'at\s+([\w\.]+/s)', line)
        if speed_match:
            job.speed = strip_ansi_codes(speed_match.group(1))
            print(f"[_parse_progress] Set speed to {job.speed}")
            
        # Regex for ETA
        eta_match = re.search(r'ETA\s+([\d:]+)', line)
        if eta_match:
            job.eta = strip_ansi_codes(eta_match.group(1))
            print(f"[_parse_progress] Set ETA to {job.eta}")
            
        # Emit (run in background so we don't block reading stdout)
        print(f"[_parse_progress] Creating emit task for job {job.id[:8]}")
        asyncio.create_task(self._emit_progress(job))

    async def _emit_progress(self, job):
        if self.progress_callback:
            data = {
                "type": "progress", 
                "job_id": job.id, 
                "status": job.status,
                "progress": job.progress, 
                "speed": job.speed, 
                "eta": job.eta,
                "filename": job.filename, 
                "title": job.title
            }
            await self.progress_callback(data)

    def update_ytdlp(self):
        import subprocess
        import importlib.metadata
        
        current_version = "Unknown"
        try:
            current_version = importlib.metadata.version('yt-dlp')
        except:
            pass

        try:
            cmd = [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"]
            process = subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            # Get new version
            new_version = current_version
            try:
                # Reload metadata or re-check
                importlib.reload(importlib.metadata)
                new_version = importlib.metadata.version('yt-dlp')
            except:
                pass
                
            return {
                "status": "success", 
                "output": process.stdout,
                "current_version": current_version,
                "new_version": new_version
            }
        except subprocess.CalledProcessError as e:
            return {
                "status": "error", 
                "output": e.stderr,
                "current_version": current_version
            }
        except Exception as e:
            return {
                "status": "error", 
                "output": str(e),
                "current_version": current_version
            }

    async def get_direct_stream_url(self, url: str) -> Optional[str]:
        """
        Extract a direct stream URL for any video URL.
        """
        def _fetch():
            current_dir = os.getcwd()
            yt_dlp_exe = os.path.join(current_dir, 'yt-dlp', 'yt-dlp.exe')
            
            cmd = [
                yt_dlp_exe,
                "-g",
                "--no-warnings",
                "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
                url
            ]
            
            # Add cookies if configured
            from app.core.config import config
            settings = config.get_settings()
            if settings.cookies_path and os.path.exists(settings.cookies_path):
                cmd.extend(["--cookies", settings.cookies_path])
            elif settings.cookies_browser:
                cmd.extend(["--cookies-from-browser", settings.cookies_browser])
            
            import subprocess
            try:
                # Use startupinfo to hide console window on Windows
                startupinfo = None
                if os.name == 'nt':
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                
                result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', startupinfo=startupinfo)
                if result.returncode == 0:
                    return result.stdout.strip().split('\n')[0]
                else:
                    return None
            except Exception as e:
                print(f"[STREAM ERROR] {e}")
                return None
        
        return await asyncio.to_thread(_fetch)
