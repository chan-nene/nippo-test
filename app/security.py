from __future__ import annotations

import os
import re
from collections.abc import Mapping
from datetime import date
from pathlib import Path, PureWindowsPath
from typing import Any

MAX_DATE_RANGE_DAYS = 366
MAX_UPDATES_PER_TYPE = 1_000
MAX_REPLIES_PER_REPORT = 100
MAX_TEXT_LENGTH = 20_000
MAX_EMPLOYEE_ID_LENGTH = 128
MAX_PATH_LENGTH = 4_096
MAX_IME_DIAGNOSTIC_EVENTS = 200

IME_DIAGNOSTIC_EVENT_NAMES = frozenset(
    {
        "editor_open",
        "focus",
        "blur",
        "composition_start",
        "composition_update",
        "composition_end",
        "before_input",
        "input_deferred",
        "input_applied",
        "chrome_sync",
        "native_unsaved_sync",
        "keydown_ignored",
        "keydown_handled",
        "editor_finish",
        "buffer_dropped",
    }
)
IME_DIAGNOSTIC_EDITOR_KINDS = frozenset({"", "report", "reply", "comment"})
IME_DIAGNOSTIC_KEYS = frozenset(
    {"", "Enter", "Escape", "Tab", "Process", "Unidentified", "IME"}
)
IME_DIAGNOSTIC_REASONS = frozenset(
    {"", "initial", "input", "composition_end", "finish", "enter", "tab", "escape"}
)

PERIOD_PRESETS = frozenset(
    {
        "",
        "default",
        "month",
        "week",
        "day",
        "previousWorkday",
        "today",
        "previousWeek",
        "thisWeek",
        "previousMonth",
        "thisMonth",
        "missing",
    }
)

_ISO_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
_INVALID_WINDOWS_FILENAME_CHARS = frozenset('<>:"/\\|?*')


class RequestValidationError(ValueError):
    """An expected rejection of data received from the WebView boundary."""


def require_request_mapping(payload: Any, label: str = "リクエスト") -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        raise RequestValidationError(f"{label}の形式が不正です。")
    return payload


def validate_load_request(payload: Any | None) -> dict[str, str | None]:
    if payload is None:
        source: Mapping[str, Any] = {}
    else:
        source = require_request_mapping(payload)
    _reject_unknown_keys(source, {"start_date", "end_date", "period_preset"})

    start_date = _optional_iso_date(source.get("start_date"), "開始日")
    end_date = _optional_iso_date(source.get("end_date"), "終了日")
    if bool(start_date) != bool(end_date):
        raise RequestValidationError("開始日と終了日は両方指定してください。")
    if start_date and end_date:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
        if start > end:
            raise RequestValidationError("開始日は終了日以前にしてください。")
        if (end - start).days + 1 > MAX_DATE_RANGE_DAYS:
            raise RequestValidationError(
                f"表示期間は{MAX_DATE_RANGE_DAYS}日以内にしてください。"
            )

    preset_value = source.get("period_preset")
    if preset_value is None:
        period_preset = None
    elif not isinstance(preset_value, str):
        raise RequestValidationError("表示期間の指定が不正です。")
    else:
        period_preset = preset_value.strip()
        if period_preset == "last7days":
            period_preset = "default"
        if period_preset not in PERIOD_PRESETS:
            raise RequestValidationError("表示期間の指定が不正です。")
        period_preset = period_preset or None

    return {
        "start_date": start_date,
        "end_date": end_date,
        "period_preset": period_preset,
    }


