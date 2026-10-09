"""Command-line interface: `python -m modder <command> ...`"""

import argparse
import json
import os
import sys

from . import __version__, edits
from .agent import ModderAgent
from .edits import EditError
from .llm import LLMClient, LLMError
from .scanner import format_profile, scan
from .workspace import GameWorkspace, ModderError

try:  # nicer line editing where available
    import readline  # noqa: F401
except ImportError:
    pass

if os.name == "nt":
    os.system("")  # turn on ANSI colours in the Windows console

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def c(text, code):
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def dim(t): return c(t, "2")
def bold(t): return c(t, "1")
def red(t): return c(t, "31")
def green(t): return c(t, "32")
def yellow(t): return c(t, "33")
def cyan(t): return c(t, "36")


def print_diff(diff):
    for line in diff.splitlines():
        if line.startswith(("+++", "---")):
            print(bold(line))
        elif line.startswith("+"):
            print(green(line))
        elif line.startswith("-"):
            print(red(line))
        elif line.startswith("@@"):
            print(cyan(line))
        else:
            print(line)


def ask_yes(prompt):
    try:
        return input(prompt).strip().lower() in ("y", "yes")
    except EOFError:
        return False


# ------------------------------------------------------------------ commands

def cmd_scan(args):
    profile = scan(args.game)
    if args.json:
        print(json.dumps(profile, indent=2))
    else:
        print(format_profile(profile, max_files=args.top))


def cmd_models(args):
    llm = make_llm(args)
    for name in llm.list_models():
        print(name)


def cmd_history(args):
    ws = GameWorkspace(args.game)
    hist = ws.history()
    if not hist:
        print("No mod changes recorded for this game.")
    for ch in hist:
        print(f"#{ch['id']:<4} {ch['time']}  {ch['summary'] or ch['path']}" + (dim(f"   ({ch['reason']})") if ch["reason"] else ""))
    print(dim(f"\nBackups: {ws.data_dir}"))


def cmd_undo(args):
    for m in GameWorkspace(args.game).undo(args.id):
        print(m)


def cmd_revert(args):
    ws = GameWorkspace(args.game)
    if not args.yes and not ask_yes(f"Restore every modded file in {ws.root} to its original? [y/N] "):
        print("Cancelled.")
        return
    for m in ws.revert_all():
        print(m)


def cmd_find(args):
    for line in GameWorkspace(args.game).search(args.text, args.glob, args.regex, max_results=args.max):
        print(line)


def cmd_set(args):
    ws = GameWorkspace(args.game)
    ext = os.path.splitext(args.file.lower())[1]
    if ext == ".json":
        change = ws.propose_json_set(args.file, args.key, edits.parse_value(args.value))
    elif ext in (".ini", ".cfg", ".conf", ".properties", ".txt"):
        change = ws.propose_ini_set(args.file, args.section or "", args.key, args.value)
    else:
        raise ModderError(f"'set' supports .json and INI-style files; use 'chat' to edit {ext} files.")
    print_diff(change.diff())
    if args.yes or ask_yes("Apply? [y/N] "):
        print(green(f"Applied as change #{ws.apply(change, 'manual set')}"))
    else:
        print("Not applied.")


def make_llm(args):
    return LLMClient(backend=args.backend, model=args.model, base_url=args.url, timeout=args.timeout,
                     num_ctx=args.ctx, api_key=os.environ.get("MODDER_API_KEY"))


CHAT_HELP = """Commands:
  /scan            show the game profile again
  /history         list applied changes
  /undo [id]       undo the last change (or back to change id)
  /revert          restore all original files
  /auto on|off     auto-approve edits (off by default)
  /model NAME      switch model
  /clear           forget the conversation (changes stay applied)
  /quit            exit
Anything else is sent to the AI, e.g. "make all weapons cost 1 gold" or "double the player's starting HP"."""


