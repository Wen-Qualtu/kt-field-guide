import json
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
