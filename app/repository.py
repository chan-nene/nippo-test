from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import polars as pl

from app.config import AppSettings

JST = ZoneInfo("Asia/Tokyo")

USER_COLUMNS = [
    "employee_id",
    "date",
    "business_name",
    "business_detail",
    "replies",
    "updated_at",
]
COMMENT_COLUMNS = [
    "superior_employee_id",
    "subordinate_employee_id",
    "date",
    "comment",
    "updated_at",
]


class DailyReportRepository:
    def __init__(self, settings: AppSettings, base_dir: Path) -> None:
        self.settings = settings
        self.base_dir = base_dir
        self.load_warnings: list[dict[str, str]] = []

    @staticmethod
    def now_jst() -> datetime:
        return datetime.now(JST).replace(tzinfo=None)

    @staticmethod
    def today_jst() -> date:
        return datetime.now(JST).date()

    def validate_paths(self) -> None:
        for label in ("users_dir", "comments_dir", "common_dir"):
            raw_path = str(getattr(self.settings, label, "")).strip()
            path = Path(raw_path)
            if not path.exists():
                raise FileNotFoundError(f"{label} が存在しません: {raw_path}")
            if not path.is_dir():
                raise NotADirectoryError(
                    f"{label} はディレクトリではありません: {raw_path}"
                )

    def load_common(self) -> dict[str, list[dict[str, Any]]]:
        common_dir = Path(self.settings.common_dir)
        data = {
            "superior_config": self._read_csv(common_dir / "superior_config.csv"),
            "superior_master": self._read_csv(common_dir / "superior_master.csv"),
            "user_master": self._read_csv(common_dir / "user_master.csv"),
            "calendar": self._read_csv(common_dir / "calendar.csv"),
        }
        return data

    def _read_csv(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            self._record_load_warning(path, FileNotFoundError("ファイルがありません"))
            return []
        errors: list[str] = []
        for encoding in ("utf8-lossy", "cp932"):
            try:
                df = pl.read_csv(
                    path, infer_schema_length=0, encoding=encoding
                ).fill_null("")
                return [dict(row) for row in df.to_dicts()]
            except Exception as exc:
                errors.append(f"{encoding}: {exc}")
                continue
        self._record_load_warning(path, RuntimeError(" / ".join(errors)))
        return []

    def _record_load_warning(self, path: Path, error: Exception) -> None:
        warning = {"file": path.name, "error": str(error)}
        self.load_warnings.append(warning)
        try:
            log_dir = self.base_dir / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            timestamp = self.now_jst().isoformat(timespec="seconds")
            with (log_dir / "daily_report.log").open("a", encoding="utf-8") as log:
                log.write(f"{timestamp} CSV読み込み失敗: {path} - {error}\n")
        except Exception:
            # ログ出力失敗によって、読み込めたデータの表示まで止めない。
            pass

    def load_view_data(
        self,
        employee_id: str,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any]:
        common = self.load_common()
        user_master = {row.get("employee_id", ""): row for row in common["user_master"]}
        my_display = user_master.get(employee_id, {}).get("display_name") or employee_id

        is_superior = any(
            row.get("superior_employee_id") == employee_id
            for row in common["superior_config"]
        )
        subordinate_ids = [
            row.get("subordinate_employee_id", "")
            for row in common["superior_config"]
            if row.get("superior_employee_id") == employee_id
        ]
        if employee_id not in subordinate_ids:
            subordinate_ids.append(employee_id)

        users_df = self._load_all_user_rows(
            employee_id, subordinate_ids if is_superior else [employee_id]
        )
        comments_df = self._load_all_comment_rows()
        rows, default_start, default_end = self._build_rows(
            users_df,
            comments_df,
            common,
            employee_id,
            is_superior,
            subordinate_ids if is_superior else [employee_id],
            start_date,
            end_date,
        )
        return {
            "employee_id": employee_id,
            "display_name": my_display,
            "is_superior": is_superior,
            "rows": rows,
            "common": common,
            "my_rank": self._get_my_rank(common, employee_id),
            "start_date": default_start.isoformat() if default_start else None,
            "end_date": default_end.isoformat() if default_end else None,
            "load_warning_count": len(self.load_warnings),
        }

    def _get_my_rank(self, common: dict[str, Any], employee_id: str) -> int:
        for row in common["superior_master"]:
            if row.get("employee_id") == employee_id:
                try:
                    return int(row.get("rank") or 9999)
                except ValueError:
                    return 9999
        return 0

    def save_updates(
        self,
        employee_id: str,
        user_updates: list[dict[str, Any]],
        comment_updates: list[dict[str, Any]],
    ) -> dict[str, Any]:
        result = {
            "user": {
                "needed": bool(user_updates),
                "local_saved": False,
                "uploaded": False,
                "error": "",
            },
            "comment": {
                "needed": bool(comment_updates),
                "local_saved": False,
                "uploaded": False,
                "error": "",
            },
        }
        if user_updates:
            try:
                self._upsert_user_rows(employee_id, user_updates)
                result["user"]["local_saved"] = True
                result["user"]["uploaded"] = True
            except Exception as exc:
                result["user"]["error"] = str(exc)

        if comment_updates:
            try:
                self._upsert_comment_rows(employee_id, comment_updates)
                result["comment"]["local_saved"] = True
                result["comment"]["uploaded"] = True
            except Exception as exc:
                result["comment"]["error"] = str(exc)

        return result

    def _load_all_user_rows(
        self, current_employee_id: str, allowed_employee_ids: list[str]
    ) -> pl.DataFrame:
        rows: list[dict[str, Any]] = []
        users_dir = Path(self.settings.users_dir)
        files = list(users_dir.glob("*.csv")) if users_dir.exists() else []
        for file in files:
            try:
                rows.extend(
                    self._normalize_rows(pl.read_csv(file).to_dicts(), USER_COLUMNS)
                )
            except Exception as exc:
                self._record_load_warning(file, exc)

        if allowed_employee_ids:
            rows = [
                row
                for row in rows
                if str(row.get("employee_id", "")) in allowed_employee_ids
            ]
        return self._dedupe_rows_to_df(rows, USER_COLUMNS, ["employee_id", "date"])

    def _load_all_comment_rows(self) -> pl.DataFrame:
        rows: list[dict[str, Any]] = []
        comments_dir = Path(self.settings.comments_dir)
        files = list(comments_dir.glob("*.csv")) if comments_dir.exists() else []
        for file in files:
            try:
                rows.extend(
                    self._normalize_rows(pl.read_csv(file).to_dicts(), COMMENT_COLUMNS)
                )
            except Exception as exc:
                self._record_load_warning(file, exc)

        return self._dedupe_rows_to_df(
            rows,
            COMMENT_COLUMNS,
            ["superior_employee_id", "subordinate_employee_id", "date"],
        )

    def _build_rows(
        self,
        users_df: pl.DataFrame,
        comments_df: pl.DataFrame,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        is_superior: bool,
        target_employee_ids: list[str],
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> tuple[list[dict[str, Any]], date | None, date | None]:
        user_master = {row.get("employee_id", ""): row for row in common["user_master"]}
        calendar = {row.get("date", ""): row for row in common["calendar"]}
        superior_ranks: dict[str, int] = {}
        for row in common["superior_master"]:
            sid = row.get("employee_id", "")
            if sid:
                try:
                    superior_ranks[sid] = int(row.get("rank") or 9999)
                except ValueError:
                    superior_ranks[sid] = 9999
        superior_ids = sorted(
            superior_ranks.keys(),
            key=lambda item: superior_ranks.get(item, 9999),
            reverse=False,
        )
        if not superior_ids and comments_df.height:
            superior_ids = sorted(
                {
                    str(row.get("superior_employee_id", ""))
                    for row in comments_df.to_dicts()
                    if row.get("superior_employee_id")
                }
            )

        today = self.today_jst()

        default_start = self._to_date(start_date)
        default_end = self._to_date(end_date)
        if not default_start:
            default_start = today + timedelta(
                days=self.settings.default_start_offset_days
            )
        if not default_end:
            default_end = today + timedelta(days=self.settings.default_end_offset_days)
        if default_start > default_end:
            default_start, default_end = default_end, default_start

        comment_map: dict[tuple[str, str, date], str] = {}
        for row in comments_df.to_dicts():
            d = self._to_date(row.get("date"))
            if d:
                comment_map[
                    (
                        str(row.get("superior_employee_id", "")),
                        str(row.get("subordinate_employee_id", "")),
                        d,
                    )
                ] = str(row.get("comment", "") or "")

        def build_view_row(
            target_employee_id: str, d: date, source_row: dict[str, Any] | None = None
        ) -> dict[str, Any]:
            date_text = d.isoformat()
            replies = self._parse_replies(
                source_row.get("replies", "[]") if source_row else "[]"
            )
            comment_cells = []
            for superior_id in superior_ids:
                comment_cells.append(
                    {
                        "superior_employee_id": superior_id,
                        "superior_name": user_master.get(superior_id, {}).get(
                            "display_name"
                        )
                        or superior_id,
                        "comment": comment_map.get(
                            (superior_id, target_employee_id, d), ""
                        ),
                        "reply": replies.get(superior_id, ""),
                        "editable": is_superior and superior_id == employee_id,
                        "rank": superior_ranks.get(superior_id, 9999),
                    }
                )
            cal = calendar.get(date_text, {})
            return {
                "employee_id": target_employee_id,
                "display_name": user_master.get(target_employee_id, {}).get(
                    "display_name"
                )
                or target_employee_id,
                "date": date_text,
                "business_name": str((source_row or {}).get("business_name") or ""),
                "business_detail": str(
                    (source_row or {}).get("business_detail") or ""
                ),
                "is_holiday": str(cal.get("is_holiday", "0")) == "1",
                "holiday_description": cal.get("description", ""),
                "is_today": d == today,
                "can_edit_report": target_employee_id == employee_id,
                "comments": comment_cells,
            }

        view_rows = []
        present_keys: set[tuple[str, date]] = set()
        for row in users_df.to_dicts():
            d = self._to_date(row.get("date"))
            if not d or d < default_start or d > default_end:
                continue
            target_employee_id = str(row.get("employee_id", ""))
            present_keys.add((target_employee_id, d))
            view_rows.append(build_view_row(target_employee_id, d, row))

        target_ids = [eid for eid in dict.fromkeys(target_employee_ids) if eid]
        days = (default_end - default_start).days
        for target_employee_id in target_ids:
            for offset in range(days + 1):
                d = default_start + timedelta(days=offset)
                if (target_employee_id, d) not in present_keys:
                    view_rows.append(build_view_row(target_employee_id, d))
        view_rows.sort(
            key=lambda item: (item["date"], item["employee_id"]), reverse=False
        )
        return view_rows, default_start, default_end

    def _parse_replies(self, raw: Any) -> dict[str, str]:
        try:
            values = json.loads(raw or "[]")
            return {
                str(item.get("superior_employee_id", "")): str(item.get("reply", ""))
                for item in values
                if item.get("superior_employee_id")
            }
        except Exception:
            return {}

    def _upsert_user_rows(
        self, employee_id: str, updates: list[dict[str, Any]]
    ) -> None:
        user_path = Path(self.settings.users_dir) / f"{employee_id}.csv"
        rows = self._read_csv_or_empty(user_path, USER_COLUMNS).to_dicts()
        existing = self._dedupe_rows(rows, ["employee_id", "date"])
        replies_by_date = {
            self._date_key(row.get("date")): self._parse_replies(
                row.get("replies", "[]")
            )
            for row in existing
        }
        now = self.now_jst()
        for update in updates:
            date_text = str(update.get("date", ""))
            replies = replies_by_date.get(date_text, {})
            for reply_item in update.get("replies", []) or []:
                sid = str(reply_item.get("superior_employee_id", ""))
                if sid:
                    replies[sid] = str(reply_item.get("reply", ""))
            rows.append(
                {
                    "employee_id": employee_id,
                    "date": self._to_date(date_text),
                    "business_name": str(update.get("business_name", "")),
                    "business_detail": str(update.get("business_detail", "")),
                    "replies": json.dumps(
                        [
                            {"superior_employee_id": key, "reply": value}
                            for key, value in replies.items()
                        ],
                        ensure_ascii=False,
                    ),
                    "updated_at": now,
                }
            )
        df = self._dedupe_rows_to_df(rows, USER_COLUMNS, ["employee_id", "date"])
        self._write_csv_atomically(df, user_path, "users")

    def _upsert_comment_rows(
        self, employee_id: str, updates: list[dict[str, Any]]
    ) -> None:
        comment_path = Path(self.settings.comments_dir) / f"{employee_id}.csv"
        rows = self._read_csv_or_empty(comment_path, COMMENT_COLUMNS).to_dicts()
        now = self.now_jst()
        for update in updates:
            rows.append(
                {
                    "superior_employee_id": employee_id,
                    "subordinate_employee_id": str(
                        update.get("subordinate_employee_id", "")
                    ),
                    "date": self._to_date(str(update.get("date", ""))),
                    "comment": str(update.get("comment", "")),
                    "updated_at": now,
                }
            )
        df = self._dedupe_rows_to_df(
            rows,
            COMMENT_COLUMNS,
            ["superior_employee_id", "subordinate_employee_id", "date"],
        )
        self._write_csv_atomically(df, comment_path, "comments")

    def _write_csv_atomically(
        self, df: pl.DataFrame, target_path: Path, backup_group: str
    ) -> None:
        """Write a CSV completely, then replace the destination in one operation."""
        target_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{target_path.stem}.",
                suffix=".tmp",
                dir=target_path.parent,
                delete=False,
            ) as temporary:
                temp_path = Path(temporary.name)

            df.write_csv(temp_path)
            with temp_path.open("rb+") as completed_file:
                os.fsync(completed_file.fileno())

            if target_path.exists():
                backup_dir = self.base_dir / "cache" / "csv_backups" / backup_group
                backup_dir.mkdir(parents=True, exist_ok=True)
                timestamp = self.now_jst().strftime("%Y%m%d_%H%M%S_%f")
                backup_path = backup_dir / f"{target_path.stem}_{timestamp}.csv"
                shutil.copy2(target_path, backup_path)

            os.replace(temp_path, target_path)
            temp_path = None
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    def _read_csv_or_empty(self, path: Path, columns: list[str]) -> pl.DataFrame:
        if not path.exists():
            return self._empty_df(columns)
        return self._ensure_columns(pl.read_csv(path), columns)

    def _empty_user_df(self) -> pl.DataFrame:
        return self._empty_df(USER_COLUMNS)

    def _empty_comment_df(self) -> pl.DataFrame:
        return self._empty_df(COMMENT_COLUMNS)

    def _empty_df(self, columns: list[str]) -> pl.DataFrame:
        return pl.DataFrame({column: [] for column in columns})

    def _ensure_columns(self, df: pl.DataFrame, columns: list[str]) -> pl.DataFrame:
        for column in columns:
            if column not in df.columns:
                df = df.with_columns(
                    pl.lit("[]" if column == "replies" else "").alias(column)
                )
        return df.select(columns)

    def _normalize_rows(
        self, rows: list[dict[str, Any]], columns: list[str]
    ) -> list[dict[str, Any]]:
        normalized = []
        for row in rows:
            normalized.append(
                {
                    column: row.get(column, "[]" if column == "replies" else "")
                    for column in columns
                }
            )
        return normalized

    def _dedupe_rows_to_df(
        self, rows: list[dict[str, Any]], columns: list[str], keys: list[str]
    ) -> pl.DataFrame:
        deduped = self._dedupe_rows(self._normalize_rows(rows, columns), keys)
        return (
            pl.DataFrame(deduped, schema=columns, orient="row")
            if deduped
            else self._empty_df(columns)
        )

    def _dedupe_rows(
        self, rows: list[dict[str, Any]], keys: list[str]
    ) -> list[dict[str, Any]]:
        latest: dict[tuple[Any, ...], dict[str, Any]] = {}
        for row in rows:
            for column in USER_COLUMNS + COMMENT_COLUMNS:
                if column == "replies":
                    row.setdefault(column, "[]")
                elif column not in row:
                    row[column] = ""

            dt = self._to_datetime(row.get("updated_at")) or self.now_jst()
            row["updated_at"] = dt.isoformat()
            row["date"] = self._date_key(row.get("date"))

            key = tuple(
                self._date_key(row.get(column))
                if column == "date"
                else str(row.get(column, ""))
                for column in keys
            )
            current = latest.get(key)
            if current is None or row["updated_at"] >= current["updated_at"]:
                latest[key] = row
        return list(latest.values())

    def _to_date(self, value: Any) -> date | None:
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        if isinstance(value, datetime):
            return value.date()
        if value is None or value == "":
            return None
        try:
            return datetime.fromisoformat(str(value)[:10]).date()
        except Exception:
            return None

    def _to_datetime(self, value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value.replace(tzinfo=None)
        if isinstance(value, date):
            return datetime.combine(value, datetime.min.time())
        if value is None or value == "":
            return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(
                tzinfo=None
            )
        except Exception:
            return None

    def _date_key(self, value: Any) -> str:
        d = self._to_date(value)
        return d.isoformat() if d else ""

