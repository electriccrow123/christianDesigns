"""Scan a game install folder: detect the engine, anti-cheat, and the files worth modding."""

import fnmatch
import os
from pathlib import Path

SKIP_DIRS = {".git", "__pycache__", "node_modules", "$recycle.bin", "_commonredist", "directx", "redist", "vcredist"}

TEXT_EXTS = {
    ".ini", ".cfg", ".conf", ".config", ".json", ".xml", ".yaml", ".yml", ".toml", ".lua", ".txt",
    ".csv", ".tsv", ".properties", ".rpy", ".js", ".gd", ".tres", ".tscn", ".mod", ".def", ".vdf",
    ".gi", ".cs", ".py", ".sii", ".scr", ".lst", ".dat.txt",
}

# File-name words that usually mean "this is gameplay data or settings".
INTERESTING_WORDS = (
    "config", "setting", "option", "pref", "balance", "tuning", "gameplay", "difficulty", "item", "weapon",
    "armor", "armour", "skill", "stat", "player", "enemy", "enemies", "actor", "class", "unit", "loot",
    "drop", "economy", "price", "shop", "recipe", "craft", "spawn", "level", "quest", "system", "rules",
    "constants", "defines", "global", "game", "character", "ability", "spell", "magic", "vehicle", "inventory",
)
BORING_WORDS = ("license", "licence", "readme", "eula", "credits", "changelog", "third_party", "thirdparty", "log")

ANTI_CHEAT = {
    "easyanticheat": "Easy Anti-Cheat",
    "easyanticheat_eos": "Easy Anti-Cheat (EOS)",
    "battleye": "BattlEye",
    "be_launcher": "BattlEye",
    "vgk.sys": "Riot Vanguard",
    "xigncode": "XIGNCODE3",
    "gameguard": "nProtect GameGuard",
    "punkbuster": "PunkBuster",
    "pnkbstra": "PunkBuster",
    "equ8": "EQU8",
    "mhyprot": "miHoYo anti-cheat",
    "ace-base": "Tencent ACE",
}

MAX_FILES = 60000
MAX_TEXT_SIZE = 4 * 1024 * 1024


def _walk(root, max_files):
    files = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d.lower() not in SKIP_DIRS and not d.startswith(".modder"))
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            files.append((rel, size))
            if len(files) >= max_files:
                return files, True
    return files, truncated


class _Index:
    def __init__(self, files):
        self.files = files
        self.lower = [rel.lower() for rel, _ in files]
        self.lower_set = set(self.lower)
        self.dirs = set()
        for rel in self.lower:
            parts = rel.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                self.dirs.add("/".join(parts[:i]))

    def has(self, pattern):
        """True if any file (lowercase relative path) matches the glob pattern."""
        return any(fnmatch.fnmatch(p, pattern) for p in self.lower)

    def find(self, pattern, limit=5):
        out = [p for p in self.lower if fnmatch.fnmatch(p, pattern)]
        return out[:limit]

    def has_dir(self, pattern):
        return any(fnmatch.fnmatch(d, pattern) for d in self.dirs)

    def count_ext(self, ext):
        return sum(1 for p in self.lower if p.endswith(ext))


def _engine(name, confidence, evidence, tips, mod_files=()):
    return {"name": name, "confidence": confidence, "evidence": list(evidence), "tips": list(tips),
            "mod_file_patterns": list(mod_files)}


