"""Sync generated kt-datacards data into this static site without running its pipeline."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import unicodedata
from pathlib import Path
from urllib.parse import quote


SITE_ROOT = Path(__file__).resolve().parents[1]
CONTENT_TYPES = {
    "factionRules": ("faction_rules", "Faction rule"),
    "firefightPloys": ("firefight_ploys", "Firefight ploy"),
    "strategyPloys": ("strategy_ploys", "Strategy ploy"),
}


def slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    normalized = re.sub(r"['.]", "", normalized.strip().lower())
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")


def read_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return data


def weapon_rules(weapons: list[dict], names: list[str]) -> list[str]:
    rules: set[str] = set()
    for weapon in weapons:
        for text in (weapon.get("special_rules") or "").split(","):
            text = text.strip()
            if not text:
                continue
            for name in names:
                base = re.sub(r"\s+x\+?$", "", name, flags=re.IGNORECASE)
                if re.match(rf"^{re.escape(base)}(?:$|[\s(])", text, flags=re.IGNORECASE):
                    rules.add(base)
                    break
            else:
                rules.add(text)
    return sorted(rules, key=str.casefold)


def build_catalog(source: Path) -> tuple[list[dict], dict, dict[str, Path], list[str]]:
    names = sorted(
        [*read_json(source / "config" / "weapon_rules.json"), "Piercing Crits x"],
        key=len,
        reverse=True,
    )
    files = sorted((source / "output").glob("*/data/*-team-data.json"))
    if not files:
        raise ValueError(f"No generated team data found in {source / 'output'}")
    operatives: list[dict] = []
    teams: dict[str, dict] = {}
    images: dict[str, Path] = {}
    warnings: list[str] = []
    ids: set[str] = set()
    for path in files:
        data = read_json(path)
        team = data.get("team") or path.parent.parent.name
        if not isinstance(team, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", team):
            raise ValueError(f"Invalid team slug in {path}: {team!r}")
        for card in data.get("datacards", []):
            if not card.get("name"):
                raise ValueError(f"Unnamed datacard in {path}")
            card_slug = slug(card["name"])
            identifier = f"{team}:{card_slug}"
            if not card_slug or identifier in ids:
                raise ValueError(f"Empty or duplicate operative ID in {path}: {identifier}")
            ids.add(identifier)
            weapons = card.get("weapons", [])
            operative = {
                "id": identifier, "team": team, "teamLabel": team.replace("-", " ").title(),
                "name": card["name"], "wounds": card.get("wounds"), "apl": card.get("apl"),
                "movement": card.get("movement"), "save": card.get("save"),
                "baseSize": card.get("base_size"), "weapons": weapons,
                "weaponRules": weapon_rules(weapons, names),
                "passiveAbilities": card.get("passive_abilities", []),
                "uniqueActions": card.get("unique_actions", []), "keywords": card.get("keywords", []),
            }
            for side in ("front", "back"):
                relative = f"output/{team}/cards/datacards/{card_slug}-{side}.jpg"
                image = source.joinpath(*relative.split("/"))
                if not image.is_file():
                    first_card = f"output/{team}/cards/datacards/{card_slug}-card1-{side}.jpg"
                    candidate = source.joinpath(*first_card.split("/"))
                    if candidate.is_file():
                        relative, image = first_card, candidate
                operative[f"{side}Image"] = "./" + quote(relative)
                if image.is_file():
                    images[relative] = image
                else:
                    warnings.append(f"Missing image: {relative}")
            operatives.append(operative)
        content_path = source / "layers" / "integration" / team / "content" / f"{team}-content.json"
        content = {"contentAvailable": False, **{key: [] for key in CONTENT_TYPES}}
        if content_path.is_file():
            raw = read_json(content_path)
            content["contentAvailable"] = True
            for key, (data_key, label) in CONTENT_TYPES.items():
                content[key] = [
                    {"name": item["name"].replace("-", " ").title(), "type": label, "text": item.get("text", "")}
                    for item in raw.get(data_key, [])
                    if isinstance(item, dict) and item.get("name")
                ]
        else:
            warnings.append(f"Missing faction/ploy content: {content_path}")
        teams[team] = content
    if not operatives:
        raise ValueError("Generated team files contain no operatives")
    return operatives, {"teams": teams, "weaponRuleNames": names}, images, warnings


def sync(source: Path, destination: Path, strict: bool = False) -> None:
    source = source.resolve()
    destination = destination.resolve()
    if destination == source or source in destination.parents or destination in source.parents:
        raise ValueError("Source and site destination must be separate, non-nested directories")
    operatives, content, images, warnings = build_catalog(source)
    for warning in warnings:
        print(f"WARNING: {warning}")
    if strict and warnings:
        raise ValueError("Sync stopped: source data is incomplete (--strict)")
    data_dir = destination / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = data_dir / "sync-manifest.json"
    previous_images = read_json(manifest_path).get("images", []) if manifest_path.is_file() else []
    for relative, original in images.items():
        target = destination.joinpath(*relative.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, target)
    # Remove only images recorded by a previous sync, never arbitrary site files.
    for relative in previous_images:
        if relative in images:
            continue
        if not re.fullmatch(r"output/[a-z0-9-]+/cards/datacards/[a-z0-9-]+-(front|back)\.jpg", relative):
            raise ValueError(f"Invalid managed image path in sync manifest: {relative!r}")
        target = destination.joinpath(*relative.split("/")).resolve()
        if destination not in target.parents:
            raise ValueError(f"Managed image escapes site directory: {target}")
        target.unlink(missing_ok=True)
    for filename, data in (
        ("operatives.json", operatives),
        ("team-content.json", content),
        ("sync-manifest.json", {"source": "Wen-Qualtu/kt-datacards", "images": sorted(images)}),
    ):
        target = data_dir / filename
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(target)
    print(f"Synced {len(operatives)} operatives, {len(content['teams'])} teams, {len(images)} images to {destination}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SITE_ROOT.parent / "kt-datacards")
    parser.add_argument("--strict", action="store_true", help="Fail before writing if images or team content are missing")
    args = parser.parse_args()
    try:
        sync(args.source, SITE_ROOT, args.strict)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Sync failed: {error}\n")


if __name__ == "__main__":
    main()
