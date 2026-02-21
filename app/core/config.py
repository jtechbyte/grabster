from typing import Optional
from pydantic import BaseModel
from app.core.db import db


class SettingsModel(BaseModel):
    download_dir: str
    library_dir: str = "downloads"
    default_format: str
    theme: str
    filename_template: str = "%(title)s.%(ext)s"
    cookies_path: Optional[str] = None
    cookies_browser: Optional[str] = None
    custom_args: Optional[str] = None
    auto_start_queue: bool = False
    show_system_logs: bool = True
    max_concurrent_downloads: int = 3
    max_retries: int = 3
    enable_registration: bool = False


class ConfigManager:
    @staticmethod
    def get_settings() -> SettingsModel:
        return SettingsModel(
            download_dir=db.get_setting("download_dir", "downloads") or "downloads",
            library_dir=db.get_setting("library_dir", "downloads") or "downloads",
            default_format=db.get_setting("default_format", "best"),
            theme=db.get_setting("theme", "dark"),
            filename_template=db.get_setting("filename_template", "%(title)s.%(ext)s"),
            cookies_path=db.get_setting("cookies_path", ""),
            cookies_browser=db.get_setting("cookies_browser", ""),
            custom_args=db.get_setting("custom_args", ""),
            auto_start_queue=db.get_setting("auto_start_queue", "false").lower() == "true",
            show_system_logs=db.get_setting("show_system_logs", "true").lower() == "true",
            max_concurrent_downloads=int(db.get_setting("max_concurrent_downloads", "3")),
            max_retries=int(db.get_setting("max_retries", "3")),
            enable_registration=db.get_setting("enable_registration", "true").lower() == "true",
        )

    @staticmethod
    def update_settings(settings: SettingsModel):
        db.set_setting("download_dir", settings.download_dir)
        db.set_setting("library_dir", settings.library_dir)
        db.set_setting("default_format", settings.default_format)
        db.set_setting("theme", settings.theme)
        db.set_setting("filename_template", settings.filename_template)
        db.set_setting("cookies_path", settings.cookies_path or "")
        db.set_setting("cookies_browser", settings.cookies_browser or "")
        db.set_setting("custom_args", settings.custom_args or "")
        db.set_setting("auto_start_queue", str(settings.auto_start_queue).lower())
        db.set_setting("show_system_logs", str(settings.show_system_logs).lower())
        db.set_setting("max_concurrent_downloads", str(settings.max_concurrent_downloads))
        db.set_setting("max_retries", str(settings.max_retries))
        db.set_setting("enable_registration", str(settings.enable_registration).lower())


config = ConfigManager()