def detect_engines(ix):
    found = []

    # Unity
    unity_ev = ix.find("*_data/globalgamemanagers") + ix.find("*unityplayer.dll") + ix.find("*_data/managed/assembly-csharp.dll")
    if unity_ev:
        il2cpp = ix.has("*gameassembly.dll") or ix.has_dir("*_data/il2cpp_data")
        backend = "IL2CPP" if il2cpp else "Mono"
        tips = [
            f"Scripting backend: {backend}.",
            "Plain-text data often lives in <Game>_Data/StreamingAssets (JSON, XML, CSV, Lua) and can be edited directly.",
        ]
        if il2cpp:
            tips += ["Code mods: install BepInEx 6 (IL2CPP build) or MelonLoader, then write plugins; use Il2CppDumper/Cpp2IL to see class names."]
        else:
            tips += ["Code mods: install BepInEx 5 (x64) and write Harmony patches, or edit <Game>_Data/Managed/Assembly-CSharp.dll with dnSpyEx (back it up first).",
                     "Many Unity games already have BepInEx config files in BepInEx/config/*.cfg once installed."]
        tips += ["Assets (textures, text assets) can be viewed/replaced with AssetRipper or UABEA."]
        found.append(_engine(f"Unity ({backend})", "high", unity_ev[:3], tips,
                             ["*_data/streamingassets/*", "bepinex/config/*.cfg"]))

    # Unreal
    ue_ev = ix.find("*-win64-shipping.exe") + ix.find("*/content/paks/*.pak") + ix.find("engine/binaries/*")
    if ue_ev:
        iostore = ix.has("*/content/paks/*.utoc")
        tips = [
            "Pak mods go in <Game>/Content/Paks/~mods/ and must end in _P.pak (e.g. MyMod_P.pak).",
            "Lua/Blueprint mods: install UE4SS into the folder next to the *-Win64-Shipping.exe.",
            "Engine/graphics tweaks: Engine.ini / GameUserSettings.ini under %LOCALAPPDATA%/<Game>/Saved/Config/Windows (outside the install folder).",
            "Browse/extract assets with FModel; repack with repak" + (" or retoc (this game uses IoStore .utoc/.ucas)." if iostore else "."),
        ]
        found.append(_engine("Unreal Engine", "high", ue_ev[:3], tips, ["*/config/*.ini", "*.ini"]))

    # Godot
    godot_ev = ix.find("*.pck")
    if godot_ev:
        found.append(_engine("Godot", "medium", godot_ev[:3], [
            "Game data is packed in the .pck; unpack/decompile with GDRE Tools (Godot RE Tools).",
            "An override.cfg next to the executable can override project settings without touching the .pck.",
        ], ["override.cfg", "*.cfg"]))

    # RPG Maker MV / MZ
    for base in ("www/", ""):
        if f"{base}data/system.json" in ix.lower_set and (ix.has(f"{base}js/rpg_*.js") or ix.has(f"{base}js/rmmz_*.js")):
            mz = ix.has(f"{base}js/rmmz_*.js")
            found.append(_engine("RPG Maker " + ("MZ" if mz else "MV"), "high", [f"{base}data/System.json"], [
                f"All game data is plain JSON in {base}data/: Actors, Classes, Items, Weapons, Armors, Enemies, Skills, States, System.json.",
                "Item/weapon/armor prices are the 'price' field; Weapons/Armors 'params' are [MaxHP, MaxMP, ATK, DEF, MAT, MDF, AGI, LUK].",
                f"Plugins are listed in {base}js/plugins.js; drop new plugin .js files into {base}js/plugins/ and register them there.",
                "Arrays in these files start with null at index 0; IDs match the array index.",
            ], [f"{base}data/*.json", f"{base}js/plugins.js"]))
            break

    # RPG Maker XP / VX / VX Ace
    rgss = ix.find("*.rgss3a") + ix.find("*.rgss2a") + ix.find("*.rgssad")
    if rgss:
        found.append(_engine("RPG Maker XP/VX/VX Ace", "high", rgss[:2], [
            "Data is in an encrypted RGSS archive; extract it with an RGSS decrypter, then edit .rvdata2/.rxdata with the RPG Maker editor or rvpacker.",
        ]))

    # Ren'Py
    if ix.has_dir("renpy") and (ix.has("game/*.rpy") or ix.has("game/*.rpyc") or ix.has("game/*.rpa")):
        found.append(_engine("Ren'Py", "high", ix.find("game/*.rp*")[:3], [
            "Scripts in game/*.rpy are plain Python-like text and can be edited directly.",
            "Safest mod: add a new file game/zz_mod.rpy (loads last) with 'init 999 python:' overrides, e.g. config.developer = True to enable the console (Shift+O).",
            "Archived .rpa files can be extracted with unrpa; .rpyc can be decompiled with unrpyc.",
        ], ["game/*.rpy"]))

    # GameMaker
    if ix.has("data.win") or ix.has("*/data.win"):
        found.append(_engine("GameMaker", "high", ix.find("*data.win")[:1], [
            "Open data.win in UndertaleModTool to edit code, sprites, rooms and strings (back it up first).",
        ]))

    # Bethesda Creation Engine
    esm = ix.find("data/*.esm")
    if esm and (ix.has("data/*.bsa") or ix.has("data/*.ba2")):
        found.append(_engine("Bethesda Creation Engine", "high", esm[:3], [
            "Use Mod Organizer 2 or Vortex rather than copying into Data/ by hand; sort load order with LOOT.",
            "Edit records with xEdit (SSEEdit/FO4Edit); script-extender mods need SKSE/F4SE matching your game version.",
            "Game INIs (Skyrim.ini, Fallout4Prefs.ini...) live in Documents/My Games/<Game>, outside the install folder.",
        ], ["*.ini"]))

    # Source / Source 2
    if ix.has("*/gameinfo.txt") or ix.has("*/gameinfo.gi"):
        found.append(_engine("Source Engine", "high", (ix.find("*/gameinfo.txt") + ix.find("*/gameinfo.gi"))[:2], [
            "Loose-file mods go in <mod>/custom/<modname>/; configs in <mod>/cfg/autoexec.cfg.",
            "Use offline/local servers only (VAC applies to online play).",
        ], ["*/cfg/*.cfg", "*/scripts/*.txt"]))

    # Paradox Clausewitz / Jomini
    if ix.has_dir("common") and (ix.has_dir("events") or ix.has_dir("game/events")) or ix.has("*descriptor.mod"):
        found.append(_engine("Paradox (Clausewitz/Jomini)", "medium", ["common/", "events/"], [
            "Don't edit base files: create a mod folder in Documents/Paradox Interactive/<Game>/mod with a descriptor.mod, and copy only the files you change.",
            "Most balance values are in common/defines/*.txt and common/**/*.txt (Paradox script).",
        ], ["common/defines/*", "common/*/*.txt"]))

    # XNA / FNA / MonoGame (+ Stardew)
    if ix.has("*.xnb") and (ix.has("*monogame.framework.dll") or ix.has("*fna.dll") or ix.has("*microsoft.xna*")):
        tips = ["Content/*.xnb assets can be unpacked with xnbcli; code mods use Harmony patches."]
        if ix.has("stardew valley.dll") or ix.has("stardew valley.exe"):
            tips.insert(0, "Stardew Valley: install SMAPI and use Content Patcher packs in the Mods/ folder instead of editing .xnb files.")
        found.append(_engine("XNA/FNA/MonoGame", "medium", ix.find("*.xnb")[:2], tips))

    # Electron / NW.js (HTML5 games)
    if ix.has("resources/app.asar") or ix.has("*nw.dll"):
        found.append(_engine("HTML5 (Electron/NW.js)", "medium", (ix.find("resources/app.asar") + ix.find("*nw.dll"))[:2], [
            "Electron games pack code in resources/app.asar; extract with 'npx asar extract'. NW.js games often ship loose JS/JSON.",
        ], ["*.json", "*.js"]))

    # LÖVE
    if ix.has("*.love") or ix.has("love.dll"):
        found.append(_engine("LÖVE (Lua)", "medium", (ix.find("*.love") + ix.find("love.dll"))[:2], [
            "A .love file (or the .exe itself) is a zip of Lua scripts; extract, edit and re-zip.",
        ], ["*.lua"]))

    if not found and ix.count_ext(".lua") > 20:
        found.append(_engine("Lua-scripted engine", "low", ix.find("*.lua")[:3], ["Loose .lua scripts can usually be edited directly."], ["*.lua"]))

    if not found:
        found.append(_engine("Unknown / custom engine", "low", [], [
            "No known engine signature. Look for loose text configs (ini/json/xml/cfg) and data tables (csv) below.",
        ]))
    return found


