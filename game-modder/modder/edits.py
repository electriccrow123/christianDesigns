"""Text-level edits that keep a file's existing formatting (only the changed value is rewritten)."""

import json
import re


class EditError(Exception):
    pass


# ---------------------------------------------------------------- plain text

def replace_text(text, old, new, replace_all=False):
    if not old:
        raise EditError("'old' text must not be empty.")
    count = text.count(old)
    if count == 0 and "\r\n" in text and "\n" in old:
        old, new = old.replace("\r\n", "\n").replace("\n", "\r\n"), new.replace("\r\n", "\n").replace("\n", "\r\n")
        count = text.count(old)
    if count == 0:
        raise EditError("'old' text was not found. Read the file again and copy the exact text, including spacing.")
    if count > 1 and not replace_all:
        raise EditError(f"'old' text appears {count} times. Include more surrounding text to make it unique, or set replace_all.")
    return text.replace(old, new) if replace_all else text.replace(old, new, 1)


# ---------------------------------------------------------------- JSON

_TOKEN = re.compile(r'\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|([^.\[\]]+)')
_WS = re.compile(r"[ \t\r\n]*")
_DEC = json.JSONDecoder()


def parse_key_path(key_path):
    """'actors[2].name' / 'actors.2.name' / 'a["b.c"]' -> ['actors', 2, 'name'] ..."""
    tokens = []
    key_path = (key_path or "").strip()
    if key_path in ("", "$", "."):
        return tokens
    pos = 0
    while pos < len(key_path):
        if key_path[pos] == ".":
            pos += 1
            continue
        m = _TOKEN.match(key_path, pos)
        if not m:
            raise EditError(f"Bad key path: {key_path!r}")
        if m.group(1) is not None:
            tokens.append(int(m.group(1)))
        elif m.group(2) is not None:
            tokens.append(json.loads(f'"{m.group(2)}"'))
        else:
            tok = m.group(3)
            tokens.append(int(tok) if tok.isdigit() else tok)
        pos = m.end()
    return tokens


def _ws(text, pos):
    return _WS.match(text, pos).end()


def _locate(text, tokens):
    """Find the span of the value at tokens. Returns ('found', start, end) or ('missing', insert_pos, needs_comma)."""
    pos = _ws(text, 0)
    for depth, tok in enumerate(tokens):
        last = depth == len(tokens) - 1
        where = ".".join(str(t) for t in tokens[:depth]) or "the top level"
        if pos >= len(text):
            raise EditError("Unexpected end of JSON.")
        ch = text[pos]
        if ch == "{":
            key = str(tok)
            pos = _ws(text, pos + 1)
            found = False
            last_end, any_member = pos, False
            while text[pos] != "}":
                k, pos = _DEC.raw_decode(text, pos)
                pos = _ws(text, pos)
                if text[pos] != ":":
                    raise EditError("Malformed JSON object.")
                pos = _ws(text, pos + 1)
                if k == key:
                    found = True
                    break
                _, pos = _DEC.raw_decode(text, pos)
                last_end, any_member = pos, True
                pos = _ws(text, pos)
                if text[pos] == ",":
                    pos = _ws(text, pos + 1)
            if not found:
                if last:
                    return ("missing", last_end, any_member, key)
                raise EditError(f"Key {key!r} not found in {where}.")
        elif ch == "[":
            if not isinstance(tok, int):
                raise EditError(f"{where} is a list; use a number index instead of {tok!r}.")
            pos = _ws(text, pos + 1)
            i = 0
            while True:
                if text[pos] == "]":
                    raise EditError(f"Index {tok} is out of range in {where} (length {i}).")
                if i == tok:
                    break
                _, pos = _DEC.raw_decode(text, pos)
                pos = _ws(text, pos)
                if text[pos] == ",":
                    pos = _ws(text, pos + 1)
                i += 1
        else:
            raise EditError(f"{where} is not an object or list, so it has no {tok!r}.")
    _, end = _DEC.raw_decode(text, pos)
    return ("found", pos, end)


