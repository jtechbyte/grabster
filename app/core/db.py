import os
import sqlite3
import json
from typing import List, Dict, Optional

# DB path is configurable; defaults to a 'data' volume-friendly location
DB_PATH = os.environ.get("DB_PATH", "data/app.db")


class DBHandler:
    def __init__(self):
        # Ensure the parent directory exists
        os.makedirs(os.path.dirname(DB_PATH) if os.path.dirname(DB_PATH) else ".", exist_ok=True)
        self._init_db()

    def _get_conn(self):
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        conn = self._get_conn()
        c = conn.cursor()

        # User Table
        c.execute('''CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE,
            password_hash TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            role TEXT DEFAULT 'user',
            is_active INTEGER DEFAULT 1
        )''')

        # Jobs Table
        c.execute('''CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            url TEXT,
            title TEXT,
            format_id TEXT,
            status TEXT,
            progress REAL,
            filename TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            extra_data TEXT,
            user_id TEXT,
            thumbnail TEXT,
            sub_id TEXT,
            error TEXT,
            view_count INTEGER,
            description TEXT,
            duration TEXT,
            upload_date TEXT,
            speed TEXT,
            eta TEXT,
            is_in_library INTEGER DEFAULT 0,
            is_in_downloads INTEGER DEFAULT 1,
            last_played DATETIME
        )''')

        # Settings Table
        c.execute('''CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )''')

        # System Logs Table
        c.execute('''CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            level TEXT,
            message TEXT,
            source TEXT
        )''')

        # ---------------------------------------------------------------
        # Incremental migrations for databases created before full schema
        # ---------------------------------------------------------------
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN user_id TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN thumbnail TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN error TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN view_count INTEGER")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN description TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN duration TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN upload_date TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN speed TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN eta TEXT")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN is_in_library INTEGER DEFAULT 0")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN is_in_downloads INTEGER DEFAULT 1")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN last_played DATETIME")
        _safe_alter(c, "ALTER TABLE jobs ADD COLUMN sub_id TEXT")
        _safe_alter(c, "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")
        _safe_alter(c, "ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1")

        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # User methods
    # ------------------------------------------------------------------

    def create_user(self, user_dict: Dict) -> bool:
        conn = self._get_conn()
        c = conn.cursor()
        try:
            role = user_dict.get("role", "user")
            is_active = user_dict.get("is_active", 1)
            c.execute(
                "INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)",
                (user_dict["id"], user_dict["username"], user_dict["password_hash"], role, is_active),
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False
        finally:
            conn.close()

    def get_user(self, username: str) -> Optional[Dict]:
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("SELECT * FROM users WHERE username = ?", (username,))
        row = c.fetchone()
        conn.close()
        return dict(row) if row else None

    def get_all_users(self) -> List[Dict]:
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("SELECT id, username, created_at, role, is_active FROM users ORDER BY created_at DESC")
        rows = c.fetchall()
        users = [dict(r) for r in rows]
        conn.close()
        return users

    def update_user(self, user_id: str, role: str = None, is_active: int = None):
        conn = self._get_conn()
        c = conn.cursor()
        updates, params = [], []
        if role is not None:
            updates.append("role = ?")
            params.append(role)
        if is_active is not None:
            updates.append("is_active = ?")
            params.append(is_active)
        if not updates:
            conn.close()
            return
        params.append(user_id)
        c.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", tuple(params))
        conn.commit()
        conn.close()

    def delete_user(self, user_id: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        conn.close()

    def change_password(self, user_id: str, password_hash: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Job methods
    # ------------------------------------------------------------------

    def add_job(self, job_dict: Dict):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(
            '''INSERT INTO jobs (id, url, title, format_id, status, progress, filename,
               extra_data, user_id, thumbnail, sub_id, is_in_library, is_in_downloads)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                job_dict["id"], job_dict["url"], job_dict["title"], job_dict["format_id"],
                job_dict["status"], job_dict.get("progress", 0.0), job_dict.get("filename", ""),
                json.dumps(job_dict), job_dict.get("user_id"), job_dict.get("thumbnail", ""),
                job_dict.get("sub_id"), job_dict.get("is_in_library", 0), job_dict.get("is_in_downloads", 1),
            ),
        )
        conn.commit()
        conn.close()

    def get_all_jobs(self, user_id: str = None, only_downloads: bool = False) -> List[Dict]:
        conn = self._get_conn()
        c = conn.cursor()
        query = "SELECT * FROM jobs"
        params: List = []
        conditions = []
        if user_id:
            conditions.append("user_id = ?")
            params.append(user_id)
        if only_downloads:
            conditions.append("is_in_downloads = 1")
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY timestamp DESC"
        c.execute(query, tuple(params))
        rows = c.fetchall()
        jobs = [dict(r) for r in rows]
        conn.close()
        return jobs

    def get_job(self, job_id: str) -> Optional[Dict]:
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = c.fetchone()
        conn.close()
        return dict(row) if row else None

    def get_jobs_by_ids(self, job_ids: List[str]) -> List[Dict]:
        if not job_ids:
            return []
        conn = self._get_conn()
        c = conn.cursor()
        placeholders = ",".join(["?"] * len(job_ids))
        c.execute(f"SELECT * FROM jobs WHERE id IN ({placeholders})", tuple(job_ids))
        rows = c.fetchall()
        jobs = [dict(r) for r in rows]
        conn.close()
        return jobs

    def get_library_jobs(self, user_id: str = None) -> List[Dict]:
        conn = self._get_conn()
        c = conn.cursor()
        if user_id:
            c.execute(
                "SELECT * FROM jobs WHERE user_id = ? AND is_in_library = 1 ORDER BY timestamp DESC",
                (user_id,),
            )
        else:
            c.execute("SELECT * FROM jobs WHERE is_in_library = 1 ORDER BY timestamp DESC")
        rows = c.fetchall()
        jobs = [dict(r) for r in rows]
        conn.close()
        return jobs

    def update_job_status(
        self,
        job_id: str,
        status: str,
        progress: float = 0.0,
        error_msg: str = None,
        speed: str = None,
        eta: str = None,
        filename: str = None,
    ):
        conn = self._get_conn()
        c = conn.cursor()
        query = "UPDATE jobs SET status = ?"
        params = [status]
        if progress is not None:
            query += ", progress = ?"
            params.append(progress)
        if error_msg is not None:
            query += ", error = ?"
            params.append(error_msg)
        if speed is not None:
            query += ", speed = ?"
            params.append(speed)
        if eta is not None:
            query += ", eta = ?"
            params.append(eta)
        if filename is not None:
            query += ", filename = ?"
            params.append(filename)
        query += " WHERE id = ?"
        params.append(job_id)
        c.execute(query, tuple(params))
        conn.commit()
        conn.close()

    def update_job_sub_id(self, job_id: str, sub_id: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("UPDATE jobs SET sub_id = ? WHERE id = ?", (sub_id, job_id))
        conn.commit()
        conn.close()

    def update_job_library_status(
        self, job_ids: List[str], is_in_library: int, is_in_downloads: Optional[int] = None
    ):
        conn = self._get_conn()
        c = conn.cursor()
        placeholders = ",".join(["?"] * len(job_ids))
        if is_in_downloads is not None:
            c.execute(
                f"UPDATE jobs SET is_in_library = ?, is_in_downloads = ? WHERE id IN ({placeholders})",
                (is_in_library, is_in_downloads, *job_ids),
            )
        else:
            c.execute(
                f"UPDATE jobs SET is_in_library = ? WHERE id IN ({placeholders})",
                (is_in_library, *job_ids),
            )
        conn.commit()
        conn.close()

    def update_job_metadata(
        self, job_id: str, view_count=None, description=None, duration=None, upload_date=None
    ):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(
            "UPDATE jobs SET view_count = ?, description = ?, duration = ?, upload_date = ? WHERE id = ?",
            (view_count, description, duration, upload_date, job_id),
        )
        conn.commit()
        conn.close()

    def update_job_filename(self, job_id: str, new_path: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("UPDATE jobs SET filename = ? WHERE id = ?", (new_path, job_id))
        conn.commit()
        conn.close()

    def update_last_played(self, job_id: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("UPDATE jobs SET last_played = CURRENT_TIMESTAMP WHERE id = ?", (job_id,))
        conn.commit()
        conn.close()

    def increment_view_count(self, job_id: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(
            "UPDATE jobs SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?",
            (job_id,),
        )
        conn.commit()
        conn.close()

    def delete_job(self, job_id: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        conn.commit()
        conn.close()

    def clear_completed_jobs(self):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("DELETE FROM jobs WHERE status = 'completed' AND (is_in_library = 0 OR is_in_library IS NULL)")
        c.execute("UPDATE jobs SET is_in_downloads = 0 WHERE status = 'completed' AND is_in_library = 1")
        conn.commit()
        conn.close()

    def clear_failed_jobs(self):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("DELETE FROM jobs WHERE (status = 'error' OR status = 'canceled')")
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Settings methods
    # ------------------------------------------------------------------

    def get_setting(self, key: str, default=None):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = c.fetchone()
        conn.close()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Log methods
    # ------------------------------------------------------------------

    def add_log(self, level: str, message: str, source: str = "system"):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(
            "INSERT INTO system_logs (level, message, source) VALUES (?, ?, ?)",
            (level, message, source),
        )
        conn.commit()
        conn.close()

    def get_logs(self, limit: int = 100) -> List[Dict]:
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?", (limit,))
        rows = c.fetchall()
        logs = [dict(r) for r in rows]
        conn.close()
        return logs


def _safe_alter(cursor, sql: str):
    """Run an ALTER TABLE statement, silently ignoring 'duplicate column' errors."""
    try:
        cursor.execute(sql)
    except sqlite3.OperationalError:
        pass


db = DBHandler()