def detect_anticheat(ix):
    hits = {}
    for path in ix.lower:
        for part in path.split("/"):
            for needle, label in ANTI_CHEAT.items():
                if needle in part:
                    hits.setdefault(label, path)
    return [{"name": k, "evidence": v} for k, v in sorted(hits.items())]


def is_text_candidate(rel, size):
    lower = rel.lower()
    ext = os.path.splitext(lower)[1]
    return ext in TEXT_EXTS and 0 < size <= MAX_TEXT_SIZE


def score_file(rel, size, mod_patterns=()):
    lower = rel.lower()
    name = lower.rsplit("/", 1)[-1]
    ext = os.path.splitext(name)[1]
    if any(w in name for w in BORING_WORDS):
        return -1
    score = {".ini": 4, ".cfg": 4, ".json": 3, ".xml": 3, ".yaml": 3, ".yml": 3, ".toml": 3, ".csv": 3,
             ".lua": 2, ".rpy": 2, ".txt": 1, ".js": 0}.get(ext, 1)
    score += sum(2 for w in INTERESTING_WORDS if w in name)
    if any(fnmatch.fnmatch(lower, p) for p in mod_patterns):
        score += 5
    if "/streamingassets/" in lower or "/config" in lower or lower.startswith("config"):
        score += 2
    if ext == ".js" and "/plugins/" not in lower and not lower.endswith("plugins.js"):
        score -= 2
    return score


