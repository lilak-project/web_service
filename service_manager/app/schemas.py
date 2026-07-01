"""Pydantic request/response shapes. Mirrors the elog auth shapes the frontend
already speaks (LoginRequest / RegisterRequest / TokenResponse / UserOut)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str
    email: str   # required — email verification needs a deliverable address
    display_name: Optional[str] = None
    phone: Optional[str] = None
    experiment_role: Optional[str] = None
    participation_from: Optional[str] = None
    participation_to: Optional[str] = None
    profile_color: Optional[str] = None
    profile_shape: Optional[str] = None
    invite_code: Optional[str] = None   # optional project-access code → instant grant


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    username: str
    role: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: Optional[str] = None
    email: Optional[str] = None
    role: str
    profile_color: Optional[str] = None
    profile_shape: Optional[str] = None
