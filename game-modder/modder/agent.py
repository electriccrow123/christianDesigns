"""The modding agent: a local LLM that inspects and edits one game folder through a small set of safe tools."""

import json
import re

from . import edits
from .edits import EditError
from .llm import LLMError
from .scanner import format_profile
from .workspace import ModderError

MAX_TOOL_OUTPUT = 12000

SYSTEM_PROMPT = """You are Game Modder, a local assistant that helps the user mod PC games they own, for single-player/offline use.
You work inside ONE game folder and can only touch files in it, through your tools. Every edit you make is shown to the
user as a diff and only applied if they approve. Originals are backed up automatically and can be restored at any time.

How to work:
1. Understand the request. If it's vague ("make the game easier"), pick concrete, sensible changes and say what they are.
2. Find the right data: use the game profile below, then search_files / list_files / read_file. Never guess file contents;
   always read the relevant part of a file before changing it.
3. Make the smallest edit that does the job. Prefer set_json_value for JSON, set_ini_value for INI/CFG,
   replace_text for everything else (copy 'old' exactly from read_file output, without the line-number prefix).
   Use write_file only to create new files (e.g. a Ren'Py zz_mod.rpy override) or when a full rewrite is unavoidable.
4. Keep the game's file format valid (JSON syntax, Lua syntax, etc.) and keep values in sensible ranges unless asked.
5. When done, summarise what you changed (file, old -> new) and how to undo it (/undo or /revert).

Limits:
- If a change needs an external tool (BepInEx, UE4SS, UndertaleModTool, xEdit, SMAPI, FModel...), or the data is in packed
  or binary files you can't edit as text, explain step by step what the user should do instead of pretending.
- Never help bypass anti-cheat, DRM or licence checks, and never make cheats for online/multiplayer play. If the game has
  anti-cheat, remind the user to only use mods offline.
- Be concise. Use tools rather than asking the user for things you can look up yourself.

GAME PROFILE
{profile}
"""


def _fn(name, description, properties, required=()):
    return {"type": "function", "function": {"name": name, "description": description,
                                             "parameters": {"type": "object", "properties": properties,
                                                            "required": list(required)}}}


_S = {"type": "string"}
_I = {"type": "integer"}
_B = {"type": "boolean"}

TOOLS = [
    _fn("list_files", "List files and folders in the game folder.",
        {"path": {**_S, "description": "Folder relative to the game root (default '.')"},
         "depth": {**_I, "description": "How many levels deep (1-6, default 1)"},
         "pattern": {**_S, "description": "Optional filename glob, e.g. '*.json'"}}),
    _fn("read_file", "Read a text file with line numbers.",
        {"path": _S, "offset": {**_I, "description": "First line (1-based)"},
         "limit": {**_I, "description": "Max lines (default 200)"}}, ["path"]),
    _fn("search_files", "Search all text files in the game for a word or regex. Returns file:line: text.",
        {"query": _S, "glob": {**_S, "description": "Optional filename glob, e.g. '*.ini'"},
         "regex": {**_B, "description": "Treat query as a regular expression"}}, ["query"]),
    _fn("get_json_value", "Read a value from a JSON file by key path like 'items[3].price' or 'config.player.hp'.",
        {"path": _S, "key_path": _S}, ["path", "key_path"]),
    _fn("set_json_value", "Change one value in a JSON file (keeps the rest of the file's formatting).",
        {"path": _S, "key_path": _S,
         "value": {**_S, "description": "New value as JSON: 999, 1.5, true, \"text\", [1,2]"}},
        ["path", "key_path", "value"]),
    _fn("set_ini_value", "Set key=value in an INI/CFG file section (adds the key/section if missing).",
        {"path": _S, "section": {**_S, "description": "Section name without brackets; '' for keys before any section"},
         "key": _S, "value": _S}, ["path", "section", "key", "value"]),
    _fn("replace_text", "Replace an exact piece of text in a file. 'old' must match exactly and be unique.",
        {"path": _S, "old": _S, "new": _S, "replace_all": _B}, ["path", "old", "new"]),
    _fn("write_file", "Create a new text file, or completely overwrite one.",
        {"path": _S, "content": _S}, ["path", "content"]),
    _fn("list_changes", "List the mod changes applied so far (with ids).", {}),
    _fn("undo_last_change", "Undo the most recent applied change.", {}),
]