def validate_save_request(
    payload: Any,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    source = require_request_mapping(payload)
    _reject_unknown_keys(source, {"user_updates", "comment_updates"})
    user_updates = _validate_update_list(
        source.get("user_updates", []), "日報更新", _validate_user_update
    )
    comment_updates = _validate_update_list(
        source.get("comment_updates", []), "コメント更新", _validate_comment_update
    )

    _reject_duplicate_values(
        [update["date"] for update in user_updates], "同じ日付の日報更新が重複しています。"
    )
    _reject_duplicate_values(
        [
            (update["subordinate_employee_id"], update["date"])
            for update in comment_updates
        ],
        "同じ対象者・日付のコメント更新が重複しています。",
    )
    return user_updates, comment_updates


def validate_employee_id(value: Any, label: str = "社員ID") -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label}が不正です。")
    employee_id = value.strip()
    if employee_id != value or not employee_id:
        raise ValueError(f"{label}が不正です。")
    if len(employee_id) > MAX_EMPLOYEE_ID_LENGTH:
        raise ValueError(f"{label}が長すぎます。")
    if employee_id in {".", ".."} or employee_id[-1] in {".", " "}:
        raise ValueError(f"{label}が不正です。")
    if any(
        ord(character) < 32 or character in _INVALID_WINDOWS_FILENAME_CHARS
        for character in employee_id
    ):
        raise ValueError(f"{label}が不正です。")
    filename = f"{employee_id}.csv"
    is_reserved = getattr(os.path, "isreserved", None)
    if (
        is_reserved(filename)
        if is_reserved is not None
        else PureWindowsPath(filename).is_reserved()
    ):
        raise ValueError(f"{label}が不正です。")
    return employee_id


def safe_employee_csv_path(directory: Path | str, employee_id: Any) -> Path:
    root = Path(directory).resolve()
    safe_id = validate_employee_id(employee_id)
    candidate = (root / f"{safe_id}.csv").resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("社員IDから安全な保存先を作成できません。") from exc
    return candidate


def validate_settings_request(payload: Any) -> Mapping[str, Any]:
    source = require_request_mapping(payload, "設定")
    _reject_unknown_keys(
        source,
        {
            "users_dir",
            "comments_dir",
            "common_dir",
            "default_start_offset_days",
            "default_end_offset_days",
            "missing_comment_start_date",
            "include_today_in_missing_comments",
            "comment_signature",
            "ui_color_theme",
        },
    )
    for key in ("users_dir", "comments_dir", "common_dir"):
        _bounded_string(source.get(key, ""), key, MAX_PATH_LENGTH)
    _bounded_string(source.get("comment_signature", ""), "サイン", 100)
    _optional_iso_date(
        source.get("missing_comment_start_date"), "未コメント確認の開始日"
    )
    _bounded_int(source.get("default_start_offset_days", -1), -14, 0, "開始日")
    _bounded_int(source.get("default_end_offset_days", 0), 0, 7, "終了日")
    include_today = source.get("include_today_in_missing_comments", False)
    if not isinstance(include_today, bool):
        raise RequestValidationError("当日を含める設定が不正です。")
    color_theme = source.get("ui_color_theme", "green")
    if not isinstance(color_theme, str) or color_theme not in {
        "green",
        "blue",
        "orange",
    }:
        raise RequestValidationError("配色の指定が不正です。")
    return source


def validate_ui_state_request(payload: Any) -> Mapping[str, Any]:
    source = require_request_mapping(payload, "表示状態")
    _reject_unknown_keys(
        source, {"sidebar_open", "period_preset", "start_date", "end_date", "font_size"}
    )
    validate_load_request(
        {
            "period_preset": source.get("period_preset"),
            "start_date": source.get("start_date"),
            "end_date": source.get("end_date"),
        }
    )
    if "sidebar_open" in source and not isinstance(source["sidebar_open"], bool):
        raise RequestValidationError("サイドバーの表示状態が不正です。")
    font_size = source.get("font_size", "standard")
    if not isinstance(font_size, str) or font_size not in {
        "standard",
        "large",
        "xlarge",
    }:
        raise RequestValidationError("文字サイズの指定が不正です。")
    return source


def validate_ime_diagnostic_request(payload: Any) -> dict[str, Any]:
    source = require_request_mapping(payload, "IME診断ログ")
    _reject_unknown_keys(source, {"client", "events"})

    client_source = require_request_mapping(source.get("client", {}), "実行環境")
    _reject_unknown_keys(client_source, {"user_agent", "language"})
    client = {
        "user_agent": _bounded_string(
            client_source.get("user_agent", ""), "ブラウザー情報", 512
        ),
        "language": _bounded_string(
            client_source.get("language", ""), "言語情報", 32
        ),
    }

    event_values = source.get("events")
    if not isinstance(event_values, list) or not event_values:
        raise RequestValidationError("IME診断イベントの形式が不正です。")
    if len(event_values) > MAX_IME_DIAGNOSTIC_EVENTS:
        raise RequestValidationError("IME診断イベントの件数が多すぎます。")
    return {
        "client": client,
        "events": [
            _validate_ime_diagnostic_event(value, index)
            for index, value in enumerate(event_values)
        ],
    }