def scan(game_root, max_files=MAX_FILES):
    """Return a profile dict describing the game folder."""
    root = Path(game_root).expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"Not a folder: {root}")
    files, truncated = _walk(str(root), max_files)
    ix = _Index(files)
    engines = detect_engines(ix)
    patterns = [p for e in engines for p in e["mod_file_patterns"]]

    ext_counts = {}
    for rel, _ in files:
        ext = os.path.splitext(rel.lower())[1] or "(none)"
        ext_counts[ext] = ext_counts.get(ext, 0) + 1

    candidates = []
    for rel, size in files:
        if is_text_candidate(rel, size):
            s = score_file(rel, size, patterns)
            if s >= 2:
                candidates.append((s, rel, size))
    candidates.sort(key=lambda t: (-t[0], t[1]))

    executables = [rel for rel, _ in files if rel.lower().endswith(".exe") and "/" not in rel.strip("/")][:10]
    if not executables:
        executables = [rel for rel, _ in files if rel.lower().endswith((".exe", ".x86_64", ".sh", ".app"))][:10]

    return {
        "root": str(root),
        "name": root.name,
        "total_files": len(files),
        "total_bytes": sum(s for _, s in files),
        "truncated": truncated,
        "engines": engines,
        "anticheat": detect_anticheat(ix),
        "executables": executables,
        "moddable_files": [{"path": rel, "size": size, "score": s} for s, rel, size in candidates[:60]],
        "top_extensions": sorted(ext_counts.items(), key=lambda kv: -kv[1])[:15],
    }


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def format_profile(p, max_files=25):
    lines = [f"Game folder: {p['root']}",
             f"Files: {p['total_files']}{'+ (scan truncated)' if p['truncated'] else ''}, {human_size(p['total_bytes'])}"]
    if p["executables"]:
        lines.append("Executables: " + ", ".join(p["executables"]))
    for e in p["engines"]:
        lines.append(f"\nEngine: {e['name']} (confidence: {e['confidence']})")
        if e["evidence"]:
            lines.append("  Evidence: " + ", ".join(e["evidence"]))
        for t in e["tips"]:
            lines.append(f"  - {t}")
    if p["anticheat"]:
        lines.append("\n!! Anti-cheat detected: " + ", ".join(a["name"] for a in p["anticheat"]))
        lines.append("   Only mod this game for offline/single-player use. Modifying files can get online accounts banned.")
    if p["moddable_files"]:
        lines.append(f"\nLikely moddable text files (top {min(max_files, len(p['moddable_files']))}):")
        for f in p["moddable_files"][:max_files]:
            lines.append(f"  {f['path']}  ({human_size(f['size'])})")
    else:
        lines.append("\nNo loose text data/config files found; mods will need engine-specific tools (see tips).")
    lines.append("\nFile types: " + ", ".join(f"{ext} x{n}" for ext, n in p["top_extensions"]))
    return "\n".join(lines)
