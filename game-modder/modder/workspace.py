"""Safe file access for one game folder.

Every path is confined to the game folder. Before a file is changed for the first time its pristine
copy is stored under ~/.game-modder/games/<id>/originals, and every individual change keeps its
"before" copy so it can be undone one step at a time or all at once.
"""

import difflib
import fnmatch
import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path

from . import edits

MAX_READ_BYTES = 8 * 1024 * 1024
DEFAULT_HOME = Path(os.environ.get("MODDER_HOME", Path.home() / ".game-modder"))


class ModderError(Exception):
    """An error that should be reported to the user/model, not crash the program."""


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _slug(name):
    return re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()[:40] or "game"


def decode(data):
    """Decode bytes to text, remembering how to encode them back. Returns (text, encoding)."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16"), "utf-16"
    if b"\x00" in data[:8192]:
        raise ModderError("This is a binary file; it can't be edited as text.")
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig"), "utf-8-sig"
    for enc in ("utf-8", "cp1252"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            pass
    return data.decode("latin-1"), "latin-1"


class Change:
    """A proposed edit to one file, not yet applied."""

    def __init__(self, rel, old_text, new_text, encoding, tool, summary=""):
        self.rel = rel
        self.old_text = old_text  # None if the file doesn't exist yet
        self.new_text = new_text
        self.encoding = encoding
        self.tool = tool
        self.summary = summary

    @property
    def created(self):
        return self.old_text is None

    def diff(self, context=3, max_lines=200):
        old = [] if self.old_text is None else self.old_text.splitlines(keepends=True)
        new = self.new_text.splitlines(keepends=True)
        lines = list(difflib.unified_diff(old, new, f"a/{self.rel}", f"b/{self.rel}", n=context))
        lines = [l.rstrip("\r\n") for l in lines]
        if len(lines) > max_lines:
            lines = lines[:max_lines] + [f"... ({len(lines) - max_lines} more diff lines)"]
        return "\n".join(lines)


class GameWorkspace:
    def __init__(self, game_root, home=None):
        self.root = Path(game_root).expanduser().resolve()
        if not self.root.is_dir():
            raise ModderError(f"Game folder not found: {self.root}")
        home = Path(home) if home else DEFAULT_HOME
        gid = f"{_slug(self.root.name)}-{hashlib.sha1(str(self.root).lower().encode()).hexdigest()[:8]}"
        self.data_dir = home / "games" / gid
        self.originals_dir = self.data_dir / "originals"
        self.history_dir = self.data_dir / "history"
        self.state_file = self.data_dir / "state.json"

    # ----- paths -----

    def resolve(self, rel):
        rel = str(rel or ".").strip().replace("\\", "/")
        if rel.startswith("/") or re.match(r"^[a-zA-Z]:", rel):
            p = Path(rel).resolve()
        else:
            p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ModderError(f"'{rel}' is outside the game folder; only files inside {self.root} can be touched.")
        return p

    def rel(self, path):
        r = path.relative_to(self.root).as_posix()
        return r or "."

    # ----- reading -----

    def list_dir(self, rel=".", depth=1, pattern=None, limit=300):
        base = self.resolve(rel)
        if not base.is_dir():
            raise ModderError(f"Not a folder: {rel}")
        out = []
        depth = max(1, min(int(depth or 1), 6))
        base_depth = len(base.parts)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            d = Path(dirpath)
            level = len(d.parts) - base_depth
            if level >= depth:
                dirnames[:] = []
            for name in dirnames:
                if not pattern:
                    out.append(self.rel(d / name) + "/")
            for name in sorted(filenames):
                if pattern and not fnmatch.fnmatch(name.lower(), pattern.lower()):
                    continue
                p = d / name
                try:
                    size = p.stat().st_size
                except OSError:
                    size = -1
                out.append(f"{self.rel(p)}  ({size} bytes)")
            if len(out) >= limit:
                out = out[:limit] + [f"... (more than {limit} entries; narrow with path/pattern)"]
                break
        return out

    def read_bytes(self, rel):
        p = self.resolve(rel)
        if not p.is_file():
            raise ModderError(f"File not found: {rel}")
        if p.stat().st_size > MAX_READ_BYTES:
            raise ModderError(f"{rel} is too large ({p.stat().st_size} bytes) to open as text.")
        return p.read_bytes()

    def read_text(self, rel):
        return decode(self.read_bytes(rel))

    def read_lines(self, rel, offset=1, limit=200):
        text, _ = self.read_text(rel)
        lines = text.splitlines()
        offset = max(1, int(offset or 1))
        limit = max(1, min(int(limit or 200), 1000))
        chunk = lines[offset - 1: offset - 1 + limit]
        body = "\n".join(f"{i:6}| {line[:500]}" for i, line in enumerate(chunk, start=offset))
        end = offset + len(chunk) - 1
        footer = f"\n[lines {offset}-{end} of {len(lines)}]" if len(lines) > end or offset > 1 else ""
        return body + footer

    def search(self, query, glob=None, regex=False, max_results=80, ignore_case=True):
        flags = re.IGNORECASE if ignore_case else 0
        pat = re.compile(query if regex else re.escape(query), flags)
        results = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames.sort()
            for name in sorted(filenames):
                if glob and not fnmatch.fnmatch(name.lower(), glob.lower()):
                    continue
                p = Path(dirpath) / name
                try:
                    if p.stat().st_size > MAX_READ_BYTES:
                        continue
                    text, _ = decode(p.read_bytes())
                except (ModderError, OSError):
                    continue
                for i, line in enumerate(text.splitlines(), 1):
                    if pat.search(line):
                        results.append(f"{self.rel(p)}:{i}: {line.strip()[:200]}")
                        if len(results) >= max_results:
                            return results + [f"... (stopped at {max_results} matches)"]
        return results

    # ----- proposing changes -----

    def propose_text(self, rel, new_text, tool="write_file", summary=""):
        p = self.resolve(rel)
        if p.is_dir():
            raise ModderError(f"{rel} is a folder.")
        if p.exists():
            old, enc = self.read_text(rel)
        else:
            old, enc = None, "utf-8"
        if old == new_text:
            raise ModderError("No change: the new content is identical to the current file.")
        return Change(self.rel(p), old, new_text, enc, tool, summary)

    def propose_replace(self, rel, old, new, replace_all=False):
        text, _ = self.read_text(rel)
        return self.propose_text(rel, edits.replace_text(text, old, new, replace_all), "replace_text",
                                 f"replace text in {rel}")

    def propose_json_set(self, rel, key_path, value):
        text, _ = self.read_text(rel)
        return self.propose_text(rel, edits.json_set(text, key_path, value), "set_json_value",
                                 f"{rel}: {key_path} = {json.dumps(value, ensure_ascii=False)[:80]}")

    def propose_ini_set(self, rel, section, key, value):
        text, _ = self.read_text(rel)
        return self.propose_text(rel, edits.ini_set(text, section, key, value), "set_ini_value",
                                 f"{rel}: [{section or ''}] {key} = {value}")

    # ----- applying / undoing -----

    def _load_state(self):
        if self.state_file.exists():
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        return {"root": str(self.root), "originals": {}, "changes": [], "next_id": 1}

    def _save_state(self, state):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(tmp, self.state_file)

    @staticmethod
    def _atomic_write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".modder-tmp")
        tmp.write_bytes(data)
        if path.exists():
            shutil.copymode(path, tmp)
        os.replace(tmp, path)

    def apply(self, change, reason=""):
        """Write a proposed change to disk, keeping backups. Returns the change id."""
        p = self.resolve(change.rel)
        state = self._load_state()
        current = p.read_bytes() if p.exists() else None
        if (current is None) != (change.old_text is None) or (
                current is not None and decode(current)[0] != change.old_text):
            raise ModderError(f"{change.rel} changed on disk since the edit was prepared; re-read it and try again.")

        if change.rel not in state["originals"]:
            if current is None:
                state["originals"][change.rel] = "absent"
            else:
                dest = self.originals_dir / change.rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, dest)
                state["originals"][change.rel] = "stored"

        cid = state["next_id"]
        before = None
        if current is not None:
            before = self.history_dir / str(cid) / "before"
            before.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, before)

        data = change.new_text.encode(change.encoding)
        self._atomic_write(p, data)
        state["changes"].append({
            "id": cid, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "path": change.rel, "tool": change.tool,
            "summary": change.summary, "reason": reason, "created": current is None,
            "before": str(before) if before else None, "after_sha": _sha(data),
        })
        state["next_id"] = cid + 1
        self._save_state(state)
        return cid

    def history(self):
        return self._load_state()["changes"]

    def undo(self, change_id=None):
        """Undo the latest change (or the latest change up to and including change_id). Returns messages."""
        state = self._load_state()
        if not state["changes"]:
            raise ModderError("Nothing to undo.")
        target = state["changes"][-1]["id"] if change_id is None else int(change_id)
        if not any(c["id"] == target for c in state["changes"]):
            raise ModderError(f"No change with id {target}.")
        msgs = []
        while state["changes"] and state["changes"][-1]["id"] >= target:
            c = state["changes"].pop()
            p = self.resolve(c["path"])
            if p.exists() and _sha(p.read_bytes()) != c["after_sha"]:
                msgs.append(f"note: {c['path']} was modified outside the modder after change #{c['id']}; restoring anyway.")
            if c["created"]:
                if p.exists():
                    p.unlink()
            else:
                self._atomic_write(p, Path(c["before"]).read_bytes())
            shutil.rmtree(self.history_dir / str(c["id"]), ignore_errors=True)
            msgs.append(f"undid #{c['id']}: {c['summary'] or c['path']}")
        self._save_state(state)
        return msgs

    def revert_all(self):
        """Restore every touched file to its original state and clear history."""
        state = self._load_state()
        msgs = []
        for rel, kind in sorted(state["originals"].items()):
            p = self.resolve(rel)
            if kind == "absent":
                if p.exists():
                    p.unlink()
                    msgs.append(f"removed {rel} (added by mods)")
            else:
                self._atomic_write(p, (self.originals_dir / rel).read_bytes())
                msgs.append(f"restored {rel}")
        shutil.rmtree(self.originals_dir, ignore_errors=True)
        shutil.rmtree(self.history_dir, ignore_errors=True)
        state["originals"], state["changes"] = {}, []
        self._save_state(state)
        return msgs or ["Nothing to revert; the game folder is untouched."]
