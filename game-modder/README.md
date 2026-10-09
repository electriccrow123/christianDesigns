# 🎮 Game Modder AI

A **local, offline AI assistant for modding PC games you own**. Point it at a game's install folder and describe
the mod you want in plain English ("make potions cost 1 gold", "double the player's HP", "raise the FOV to 110",
"turn on the developer console"). It:

1. **Scans the game.** It detects the engine (Unity Mono/IL2CPP, Unreal, Godot, RPG Maker MV/MZ/XP/VX, Ren'Py, GameMaker,
   Bethesda Creation, Source, Paradox, XNA/MonoGame/Stardew, Electron/NW.js, LÖVE…), finds anti-cheat, and ranks the
   files most worth modding.
2. **Lets a local LLM do the work.** The model searches and reads the game's data files, then proposes minimal edits.
3. **Shows a diff before every change.** Nothing is written until you approve it.
4. **Backs up everything.** Each file's original is saved the first time it's touched. You can undo changes one at a time or
   revert the whole game to stock.

Everything runs on your PC. No game files or prompts leave your machine. It needs only Python, with no packages to install.

## Setup

1. Install **Python 3.9+** from <https://python.org>. On Windows, tick "Add Python to PATH".
2. Install a local AI server. The easiest is **[Ollama](https://ollama.com)**. Then pull a model that supports tool calling:
   ```bash
   ollama pull qwen3:8b        # good default (~5 GB, runs on 8 GB+ VRAM or CPU)
   # stronger, if you have the hardware:  qwen3:14b, qwen3:32b, mistral-small, llama3.3
   ```
   You can also use **LM Studio**, the **llama.cpp server**, KoboldCpp or Jan. Start their OpenAI-compatible server and
   add `--backend openai --url http://localhost:1234/v1`.
3. Run it from this folder:
   ```bash
   # Windows
   modder.bat chat "C:\Program Files (x86)\Steam\steamapps\common\Some Game"
   # Linux / macOS / Steam Deck
   ./modder.sh chat ~/.steam/steam/steamapps/common/Some\ Game
   # or anywhere:  python -m modder ...   (from inside game-modder/)
   ```

## Example session

```
you> make all healing items cost 1 gold
  > search_files {"query": "Potion", "glob": "*.json"}
  > read_file {"path": "www/data/Items.json"}
  > set_json_value {"path": "www/data/Items.json", "key_path": "[1].price", "value": "1"}

Proposed change: www/data/Items.json: [1].price = 1
-{"id":1,"name":"Potion","price":50,...}
+{"id":1,"name":"Potion","price":1,...}
Apply? [y]es / [n]o / [a]lways this session: y
  Applied change #1
...
modder> Done: Potion 50→1, Hi-Potion 150→1, Elixir 500→1. Use /undo or /revert to go back.
```

Chat commands: `/scan`, `/history`, `/undo [id]`, `/revert`, `/auto on|off`, `/model NAME`, `/clear`, `/quit`.

## Commands that don't need the AI

| Command | What it does |
| --- | --- |
| `modder scan GAME [--json]` | Engine, anti-cheat, modding tips and likely moddable files |
| `modder find GAME TEXT [--glob *.json] [--regex]` | Search every text file in the game |
| `modder set GAME FILE KEY VALUE [--section S]` | Change one JSON value (`items[3].price`) or INI key, with a diff and a backup |
| `modder history GAME` | List applied changes |
| `modder undo GAME [ID]` | Undo the last change, or everything back to change ID |
| `modder revert GAME` | Restore every modded file to the original and delete files mods added |
| `modder models` | List the models on your local AI server |

Options for `chat`/`models`: `--backend ollama|openai`, `--model`, `--url`, `--ctx` (context size, default 16384),
`--yes` (auto-approve; backups are still kept) and `-v` (show tool output). You can also set these as defaults with the
environment variables `MODDER_BACKEND`, `MODDER_MODEL`, `MODDER_URL` and `MODDER_CTX`. Backups live in `~/.game-modder`
(override with `MODDER_HOME`).

## What it can and can't do

- ✅ **Text-based game data**: JSON, INI/CFG, XML, YAML, TOML, CSV, Lua, Ren'Py `.rpy`, JS plugins and similar files.
  That covers a lot: RPG Maker data, Ren'Py scripts, Unity StreamingAssets, Paradox defines, config tweaks and BepInEx configs.
- ✅ **New files**, such as a Ren'Py `zz_mod.rpy` override or a plugin config.
- ℹ️ **Packed or compiled data** (Unreal `.pak`, Godot `.pck`, GameMaker `data.win`, Unity assets and DLLs, Bethesda plugins).
  The AI can't edit these directly. Instead it explains which community tool to use (FModel/repak, UE4SS, GDRE Tools,
  UndertaleModTool, BepInEx/MelonLoader, dnSpyEx, xEdit, SMAPI…) and walks you through it.
- 🚫 **Online cheating, anti-cheat bypasses and DRM cracking.** It won't help with these. If anti-cheat is detected, it warns you to
  use mods offline only, because modified files can get online accounts banned.

**Tips:** Steam's "Verify integrity of game files" also restores originals, but use `modder revert` first so the backups
stay in sync. Game updates can overwrite mods; just ask the AI to re-apply them. Bigger models follow multi-step mod
requests much more reliably than small ones.

## Development

```bash
cd game-modder
python -m unittest discover -s tests -v
```

| File | Purpose |
| --- | --- |
| `modder/scanner.py` | Engine/anti-cheat detection and ranking of moddable files |
| `modder/workspace.py` | Path confinement, encoding-preserving reads/writes, backups, history, undo/revert |
| `modder/edits.py` | Format-preserving JSON value edits, INI edits and exact text replacement |
| `modder/llm.py` | Ollama and OpenAI-compatible clients, with a fallback for models that print tool calls as text |
| `modder/agent.py` | System prompt, tool definitions and the tool-calling loop |
| `modder/cli.py` | Command-line interface and interactive chat |
