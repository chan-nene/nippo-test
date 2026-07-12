from __future__ import annotations

import getpass
import os
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.config import AppSettings, SettingsManager
from app.repository import DailyReportRepository


class DailyReportApi:
    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir
        self._settings_manager = SettingsManager(base_dir)
        self._settings = self._settings_manager.load()
        self._employee_id = self._get_employee_id()
        self._has_unsaved_changes = False

    @property
    def employee_id(self) -> str:
        return self._employee_id

    @property
    def has_unsaved_changes(self) -> bool:
        return self._has_unsaved_changes

    def set_unsaved_changes(self, value: Any) -> dict[str, bool]:
        self._has_unsaved_changes = self._to_bool(value, False)
        return {"ok": True}

    def get_initial_state(self) -> dict[str, Any]:
        return {
            "employee_id": self._employee_id,
            "settings": self._settings_dict(),
            "settings_complete": self._settings.is_complete,
        }

    def save_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            candidate = AppSettings(
                users_dir=str(payload.get("users_dir", "")).strip(),
                comments_dir=str(payload.get("comments_dir", "")).strip(),
                common_dir=str(payload.get("common_dir", "")).strip(),
                default_start_offset_days=self._to_int(
                    payload.get("default_start_offset_days"), -1
                ),
                default_end_offset_days=self._to_int(
                    payload.get("default_end_offset_days"), 0
                ),
                missing_comment_start_date=str(
                    payload.get("missing_comment_start_date", "")
                ).strip(),
                comment_signature=str(payload.get("comment_signature", "")).strip(),
                hide_holidays_default=self._settings.hide_holidays_default,
                ui_sidebar_open=self._settings.ui_sidebar_open,
                ui_period_preset=self._settings.ui_period_preset,
                ui_start_date=self._settings.ui_start_date,
                ui_end_date=self._settings.ui_end_date,
                ui_hide_holidays=self._settings.ui_hide_holidays,
                ui_font_size=self._settings.ui_font_size,
            )
            field_errors = self._validate_settings_paths(candidate)
            if field_errors:
                return {
                    "ok": False,
                    "message": f"{len(field_errors)}項目を確認してください。",
                    "field_errors": field_errors,
                }
            self._settings = candidate
            self._settings_manager.save(self._settings)
            return {
                "ok": True,
                "message": "設定を保存しました。",
                "settings": self._settings_dict(),
            }
        except Exception as exc:
            return {"ok": False, "message": f"設定保存に失敗しました: {exc}"}

    def _validate_settings_paths(self, settings: AppSettings) -> dict[str, str]:
        labels = {
            "users_dir": "ユーザー日報フォルダ",
            "comments_dir": "上司コメントフォルダ",
            "common_dir": "共通マスターフォルダ",
        }
        errors: dict[str, str] = {}
        for field, label in labels.items():
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

    def save_ui_state(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            preset = str(payload.get("period_preset", "")).strip()
            if preset not in {"default", "today", "last7days", "thisMonth", ""}:
                preset = "default"
            self._settings = replace(
                self._settings,
                ui_sidebar_open=self._to_bool(
                    payload.get("sidebar_open"), self._settings.ui_sidebar_open
                ),
                ui_period_preset=preset,
                ui_start_date=str(payload.get("start_date", "")).strip(),
                ui_end_date=str(payload.get("end_date", "")).strip(),
                ui_hide_holidays=self._to_bool(
                    payload.get("hide_holidays"), self._settings.ui_hide_holidays
                ),
                ui_font_size=self._validated_font_size(payload.get("font_size")),
            )
            self._settings_manager.save(self._settings)
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "message": f"表示状態の保存に失敗しました: {exc}"}

    def load_data(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        if not self._settings.is_complete:
            return {
                "ok": False,
                "message": "ネットワークFSパスが未設定です。",
                "needs_settings": True,
            }
        try:
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            data = repo.load_view_data(
                self._employee_id,
                start_date=payload.get("start_date"),
                end_date=payload.get("end_date"),
            )
            return {"ok": True, "data": data}
        except Exception as exc:
            return {"ok": False, "message": f"現在利用できません: {exc}"}

    def save_updates(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._settings.is_complete:
            return {"ok": False, "message": "ネットワークFSパスが未設定です。"}
        try:
            user_updates = payload.get("user_updates", []) or []
            comment_updates = payload.get("comment_updates", []) or []
            repo = DailyReportRepository(self._settings, self._base_dir)
            result = repo.save_updates(self._employee_id, user_updates, comment_updates)
            message = self._build_save_message(result)
            ok = self._is_save_ok(result)
            no_targets = not any(v.get("needed") for v in result.values())
            return {
                "ok": ok,
                "no_targets": no_targets,
                "message": message,
                "result": result,
            }
        except Exception as exc:
            return {
                "ok": False,
                "no_targets": False,
                "message": f"更新処理に失敗しました: {exc}",
            }

    def _settings_dict(self) -> dict[str, Any]:
        return {
            "users_dir": self._settings.users_dir,
            "comments_dir": self._settings.comments_dir,
            "common_dir": self._settings.common_dir,
            "default_start_offset_days": self._settings.default_start_offset_days,
            "default_end_offset_days": self._settings.default_end_offset_days,
            "missing_comment_start_date": self._settings.missing_comment_start_date,
            "comment_signature": self._settings.comment_signature,
            "hide_holidays_default": self._settings.hide_holidays_default,
            "ui_sidebar_open": self._settings.ui_sidebar_open,
            "ui_period_preset": self._settings.ui_period_preset,
            "ui_start_date": self._settings.ui_start_date,
            "ui_end_date": self._settings.ui_end_date,
            "ui_hide_holidays": self._settings.ui_hide_holidays,
            "ui_font_size": self._settings.ui_font_size,
        }

    def _validated_font_size(self, value: Any) -> str:
        font_size = str(value or "standard").strip()
        return (
            font_size
            if font_size in {"standard", "large", "xlarge"}
            else "standard"
        )

    def _to_int(self, value: Any, default: int) -> int:
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    def _to_bool(self, value: Any, default: bool) -> bool:
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
        return default

    def _get_employee_id(self) -> str:
        import sys

        # 開発中の場合、デバッグユーザーを選択させる
        if not getattr(sys, "frozen", False):
            try:
                import tkinter as tk
                from tkinter import simpledialog

                root = tk.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                debug_user = simpledialog.askstring(
                    "開発用ログイン",
                    "テストユーザーIDを入力してください\n(user1, user2, user3, boss1, boss2)\n※キャンセル・空白でOSユーザー",
                    parent=root,
                )
                root.destroy()
                if debug_user and debug_user.strip():
                    return debug_user.strip()
            except Exception as e:
                print(f"Failed to show debug login: {e}")

        for getter in (getpass.getuser, lambda: os.environ.get("USERNAME", "")):
            try:
                value = getter()
                if value:
                    return str(value)
            except Exception:
                continue
        return "unknown"

    def _is_save_ok(self, result: dict[str, Any]) -> bool:
        targets = [value for value in result.values() if value.get("needed")]
        return bool(targets) and all(value.get("uploaded") for value in targets)

    def _build_save_message(self, result: dict[str, Any]) -> str:
        user = result.get("user", {})
        comment = result.get("comment", {})
        user_needed = user.get("needed")
        comment_needed = comment.get("needed")
        if not user_needed and not comment_needed:
            return "更新対象がありません。"

        if user_needed and not comment_needed:
            return self._single_target_message("日報", user)
        if comment_needed and not user_needed:
            return self._single_target_message("コメント", comment)

        user_ok = bool(user.get("uploaded"))
        comment_ok = bool(comment.get("uploaded"))
        if user_ok and comment_ok:
            return "日報とコメントの更新が完了しました。"
        if user_ok and not comment_ok:
            return "日報の更新は完了しました。コメントの更新に失敗しました。ネットワーク接続を確認して、再度「更新」を押してください。"
        if comment_ok and not user_ok:
            return "コメントの更新は完了しました。日報の更新に失敗しました。ネットワーク接続を確認して、再度「更新」を押してください。"
        return "日報とコメントの更新に失敗しました。ネットワーク接続を確認して、再度「更新」を押してください。"

    def _single_target_message(self, label: str, result: dict[str, Any]) -> str:
        if result.get("uploaded"):
            return f"{label}の更新が完了しました。"
        if result.get("local_saved"):
            return f"{label}の更新に失敗しました。ネットワーク接続を確認して、再度「更新」を押してください。"
        return f"{label}の更新に失敗しました。ログを確認してください。"
