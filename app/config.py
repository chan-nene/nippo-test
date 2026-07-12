from __future__ import annotations

from configparser import ConfigParser
from dataclasses import dataclass
from pathlib import Path


@dataclass
class AppSettings:
    users_dir: str = ""
    comments_dir: str = ""
    common_dir: str = ""
    default_start_offset_days: int = -1
    default_end_offset_days: int = 0
    missing_comment_start_date: str = ""
    comment_signature: str = ""
    hide_holidays_default: bool = False
    ui_sidebar_open: bool = True
    ui_period_preset: str = "default"
    ui_start_date: str = ""
    ui_end_date: str = ""
    ui_hide_holidays: bool = False
    ui_font_size: str = "standard"

    @property
    def is_complete(self) -> bool:
        return bool(self.users_dir and self.comments_dir and self.common_dir)


class SettingsManager:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.path = base_dir / "settings.ini"

    def _get_int(self, section: dict[str, str], key: str, default: int) -> int:
        try:
            return int(str(section.get(key, default)).strip())
        except (TypeError, ValueError):
            return default

    def _get_bool(self, section: dict[str, str], key: str, default: bool) -> bool:
        value = str(section.get(key, str(default))).strip().lower()
        if value in {"1", "true", "yes", "on"}:
            return True
        if value in {"0", "false", "no", "off"}:
            return False
        return default

    def load(self) -> AppSettings:
        parser = ConfigParser()
        if not self.path.exists():
            return AppSettings()
        parser.read(self.path, encoding="utf-8")
        section = parser["database"] if parser.has_section("database") else {}
        hide_holidays_default = self._get_bool(
            section, "hide_holidays_default", False
        )
        return AppSettings(
            users_dir=str(section.get("users_dir", "")).strip(),
            comments_dir=str(section.get("comments_dir", "")).strip(),
            common_dir=str(section.get("common_dir", "")).strip(),
            default_start_offset_days=self._get_int(
                section, "default_start_offset_days", -1
            ),
            default_end_offset_days=self._get_int(
                section, "default_end_offset_days", 0
            ),
            missing_comment_start_date=str(
                section.get("missing_comment_start_date", "")
            ).strip(),
            comment_signature=str(section.get("comment_signature", "")).strip(),
            hide_holidays_default=hide_holidays_default,
            ui_sidebar_open=self._get_bool(section, "ui_sidebar_open", True),
            ui_period_preset=str(
                section.get("ui_period_preset", "default")
            ).strip(),
            ui_start_date=str(section.get("ui_start_date", "")).strip(),
            ui_end_date=str(section.get("ui_end_date", "")).strip(),
            ui_hide_holidays=self._get_bool(
                section, "ui_hide_holidays", hide_holidays_default
            ),
            ui_font_size=str(section.get("ui_font_size", "standard")).strip(),
        )

    def save(self, settings: AppSettings) -> None:
        parser = ConfigParser()
        parser["database"] = {
            "users_dir": settings.users_dir,
            "comments_dir": settings.comments_dir,
            "common_dir": settings.common_dir,
            "default_start_offset_days": str(settings.default_start_offset_days),
            "default_end_offset_days": str(settings.default_end_offset_days),
            "missing_comment_start_date": settings.missing_comment_start_date,
            "comment_signature": settings.comment_signature,
            "hide_holidays_default": str(settings.hide_holidays_default),
            "ui_sidebar_open": str(settings.ui_sidebar_open),
            "ui_period_preset": settings.ui_period_preset,
            "ui_start_date": settings.ui_start_date,
            "ui_end_date": settings.ui_end_date,
            "ui_hide_holidays": str(settings.ui_hide_holidays),
            "ui_font_size": settings.ui_font_size,
        }
        self.base_dir.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as file:
            parser.write(file)
