"""Portal SSO — re-exported from the shared `lilak_portal_auth` package.

The token-verify / identity / introspect glue lives once in `lilak_portal_auth`
(installed in the shared portal venv). Keep this a thin re-export so every service
shares one implementation; add service-specific auth helpers here, not another copy.
"""
from lilak_portal_auth import (  # noqa: F401  (re-export)
    SECRET_KEY,
    ALGORITHM,
    MANAGER_COLOR,
    decode_token,
    bearer_from_request,
    introspect,
    fresh_payload,
    identity,
    list_accounts,
)
