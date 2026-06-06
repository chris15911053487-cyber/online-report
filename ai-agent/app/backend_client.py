"""回调主后端 internal skill 端点（带 scoped token）。Agent 无 DB 凭据，数据一律经此取。"""
import httpx

from .config import settings


class BackendClient:
    def __init__(self, scoped_token: str):
        self.scoped_token = scoped_token
        self.base = settings.BACKEND_URL

    def _post(self, path: str, body: dict) -> dict:
        headers = {"Content-Type": "application/json", "X-Scoped-Token": self.scoped_token}
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(f"{self.base}{path}", json=body, headers=headers)
            data = {}
            try:
                data = resp.json()
            except Exception:  # noqa: BLE001
                data = {"error": resp.text}
            if resp.status_code >= 400:
                msg = data.get("error") if isinstance(data, dict) else resp.text
                raise RuntimeError(f"backend {path} {resp.status_code}: {msg}")
            return data

    def run_report(self, route_key: str, params: dict) -> dict:
        return self._post("/ai/agent/internal/run-report", {"routeKey": route_key, "params": params or {}})

    def lookup_options(self, route_key: str, field_name: str, keyword: str) -> dict:
        return self._post(
            "/ai/agent/internal/lookup-options",
            {"routeKey": route_key, "fieldName": field_name, "keyword": keyword or ""},
        )

    def knowledge_search(self, query: str, top_k: int = 5) -> dict:
        return self._post("/ai/agent/internal/knowledge-search", {"query": query, "topK": top_k})

    def save_record(self, entity: str, payload: dict) -> dict:
        return self._post("/ai/agent/internal/save-record", {"entity": entity, "payload": payload or {}})

    def store_document(self, filename: str, ext: str, content_base64: str) -> dict:
        return self._post(
            "/ai/agent/internal/store-document",
            {"filename": filename, "ext": ext, "contentBase64": content_base64},
        )
