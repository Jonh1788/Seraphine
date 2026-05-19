"""POST /auth/register, POST /auth/login, GET /auth/me."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

from core_auth import issue
from mod_tasks.routes import get_current_user_id

from aura.auth.service import (
    InvalidCredentials,
    UserAlreadyExists,
    UsersService,
)
from aura.config import settings

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)


class RegisterBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=64)


class LoginBody(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str
    name: str | None = None


def _service_or_503(request: Request) -> UsersService:
    svc: Optional[UsersService] = getattr(request.app.state, "users_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="users service not configured")
    return svc


@router.post("/register", response_model=TokenResponse)
async def register(request: Request, body: RegisterBody) -> TokenResponse:
    svc = _service_or_503(request)
    try:
        user_id = await svc.register(
            str(body.email), body.password, body.name,
        )
    except UserAlreadyExists:
        raise HTTPException(status_code=409, detail="email já cadastrado")
    except InvalidCredentials as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    token = issue(
        user_id, settings.jwt_secret,
        expires_in_seconds=settings.jwt_expires_seconds,
    )
    return TokenResponse(
        access_token=token, user_id=user_id,
        email=str(body.email).strip().lower(),
        name=body.name.strip() or None,
    )


@router.post("/login", response_model=TokenResponse)
async def login(request: Request, body: LoginBody) -> TokenResponse:
    svc = _service_or_503(request)
    try:
        user_id = await svc.authenticate(str(body.email), body.password)
    except InvalidCredentials:
        raise HTTPException(status_code=401, detail="email ou senha inválidos")
    name = await svc.get_name(user_id)
    token = issue(
        user_id, settings.jwt_secret,
        expires_in_seconds=settings.jwt_expires_seconds,
    )
    return TokenResponse(
        access_token=token, user_id=user_id,
        email=str(body.email).strip().lower(), name=name,
    )


@router.get("/me")
async def me(
    request: Request,
    user_id: str = Depends(get_current_user_id),
) -> dict:
    if user_id is None:
        # Defensive — the dep override should make this unreachable.
        raise HTTPException(status_code=401, detail="unauthenticated")
    svc = _service_or_503(request)
    email = await svc.get_email(user_id)
    if email is None:
        raise HTTPException(status_code=401, detail="user not found")
    name = await svc.get_name(user_id)
    return {"id": user_id, "email": email, "name": name}