def _validate_ime_diagnostic_event(value: Any, index: int) -> dict[str, Any]:
    source = require_request_mapping(value, f"IME診断イベント{index + 1}件目")
    allowed_keys = {
        "sequence",
        "elapsed_ms",
        "name",
        "editor_id",
        "composition_id",
        "editor_kind",
        "input_type",
        "key",
        "reason",
        "composing",
        "event_composing",
        "focused",
        "connected",
        "deferred",
        "default_prevented",
        "value_length",
        "data_length",
        "selection_start",
        "selection_end",
        "height_px",
        "dropped_count",
    }
    _reject_unknown_keys(source, allowed_keys)
    name = source.get("name")
    if not isinstance(name, str) or name not in IME_DIAGNOSTIC_EVENT_NAMES:
        raise RequestValidationError("IME診断イベント名が不正です。")

    event: dict[str, Any] = {
        "sequence": _strict_int(source.get("sequence"), 1, 10_000_000, "連番"),
        "elapsed_ms": _strict_int(
            source.get("elapsed_ms"), 0, 2_147_483_647, "経過時間"
        ),
        "name": name,
    }
    for key, minimum, maximum, label in (
        ("editor_id", 0, 1_000_000, "エディタ番号"),
        ("composition_id", 0, 1_000_000, "変換番号"),
        ("value_length", 0, MAX_TEXT_LENGTH, "入力文字数"),
        ("data_length", 0, MAX_TEXT_LENGTH, "イベント文字数"),
        ("selection_start", -1, MAX_TEXT_LENGTH, "選択開始位置"),
        ("selection_end", -1, MAX_TEXT_LENGTH, "選択終了位置"),
        ("height_px", 0, 100_000, "入力欄の高さ"),
        ("dropped_count", 0, 100_000, "破棄イベント数"),
    ):
        if key in source:
            event[key] = _strict_int(source[key], minimum, maximum, label)
    for key, label in (
        ("composing", "変換状態"),
        ("event_composing", "イベント変換状態"),
        ("focused", "フォーカス状態"),
        ("connected", "DOM接続状態"),
        ("deferred", "保留状態"),
        ("default_prevented", "既定動作状態"),
    ):
        if key in source:
            if not isinstance(source[key], bool):
                raise RequestValidationError(f"{label}が不正です。")
            event[key] = source[key]

    editor_kind = source.get("editor_kind", "")
    key_name = source.get("key", "")
    reason = source.get("reason", "")
    if editor_kind not in IME_DIAGNOSTIC_EDITOR_KINDS:
        raise RequestValidationError("エディタ種別が不正です。")
    if key_name not in IME_DIAGNOSTIC_KEYS:
        raise RequestValidationError("キー情報が不正です。")
    if reason not in IME_DIAGNOSTIC_REASONS:
        raise RequestValidationError("IME診断理由が不正です。")
    input_type = _bounded_string(source.get("input_type", ""), "入力種別", 64)
    if input_type and not re.fullmatch(r"[A-Za-z0-9_-]+", input_type):
        raise RequestValidationError("入力種別が不正です。")
    event.update(
        {
            "editor_kind": editor_kind,
            "input_type": input_type,
            "key": key_name,
            "reason": reason,
        }
    )
    return event


