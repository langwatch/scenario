"""
The LangWatch evaluations API as the scenario runner uses it: the evaluator
catalogue (which inputs an evaluator takes), saved evaluators, and the
evaluate call itself. Same endpoint and headers as the LangWatch SDKs.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx

from scenario._events.event_reporter import _resolve_langwatch_client_api_key
from scenario.config import LangWatchSettings

logger = logging.getLogger("scenario.evaluators.api")

_SAVED_EVALUATOR_PREFIX = "evaluators/"


@dataclass(frozen=True)
class EvaluatorInput:
    id: str
    required: bool


@dataclass(frozen=True)
class EvaluatorSpec:
    """What the runner needs to know about an evaluator before running it."""

    #: The saved evaluator id, or the evaluator type when run by type.
    evaluator_id: str
    name: str
    #: Inputs the evaluator reads, required ones first.
    inputs: List[EvaluatorInput] = field(default_factory=list)
    #: Whether the evaluator answers pass or fail (against a score only).
    produces_passed: bool = True


class EvaluationsApiError(RuntimeError):
    """A transport or HTTP failure of the evaluations API."""


@dataclass(frozen=True)
class EvaluationsApiAuth:
    endpoint: str
    api_key: str
    project_id: str


def resolve_evaluations_api_auth() -> EvaluationsApiAuth:
    """
    The endpoint, key and project the run reports to: the LANGWATCH_*
    environment variables, then the key set through ``langwatch.setup``.
    """
    settings = LangWatchSettings()
    return EvaluationsApiAuth(
        endpoint=str(settings.endpoint).rstrip("/"),
        api_key=settings.api_key or _resolve_langwatch_client_api_key(),
        project_id=settings.project_id,
    )


class EvaluationsApiClient:
    def __init__(
        self,
        auth: EvaluationsApiAuth,
        *,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._auth = auth
        self._client = client
        self._catalogue: Optional[Dict[str, Dict[str, Any]]] = None

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._auth.api_key}",
            "X-Auth-Token": self._auth.api_key,
        }
        if self._auth.project_id:
            headers["X-Project-Id"] = self._auth.project_id
        return headers

    async def _request(
        self, method: str, path: str, *, json: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        url = f"{self._auth.endpoint}{path}"
        # No redirect following: httpx drops Authorization across hosts but
        # keeps X-Auth-Token, so a misconfigured endpoint would forward the
        # API key to the redirect target.
        if self._client is not None:
            response = await self._client.request(
                method, url, headers=self._headers(), json=json
            )
        else:
            async with httpx.AsyncClient(follow_redirects=False) as client:
                response = await client.request(
                    method,
                    url,
                    headers=self._headers(),
                    json=json,
                    timeout=httpx.Timeout(120.0),
                )
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise EvaluationsApiError(
                f"{method} {path} answered {response.status_code}: {response.text}"
            )
        return response.json()

    async def _load_catalogue(self) -> Dict[str, Dict[str, Any]]:
        if self._catalogue is None:
            body = await self._request("GET", "/api/evaluations/list")
            self._catalogue = dict((body or {}).get("evaluators") or {})
        return self._catalogue

    @staticmethod
    def _spec_from_catalogue(
        *, evaluator_id: str, entry: Dict[str, Any], name: Optional[str] = None
    ) -> EvaluatorSpec:
        result = entry.get("result") or {}
        return EvaluatorSpec(
            evaluator_id=evaluator_id,
            name=name or str(entry.get("name") or evaluator_id),
            inputs=[
                *[EvaluatorInput(id=str(i), required=True) for i in entry.get("requiredFields") or []],
                *[EvaluatorInput(id=str(i), required=False) for i in entry.get("optionalFields") or []],
            ],
            produces_passed="passed" in result,
        )

    async def get_evaluator_spec(self, evaluator_ref: str) -> Optional[EvaluatorSpec]:
        """
        Which inputs an evaluator takes and what to call it. A built-in type
        is read from the catalogue; a saved evaluator from its record, then
        from the catalogue entry of its type. None when the evaluator is
        unknown.
        """
        if not evaluator_ref.startswith(_SAVED_EVALUATOR_PREFIX):
            entry = (await self._load_catalogue()).get(evaluator_ref)
            if entry is None:
                return None
            return self._spec_from_catalogue(evaluator_id=evaluator_ref, entry=entry)

        id_or_slug = evaluator_ref[len(_SAVED_EVALUATOR_PREFIX) :]
        saved = await self._request(
            "GET", f"/api/evaluators/{quote(id_or_slug, safe='')}"
        )
        if saved is None:
            return None
        evaluator_type = (saved.get("config") or {}).get("evaluatorType")
        entry = (await self._load_catalogue()).get(evaluator_type) if evaluator_type else None
        if entry is not None:
            return self._spec_from_catalogue(
                evaluator_id=str(saved["id"]), entry=entry, name=str(saved.get("name") or evaluator_ref)
            )
        logger.debug(
            "Saved evaluator %s has no catalogue entry for its type; only explicit mappings are used",
            evaluator_ref,
        )
        return EvaluatorSpec(
            evaluator_id=str(saved["id"]),
            name=str(saved.get("name") or evaluator_ref),
            inputs=[],
            produces_passed=True,
        )

    async def evaluate(
        self,
        *,
        evaluator_ref: str,
        data: Dict[str, Any],
        settings: Optional[Dict[str, Any]] = None,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Runs one evaluator over the resolved inputs. Raises on a transport or
        HTTP failure; an evaluator failure comes back as ``status: "error"``.
        """
        body = await self._request(
            "POST",
            f"/api/evaluations/{evaluator_ref}/evaluate",
            json={"data": data, "settings": settings, "trace_id": trace_id},
        )
        if body is None:
            raise EvaluationsApiError(f"Evaluator {evaluator_ref} was not found in LangWatch")
        return body