def _truncate(text, limit=MAX_TOOL_OUTPUT):
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated {len(text) - limit} characters; use offset/limit or a narrower search]"


class ModderAgent:
    def __init__(self, workspace, profile, llm, confirm, on_event=None, auto_approve=False, max_steps=30):
        """confirm(change) -> bool asks the user to approve a Change. on_event(kind, data) reports progress."""
        self.ws = workspace
        self.profile = profile
        self.llm = llm
        self.confirm = confirm
        self.on_event = on_event or (lambda kind, data: None)
        self.auto_approve = auto_approve
        self.max_steps = max_steps
        self.reset()

    def reset(self):
        self.messages = [{"role": "system", "content": SYSTEM_PROMPT.format(profile=format_profile(self.profile, 40))}]

    # ----- tool dispatch -----

    def _apply(self, change, reason):
        self.on_event("proposal", change)
        if not (self.auto_approve or self.confirm(change)):
            return "The user declined this change. Ask what they'd prefer or try a different approach."
        cid = self.ws.apply(change, reason)
        self.on_event("applied", {"id": cid, "change": change})
        return f"Applied as change #{cid}: {change.summary or change.rel}\n{change.diff(context=1, max_lines=40)}"

    def run_tool(self, name, args, reason=""):
        a = args or {}
        if name == "list_files":
            out = self.ws.list_dir(a.get("path", "."), a.get("depth", 1), a.get("pattern"))
            return "\n".join(out) or "(empty)"
        if name == "read_file":
            return self.ws.read_lines(a["path"], a.get("offset", 1), a.get("limit", 200))
        if name == "search_files":
            res = self.ws.search(a["query"], a.get("glob"), bool(a.get("regex")))
            return "\n".join(res) or "No matches."
        if name == "get_json_value":
            text, _ = self.ws.read_text(a["path"])
            val = edits.json_get(text, a["key_path"])
            return json.dumps(val, ensure_ascii=False, indent=1)
        if name == "set_json_value":
            value = edits.parse_value(a["value"])
            return self._apply(self.ws.propose_json_set(a["path"], a["key_path"], value), reason)
        if name == "set_ini_value":
            return self._apply(self.ws.propose_ini_set(a["path"], a.get("section", ""), a["key"], a["value"]), reason)
        if name == "replace_text":
            return self._apply(self.ws.propose_replace(a["path"], a["old"], a["new"], bool(a.get("replace_all"))), reason)
        if name == "write_file":
            ch = self.ws.propose_text(a["path"], a["content"], "write_file",
                                      ("create " if not self.ws.resolve(a["path"]).exists() else "rewrite ") + a["path"])
            return self._apply(ch, reason)
        if name == "list_changes":
            hist = self.ws.history()
            return "\n".join(f"#{c['id']} {c['time']} {c['summary'] or c['path']}" for c in hist) or "No changes yet."
        if name == "undo_last_change":
            msgs = self.ws.undo()
            self.on_event("undo", msgs)
            return "\n".join(msgs)
        raise ModderError(f"Unknown tool {name!r}.")

    def _safe_tool(self, name, args, reason):
        try:
            return _truncate(self.run_tool(name, args, reason))
        except KeyError as e:
            return f"Error: missing required argument {e} for {name}."
        except (ModderError, EditError, OSError, ValueError, re.error) as e:
            return f"Error: {e}"

    # ----- conversation -----

    def ask(self, user_text):
        """Run one user turn to completion. Returns the assistant's final text."""
        self.messages.append({"role": "user", "content": user_text})
        for _ in range(self.max_steps):
            reply = self.llm.chat(self.messages, TOOLS)
            calls = reply["tool_calls"]
            self.messages.append({"role": "assistant", "content": reply["content"], "tool_calls": calls}
                                 if calls else {"role": "assistant", "content": reply["content"]})
            if not calls:
                return reply["content"]
            if reply["content"]:
                self.on_event("thinking", reply["content"])
            for call in calls:
                self.on_event("tool", call)
                result = self._safe_tool(call["name"], call["arguments"], user_text[:200])
                self.on_event("tool_result", {"call": call, "result": result})
                self.messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"], "content": result})
        return "(Stopped after too many steps. Tell me how to continue, or narrow the request.)"


__all__ = ["ModderAgent", "TOOLS", "LLMError"]
