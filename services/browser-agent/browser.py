"""Playwright browser singleton: launch, context, page."""

from __future__ import annotations

import logging
from typing import Optional

from playwright.async_api import (
    Playwright,
    BrowserContext,
    Page,
    async_playwright,
)

logger = logging.getLogger(__name__)


class BrowserManager:
    """Manages a single Playwright Chromium persistent context."""

    def __init__(
        self,
        headless: bool,
        viewport_w: int,
        viewport_h: int,
        user_data_dir: str,
        slow_mo: int,
    ) -> None:
        self.headless = headless
        self.viewport_w = viewport_w
        self.viewport_h = viewport_h
        self.user_data_dir = user_data_dir
        self.slow_mo = slow_mo

        self._playwright: Optional[Playwright] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def launch(self) -> None:
        """Start Playwright and open a persistent Chromium context."""
        logger.info(
            "Launching Chromium (headless=%s, viewport=%dx%d, slow_mo=%d)",
            self.headless,
            self.viewport_w,
            self.viewport_h,
            self.slow_mo,
        )
        self._playwright = await async_playwright().start()
        self._context = await self._playwright.chromium.launch_persistent_context(
            user_data_dir=self.user_data_dir,
            headless=self.headless,
            viewport={"width": self.viewport_w, "height": self.viewport_h},
            slow_mo=self.slow_mo,
            args=["--disable-blink-features=AutomationControlled"],
        )
        # Reuse the default page created by the persistent context, or make one.
        self._page = (
            self._context.pages[0]
            if self._context.pages
            else await self._context.new_page()
        )
        logger.info("Browser ready.")

    async def close(self) -> None:
        """Shut down browser and Playwright."""
        if self._context:
            await self._context.close()
            self._context = None
            self._page = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
        logger.info("Browser closed.")

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._page is not None and not self._page.is_closed()

    @property
    def page(self) -> Page:
        if not self.ready:
            raise RuntimeError("Browser is not ready")
        assert self._page is not None
        return self._page
