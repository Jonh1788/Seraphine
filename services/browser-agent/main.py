"""Browser automation service - FastAPI app with Playwright lifecycle."""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

import config
from browser import BrowserManager
from routes import register_routes
from routes import (
    click,
    close,
    health,
    keyboard,
    navigate,
    page,
    screenshot,
    scroll,
    select,
    type_text,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("browser-agent")

# ---------------------------------------------------------------------------
# Browser singleton
# ---------------------------------------------------------------------------
browser_manager = BrowserManager(
    headless=config.BROWSER_HEADLESS,
    viewport_w=config.BROWSER_VIEWPORT_WIDTH,
    viewport_h=config.BROWSER_VIEWPORT_HEIGHT,
    user_data_dir=config.BROWSER_USER_DATA_DIR,
    slow_mo=config.BROWSER_SLOW_MO,
)

# Inject the manager into every route module
for mod in (click, close, health, keyboard, navigate, page, screenshot, scroll, select, type_text):
    mod.init(browser_manager)


# ---------------------------------------------------------------------------
# Lifespan: launch browser on startup, close on shutdown
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    await browser_manager.launch()
    logger.info("Browser service ready on port %s", config.BROWSER_PORT)
    yield
    await browser_manager.close()
    logger.info("Browser service shut down.")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Seraphine Browser Service",
    version="0.1.0",
    lifespan=lifespan,
)
register_routes(app)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.BROWSER_PORT)
