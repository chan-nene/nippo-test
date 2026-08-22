from __future__ import annotations

import getpass
import json
import logging
import os
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

from app.config import (
    SettingsManager,
    normalize_member_filter_levels,
    normalize_color_theme,
    to_bool,
    to_int,
    validate_settings_paths,
)
from app.ime_diagnostics import ImeDiagnosticRecorder
from app.repository import CommonMasterConflictError, DailyReportRepository
from app.security import (
    PERIOD_PRESETS,
    RequestValidationError,
    validate_administration_save_request,
    validate_common_master_save_request,
    validate_load_request,
    validate_ime_diagnostic_request,
    validate_save_request,
    validate_settings_request,
    validate_user_team_references,
    validate_ui_state_request,
    validate_user_administration_save_request,
)


logger = logging.getLogger(__name__)
UNREGISTERED_EMPLOYEE_MESSAGE = "このアプリは使用できません。管理者に連絡してください。"


class DailyReportApi:
    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir
        self._settings_manager = SettingsManager(base_dir)
        self._settings = self._settings_manager.load()
        self._employee_id = self._get_employee_id()
        self._has_unsaved_changes = False
        self._close_window_callback: Callable[[], None] | None = None
        self._ime_diagnostic_recorder = ImeDiagnosticRecorder(base_dir)

    @property
    def employee_id(self) -> str:
        return self._employee_id

    @property
    def has_unsaved_changes(self) -> bool:
        return self._has_unsaved_changes

    def set_unsaved_changes(self, value: Any) -> dict[str, bool]:
        self._has_unsaved_changes = to_bool(value, False)
        return {"ok": True}

    def _set_close_window_callback(self, callback: Callable[[], None]) -> None:
        self._close_window_callback = callback

    def close_window(self) -> dict[str, bool]:
        callback = getattr(self, "_close_window_callback", None)
        if callback is None:
            return {"ok": False}
        callback()
        return {"ok": True}

    def record_ime_diagnostics(self, payload: Any) -> dict[str, Any]:
        try:
            validated = validate_ime_diagnostic_request(payload)
            recorder = getattr(self, "_ime_diagnostic_recorder", None)
            if recorder is None:
                recorder = ImeDiagnosticRecorder(self._base_dir)
                self._ime_diagnostic_recorder = recorder
            recorded = recorder.append(validated["client"], validated["events"])
            return {"ok": True, "recorded": recorded}
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except Exception:
            logger.exception("Failed to write IME diagnostics")
            return {"ok": False, "message": "IME診断ログの保存に失敗しました。"}

    def get_initial_state(self) -> dict[str, Any]:
        employee_registered: bool | None = None
        if self._settings.is_complete:
            try:
                employee_registered = self._is_employee_registered()
            except Exception:
                logger.exception("Failed to check employee registration")
        is_admin = self._is_admin()
        if employee_registered is False:
            is_admin = False
        return {
            "employee_id": self._employee_id,
            "is_admin": is_admin,
            "settings": self._settings.to_dict(),
            "settings_complete": self._settings.is_complete,
            "employee_registered": employee_registered,
            "access_denied": employee_registered is False,
            "access_denied_message": (
                UNREGISTERED_EMPLOYEE_MESSAGE
                if employee_registered is False
                else ""
            ),
        }

    def save_settings(self, payload: Any) -> dict[str, Any]:
        try:
            payload = validate_settings_request(payload)
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
                include_today_in_missing_comments=to_bool(
                    payload.get("include_today_in_missing_comments"),
                    self._settings.include_today_in_missing_comments,
                ),
                comment_signature=str(payload.get("comment_signature", "")).strip(),
                ui_color_theme=normalize_color_theme(
                    payload.get("ui_color_theme"),
                    self._settings.ui_color_theme,
                ),
                ui_member_filter_levels=normalize_member_filter_levels(
                    payload.get("ui_member_filter_levels"),
                    self._settings.ui_member_filter_levels,
                ),
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
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except Exception:
            logger.exception("Failed to save settings")
            return {"ok": False, "message": "設定の保存に失敗しました。"}

    def save_ui_state(self, payload: Any) -> dict[str, Any]:
        try:
            payload = validate_ui_state_request(payload)
            preset = str(payload.get("period_preset", "")).strip()
            if preset == "last7days":
                preset = "default"
            if preset not in PERIOD_PRESETS:
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
                ui_color_theme=normalize_color_theme(
                    payload.get("ui_color_theme"), self._settings.ui_color_theme
                ),
                ui_column_widths=(
                    json.dumps(
                        payload["column_widths"],
                        ensure_ascii=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    if "column_widths" in payload
                    else self._settings.ui_column_widths
                ),
            )
            self._settings_manager.save(self._settings)
            return {"ok": True}
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except Exception:
            logger.exception("Failed to save UI state")
            return {"ok": False, "message": "表示状態の保存に失敗しました。"}

    def load_data(self, payload: Any = None) -> dict[str, Any]:
        try:
            payload = validate_load_request(payload)
            if not self._settings.is_complete:
                return {
                    "ok": False,
                    "message": "ネットワークFSパスが未設定です。",
                    "needs_settings": True,
                }
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            access_denied = self._registered_employee_access_denied(repo)
            if access_denied:
                return access_denied
            data = repo.load_view_data(
                self._employee_id,
                start_date=payload.get("start_date"),
                end_date=payload.get("end_date"),
                period_preset=payload.get("period_preset"),
            )
            return {"ok": True, "data": data}
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except Exception:
            logger.exception("Failed to load daily report data")
            return {"ok": False, "message": "現在利用できません。"}

    def load_common_masters(self) -> dict[str, Any]:
        try:
            if not self._is_admin():
                return self._admin_access_denied()
            access_denied = self._registered_employee_access_denied()
            if access_denied:
                return access_denied
            if not self._settings.is_complete:
                return {
                    "ok": False,
                    "message": "ネットワークFSパスが未設定です。",
                    "needs_settings": True,
                }
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            data = repo.load_common_masters()
            return {
                "ok": True,
                "data": data,
                "revisions": repo.get_common_master_revisions(),
                "migration_required": {
                    "user_master": repo.legacy_rank_migration_required,
                    "team_master": repo.commenter_assignment_migration_required,
                    "calendar": repo.calendar_migration_required,
                },
            }
        except Exception:
            logger.exception("Failed to load common masters")
            return {"ok": False, "message": "共通マスターを読み込めませんでした。"}

    def save_common_master(self, payload: Any) -> dict[str, Any]:
        try:
            if not self._is_admin():
                return self._admin_access_denied()
            access_denied = self._registered_employee_access_denied()
            if access_denied:
                return access_denied
            master, rows, revision = validate_common_master_save_request(payload)
            if master != "calendar":
                raise RequestValidationError(
                    "ユーザー情報はユーザー管理画面から保存してください。"
                )
            if not self._settings.is_complete:
                return {"ok": False, "message": "ネットワークFSパスが未設定です。"}
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            new_revision = repo.save_common_master(
                master, rows, expected_revision=revision
            )
            return {
                "ok": True,
                "message": "共通マスターを保存しました。",
                "master": master,
                "revision": new_revision,
            }
        except CommonMasterConflictError:
            return {
                "ok": False,
                "conflict": True,
                "message": "別のユーザーが更新しています。再読み込みしてから修正してください。",
            }
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except Exception:
            logger.exception("Failed to save common master")
            return {"ok": False, "message": "共通マスターの保存に失敗しました。"}

    def save_user_administration(self, payload: Any) -> dict[str, Any]:
        try:
            if not self._is_admin():
                return self._admin_access_denied()
            access_denied = self._registered_employee_access_denied()
            if access_denied:
                return access_denied
            if isinstance(payload, dict) and "teams" in payload:
                teams, users, revisions = validate_administration_save_request(payload)
            else:
                users, revisions = validate_user_administration_save_request(payload)
                teams = None
            if not self._settings.is_complete:
                return {"ok": False, "message": "ネットワークFSパスが未設定です。"}
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            if teams is None:
                validate_user_team_references(
                    users, repo.load_common_masters().get("team_master", [])
                )
            new_revisions = (
                repo.save_administration(teams, users, revisions)
                if teams is not None
                else repo.save_user_administration(users, revisions)
            )
            return {
                "ok": True,
                "message": "組織・ユーザー情報を保存しました。",
                "revisions": new_revisions,
            }
        except CommonMasterConflictError:
            return {
                "ok": False,
                "conflict": True,
                "message": "別のユーザーが更新しています。再読み込みしてから修正してください。",
            }
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except Exception:
            logger.exception("Failed to save user administration")
            return {"ok": False, "message": "ユーザー管理データの保存に失敗しました。"}

    def save_updates(self, payload: Any) -> dict[str, Any]:
        try:
            user_updates, comment_updates = validate_save_request(payload)
            if not self._settings.is_complete:
                return {"ok": False, "message": "ネットワークFSパスが未設定です。"}
            access_denied = self._registered_employee_access_denied()
            if access_denied:
                return {**access_denied, "no_targets": False}
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            result = repo.save_updates(self._employee_id, user_updates, comment_updates)
            targets = [value for value in result.values() if value.get("needed")]
            return {
                "ok": bool(targets) and all(value.get("saved") for value in targets),
                "no_targets": not targets,
                "result": result,
            }
        except RequestValidationError as exc:
            return {
                **self._invalid_request(exc),
                "no_targets": False,
            }
        except PermissionError:
            logger.warning("Rejected an unauthorized save request", exc_info=True)
            return {
                "ok": False,
                "no_targets": False,
                "message": "この更新を保存する権限がありません。",
            }
        except Exception:
            logger.exception("Failed to save daily report updates")
            return {
                "ok": False,
                "no_targets": False,
                "message": "更新処理に失敗しました。",
            }

    @staticmethod
    def _invalid_request(exc: RequestValidationError) -> dict[str, Any]:
        return {
            "ok": False,
            "message": f"入力内容を確認してください。{exc}",
        }

    @staticmethod
    def _admin_access_denied() -> dict[str, Any]:
        return {
            "ok": False,
            "forbidden": True,
            "message": "管理者機能を利用する権限がありません。",
        }

    @staticmethod
    def _employee_access_denied() -> dict[str, Any]:
        return {
            "ok": False,
            "access_denied": True,
            "employee_registered": False,
            "message": UNREGISTERED_EMPLOYEE_MESSAGE,
        }

    def _registered_employee_access_denied(
        self, repo: DailyReportRepository | None = None
    ) -> dict[str, Any] | None:
        if not self._settings.is_complete:
            return None
        if not self._is_employee_registered(repo):
            return self._employee_access_denied()
        return None

    def _is_employee_registered(
        self, repo: DailyReportRepository | None = None
    ) -> bool:
        return self._current_user_master_row(repo) is not None

    def _current_user_master_row(
        self, repo: DailyReportRepository | None = None
    ) -> dict[str, Any] | None:
        repository = repo or DailyReportRepository(self._settings, self._base_dir)
        if repo is None:
            repository.validate_paths()
        employee_id = str(self._employee_id or "").strip()
        if not employee_id:
            return None
        common = repository.load_common()
        return next(
            (
                row
                for row in common.get("user_master", [])
                if str(row.get("employee_id", "")).strip() == employee_id
            ),
            None,
        )

    def _is_admin(self) -> bool:
        if not self._settings.is_complete:
            return False
        try:
            user = self._current_user_master_row()
        except Exception:
            logger.exception("Failed to check administrator permission")
            return False
        return bool(
            user
            and str(user.get("employment_type", "")).strip() == "regular"
            and str(user.get("is_admin", "")).strip() == "1"
        )

    def _validated_font_size(self, value: Any) -> str:
        font_size = str(value or "large").strip()
        return (
            font_size
            if font_size in {"compact", "standard", "medium", "large", "xlarge"}
            else "large"
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