def _validate_update_list(value: Any, label: str, validator: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise RequestValidationError(f"{label}の形式が不正です。")
    if len(value) > MAX_UPDATES_PER_TYPE:
        raise RequestValidationError(f"{label}の件数が多すぎます。")
    return [validator(item, index) for index, item in enumerate(value)]


def _validate_user_update(value: Any, index: int) -> dict[str, Any]:
    source = require_request_mapping(value, f"日報更新{index + 1}件目")
    _reject_unknown_keys(source, {"date", "business_name", "business_detail", "replies"})
    if "date" not in source:
        raise RequestValidationError("日報更新の日付がありません。")
    if not any(key in source for key in ("business_name", "business_detail", "replies")):
        raise RequestValidationError("日報更新の内容がありません。")

    update: dict[str, Any] = {"date": _required_iso_date(source["date"], "日報の日付")}
    for key, label in (
        ("business_name", "業務名"),
        ("business_detail", "業務内容"),
    ):
        if key in source:
            update[key] = _bounded_string(source[key], label, MAX_TEXT_LENGTH)

    if "replies" in source:
        replies_value = source["replies"]
        if not isinstance(replies_value, list):
            raise RequestValidationError("返信の形式が不正です。")
        if len(replies_value) > MAX_REPLIES_PER_REPORT:
            raise RequestValidationError("返信の件数が多すぎます。")
        replies: list[dict[str, str]] = []
        seen_superiors: set[str] = set()
        for reply_index, reply_value in enumerate(replies_value):
            reply_source = require_request_mapping(
                reply_value, f"返信{reply_index + 1}件目"
            )
            _reject_unknown_keys(reply_source, {"superior_employee_id", "reply"})
            if "superior_employee_id" not in reply_source or "reply" not in reply_source:
                raise RequestValidationError("返信の必須項目がありません。")
            try:
                superior_id = validate_employee_id(
                    reply_source["superior_employee_id"], "返信先の上司ID"
                )
            except ValueError as exc:
                raise RequestValidationError(str(exc)) from exc
            if superior_id in seen_superiors:
                raise RequestValidationError("同じ上司への返信が重複しています。")
            seen_superiors.add(superior_id)
            replies.append(
                {
                    "superior_employee_id": superior_id,
                    "reply": _bounded_string(
                        reply_source["reply"], "返信", MAX_TEXT_LENGTH
                    ),
                }
            )
        update["replies"] = replies
    return update


def _validate_comment_update(value: Any, index: int) -> dict[str, Any]:
    source = require_request_mapping(value, f"コメント更新{index + 1}件目")
    _reject_unknown_keys(source, {"subordinate_employee_id", "date", "comment"})
    if not all(key in source for key in ("subordinate_employee_id", "date", "comment")):
        raise RequestValidationError("コメント更新の必須項目がありません。")
    try:
        subordinate_id = validate_employee_id(
            source["subordinate_employee_id"], "コメント対象者ID"
        )
    except ValueError as exc:
        raise RequestValidationError(str(exc)) from exc
    return {
        "subordinate_employee_id": subordinate_id,
        "date": _required_iso_date(source["date"], "コメントの日付"),
        "comment": _bounded_string(source["comment"], "コメント", MAX_TEXT_LENGTH),
    }


def _bounded_string(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise RequestValidationError(f"{label}は文字列で指定してください。")
    if len(value) > maximum:
        raise RequestValidationError(f"{label}が長すぎます。")
    return value


def _bounded_int(value: Any, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool):
        raise RequestValidationError(f"{label}の指定が不正です。")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise RequestValidationError(f"{label}の指定が不正です。") from exc
    if str(number) != str(value).strip() or not minimum <= number <= maximum:
        raise RequestValidationError(f"{label}の指定が範囲外です。")
    return number


def _strict_int(value: Any, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RequestValidationError(f"{label}が不正です。")
    if not minimum <= value <= maximum:
        raise RequestValidationError(f"{label}が範囲外です。")
    return value


def _optional_iso_date(value: Any, label: str) -> str | None:
    if value is None or value == "":
        return None
    return _required_iso_date(value, label)


def _required_iso_date(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ISO_DATE_PATTERN.fullmatch(value):
        raise RequestValidationError(f"{label}が不正です。")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise RequestValidationError(f"{label}が不正です。") from exc
    return parsed.isoformat()


def _reject_unknown_keys(source: Mapping[str, Any], allowed: set[str]) -> None:
    if any(not isinstance(key, str) or key not in allowed for key in source):
        raise RequestValidationError("未対応の入力項目が含まれています。")


def _reject_duplicate_values(values: list[Any], message: str) -> None:
    if len(values) != len(set(values)):
        raise RequestValidationError(message)
