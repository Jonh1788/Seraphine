"""Route registration helper."""

from fastapi import FastAPI

from . import (
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

_ROUTE_MODULES = [
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
]


def register_routes(app: FastAPI) -> None:
    for mod in _ROUTE_MODULES:
        app.include_router(mod.router)
