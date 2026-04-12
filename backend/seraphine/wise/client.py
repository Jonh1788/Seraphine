"""Async httpx wrapper for the Wise Platform API.

Supports profiles, quotes, recipients, transfers, balances — everything
needed for PIX payments via the Wise multi-currency account.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx

logger = logging.getLogger(__name__)

WISE_PRODUCTION_URL = "https://api.transferwise.com"
WISE_SANDBOX_URL = "https://api.sandbox.transferwise.tech"


class WiseError(Exception):
    """Base error for Wise API failures."""

    def __init__(self, message: str, status_code: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class WiseAuthError(WiseError):
    pass


class WiseSCARequired(WiseError):
    """Strong Customer Authentication required (403 with X-2FA-Approval)."""

    def __init__(self, message: str, one_time_token: str = "", body: Any = None) -> None:
        super().__init__(message, status_code=403, body=body)
        self.one_time_token = one_time_token


class WiseValidationError(WiseError):
    pass


class WiseRateLimitError(WiseError):
    pass


class WiseClient:
    """Async client for the Wise Platform API.

    Parameters
    ----------
    api_key : str
        Wise API token (personal or business).
    profile_id : int
        Wise profile ID. Pass 0 to auto-detect on first call.
    sandbox : bool
        Use sandbox URL instead of production.
    """

    def __init__(
        self,
        api_key: str,
        profile_id: int = 0,
        sandbox: bool = False,
    ) -> None:
        base_url = WISE_SANDBOX_URL if sandbox else WISE_PRODUCTION_URL
        self._profile_id = profile_id
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _ensure_profile(self) -> int:
        """Return the profile ID, auto-detecting if needed."""
        if self._profile_id:
            return self._profile_id
        profiles = await self.get_profiles()
        for p in profiles:
            if p.get("type") == "personal":
                self._profile_id = p["id"]
                logger.info("Wise auto-detected personal profile id=%d", self._profile_id)
                return self._profile_id
        if profiles:
            self._profile_id = profiles[0]["id"]
            logger.info("Wise using first profile id=%d", self._profile_id)
            return self._profile_id
        raise WiseError("No Wise profiles found for this API key")

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        resp = await self._http.request(method, path, json=json, params=params)
        return self._handle_response(resp)

    @staticmethod
    def _handle_response(resp: httpx.Response) -> Any:
        if resp.status_code == 401:
            raise WiseAuthError(
                "Wise authentication failed (401). Check your API key.",
                status_code=401,
                body=resp.text,
            )
        if resp.status_code == 403:
            ott = resp.headers.get("X-2FA-Approval", "")
            raise WiseSCARequired(
                f"Strong Customer Authentication required (403). "
                f"X-2FA-Approval token: {ott or 'not provided'}. "
                f"Sign the token with your private key and retry with "
                f"X-2FA-Approval and X-Signature headers.",
                one_time_token=ott,
                body=resp.text,
            )
        if resp.status_code == 422:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            errors = body if isinstance(body, list) else [body]
            details = "; ".join(
                f"{e.get('path', '?')}: {e.get('message', str(e))}"
                for e in errors
                if isinstance(e, dict)
            )
            raise WiseValidationError(
                f"Validation error (422): {details or resp.text}",
                status_code=422,
                body=body,
            )
        if resp.status_code == 429:
            raise WiseRateLimitError(
                "Rate limited by Wise (429). Try again later.",
                status_code=429,
                body=resp.text,
            )
        resp.raise_for_status()
        if resp.status_code == 204:
            return {}
        return resp.json()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_profiles(self) -> list[dict]:
        """GET /v1/profiles"""
        return await self._request("GET", "/v1/profiles")

    async def create_quote(
        self,
        source_currency: str,
        target_currency: str,
        amount: float,
        pay_out: str = "PIX",
    ) -> dict:
        """POST /v3/profiles/{id}/quotes"""
        profile_id = await self._ensure_profile()
        payload: dict[str, Any] = {
            "sourceCurrency": source_currency.upper(),
            "targetCurrency": target_currency.upper(),
            "targetAmount": amount,
            "payOut": pay_out,
        }
        return await self._request(
            "POST", f"/v3/profiles/{profile_id}/quotes", json=payload
        )

    async def create_recipient(
        self,
        name: str,
        pix_key: str,
        pix_key_type: str,
        currency: str = "BRL",
    ) -> dict:
        """POST /v1/accounts"""
        profile_id = await self._ensure_profile()
        payload = {
            "profile": profile_id,
            "accountHolderName": name,
            "currency": currency.upper(),
            "type": "pix",
            "details": {
                "pixKey": pix_key,
                "pixKeyType": pix_key_type.upper(),
                "legalType": "PRIVATE",
            },
        }
        return await self._request("POST", "/v1/accounts", json=payload)

    async def list_recipients(self, currency: str = "BRL") -> list[dict]:
        """GET /v1/accounts?profile={id}&currency={currency}"""
        profile_id = await self._ensure_profile()
        return await self._request(
            "GET",
            "/v1/accounts",
            params={"profile": profile_id, "currency": currency.upper()},
        )

    async def create_transfer(
        self,
        quote_id: str,
        recipient_id: int,
        reference: str = "",
    ) -> dict:
        """POST /v1/transfers"""
        payload: dict[str, Any] = {
            "targetAccount": recipient_id,
            "quoteUuid": quote_id,
            "customerTransactionId": str(uuid.uuid4()),
        }
        if reference:
            payload["details"] = {"reference": reference}
        return await self._request("POST", "/v1/transfers", json=payload)

    async def fund_transfer(self, transfer_id: int) -> dict:
        """POST /v3/profiles/{id}/transfers/{id}/payments (type=BALANCE)"""
        profile_id = await self._ensure_profile()
        return await self._request(
            "POST",
            f"/v3/profiles/{profile_id}/transfers/{transfer_id}/payments",
            json={"type": "BALANCE"},
        )

    async def get_transfer(self, transfer_id: int) -> dict:
        """GET /v1/transfers/{id}"""
        return await self._request("GET", f"/v1/transfers/{transfer_id}")

    async def get_balances(self) -> list[dict]:
        """GET /v4/profiles/{id}/balances?types=STANDARD"""
        profile_id = await self._ensure_profile()
        return await self._request(
            "GET",
            f"/v4/profiles/{profile_id}/balances",
            params={"types": "STANDARD"},
        )

    async def list_transfers(self, limit: int = 20) -> list[dict]:
        """GET /v1/transfers"""
        profile_id = await self._ensure_profile()
        return await self._request(
            "GET",
            "/v1/transfers",
            params={"profile": profile_id, "limit": limit},
        )

    async def aclose(self) -> None:
        """Close the underlying httpx client."""
        await self._http.aclose()
