"""Environment-based configuration for the browser automation service."""

import os

BROWSER_PORT: int = int(os.environ.get("BROWSER_PORT", "3002"))
BROWSER_HEADLESS: bool = os.environ.get("BROWSER_HEADLESS", "false").lower() in (
    "true",
    "1",
    "yes",
)
BROWSER_VIEWPORT_WIDTH: int = int(os.environ.get("BROWSER_VIEWPORT_WIDTH", "1280"))
BROWSER_VIEWPORT_HEIGHT: int = int(os.environ.get("BROWSER_VIEWPORT_HEIGHT", "800"))
BROWSER_USER_DATA_DIR: str = os.environ.get("BROWSER_USER_DATA_DIR", "./user-data")
BROWSER_SLOW_MO: int = int(os.environ.get("BROWSER_SLOW_MO", "100"))
