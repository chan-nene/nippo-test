from __future__ import annotations

import getpass
import os
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.config import (
    SettingsManager,
    to_bool,
    to_int,
    validate_settings_paths,
)
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
        self._has_unsaved_changes = to_bool(value, False)
        return {"ok": True}

    def get_initial_state(self) -> dict[str, Any]:
        return {
            "employee_id": self._employee_id,
            "settings": self._settings.to_dict(),
            "settings_complete": self._settings.is_complete,
        }

    def save_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            candidate = replace(
                self._settings,
                users_dir=str(payload.get("users_dir", "")).strip(),
                comments_dir=str(payload.get("comments_dir", "")).strip(),
                common_dir=str(payload.get("common_dir", "")).strip(),
                default_start_offset_days=to_int(
                    payload.get("default_start_offset_days"), -1
                ),
                default_end_offset_days=to_int(
                    payload.get("default_end_offset_days"), 0
                ),
                missing_comment_start_date=str(
                    payload.get("missing_comment_start_date", "")
                ).strip(),
                comment_signature=str(payload.get("comment_signature", "")).strip(),
            )
            field_errors = validate_settings_paths(candidate)
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
                "settings": self._settings.to_dict(),
            }
        except Exception as exc:
            return {"ok": False, "message": f"設定保存に失敗しました: {exc}"}

    def save_ui_state(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            preset = str(payload.get("period_preset", "")).strip()
            if preset not in {"default", "today", "last7days", "thisMonth", ""}:
                preset = "default"
            self._settings = replace(
                self._settings,
                ui_sidebar_open=to_bool(
                    payload.get("sidebar_open"), self._settings.ui_sidebar_open
                ),
                ui_period_preset=preset,
                ui_start_date=str(payload.get("start_date", "")).strip(),
                ui_end_date=str(payload.get("end_date", "")).strip(),
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
            targets = [value for value in result.values() if value.get("needed")]
            return {
                "ok": bool(targets) and all(value.get("saved") for value in targets),
                "no_targets": not targets,
                "result": result,
            }
        except Exception as exc:
            return {
                "ok": False,
                "no_targets": False,
                "message": f"更新処理に失敗しました: {exc}",
            }

    def _validated_font_size(self, value: Any) -> str:
        font_size = str(value or "standard").strip()
        return (
            font_size
            if font_size in {"standard", "large", "xlarge"}
            else "standard"
        )

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