def json_get(text, key_path):
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise EditError(f"File is not valid JSON ({e}). Use read_file/replace_text instead.")
    cur = data
    for tok in parse_key_path(key_path):
        try:
            cur = cur[tok] if not isinstance(cur, dict) else cur[str(tok)]
        except (KeyError, IndexError, TypeError):
            raise EditError(f"{key_path!r} not found.")
    return cur


def json_set(text, key_path, value):
    """Set a value inside JSON text, rewriting only that value's characters."""
    try:
        json.loads(text)
    except json.JSONDecodeError as e:
        raise EditError(f"File is not valid JSON ({e}). Use replace_text instead.")
    tokens = parse_key_path(key_path)
    if not tokens:
        raise EditError("Key path is empty; use write_file to replace the whole file.")
    encoded = json.dumps(value, ensure_ascii=False)
    try:
        res = _locate(text, tokens)
    except (IndexError, json.JSONDecodeError) as e:
        raise EditError(f"Could not navigate the JSON: {e}")
    if res[0] == "found":
        _, start, end = res
        new = text[:start] + encoded + text[end:]
    else:
        _, at, needs_comma, key = res
        new = text[:at] + (", " if needs_comma else "") + json.dumps(key, ensure_ascii=False) + ": " + encoded + text[at:]
    json.loads(new)  # sanity check
    return new


def parse_value(raw):
    """Values arrive as strings from the CLI / model: '42', 'true', '"text"', '[1,2]'. Bare words stay strings."""
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


# ---------------------------------------------------------------- INI / CFG

_SECTION = re.compile(r"^\s*\[(.+?)\]\s*$")
_KEYLINE = re.compile(r"^(\s*)([^=;#\[\s][^=]*?)(\s*=\s*)(.*)$")


def _newline(text):
    return "\r\n" if "\r\n" in text else "\n"


def _iter_ini(lines):
    """Yield (index, section, key, match) for each key=value line."""
    section = ""
    for i, raw in enumerate(lines):
        line = raw.rstrip("\r\n")
        m = _SECTION.match(line)
        if m:
            section = m.group(1).strip()
            yield i, section, None, None
            continue
        km = _KEYLINE.match(line)
        if km:
            yield i, section, km.group(2).strip(), km


def ini_get(text, section, key):
    section = (section or "").strip().lower()
    for _, sec, k, km in _iter_ini(text.splitlines(keepends=True)):
        if k is not None and sec.lower() == section and k.lower() == key.strip().lower():
            return km.group(4).strip()
    raise EditError(f"[{section}] {key} not found.")


def ini_set(text, section, key, value):
    nl = _newline(text)
    lines = text.splitlines(keepends=True)
    want_sec = (section or "").strip().lower()
    want_key = key.strip().lower()
    value = str(value).lower() if isinstance(value, bool) else str(value)
    section_seen = want_sec == ""
    last_in_section = -1 if want_sec else None
    for i, sec, k, km in _iter_ini(lines):
        in_sec = sec.lower() == want_sec
        if k is None:
            if in_sec:
                section_seen, last_in_section = True, i
            continue
        if in_sec:
            last_in_section = i
            if k.lower() == want_key:
                ending = lines[i][len(lines[i].rstrip("\r\n")):]
                lines[i] = km.group(1) + km.group(2) + km.group(3) + value + ending
                return "".join(lines)
    new_line = f"{key}={value}{nl}"
    if section_seen and last_in_section is not None and last_in_section >= 0:
        if not lines[last_in_section].endswith(("\n", "\r")):
            lines[last_in_section] += nl
        lines.insert(last_in_section + 1, new_line)
    elif not want_sec:
        lines.insert(0, new_line)
    else:
        if lines and not lines[-1].endswith(("\n", "\r")):
            lines[-1] += nl
        if lines and lines[-1].strip():
            lines.append(nl)
        lines += [f"[{section.strip()}]{nl}", new_line]
    return "".join(lines)
