"""A local A2A agent for tests: an Agent Card plus JSON-RPC and HTTP+JSON SendMessage."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional

Reply = Callable[[Dict[str, Any]], Dict[str, Any]]


def text_message(text: str, context_id: str) -> Dict[str, Any]:
    return {
        "message": {
            "messageId": "reply",
            "contextId": context_id,
            "role": "ROLE_AGENT",
            "parts": [{"text": text}],
        }
    }


def echo_reply(request: Dict[str, Any]) -> Dict[str, Any]:
    message = request["message"]
    return text_message(f"echo: {message['parts'][0]['text']}", message["contextId"])


class FakeA2AServer:
    """Serves a card at ``/.well-known/agent-card.json`` and records every request."""

    def __init__(
        self,
        reply: Reply = echo_reply,
        binding: str = "JSONRPC",
        name: str = "Fake A2A Agent",
        jsonrpc_error: Optional[Dict[str, Any]] = None,
        card: Optional[Dict[str, Any]] = None,
        card_status: int = 200,
        card_redirect: Optional[str] = None,
        get_task: Optional[Reply] = None,
        raw_reply: Optional[bytes] = None,
        tenant: Optional[str] = None,
    ):
        self.reply = reply
        self.binding = binding
        self.name = name
        self.jsonrpc_error = jsonrpc_error
        self.card_override = card
        self.card_status = card_status
        self.card_redirect = card_redirect
        self.get_task = get_task
        self.raw_reply = raw_reply
        self.tenant = tenant
        self.requests: List[Dict[str, Any]] = []
        self.card_headers: List[Dict[str, str]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return None

            def _send(self, payload: Dict[str, Any], status: int = 200) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                if "/tasks/" in self.path and server.get_task:
                    headers = {k.lower(): v for k, v in self.headers.items()}
                    server.requests.append({"path": self.path, "headers": headers, "body": None})
                    self._send(server.get_task({"id": self.path.rsplit("/", 1)[1]}))
                    return
                server.card_headers.append({k.lower(): v for k, v in self.headers.items()})
                if server.card_redirect:
                    self.send_response(302)
                    self.send_header("Location", server.card_redirect)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self._send(server.card(), status=server.card_status)

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length))
                headers = {k.lower(): v for k, v in self.headers.items()}
                server.requests.append({"path": self.path, "headers": headers, "body": body})
                if server.raw_reply is not None:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(server.raw_reply)))
                    self.end_headers()
                    self.wfile.write(server.raw_reply)
                    return
                if server.binding == "HTTP+JSON":
                    reply = server.reply(body)
                    self._send(reply, status=404 if "error" in reply else 200)
                    return
                if server.jsonrpc_error:
                    self._send({"jsonrpc": "2.0", "id": body["id"], "error": server.jsonrpc_error})
                    return
                if body.get("method") == "GetTask" and server.get_task:
                    self._send({"jsonrpc": "2.0", "id": body["id"], "result": server.get_task(body["params"])})
                    return
                result = server.reply(body["params"])
                if "error" in result:
                    self._send({"jsonrpc": "2.0", "id": body["id"], "error": result["error"]})
                    return
                self._send({"jsonrpc": "2.0", "id": body["id"], "result": result})

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self.card_url = f"{self.base_url}/.well-known/agent-card.json"

    def card(self) -> Dict[str, Any]:
        if self.card_override is not None:
            return self.card_override
        interface: Dict[str, Any] = {
            "url": f"{self.base_url}/a2a",
            "protocolBinding": self.binding,
            "protocolVersion": "1.0",
        }
        if self.tenant:
            interface["tenant"] = self.tenant
        return {
            "name": self.name,
            "description": "A fake agent for tests",
            "version": "1.0.0",
            "supportedInterfaces": [interface],
            "capabilities": {"streaming": False},
            "defaultInputModes": ["text/plain"],
            "defaultOutputModes": ["text/plain"],
            "skills": [{"id": "echo", "name": "Echo", "description": "Echoes", "tags": []}],
        }

    def __enter__(self) -> "FakeA2AServer":
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *args: Any) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
