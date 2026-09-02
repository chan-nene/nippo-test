from __future__ import annotations

from collections.abc import Mapping
from configparser import ConfigParser
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any


COLOR_THEMES = frozenset({"light", "dark"})
COLOR_PALETTES = frozenset({"default", "blue"})
MEMBER_FILTER_LEVELS = ("department", "section", "member")
DEFAULT_MEMBER_FILTER_LEVELS = ""


def to_int(value: Any, default: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def to_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def normalize_color_theme(value: Any, default: str = "dark") -> str:
    fallback = default if default in COLOR_THEMES else "dark"
    color_theme = str(value or "").strip().lower()
    return color_theme if color_theme in COLOR_THEMES else fallback


def normalize_color_palette(value: Any, default: str = "default") -> str:
    fallback = default if default in COLOR_PALETTES else "default"
    color_palette = str(value or "").strip().lower()
    return color_palette if color_palette in COLOR_PALETTES else fallback


def normalize_member_filter_levels(
    value: Any, default: str = DEFAULT_MEMBER_FILTER_LEVELS
) -> str:
    def parse_levels(raw: Any) -> list[str]:
        if isinstance(raw, (list, tuple, set)):
            values = [str(item).strip() for item in raw]
        else:
            values = [item.strip() for item in str(raw or "").replace(";", ",").split(",")]
        aliases = {"large": "department", "medium": "section", "small": "section"}
        return [aliases.get(item, item) for item in values]

    fallback = [
        level for level in MEMBER_FILTER_LEVELS if level in parse_levels(default)
    ]
    if value is None:
        return ",".join(fallback)
    raw_levels = parse_levels(value)
    normalized = [
        level for level in MEMBER_FILTER_LEVELS if level in raw_levels
    ]
    if normalized or not any(raw_levels):
        return ",".join(normalized)
    return ",".join(fallback)


@dataclass
class AppSettings:
    users_dir: str = ""
    comments_dir: str = ""
    common_dir: str = ""
    default_start_offset_days: int = -2
    default_end_offset_days: int = 0
    missing_comment_start_date: str = ""
    include_today_in_missing_comments: bool = False
    comment_signature: str = ""
    ui_sidebar_open: bool = True
    ui_period_preset: str = "default"
    ui_start_date: str = ""
    ui_end_date: str = ""
    ui_font_size: str = "large"
    ui_column_widths: str = ""
    ui_color_theme: str = "dark"
    ui_color_palette: str = "default"
    ui_member_filter_levels: str = DEFAULT_MEMBER_FILTER_LEVELS

    @property
    def is_complete(self) -> bool:
        return bool(self.users_dir and self.comments_dir and self.common_dir)

    @classmethod
    def from_mapping(cls, source: Mapping[str, Any]) -> AppSettings:
        defaults = cls()
        values: dict[str, Any] = {}
        for field in fields(cls):
            default = getattr(defaults, field.name)
            raw_value = source.get(field.name, default)
            if field.name == "ui_color_theme":
                values[field.name] = normalize_color_theme(raw_value, default)
            elif field.name == "ui_color_palette":
                values[field.name] = normalize_color_palette(raw_value, default)
            elif field.name == "ui_member_filter_levels":
                values[field.name] = normalize_member_filter_levels(raw_value, default)
            elif isinstance(default, bool):
                values[field.name] = to_bool(raw_value, default)
            elif isinstance(default, int):
                values[field.name] = to_int(raw_value, default)
            else:
                values[field.name] = (
                    "" if raw_value is None else str(raw_value).strip()
                )
        return cls(**values)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


PATH_FIELD_LABELS = {
    "users_dir": "ユーザー日報フォルダ",
    "comments_dir": "上司コメントフォルダ",
    "common_dir": "管理フォルダ",
}


def validate_settings_paths(settings: AppSettings) -> dict[str, str]:
    errors: dict[str, str] = {}
    for field, label in PATH_FIELD_LABELS.items():
        raw_path = str(getattr(settings, field, "")).strip()
        if not raw_path:
            errors[field] = f"{label}を入力してください。"
            continue
        path = Path(raw_path)
        if not path.exists():
            errors[field] = f"{label}が見つかりません。パスを確認してください。"
        elif not path.is_dir():
            errors[field] = f"{label}にはフォルダを指定してください。"
    return errors


class SettingsManager:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.path = base_dir / "settings.ini"

    def load(self) -> AppSettings:
        parser = ConfigParser()
        if not self.path.exists():
            return AppSettings()
        parser.read(self.path, encoding="utf-8")
        section = parser["database"] if parser.has_section("database") else {}
        return AppSettings.from_mapping(section)

    def save(self, settings: AppSettings) -> None:
        parser = ConfigParser()
        parser["database"] = {
            key: str(value) for key, value in settings.to_dict().items()
        }
        self.base_dir.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as file:
            parser.write(file)
