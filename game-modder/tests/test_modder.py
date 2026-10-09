import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from modder import edits
from modder.agent import ModderAgent
from modder.cli import main
from modder.edits import EditError
from modder.scanner import format_profile, scan
from modder.workspace import GameWorkspace, ModderError

ITEMS = '[\nnull,\n{"id":1,"name":"Potion","price":50,"note":""},\n{"id":2,"name":"Ether","price":200,"note":""}\n]'


def make_files(root, files):
    for rel, content in files.items():
        p = Path(root) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(content, encoding="utf-8", newline="")


class TempGame(unittest.TestCase):
    files = {}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.game = Path(self.tmp.name) / "My Game"
        self.home = Path(self.tmp.name) / "home"
        make_files(self.game, self.files)
        os.environ["MODDER_HOME"] = str(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def ws(self):
        return GameWorkspace(self.game, home=self.home)


class ScannerTests(TempGame):
    def test_unity_mono(self):
        make_files(self.game, {"Game_Data/globalgamemanagers": b"\x00", "UnityPlayer.dll": b"\x00",
                               "Game_Data/Managed/Assembly-CSharp.dll": b"\x00",
                               "Game_Data/StreamingAssets/balance.json": "{}", "Game.exe": b"MZ"})
        p = scan(self.game)
        self.assertEqual(p["engines"][0]["name"], "Unity (Mono)")
        self.assertEqual(p["moddable_files"][0]["path"], "Game_Data/StreamingAssets/balance.json")
        self.assertIn("Game.exe", p["executables"])

    def test_unity_il2cpp_and_anticheat(self):
        make_files(self.game, {"Game_Data/globalgamemanagers": b"\x00", "GameAssembly.dll": b"\x00",
                               "EasyAntiCheat/settings.json": "{}"})
        p = scan(self.game)
        self.assertEqual(p["engines"][0]["name"], "Unity (IL2CPP)")
        self.assertEqual(p["anticheat"][0]["name"], "Easy Anti-Cheat")
        self.assertIn("Anti-cheat detected", format_profile(p))

    def test_rpgmaker_mv(self):
        make_files(self.game, {"www/data/System.json": "{}", "www/data/Items.json": ITEMS,
                               "www/js/rpg_core.js": "", "www/js/plugins.js": "var $plugins = [];"})
        names = [e["name"] for e in scan(self.game)["engines"]]
        self.assertIn("RPG Maker MV", names)

    def test_unreal_and_renpy_and_unknown(self):
        make_files(self.game, {"Foo/Binaries/Win64/Foo-Win64-Shipping.exe": b"MZ", "Foo/Content/Paks/Foo.pak": b"\x00"})
        self.assertEqual(scan(self.game)["engines"][0]["name"], "Unreal Engine")
        other = Path(self.tmp.name) / "vn"
        make_files(other, {"renpy/__init__.py": "", "game/script.rpy": "label start:"})
        self.assertEqual(scan(other)["engines"][0]["name"], "Ren'Py")
        empty = Path(self.tmp.name) / "empty"
        make_files(empty, {"settings.ini": "[a]\nb=1\n"})
        p = scan(empty)
        self.assertTrue(p["engines"][0]["name"].startswith("Unknown"))
        self.assertEqual(p["moddable_files"][0]["path"], "settings.ini")


class EditTests(unittest.TestCase):
    def test_json_set_keeps_formatting(self):
        new = edits.json_set(ITEMS, "[1].price", 1)
        self.assertEqual(new, ITEMS.replace('"price":50', '"price":1'))
        self.assertEqual(edits.json_get(new, "1.price"), 1)

    def test_json_set_nested_and_new_key(self):
        text = '{\n  "player": {"hp": 100, "name": "A.B"},\n  "list": []\n}'
        new = edits.json_set(text, "player.hp", 250)
        self.assertIn('"hp": 250', new)
        new = edits.json_set(new, "player.mp", 30)
        self.assertEqual(json.loads(new)["player"], {"hp": 250, "name": "A.B", "mp": 30})
        new = edits.json_set(new, 'player["name"]', "Hero")
        self.assertEqual(json.loads(new)["player"]["name"], "Hero")
        self.assertEqual(json.loads(edits.json_set('{}', "x", True)), {"x": True})

    def test_json_errors(self):
        with self.assertRaises(EditError):
            edits.json_set(ITEMS, "[9].price", 1)
        with self.assertRaises(EditError):
            edits.json_set('{"a": 1}', "b.c", 1)
        with self.assertRaises(EditError):
            edits.json_set("{not json", "a", 1)

    def test_parse_value(self):
        self.assertEqual(edits.parse_value("42"), 42)
        self.assertEqual(edits.parse_value('"42"'), "42")
        self.assertEqual(edits.parse_value("Iron Sword"), "Iron Sword")
        self.assertIs(edits.parse_value("true"), True)

    def test_ini_set(self):
        text = "; settings\r\ntop=1\r\n[Game]\r\nDifficulty = Normal ; comment\r\nFov=90\r\n\r\n[Audio]\r\nVolume=5\r\n"
        new = edits.ini_set(text, "game", "fov", 110)
        self.assertIn("Fov=110\r\n", new)
        new = edits.ini_set(new, "Game", "Speed", "2")
        self.assertIn("Fov=110\r\nSpeed=2\r\n\r\n[Audio]", new)
        new = edits.ini_set(new, "Video", "VSync", True)
        self.assertTrue(new.endswith("[Video]\r\nVSync=true\r\n"))
        new = edits.ini_set(new, "", "top", "2")
        self.assertIn("top=2\r\n[Game]", new)
        self.assertEqual(edits.ini_get(new, "audio", "volume"), "5")

    def test_unreal_style_sections(self):
        text = "[/Script/Engine.RendererSettings]\nr.MotionBlur=1\n"
        self.assertEqual(edits.ini_set(text, "/Script/Engine.RendererSettings", "r.MotionBlur", 0),
                         "[/Script/Engine.RendererSettings]\nr.MotionBlur=0\n")

    def test_replace_text(self):
        self.assertEqual(edits.replace_text("a b a", "b", "c"), "a c a")
        with self.assertRaises(EditError):
            edits.replace_text("a b a", "a", "c")
        self.assertEqual(edits.replace_text("a b a", "a", "c", replace_all=True), "c b c")
        self.assertEqual(edits.replace_text("x\r\ny\r\n", "x\ny", "z\nw"), "z\r\nw\r\n")
        with self.assertRaises(EditError):
            edits.replace_text("abc", "zzz", "y")


class WorkspaceTests(TempGame):
    files = {"data/Items.json": ITEMS, "config.ini": "[Game]\nGold=10\n", "bin.dat": b"\x00\x01\x02",
             "latin.txt": "caf\xe9".encode("cp1252"), "bom.json": b'\xef\xbb\xbf{"a": 1}'}

    def test_paths_are_confined(self):
        ws = self.ws()
        for bad in ("../outside.txt", "/etc/passwd", "data/../../x"):
            with self.assertRaises(ModderError):
                ws.resolve(bad)
        self.assertEqual(ws.resolve("data/Items.json"), self.game.resolve() / "data" / "Items.json")

    def test_binary_and_encodings(self):
        ws = self.ws()
        with self.assertRaises(ModderError):
            ws.read_text("bin.dat")
        ch = ws.propose_replace("latin.txt", "caf\xe9", "th\xe9")
        ws.apply(ch)
        self.assertEqual((self.game / "latin.txt").read_bytes(), "th\xe9".encode("cp1252"))
        ws.apply(ws.propose_json_set("bom.json", "a", 2))
        self.assertEqual((self.game / "bom.json").read_bytes(), b'\xef\xbb\xbf{"a": 2}')

    def test_apply_undo_revert(self):
        ws = self.ws()
        orig_items = (self.game / "data/Items.json").read_text()
        c1 = ws.apply(ws.propose_json_set("data/Items.json", "[1].price", 1), "cheap potions")
        c2 = ws.apply(ws.propose_ini_set("config.ini", "Game", "Gold", 9999))
        c3 = ws.apply(ws.propose_text("mods/new.txt", "hello"))
        self.assertEqual([c["id"] for c in ws.history()], [c1, c2, c3])
        self.assertTrue((self.game / "mods/new.txt").exists())

        ws.undo()  # removes the created file
        self.assertFalse((self.game / "mods/new.txt").exists())
        ws.apply(ws.propose_json_set("data/Items.json", "[2].price", 5))
        ws.undo(c2)  # undoes c2 and everything after it
        self.assertEqual((self.game / "config.ini").read_text(), "[Game]\nGold=10\n")
        self.assertIn('"price":1', (self.game / "data/Items.json").read_text())
        self.assertIn('"price":200', (self.game / "data/Items.json").read_text())

        ws.apply(ws.propose_text("extra.rpy", "x"))
        msgs = ws.revert_all()
        self.assertEqual((self.game / "data/Items.json").read_text(), orig_items)
        self.assertFalse((self.game / "extra.rpy").exists())
        self.assertEqual(ws.history(), [])
        self.assertTrue(any("restored" in m for m in msgs))

    def test_stale_change_rejected(self):
        ws = self.ws()
        ch = ws.propose_ini_set("config.ini", "Game", "Gold", 5)
        (self.game / "config.ini").write_text("[Game]\nGold=11\n")
        with self.assertRaises(ModderError):
            ws.apply(ch)

    def test_read_and_search(self):
        ws = self.ws()
        self.assertIn('     3| {"id":1,"name":"Potion"', ws.read_lines("data/Items.json"))
        self.assertIn("[lines 2-2 of 5]", ws.read_lines("data/Items.json", 2, 1))
        hits = ws.search("ether")
        self.assertEqual(hits, ['data/Items.json:4: {"id":2,"name":"Ether","price":200,"note":""}'])
        self.assertEqual(ws.search("gold", glob="*.json"), [])
        self.assertIn("data/", ws.list_dir("."))


class FakeLLM:
    """Plays back a scripted list of replies."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []

    def chat(self, messages, tools):
        self.seen.append([dict(m) for m in messages])
        return self.replies.pop(0)


def call(name, **args):
    return {"content": "", "tool_calls": [{"id": f"c-{name}", "name": name, "arguments": args}]}


class AgentTests(TempGame):
    files = {"www/data/Items.json": ITEMS, "www/data/System.json": "{}", "www/js/rpg_core.js": ""}

    def agent(self, replies, approve=True):
        self.asked = []
        llm = FakeLLM(replies)
        ws = self.ws()
        a = ModderAgent(ws, scan(self.game), llm, lambda ch: self.asked.append(ch) or approve)
        return a, llm

    def test_tool_loop_applies_edit(self):
        a, llm = self.agent([
            call("search_files", query="Potion"),
            call("set_json_value", path="www/data/Items.json", key_path="[1].price", value="1"),
            {"content": "Potions now cost 1 gold.", "tool_calls": []},
        ])
        self.assertEqual(a.ask("make potions cost 1"), "Potions now cost 1 gold.")
        self.assertIn('"price":1,', (self.game / "www/data/Items.json").read_text())
        self.assertEqual(len(self.asked), 1)
        self.assertIn("RPG Maker MV", llm.seen[0][0]["content"])
        tool_msgs = [m for m in a.messages if m["role"] == "tool"]
        self.assertIn("www/data/Items.json:3:", tool_msgs[0]["content"])
        self.assertIn("Applied as change #1", tool_msgs[1]["content"])

    def test_declined_and_errors_are_reported_to_model(self):
        a, _ = self.agent([
            call("set_json_value", path="www/data/Items.json", key_path="[1].price", value="1"),
            call("read_file", path="../../etc/passwd"),
            call("read_file"),
            {"content": "ok", "tool_calls": []},
        ], approve=False)
        a.ask("x")
        results = [m["content"] for m in a.messages if m["role"] == "tool"]
        self.assertIn("declined", results[0])
        self.assertIn("outside the game folder", results[1])
        self.assertIn("missing required argument", results[2])
        self.assertIn('"price":50', (self.game / "www/data/Items.json").read_text())

    def test_step_limit(self):
        a, _ = self.agent([call("list_files")] * 40)
        a.max_steps = 3
        self.assertIn("Stopped after too many steps", a.ask("loop"))


class LLMFallbackTests(unittest.TestCase):
    def test_tool_call_printed_as_text(self):
        from modder.llm import _clean, _fallback_tool_calls
        calls = _fallback_tool_calls('```json\n{"name": "read_file", "arguments": {"path": "a.ini"}}\n```', {"read_file"})
        self.assertEqual(calls[0]["name"], "read_file")
        self.assertEqual(calls[0]["arguments"], {"path": "a.ini"})
        self.assertEqual(_fallback_tool_calls('{"name": "rm_rf"}', {"read_file"}), [])
        self.assertEqual(_clean("<think>hmm</think>Done."), "Done.")


class CLITests(TempGame):
    files = {"Data/Items.json": ITEMS, "settings.ini": "[Video]\nFov=90\n"}

    def run_cli(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main(list(argv))
        return code, buf.getvalue()

    def test_scan_set_history_undo_revert(self):
        g = str(self.game)
        code, out = self.run_cli("scan", g)
        self.assertEqual(code, 0)
        self.assertIn("Likely moddable", out)
        code, out = self.run_cli("set", g, "Data/Items.json", "[2].name", '"Mega Ether"', "--yes")
        self.assertIn("Applied as change #1", out)
        code, out = self.run_cli("set", g, "settings.ini", "Fov", "110", "--section", "Video", "--yes")
        self.assertEqual((self.game / "settings.ini").read_text(), "[Video]\nFov=110\n")
        code, out = self.run_cli("history", g)
        self.assertIn("#1", out)
        self.assertIn("#2", out)
        code, out = self.run_cli("find", g, "mega")
        self.assertIn("Data/Items.json:4:", out)
        self.run_cli("undo", g)
        self.assertEqual((self.game / "settings.ini").read_text(), "[Video]\nFov=90\n")
        self.run_cli("revert", g, "--yes")
        self.assertEqual((self.game / "Data/Items.json").read_text(), ITEMS)


if __name__ == "__main__":
    unittest.main()
