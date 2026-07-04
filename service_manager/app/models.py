"""
Portal data model — accounts + service registry + permissions, all in one DB.

`User` is a superset of an elog user (same column names/types for the fields that
matter), so a portal token minted from this row carries every attribute an elog
backend needs to link/provision a matching local user on entry.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def _now() -> datetime:
    return datetime.utcnow()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    display_name = Column(String(128))
    email = Column(String(256), nullable=True, index=True)
    phone = Column(String(64), nullable=True)
    # System role: "user" | "manager" (manager == portal admin).
    role = Column(String(16), nullable=False, default="user")
    experiment_role = Column(String(64), nullable=True)
    participation_from = Column(String(10), nullable=True)
    participation_to = Column(String(10), nullable=True)
    profile_color = Column(String(16), nullable=True)
    profile_shape = Column(String(32), nullable=True)
    preferences_json = Column(Text, nullable=True)
    password_hash = Column(String(256), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    # Email ownership confirmation. New signups start unverified and cannot log
    # in until they click the verification link. `verify_token` is the one-time
    # secret in that link (cleared once used). The "send email" step is pluggable
    # — local dev surfaces the link directly; production swaps in Firebase.
    email_verified = Column(Boolean, nullable=False, default=False)
    verify_token = Column(String(64), nullable=True, index=True)
    # When the address was last (re-)verified. Verification expires annually: once
    # it's older than VERIFY_VALID_DAYS the account keeps its login but its project
    # permissions drop to view-only until it re-verifies.
    email_verified_at = Column(DateTime, nullable=True)
    # A requested new email awaiting admin approval (email changes are gated).
    pending_email = Column(String(256), nullable=True)
    created_at = Column(DateTime, nullable=False, default=_now)
    updated_at = Column(DateTime, nullable=False, default=_now, onupdate=_now)


# Email verification is valid for a year; after that, re-verify to keep entering.
VERIFY_VALID_DAYS = 365


# ── Service registry / visibility ────────────────────────────────────────────
VIS_PRIVATE, VIS_PROTECTED, VIS_ADMIN = 1, 2, 3
DEFAULT_VISIBILITY = VIS_PROTECTED


class Service(Base):
    """Portal-level metadata for a service. The *manifest* (service.json) holds
    how to run/reach it; this row holds who may see/enter it."""
    __tablename__ = "portal_services"

    name = Column(String(128), primary_key=True)
    kind = Column(String(32), nullable=False, default="elog")
    visibility = Column(Integer, nullable=False, default=DEFAULT_VISIBILITY)


class ServicePermission(Base):
    __tablename__ = "portal_permissions"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    service_name = Column(String(128), nullable=False, index=True)
    # Per-project grant. "" (empty) means a whole-service grant covering every
    # project in it; a non-empty value grants just that one project.
    project = Column(String(128), nullable=False, default="")
    __table_args__ = (UniqueConstraint("user_id", "service_name", "project", name="uq_user_service_project"),)


class AccessRequest(Base):
    __tablename__ = "portal_access_requests"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    service_name = Column(String(128), nullable=False, index=True)
    project = Column(String(128), nullable=False, default="")
    status = Column(String(16), nullable=False, default="pending")  # pending|approved|rejected
    created_at = Column(DateTime, default=_now)


# ── Groups (assign accounts to groups; grant permissions per group) ───────────
class Group(Base):
    __tablename__ = "portal_groups"

    id = Column(Integer, primary_key=True)
    name = Column(String(64), unique=True, nullable=False, index=True)
    description = Column(String(256), nullable=True)
    icon = Column(String(64), nullable=True)     # square-mark icon (kit ICONS name)
    color = Column(String(16), nullable=True)    # group colour (hex)
    created_at = Column(DateTime, default=_now)


class GroupMembership(Base):
    """A user belongs to a group (many-to-many; one account can be in several)."""
    __tablename__ = "portal_group_members"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    group_id = Column(Integer, nullable=False, index=True)
    __table_args__ = (UniqueConstraint("user_id", "group_id", name="uq_user_group"),)


class GroupPermission(Base):
    """A group's grant to a service / single project. Every member inherits it."""
    __tablename__ = "portal_group_permissions"

    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, nullable=False, index=True)
    service_name = Column(String(128), nullable=False, index=True)
    project = Column(String(128), nullable=False, default="")   # "" = whole service
    __table_args__ = (UniqueConstraint("group_id", "service_name", "project", name="uq_group_service_project"),)


class InviteCode(Base):
    """A redeemable code granting access without admin approval.

    `kind`:
      "project" — grants a service / single project (service_name + project).
      "group"   — joins a group (group_id); the member then inherits that group's
                  project grants.
    The code string may be admin-chosen (≥8 chars) or auto-generated. Reusable
    until it expires or is revoked."""
    __tablename__ = "portal_invite_codes"

    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False, index=True)
    kind = Column(String(16), nullable=False, default="project")   # "project" | "group"
    service_name = Column(String(128), nullable=False, default="")
    project = Column(String(128), nullable=False, default="")      # "" = whole service
    group_id = Column(Integer, nullable=True)                      # for kind="group"
    expires_at = Column(DateTime, nullable=False)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_now)
    uses = Column(Integer, nullable=False, default=0)
    # Redemption cap. 0 = unlimited; 1 = single-use; N = N redemptions, then "used".
    max_uses = Column(Integer, nullable=False, default=0)
    active = Column(Boolean, nullable=False, default=True)
    # Signing up with this code skips email verification (auto-approved).
    no_verify = Column(Boolean, nullable=False, default=False)


# ── Feedback: bug reports / recommendations / inquiries ───────────────────────
class Report(Base):
    """A message from a user to the admins. `kind` sorts the intent
    (bug | recommendation | inquiry); admins reply and mark it resolved."""
    __tablename__ = "portal_reports"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    kind = Column(String(16), nullable=False, default="inquiry")   # bug | recommendation | inquiry
    subject = Column(String(200), nullable=False, default="")
    body = Column(Text, nullable=False, default="")
    status = Column(String(16), nullable=False, default="open")    # open | resolved
    reply = Column(Text, nullable=True)                            # admin's answer
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)
