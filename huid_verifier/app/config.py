"""
Runtime configuration loaded from environment / .env file.
All Appium/device settings live here — no magic strings in agent code.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Appium
    appium_url: str = "http://127.0.0.1:4723"
    device_udid: str = "emulator-5554"
    device_name: str = "Android Emulator"
    platform_version: str = "13.0"

    # BIS CARE app
    bis_package: str = "com.bis.bisapp"
    bis_activity: str = ""  # leave blank; agent will use package-only launch

    # Timeouts (seconds)
    appium_new_command_timeout: int = 120
    element_wait_timeout: int = 15
    result_wait_timeout: int = 20

    # File paths
    screenshots_dir: str = "screenshots"
    save_debug_artifacts: bool = False
    include_raw_text: bool = False

    # FastAPI
    api_host: str = "0.0.0.0"
    api_port: int = 8001
    log_level: str = "INFO"
    allowed_origins: str = "*"


settings = Settings()