def cmd_chat(args):
    ws = GameWorkspace(args.game)
    print(dim("Scanning game folder..."))
    profile = scan(ws.root)
    print(format_profile(profile, max_files=10))
    llm = make_llm(args)
    try:
        models = llm.list_models()
        if models and llm.model not in models and f"{llm.model}:latest" not in models:
            print(yellow(f"\nModel '{llm.model}' isn't installed. Available: {', '.join(models[:10])}"))
            if args.backend == "ollama":
                print(yellow(f"Install it with:  ollama pull {llm.model}   (or pass --model one-of-the-above)"))
            return 1
    except LLMError as e:
        print(red(f"\n{e}"))
        if args.backend == "ollama":
            print("Install Ollama from https://ollama.com, run `ollama pull " + llm.model + "`, then try again.")
        return 1

    def confirm(change):
        print()
        print(bold(yellow(f"Proposed change: {change.summary or change.rel}")))
        print_diff(change.diff())
        try:
            ans = input(bold("Apply? [y]es / [n]o / [a]lways this session: ")).strip().lower()
        except EOFError:
            return False
        if ans in ("a", "always"):
            agent.auto_approve = True
            return True
        return ans in ("y", "yes")

    def on_event(kind, data):
        if kind == "tool":
            argtxt = json.dumps(data["arguments"], ensure_ascii=False)
            print(dim(f"  > {data['name']} {argtxt[:150]}{'...' if len(argtxt) > 150 else ''}"))
        elif kind == "tool_result" and args.verbose:
            print(dim("    " + data["result"][:600].replace("\n", "\n    ")))
        elif kind == "applied":
            print(green(f"  Applied change #{data['id']}"))
        elif kind == "proposal" and agent.auto_approve:
            print(yellow(f"  Auto-applying: {data.summary or data.rel}"))
        elif kind == "thinking" and data:
            print(dim(f"  {data[:300]}"))

    agent = ModderAgent(ws, profile, llm, confirm, on_event, auto_approve=args.yes)
    print(bold(f"\nGame Modder AI ready ({llm.backend}: {llm.model}). Backups: {ws.data_dir}"))
    print(dim("Describe the mod you want. Type /help for commands.\n"))

    while True:
        try:
            line = input(bold(cyan("you> "))).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        if line.startswith("/"):
            cmd, _, rest = line[1:].partition(" ")
            try:
                if cmd in ("quit", "exit", "q"):
                    break
                elif cmd == "help":
                    print(CHAT_HELP)
                elif cmd == "scan":
                    print(format_profile(scan(ws.root)))
                elif cmd == "history":
                    cmd_history(argparse.Namespace(game=str(ws.root)))
                elif cmd == "undo":
                    for m in ws.undo(int(rest) if rest.strip() else None):
                        print(m)
                elif cmd == "revert":
                    cmd_revert(argparse.Namespace(game=str(ws.root), yes=False))
                elif cmd == "auto":
                    agent.auto_approve = rest.strip().lower() in ("on", "1", "yes", "true")
                    print(f"Auto-approve is {'ON' if agent.auto_approve else 'off'}.")
                elif cmd == "model" and rest.strip():
                    llm.model = rest.strip()
                    print(f"Model set to {llm.model}.")
                elif cmd == "clear":
                    agent.reset()
                    print("Conversation cleared.")
                else:
                    print("Unknown command. /help lists commands.")
            except (ModderError, EditError, ValueError) as e:
                print(red(str(e)))
            continue
        try:
            answer = agent.ask(line)
        except LLMError as e:
            print(red(f"AI error: {e}"))
            continue
        except KeyboardInterrupt:
            print(yellow("\nInterrupted."))
            continue
        print(f"\n{bold('modder>')} {answer}\n")
    return 0


# ------------------------------------------------------------------ entry point

def build_parser():
    p = argparse.ArgumentParser(prog="modder", description="Local AI game modder: mod games you own, with backups and undo.")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    def llm_opts(sp):
        sp.add_argument("--backend", choices=["ollama", "openai"], default=os.environ.get("MODDER_BACKEND", "ollama"),
                        help="ollama (default) or openai = any OpenAI-compatible local server (LM Studio, llama.cpp)")
        sp.add_argument("--model", default=os.environ.get("MODDER_MODEL", "qwen3:8b"), help="model name (default qwen3:8b)")
        sp.add_argument("--url", default=os.environ.get("MODDER_URL"), help="server URL (default per backend)")
        sp.add_argument("--ctx", type=int, default=int(os.environ.get("MODDER_CTX", "16384")), help="context window (Ollama)")
        sp.add_argument("--timeout", type=int, default=600, help="seconds to wait for the AI per step")

    sp = sub.add_parser("chat", help="talk to the AI modder about a game folder")
    sp.add_argument("game", help="path to the game's install folder")
    sp.add_argument("--yes", action="store_true", help="apply edits without asking (backups are still kept)")
    sp.add_argument("-v", "--verbose", action="store_true", help="show tool results")
    llm_opts(sp)
    sp.set_defaults(func=cmd_chat)

    sp = sub.add_parser("scan", help="detect engine, anti-cheat and moddable files")
    sp.add_argument("game")
    sp.add_argument("--json", action="store_true")
    sp.add_argument("--top", type=int, default=25, help="how many moddable files to list")
    sp.set_defaults(func=cmd_scan)

    sp = sub.add_parser("find", help="search the game's text files")
    sp.add_argument("game")
    sp.add_argument("text")
    sp.add_argument("--glob", help="filename filter, e.g. *.json")
    sp.add_argument("--regex", action="store_true")
    sp.add_argument("--max", type=int, default=100)
    sp.set_defaults(func=cmd_find)

    sp = sub.add_parser("set", help="change one JSON/INI value without the AI")
    sp.add_argument("game")
    sp.add_argument("file", help="file relative to the game folder")
    sp.add_argument("key", help="JSON key path (items[3].price) or INI key")
    sp.add_argument("value", help="new value (JSON literal for .json files)")
    sp.add_argument("--section", help="INI section name")
    sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_set)

    sp = sub.add_parser("history", help="list applied changes")
    sp.add_argument("game")
    sp.set_defaults(func=cmd_history)

    sp = sub.add_parser("undo", help="undo the last change (or everything back to change ID)")
    sp.add_argument("game")
    sp.add_argument("id", nargs="?", type=int)
    sp.set_defaults(func=cmd_undo)

    sp = sub.add_parser("revert", help="restore all original files")
    sp.add_argument("game")
    sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_revert)

    sp = sub.add_parser("models", help="list models on the local AI server")
    llm_opts(sp)
    sp.set_defaults(func=cmd_models)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args) or 0
    except (ModderError, EditError, LLMError, NotADirectoryError) as e:
        print(red(f"Error: {e}"), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
