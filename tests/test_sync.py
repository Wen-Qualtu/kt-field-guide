import base64
import json
import hashlib
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.sync import build_catalog, sync


class SyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source"
        self.site = self.root / "site"
        self.write_json("config/weapon_rules.json", {"Lethal x+": "description", "Piercing x": "description"})
        self.write_json("output/test-team/data/test-team-team-data.json", {
            "team": "test-team",
            "datacards": [{
                "name": "Test Leader", "apl": 2, "save": "4+", "movement": "6", "wounds": 8,
                "base_size": 25, "weapons": [{"name": "Gun", "special_rules": "Lethal 5+, Piercing Crits 1"}],
            }],
        })
        self.write_json("layers/integration/test-team/content/test-team-content.json", {
            "strategy_ploys": [{"name": "test-ploy", "text": "Grants Lethal 5+."}],
        })
        for side in ("front", "back"):
            path = self.source / "output" / "test-team" / "cards" / "datacards" / f"test-leader-{side}.jpg"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture")

    def write_json(self, relative: str, data: dict) -> None:
        path = self.source.joinpath(*relative.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def test_catalog_keeps_existing_api_shape_and_relative_images(self) -> None:
        operatives, content, images, warnings = build_catalog(self.source)
        self.assertEqual(operatives[0]["save"], "4+")
        self.assertEqual(operatives[0]["weaponRules"], ["Lethal", "Piercing Crits"])
        self.assertEqual(operatives[0]["frontImage"], "./output/test-team/cards/datacards/test-leader-front.jpg")
        self.assertEqual(content["teams"]["test-team"]["strategyPloys"][0]["text"], "Grants Lethal 5+.")
        self.assertEqual(len(images), 2)
        self.assertEqual(warnings, [])

    def test_sync_is_repeatable_and_preserves_ui_and_unmanaged_files(self) -> None:
        self.site.mkdir()
        index = self.site / "index.html"
        index.write_text("custom UI", encoding="utf-8")
        sync(self.source, self.site, strict=True)
        first = (self.site / "data" / "operatives.json").read_bytes()
        sync(self.source, self.site, strict=True)
        self.assertEqual((self.site / "data" / "operatives.json").read_bytes(), first)
        self.assertEqual(index.read_text(encoding="utf-8"), "custom UI")
        unmanaged = self.site / "output" / "keep.txt"
        unmanaged.write_text("keep", encoding="utf-8")
        removed = self.source / "output" / "test-team" / "cards" / "datacards" / "test-leader-back.jpg"
        removed.unlink()
        sync(self.source, self.site)
        self.assertFalse((self.site / "output" / "test-team" / "cards" / "datacards" / removed.name).exists())
        self.assertTrue(unmanaged.exists())

    def test_missing_content_is_visible_and_strict_fails_before_writing(self) -> None:
        (self.source / "layers" / "integration" / "test-team" / "content" / "test-team-content.json").unlink()
        _, content, _, warnings = build_catalog(self.source)
        self.assertFalse(content["teams"]["test-team"]["contentAvailable"])
        self.assertTrue(warnings)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            sync(self.source, self.site, strict=True)
        self.assertFalse(self.site.exists())

    def test_malformed_input_and_nested_destinations_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "separate"):
            sync(self.source, self.source / "site")
        (self.source / "config" / "weapon_rules.json").write_text("invalid", encoding="utf-8")
        with self.assertRaises(json.JSONDecodeError):
            build_catalog(self.source)

    def test_multi_card_operative_uses_first_generated_card(self) -> None:
        folder = self.source / "output" / "test-team" / "cards" / "datacards"
        for side in ("front", "back"):
            (folder / f"test-leader-{side}.jpg").rename(folder / f"test-leader-card1-{side}.jpg")
        operatives, _, images, warnings = build_catalog(self.source)
        self.assertTrue(operatives[0]["frontImage"].endswith("test-leader-card1-front.jpg"))
        self.assertEqual(len(images), 2)
        self.assertFalse(warnings)


    def test_dry_run_does_not_create_destination(self) -> None:
        sync(self.source, self.site, strict=True, dry_run=True)
        self.assertFalse(self.site.exists())

    def test_invalid_manifest_fails_before_copying(self) -> None:
        data_dir = self.site / "data"
        data_dir.mkdir(parents=True)
        (data_dir / "sync-manifest.json").write_text(json.dumps({"images": ["../outside.jpg"]}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Invalid managed image"):
            sync(self.source, self.site)
        self.assertFalse((self.site / "output").exists())

    def test_selection_and_equipment_preserve_source(self) -> None:
        self.write_json("layers/integration/test-team/content/test-team-content.json", {
            "operatives_selection": [{"name": "Selection", "text": "Select 1 leader and 5 others.",
                                      "selection": {"Warrior": ["Gun"]}}],
            "equipment": [{"name": "Grenade", "text": "Once per battle."}],
        })
        _, content, _, _ = build_catalog(self.source)
        team = content["teams"]["test-team"]
        self.assertEqual(team["operativeSelection"][0]["selection"], {"Warrior": ["Gun"]})
        self.assertEqual(team["equipment"][0]["text"], "Once per battle.")
        self.assertEqual(team["sourcePath"], "layers/integration/test-team/content/test-team-content.json")

    def test_new_team_and_all_numbered_pairs_are_discovered(self) -> None:
        self.write_json("output/new-team/data/new-team-team-data.json", {
            "team": "new-team", "datacards": [{"name": "New Warrior"}],
        })
        folder = self.source / "output" / "new-team" / "cards" / "datacards"
        folder.mkdir(parents=True)
        for number in (1, 2, 10):
            for side in ("front", "back"):
                (folder / f"new-warrior-card{number}-{side}.jpg").write_bytes(b"fixture")
        operatives, content, images, _ = build_catalog(self.source)
        operative = next(item for item in operatives if item["team"] == "new-team")
        self.assertEqual(len(operative["cards"]), 3)
        self.assertTrue(operative["cards"][-1]["frontImage"].endswith("card10-front.jpg"))
        self.assertIn("new-team", content["teams"])
        self.assertEqual(len(images), 8)

    def test_malformed_nested_content_is_rejected(self) -> None:
        self.write_json("layers/integration/test-team/content/test-team-content.json", {
            "equipment": ["invalid entry"],
        })
        with self.assertRaisesRegex(ValueError, "Malformed equipment"):
            sync(self.source, self.site, strict=True)
        self.assertFalse(self.site.exists())

    def test_symlinked_temporary_file_cannot_overwrite_ui(self) -> None:
        data_dir = self.site / "data"
        data_dir.mkdir(parents=True)
        index = self.site / "index.html"
        index.write_text("keep UI", encoding="utf-8")
        try:
            (data_dir / "operatives.json.tmp").symlink_to(index)
        except OSError as error:
            self.skipTest(f"Symlinks unavailable: {error}")
        with self.assertRaisesRegex(ValueError, "Unsafe destination"):
            sync(self.source, self.site, strict=True)
        self.assertEqual(index.read_text(encoding="utf-8"), "keep UI")
        self.assertFalse((self.site / "output").exists())

    def test_interrupted_copy_preserves_previous_image(self) -> None:
        sync(self.source, self.site, strict=True)
        image = self.site / "output" / "test-team" / "cards" / "datacards" / "test-leader-front.jpg"
        original = image.read_bytes()
        with patch("scripts.sync.shutil.copyfile", side_effect=OSError("Interrupted")):
            with self.assertRaisesRegex(OSError, "Interrupted"):
                sync(self.source, self.site, strict=True)
        self.assertEqual(image.read_bytes(), original)
        self.assertEqual(len(list(image.parent.iterdir())), 2)


class SiteContractTests(unittest.TestCase):
    def test_inline_script_matches_security_policy(self) -> None:
        root = Path(__file__).resolve().parents[1]
        html = (root / "index.html").read_text(encoding="utf-8")
        scripts = re.findall(r"<script>(.*?)</script>", html, flags=re.DOTALL)
        self.assertEqual(len(scripts), 1)
        digest = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode("ascii")
        policy = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', html)
        self.assertIsNotNone(policy)
        self.assertIn(f"script-src 'sha256-{digest}'", policy[1])
        self.assertNotRegex(html, r"\son(?:error|click|load)=")

    def test_published_snapshot_images_are_local_and_exist(self) -> None:
        root = Path(__file__).resolve().parents[1]
        operatives = json.loads((root / "data" / "operatives.json").read_text(encoding="utf-8"))
        for operative in operatives:
            for card in operative.get("cards") or [operative]:
                for side in ("front", "back"):
                    relative = card[f"{side}Image"]
                    with self.subTest(operative=operative["id"], image=relative):
                        self.assertRegex(relative, r"^\./output/[a-z0-9-]+/cards/datacards/[a-z0-9-]+-(front|back)\.jpg$")
                        self.assertTrue((root / relative).is_file())


if __name__ == "__main__":
    unittest.main()
