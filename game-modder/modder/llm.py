"""Minimal clients for local LLM servers, using only the standard library.

Backends:
  ollama  - Ollama's native API (default http://localhost:11434)
  openai  - any OpenAI-compatible local server: LM Studio (http://localhost:1234/v1),
            llama.cpp server (http://localhost:8080/v1), KoboldCpp, Jan, vLLM ...

Messages use one internal format (OpenAI-style):
  {"role": "assistant", "content": str, "tool_calls": [{"id", "name", "arguments": dict}]}
  {"role": "tool", "tool_call_id": str, "name": str, "content": str}
"""

import json
import re
import urllib.error
import urllib.request
import uuid

DEFAULT_URLS = {"ollama": "http://localhost:11434", "openai": "http://localhost:1234/v1"}


class LLMError(Exception):
    pass


def _post(url, payload, timeout):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    return _send(req, timeout)


def _get(url, timeout):
    return _send(urllib.request.Request(url), timeout)


def _send(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        raise LLMError(f"{req.full_url} returned HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise LLMError(f"Can't reach the local AI server at {req.full_url} ({e.reason}). Is it running?")
    except TimeoutError:
        raise LLMError("The local AI server timed out. Try a smaller model or raise --timeout.")


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


def _clean(content):
    return _THINK.sub("", content or "").strip()


def _fallback_tool_calls(content, tool_names):
    """Some local models print a tool call as JSON text instead of using the tool API. Recover it."""
    candidates = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL) or [content.strip()]
    calls = []
    for c in candidates:
        c = re.sub(r"^<tool_call>|</tool_call>$", "", c.strip()).strip()
        try:
            obj = json.loads(c)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("name") in tool_names:
            args = obj.get("arguments", obj.get("parameters", {}))
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            calls.append({"id": f"call_{uuid.uuid4().hex[:8]}", "name": obj["name"], "arguments": args or {}})
    return calls


class LLMClient:
    def __init__(self, backend="ollama", model="qwen3:8b", base_url=None, timeout=600, num_ctx=16384,
                 temperature=0.2, api_key=None):
        if backend not in DEFAULT_URLS:
            raise LLMError(f"Unknown backend {backend!r}; use 'ollama' or 'openai'.")
        self.backend = backend
        self.model = model
        self.base_url = (base_url or DEFAULT_URLS[backend]).rstrip("/")
        self.timeout = timeout
        self.num_ctx = num_ctx
        self.temperature = temperature
        self.api_key = api_key

    def list_models(self):
        if self.backend == "ollama":
            return [m["name"] for m in _get(f"{self.base_url}/api/tags", 15).get("models", [])]
        return [m["id"] for m in _get(f"{self.base_url}/models", 15).get("data", [])]

    def chat(self, messages, tools=None):
        tool_names = {t["function"]["name"] for t in tools or []}
        if self.backend == "ollama":
            result = self._chat_ollama(messages, tools)
        else:
            result = self._chat_openai(messages, tools)
        if not result["tool_calls"] and tool_names and "{" in result["content"]:
            calls = _fallback_tool_calls(result["content"], tool_names)
            if calls:
                result = {"content": "", "tool_calls": calls}
        return result

    # --- Ollama native ---
    def _chat_ollama(self, messages, tools):
        out = []
        for m in messages:
            if m["role"] == "assistant" and m.get("tool_calls"):
                out.append({"role": "assistant", "content": m.get("content") or "",
                            "tool_calls": [{"function": {"name": c["name"], "arguments": c["arguments"]}}
                                           for c in m["tool_calls"]]})
            elif m["role"] == "tool":
                out.append({"role": "tool", "content": m["content"], "tool_name": m.get("name", "")})
            else:
                out.append({"role": m["role"], "content": m["content"]})
        payload = {"model": self.model, "messages": out, "stream": False,
                   "options": {"num_ctx": self.num_ctx, "temperature": self.temperature}}
        if tools:
            payload["tools"] = tools
        data = _post(f"{self.base_url}/api/chat", payload, self.timeout)
        if "error" in data:
            raise LLMError(data["error"])
        msg = data.get("message", {})
        calls = []
        for c in msg.get("tool_calls") or []:
            fn = c.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args or "{}")
            calls.append({"id": f"call_{uuid.uuid4().hex[:8]}", "name": fn.get("name", ""), "arguments": args})
        return {"content": _clean(msg.get("content")), "tool_calls": calls}

    # --- OpenAI-compatible ---
    def _chat_openai(self, messages, tools):
        out = []
        for m in messages:
            if m["role"] == "assistant" and m.get("tool_calls"):
                out.append({"role": "assistant", "content": m.get("content") or None,
                            "tool_calls": [{"id": c["id"], "type": "function",
                                            "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
                                           for c in m["tool_calls"]]})
            elif m["role"] == "tool":
                out.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"]})
            else:
                out.append({"role": m["role"], "content": m["content"]})
        payload = {"model": self.model, "messages": out, "temperature": self.temperature}
        if tools:
            payload["tools"] = tools
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json",
                                              **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {})})
        data = _send(req, self.timeout)
        if "error" in data:
            raise LLMError(str(data["error"]))
        msg = (data.get("choices") or [{}])[0].get("message", {})
        calls = []
        for c in msg.get("tool_calls") or []:
            fn = c.get("function", {})
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            calls.append({"id": c.get("id") or f"call_{uuid.uuid4().hex[:8]}", "name": fn.get("name", ""), "arguments": args})
        return {"content": _clean(msg.get("content")), "tool_calls": calls}
