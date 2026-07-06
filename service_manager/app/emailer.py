"""Email delivery helpers for portal account flows."""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from . import config


class EmailDeliveryError(RuntimeError):
    pass


def send_verification_email(to_email: str, verification_code: str) -> None:
    if not config.RESEND_API_KEY or not config.RESEND_FROM_EMAIL:
        raise EmailDeliveryError("Resend is not configured")

    payload = {
        "from": config.RESEND_FROM_EMAIL,
        "to": [to_email],
        "subject": "Verify your LILAK Web Portal account",
        "html": _verification_html(verification_code),
        "text": (
            "Verify your LILAK Web Portal account with this code:\n\n"
            f"{verification_code}\n\n"
            "If you did not create this account, you can ignore this email."
        ),
    }
    if config.RESEND_REPLY_TO:
        payload["reply_to"] = [config.RESEND_REPLY_TO]

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {config.RESEND_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "lilak-web-portal/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            if res.status < 200 or res.status >= 300:
                raise EmailDeliveryError(f"Resend returned HTTP {res.status}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise EmailDeliveryError(f"Resend returned HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise EmailDeliveryError(f"Could not reach Resend: {exc.reason}") from exc


def _verification_html(verification_code: str) -> str:
    return f"""<!doctype html>
<html>
  <body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#14140f">
    <h2 style="margin:0 0 12px">Verify your LILAK Web Portal account</h2>
    <p>Enter this 6-digit code in the portal to finish creating your account.</p>
    <p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:20px 0">{verification_code}</p>
    <p style="font-size:13px;color:#555">If you did not create this account, you can ignore this email.</p>
  </body>
</html>"""
