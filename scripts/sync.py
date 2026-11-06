"""Sync generated kt-datacards data into this static site without running its pipeline."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
import unicodedata
from pathlib import Path
from urllib.parse import quote


SITE_ROOT = Path(__file__).resolve().parents[1]
CONTENT_TYPES = {
    "factionRules": ("faction_rules", "Faction rule"),
    "firefightPloys": ("firefight_ploys", "Firefight ploy"),
    "strategyPloys": ("strategy_ploys", "Strategy ploy"),
    "equipment": ("equipment", "Equipment"),
    "operativeSelection": ("operatives_selection", "Operative selection"),
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
    config = source / "config" / "weapon_rules.json"
    if source.resolve() not in config.resolve().parents:
        raise ValueError("Weapon rule configuration escapes source directory")
    names = sorted(
        [*read_json(config), "Piercing Crits x"],
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
        if team in teams:
            raise ValueError(f"Duplicate team slug: {team}")
        if source.resolve() not in path.resolve().parents:
            raise ValueError(f"Team data escapes source directory: {team}")
        cards = data.get("datacards")
        if not isinstance(cards, list) or not cards:
            raise ValueError(f"Expected non-empty datacards list: {path}")
        for card in cards:
            if not isinstance(card, dict) or not isinstance(card.get("name"), str) or not card["name"]:
                raise ValueError(f"Unnamed datacard in {path}")
            card_slug = slug(card["name"])
            identifier = f"{team}:{card_slug}"
            if not card_slug or identifier in ids:
                raise ValueError(f"Empty or duplicate operative ID in {path}: {identifier}")
            ids.add(identifier)
            weapons = card.get("weapons", [])
            if not isinstance(weapons, list) or any(
                not isinstance(weapon, dict) or not isinstance(weapon.get("name"), str)
                or not isinstance(weapon.get("special_rules", ""), str) for weapon in weapons
            ):
                raise ValueError(f"Malformed weapons: {identifier}")
            for field in ("passive_abilities", "unique_actions"):
                entries = card.get(field, [])
                if not isinstance(entries, list) or any(
                    not isinstance(entry, dict) or not isinstance(entry.get("name"), str)
                    or not isinstance(entry.get("description", ""), str) for entry in entries
                ):
                    raise ValueError(f"Malformed {field}: {identifier}")
            keywords = card.get("keywords", [])
            if not isinstance(keywords, list) or any(not isinstance(keyword, str) for keyword in keywords):
                raise ValueError(f"Malformed keywords: {identifier}")
            operative = {
                "id": identifier, "team": team, "teamLabel": team.replace("-", " ").title(),
                "name": card["name"], "wounds": card.get("wounds"), "apl": card.get("apl"),
                "movement": card.get("movement"), "save": card.get("save"),
                "baseSize": card.get("base_size"), "weapons": weapons,
                "weaponRules": weapon_rules(weapons, names),
                "passiveAbilities": card.get("passive_abilities", []),
                "uniqueActions": card.get("unique_actions", []), "keywords": card.get("keywords", []),
            }
            folder = source / "output" / team / "cards" / "datacards"
            numbers = set()
            for candidate in folder.glob(f"{card_slug}-card*-*.jpg"):
                match = re.fullmatch(rf"{re.escape(card_slug)}-card([1-9][0-9]*)-(front|back)\.jpg", candidate.name)
                if match:
                    numbers.add(int(match[1]))
            stems = [f"{card_slug}-card{number}" for number in sorted(numbers)]
            if any((folder / f"{card_slug}-{side}.jpg").is_file() for side in ("front", "back")) or not stems:
                stems.insert(0, card_slug)
            operative["cards"] = []
            for stem in stems:
                pair = {}
                for side in ("front", "back"):
                    relative = f"output/{team}/cards/datacards/{stem}-{side}.jpg"
                    image = source.joinpath(*relative.split("/"))
                    pair[f"{side}Image"] = "./" + quote(relative)
                    pair[f"{side}Available"] = image.is_file()
                    if image.is_file():
                        if source.resolve() not in image.resolve().parents:
                            raise ValueError(f"Source image escapes source directory: {relative}")
                        images[relative] = image
                    else:
                        warnings.append(f"Missing image: {relative}")
                operative["cards"].append(pair)
            operative.update({key: operative["cards"][0][key] for key in ("frontImage", "backImage")})
            operatives.append(operative)
        content_path = source / "layers" / "integration" / team / "content" / f"{team}-content.json"
        content = {"contentAvailable": False, **{key: [] for key in CONTENT_TYPES}}
        if content_path.is_file():
            if source.resolve() not in content_path.resolve().parents:
                raise ValueError(f"Team content escapes source directory: {team}")
            raw = read_json(content_path)
            content["contentAvailable"] = True
            content["sourcePath"] = content_path.relative_to(source).as_posix()
            content["generatedAt"] = raw.get("generated_at")
            for key, (data_key, label) in CONTENT_TYPES.items():
                entries = raw.get(data_key, [])
                if not isinstance(entries, list):
                    raise ValueError(f"Expected list for {data_key}: {content_path}")
                for item in entries:
                    if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("text", ""), str):
                        raise ValueError(f"Malformed {data_key} entry: {content_path}")
                    content[key].append({"name": item["name"], "type": label, "text": item.get("text", ""),
                                         "sourcePath": content["sourcePath"],
                                         **{field: item[field] for field in ("selection", "options") if field in item}})
        else:
            warnings.append(f"Missing faction/ploy content: {content_path}")
        teams[team] = content
    if not operatives:
        raise ValueError("Generated team files contain no operatives")
    return operatives, {"schemaVersion": 2, "teams": teams, "weaponRuleNames": names}, images, warnings


def validate_destination(destination: Path, target: Path) -> None:
    if destination not in target.resolve().parents or target.is_symlink() or any(
        parent.is_symlink() for parent in target.parents if destination in parent.parents
    ):
        raise ValueError(f"Unsafe destination path: {target.relative_to(destination).as_posix()}")


def managed_target(destination: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not re.fullmatch(
        r"output/[a-z0-9-]+/cards/datacards/[a-z0-9-]+-(front|back)\.jpg", relative
    ):
        raise ValueError(f"Invalid managed image path: {relative!r}")
    target = destination.joinpath(*relative.split("/"))
    validate_destination(destination, target)
    return target


def sync(source: Path, destination: Path, strict: bool = False, dry_run: bool = False) -> None:
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
    validate_destination(destination, data_dir)
    manifest_path = data_dir / "sync-manifest.json"
    previous_images = read_json(manifest_path).get("images", []) if manifest_path.is_file() else []
    if not isinstance(previous_images, list):
        raise ValueError("Manifest images must be a list")
    for relative in previous_images:
        managed_target(destination, relative)
    for relative, original in images.items():
        managed_target(destination, relative)
        if source not in original.resolve().parents:
            raise ValueError(f"Source image escapes source directory: {relative}")
    for filename in ("operatives.json", "team-content.json", "sync-manifest.json"):
        for target in (data_dir / filename, (data_dir / filename).with_suffix(".json.tmp")):
            validate_destination(destination, target)
    if dry_run:
        removed = set(previous_images) - images.keys()
        print(f"Dry run: {len(operatives)} operatives, {len(content['teams'])} teams, "
              f"{len(images)} images to copy, {len(removed)} managed images to remove; no files written")
        return
    data_dir.mkdir(parents=True, exist_ok=True)
    for relative, original in images.items():
        target = managed_target(destination, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary_file:
            temporary_image = Path(temporary_file.name)
        try:
            shutil.copyfile(original, temporary_image)
            temporary_image.replace(target)
        finally:
            temporary_image.unlink(missing_ok=True)
    # Remove only images recorded by a previous sync, never arbitrary site files.
    for relative in previous_images:
        if relative in images:
            continue
        target = managed_target(destination, relative)
        target.unlink(missing_ok=True)
    for filename, data in (
        ("operatives.json", operatives),
        ("team-content.json", content),
        ("sync-manifest.json", {"schemaVersion": 2, "source": "Wen-Qualtu/kt-datacards", "images": sorted(images)}),
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
    parser.add_argument("--dry-run", action="store_true", help="Validate and report without writing")
    args = parser.parse_args()
    try:
        sync(args.source, SITE_ROOT, args.strict, args.dry_run)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Sync failed: {error}\n")


if __name__ == "__main__":
    main()
