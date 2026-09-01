from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import polars as pl

from app.calendar_policy import DEFAULT_MISSING_COMMENT_START_DATE
from app.config import AppSettings, validate_settings_paths
from app.security import (
    COMMON_MASTER_COLUMNS,
    LEGACY_COMMON_MASTER_COLUMNS,
    USER_MASTER_DEFAULTS,
    safe_employee_csv_path,
    validate_employee_id,
)


logger = logging.getLogger(__name__)

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
CSV_ENCODINGS = ("utf8", "cp932")
DEFAULT_BACKUP_LIMIT = 20


class CommonMasterConflictError(RuntimeError):
    """The common CSV changed after it was loaded in the admin screen."""


class DailyReportRepository:
    def __init__(self, settings: AppSettings, base_dir: Path) -> None:
        self.settings = settings
        self.base_dir = base_dir
        self.load_warnings: list[dict[str, str]] = []
        self.backup_limit = DEFAULT_BACKUP_LIMIT
        self.legacy_rank_migration_required = False
        self.commenter_assignment_migration_required = False
        self.organization_schema_migration_required = False
        self.organization_migration_preview: dict[str, Any] = {}
        self.calendar_migration_required = False

    @staticmethod
    def now_jst() -> datetime:
        return datetime.now(JST).replace(tzinfo=None)

    @staticmethod
    def today_jst() -> date:
        return datetime.now(JST).date()

    def validate_paths(self) -> None:
        errors = validate_settings_paths(self.settings)
        if errors:
            raise ValueError(" / ".join(errors.values()))

    def load_common(self) -> dict[str, list[dict[str, Any]]]:
        common_dir = Path(self.settings.common_dir)
        users, teams, assignments, schema_mode = self._load_organization_masters(
            common_dir
        )
        return {
            "user_master": users,
            "team_master": teams,
            "comment_assignment": assignments,
            "calendar": self._load_calendar(common_dir),
            "organization_schema": [{"mode": schema_mode}],
        }

    def load_common_masters(self) -> dict[str, list[dict[str, Any]]]:
        common_dir = Path(self.settings.common_dir)
        users, teams, assignments, schema_mode = self._load_organization_masters(
            common_dir
        )
        return {
            "user_master": users,
            "team_master": teams,
            "comment_assignment": assignments,
            "calendar": self._load_calendar(common_dir),
            "organization_schema": [{"mode": schema_mode}],
        }

    def _load_organization_masters(
        self, common_dir: Path
    ) -> tuple[
        list[dict[str, Any]],
        list[dict[str, Any]],
        list[dict[str, Any]],
        str,
    ]:
        user_path = common_dir / "user_master.csv"
        team_path = common_dir / "team_master.csv"
        assignment_path = common_dir / "comment_assignment.csv"
        try:
            user_source = self._read_csv_frame(user_path)
        except Exception as exc:
            self._record_load_warning(user_path, exc)
            user_source = self._empty_df(list(COMMON_MASTER_COLUMNS["user_master"]))
        if team_path.exists():
            try:
                team_source = self._read_csv_frame(team_path)
            except Exception as exc:
                self._record_load_warning(team_path, exc)
                team_source = self._empty_df(
                    list(COMMON_MASTER_COLUMNS["team_master"])
                )
        else:
            team_source = self._empty_df(list(COMMON_MASTER_COLUMNS["team_master"]))

        new_user_columns = set(COMMON_MASTER_COLUMNS["user_master"])
        new_team_columns = set(COMMON_MASTER_COLUMNS["team_master"])
        is_new_schema = new_user_columns.issubset(user_source.columns) and (
            new_team_columns.issubset(team_source.columns)
            or (team_source.is_empty() and set(team_source.columns) == new_team_columns)
        )
        if is_new_schema:
            users = self._normalize_user_rows(user_source)
            teams = self._ensure_columns(
                team_source, list(COMMON_MASTER_COLUMNS["team_master"])
            ).to_dicts()
            if assignment_path.exists():
                try:
                    assignment_source = self._read_csv_frame(assignment_path)
                except Exception as exc:
                    self._record_load_warning(assignment_path, exc)
                    assignment_source = self._empty_df(
                        list(COMMON_MASTER_COLUMNS["comment_assignment"])
                    )
                assignments = self._ensure_columns(
                    assignment_source,
                    list(COMMON_MASTER_COLUMNS["comment_assignment"]),
                ).to_dicts()
                self.commenter_assignment_migration_required = not set(
                    COMMON_MASTER_COLUMNS["comment_assignment"]
                ).issubset(assignment_source.columns)
            else:
                assignments = []
                self.commenter_assignment_migration_required = True
            return users, teams, assignments, "new"

        self.organization_schema_migration_required = True
        raw_users = user_source.to_dicts()
        users = self._normalize_legacy_user_rows(user_source)
        teams = self._ensure_columns(
            team_source, list(LEGACY_COMMON_MASTER_COLUMNS["team_master"])
        ).to_dicts()
        has_commenter_scope = "commenter_scope" in team_source.columns
        for team in teams:
            if not has_commenter_scope:
                level = str(team.get("team_level", ""))
                team["commenter_scope"] = level if level in {"large", "medium"} else "custom"
                if level == "small":
                    team["target_employee_ids"] = ";".join(
                        str(user.get("employee_id", ""))
                        for user in users
                        if str(user.get("small_team_id", "")).strip() == str(team.get("team_id", "")).strip()
                    )
            if "target_employee_ids" not in team:
                team["target_employee_ids"] = ""

        deprecated_user_columns = {"superior_rank", "managed_team_ids"}
        self.legacy_rank_migration_required = bool(
            deprecated_user_columns.intersection(user_source.columns)
        )
        if "commenter_employee_ids" not in team_source.columns:
            self.commenter_assignment_migration_required = True
            self._migrate_commenter_assignments(common_dir, raw_users, teams)
        self.organization_migration_preview = self._build_organization_migration_preview(
            users, teams
        )
        return users, teams, [], "legacy"

    def _load_user_master(self, common_dir: Path) -> list[dict[str, Any]]:
        path = common_dir / "user_master.csv"
        columns = list(COMMON_MASTER_COLUMNS["user_master"])
        if not path.exists():
            self._record_load_warning(path, FileNotFoundError("ファイルがありません"))
            return []
        try:
            source = self._read_csv_frame(path)
        except Exception as exc:
            self._record_load_warning(path, exc)
            return []

        return self._normalize_user_rows(source)

    def _normalize_user_rows(self, source: pl.DataFrame) -> list[dict[str, Any]]:
        columns = list(COMMON_MASTER_COLUMNS["user_master"])
        rows = self._ensure_columns(source, columns).to_dicts()
        for row in rows:
            for column, default in USER_MASTER_DEFAULTS.items():
                if not str(row.get(column, "")).strip():
                    row[column] = default
            if (
                row.get("affiliation_type") == "organization"
                and not str(row.get("organization_id", "")).strip()
            ):
                row["affiliation_type"] = "unassigned"
            if row.get("employment_type") == "temporary":
                row["is_admin"] = "0"
        return rows

    def _normalize_legacy_user_rows(
        self, source: pl.DataFrame
    ) -> list[dict[str, Any]]:
        columns = list(LEGACY_COMMON_MASTER_COLUMNS["user_master"])
        rows = self._ensure_columns(source, columns).to_dicts()
        for row in rows:
            for column, default in USER_MASTER_DEFAULTS.items():
                if not str(row.get(column, "")).strip():
                    row[column] = default
            if row.get("employment_type") == "temporary":
                row["is_admin"] = "0"
        return rows

    @staticmethod
    def _build_organization_migration_preview(
        users: list[dict[str, Any]], teams: list[dict[str, Any]]
    ) -> dict[str, Any]:
        team_ids = {str(row.get("team_id", "")) for row in teams}
        return {
            "department_candidates": [
                str(row.get("team_id", ""))
                for row in teams
                if str(row.get("team_level", "")) == "large"
            ],
            "section_candidates": [
                str(row.get("team_id", ""))
                for row in teams
                if str(row.get("team_level", "")) == "medium"
                and str(row.get("parent_team_id", "")) in team_ids
            ],
            "ambiguous_team_ids": [
                str(row.get("team_id", ""))
                for row in teams
                if str(row.get("team_level", "")) == "small"
            ],
            "unresolved_employee_ids": [
                str(row.get("employee_id", ""))
                for row in users
                if not str(row.get("small_team_id", "")).strip()
                or str(row.get("small_team_id", "")) not in team_ids
            ],
        }

    def _migrate_commenter_assignments(
        self,
        common_dir: Path,
        raw_users: list[dict[str, Any]],
        teams: list[dict[str, Any]],
    ) -> None:
        legacy_path = common_dir / "superior_master.csv"
        legacy_rows = self._read_csv(legacy_path) if legacy_path.exists() else []
        legacy_ranks = {
            str(row.get("employee_id", "")): str(row.get("rank", ""))
            for row in legacy_rows
            if row.get("employee_id")
        }

        def order_key(row: dict[str, Any]) -> tuple[int, int, str]:
            employee_id = str(row.get("employee_id", ""))
            raw_rank = str(row.get("superior_rank", "")).strip()
            if not raw_rank:
                raw_rank = legacy_ranks.get(employee_id, "")
            rank = int(raw_rank) if raw_rank.isdigit() else 9999
            raw_display_order = str(row.get("display_order", "")).strip()
            display_order = (
                int(raw_display_order) if raw_display_order.isdigit() else 999999
            )
            return rank, display_order, employee_id

        team_commenters: dict[str, list[str]] = {
            str(row.get("team_id", "")): [] for row in teams
        }
        for user in sorted(raw_users, key=order_key):
            employee_id = str(user.get("employee_id", "")).strip()
            if not employee_id:
                continue
            managed_ids = {
                team_id.strip()
                for team_id in str(user.get("managed_team_ids", "")).split(";")
                if team_id.strip()
            }
            for team_id in managed_ids:
                commenters = team_commenters.get(team_id)
                if commenters is not None and employee_id not in commenters:
                    commenters.append(employee_id)
        for team in teams:
            team_id = str(team.get("team_id", ""))
            team["commenter_employee_ids"] = ";".join(
                team_commenters.get(team_id, [])
            )

    def _load_calendar(self, common_dir: Path) -> list[dict[str, Any]]:
        path = common_dir / "calendar.csv"
        if not path.exists():
            self._record_load_warning(path, FileNotFoundError("ファイルがありません"))
            return []
        try:
            source = self._read_csv_frame(path)
        except Exception as exc:
            self._record_load_warning(path, exc)
            return []

        self.calendar_migration_required = source.columns != ["date"]
        has_legacy_flag = "is_holiday" in source.columns
        dates: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in source.to_dicts():
            if has_legacy_flag and str(row.get("is_holiday", "0")).strip() != "1":
                continue
            date_text = str(row.get("date", "")).strip()
            if not date_text or date_text in seen:
                continue
            seen.add(date_text)
            dates.append({"date": date_text})
        return dates

    def get_common_master_revisions(self) -> dict[str, str]:
        common_dir = Path(self.settings.common_dir)
        return {
            master: self._common_master_revision(common_dir / f"{master}.csv")
            for master in COMMON_MASTER_COLUMNS
        }

    def get_common_master_revision(self, master: str) -> str:
        if master not in COMMON_MASTER_COLUMNS:
            raise ValueError("管理の種類が不正です。")
        return self._common_master_revision(
            Path(self.settings.common_dir) / f"{master}.csv"
        )

    def save_common_master(
        self,
        master: str,
        rows: list[dict[str, str]],
        expected_revision: str = "",
    ) -> str:
        if master not in COMMON_MASTER_COLUMNS:
            raise ValueError("管理の種類が不正です。")
        columns = list(COMMON_MASTER_COLUMNS[master])
        normalized = [
            {column: str(row.get(column, "")) for column in columns}
            for row in rows
        ]
        df = (
            pl.DataFrame(normalized, schema=columns, orient="row")
            if normalized
            else self._empty_df(columns)
        )
        target_path = Path(self.settings.common_dir) / f"{master}.csv"
        if (
            expected_revision
            and self._common_master_revision(target_path) != expected_revision
        ):
            raise CommonMasterConflictError(
                "管理が別の場所で更新されています。"
            )
        self._write_csv_atomically(df, target_path, "common")
        return self._common_master_revision(target_path)

    def save_user_administration(
        self,
        users: list[dict[str, str]],
        expected_revisions: dict[str, str],
    ) -> dict[str, str]:
        common_dir = Path(self.settings.common_dir)
        targets = {
            "user_master": common_dir / "user_master.csv",
        }
        for master, target_path in targets.items():
            expected = expected_revisions.get(master, "")
            if expected and self._common_master_revision(target_path) != expected:
                raise CommonMasterConflictError(
                    "管理が別の場所で更新されています。"
                )

        frames = [(self._common_master_frame("user_master", users), targets["user_master"])]
        self._write_csv_frames_atomically(frames, "common")
        return {
            master: self._common_master_revision(path)
            for master, path in targets.items()
        }

    def save_administration(
        self,
        teams: list[dict[str, str]],
        users: list[dict[str, str]],
        comment_assignments: list[dict[str, str]] | dict[str, str],
        expected_revisions: dict[str, str] | None = None,
    ) -> dict[str, str]:
        legacy_call = expected_revisions is None
        if legacy_call:
            expected_revisions = dict(comment_assignments)
            comment_assignments = []
        common_dir = Path(self.settings.common_dir)
        targets = {
            "team_master": common_dir / "team_master.csv",
            "user_master": common_dir / "user_master.csv",
        }
        if not legacy_call:
            targets["comment_assignment"] = common_dir / "comment_assignment.csv"
        for master, target_path in targets.items():
            expected = expected_revisions.get(master, "")
            if expected and self._common_master_revision(target_path) != expected:
                raise CommonMasterConflictError(
                    "管理が別の場所で更新されています。"
                )

        master_rows: list[tuple[str, list[dict[str, str]]]] = [
            ("team_master", teams),
            ("user_master", users),
        ]
        if not legacy_call:
            master_rows.append(("comment_assignment", list(comment_assignments)))
        frames = [
            (
                self._legacy_common_master_frame(master, rows)
                if legacy_call
                else self._common_master_frame(master, rows),
                targets[master],
            )
            for master, rows in master_rows
        ]
        self._write_csv_frames_atomically(frames, "common")
        return {
            master: self._common_master_revision(path)
            for master, path in targets.items()
        }

    def _common_master_frame(
        self, master: str, rows: list[dict[str, str]]
    ) -> pl.DataFrame:
        columns = list(COMMON_MASTER_COLUMNS[master])
        normalized = [
            {column: str(row.get(column, "")) for column in columns}
            for row in rows
        ]
        if master == "user_master":
            for row in normalized:
                for column, default in USER_MASTER_DEFAULTS.items():
                    if not row[column].strip():
                        row[column] = default
        return (
            pl.DataFrame(normalized, schema=columns, orient="row")
            if normalized
            else self._empty_df(columns)
        )

    def _legacy_common_master_frame(
        self, master: str, rows: list[dict[str, str]]
    ) -> pl.DataFrame:
        columns = list(LEGACY_COMMON_MASTER_COLUMNS[master])
        normalized = [
            {column: str(row.get(column, "")) for column in columns}
            for row in rows
        ]
        return (
            pl.DataFrame(normalized, schema=columns, orient="row")
            if normalized
            else self._empty_df(columns)
        )

    @staticmethod
    def _common_master_revision(path: Path) -> str:
        if not path.exists():
            return "missing"
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _read_csv(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            self._record_load_warning(path, FileNotFoundError("ファイルがありません"))
            return []
        try:
            return self._read_csv_frame(path).to_dicts()
        except Exception as exc:
            self._record_load_warning(path, exc)
            return []

    def _read_csv_frame(self, path: Path) -> pl.DataFrame:
        errors: list[str] = []
        for encoding in CSV_ENCODINGS:
            try:
                return pl.read_csv(
                    path,
                    infer_schema_length=0,
                    encoding=encoding,
                ).fill_null("")
            except Exception as exc:
                errors.append(f"{encoding}: {exc}")
        raise RuntimeError(" / ".join(errors))

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
        period_preset: str | None = None,
    ) -> dict[str, Any]:
        common = self.load_common()
        scope = self.resolve_view_scope(common, employee_id)
        target_employee_ids = scope["target_employee_ids"]
        users_df = self._load_all_user_rows(target_employee_ids)
        comments_df = self._load_all_comment_rows(target_employee_ids)
        return self.build_view_data_from_cache(
            employee_id,
            common,
            users_df,
            comments_df,
            start_date=start_date,
            end_date=end_date,
            period_preset=period_preset,
            load_warning_count=len(self.load_warnings),
        )

    def resolve_view_scope(
        self,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
    ) -> dict[str, Any]:
        user_master = {row.get("employee_id", ""): row for row in common["user_master"]}
        current_user = user_master.get(employee_id, {})
        is_temporary_user = self._is_temporary_user(current_user)
        assigned_subordinate_ids = (
            set()
            if is_temporary_user
            else self._assigned_subordinate_ids(common, employee_id)
        )
        viewable_members = self._build_viewable_members(
            common, employee_id, assigned_subordinate_ids
        )
        return {
            "user_master": user_master,
            "current_user": current_user,
            "is_temporary_user": is_temporary_user,
            "assigned_subordinate_ids": assigned_subordinate_ids,
            "viewable_members": viewable_members,
            "target_employee_ids": [
                member["employee_id"] for member in viewable_members
            ],
        }

    def build_view_data_from_cache(
        self,
        employee_id: str,
        common: dict[str, list[dict[str, Any]]],
        users_df: pl.DataFrame,
        comments_df: pl.DataFrame,
        start_date: str | None = None,
        end_date: str | None = None,
        period_preset: str | None = None,
        load_warning_count: int = 0,
    ) -> dict[str, Any]:
        if period_preset == "previousWorkday":
            previous_working_date = self._previous_working_date(common["calendar"])
            start_date = previous_working_date.isoformat()
            end_date = start_date
        scope = self.resolve_view_scope(common, employee_id)
        user_master = scope["user_master"]
        current_user = scope["current_user"]
        my_display = current_user.get("display_name") or employee_id
        can_input_own_report = self._user_can_input_own_report(current_user)
        is_temporary_user = scope["is_temporary_user"]
        assigned_subordinate_ids = scope["assigned_subordinate_ids"]
        viewable_members = scope["viewable_members"]
        target_employee_ids = scope["target_employee_ids"]
        missing_comment_summary = self._build_missing_comment_summary(
            users_df,
            comments_df,
            common,
            employee_id,
            list(assigned_subordinate_ids),
        )
        rows, default_start, default_end = self._build_rows(
            users_df,
            comments_df,
            common,
            employee_id,
            assigned_subordinate_ids,
            target_employee_ids,
            start_date,
            end_date,
            missing_comment_summary,
        )
        for member in viewable_members:
            member["pending_review_count"] = missing_comment_summary.get(
                "member_counts", {}
            ).get(member["employee_id"], 0)
        return {
            "employee_id": employee_id,
            "display_name": my_display,
            "can_input_own_report": can_input_own_report,
            "is_superior": bool(assigned_subordinate_ids),
            "is_director": self._is_director(common, employee_id),
            "restrict_to_self": is_temporary_user,
            "current_team": self._team_path(
                common,
                str(
                    user_master.get(employee_id, {}).get("organization_id")
                    or user_master.get(employee_id, {}).get("small_team_id", "")
                ),
            ),
            "viewable_members": viewable_members,
            "rows": rows,
            "missing_comment_summary": missing_comment_summary,
            "my_rank": self._get_my_rank(common, employee_id),
            "start_date": default_start.isoformat() if default_start else None,
            "end_date": default_end.isoformat() if default_end else None,
            "load_warning_count": load_warning_count,
        }

    def _build_viewable_members(
        self,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        assigned_subordinate_ids: set[str],
    ) -> list[dict[str, Any]]:
        if self._uses_new_organization_schema(common):
            return self._build_new_viewable_members(
                common, employee_id, assigned_subordinate_ids
            )
        users = {
            str(row.get("employee_id", "")): row
            for row in common["user_master"]
            if row.get("employee_id")
        }
        current_user = users.get(employee_id, {})
        can_input_own_report = self._user_can_input_own_report(current_user)
        if self._is_temporary_user(current_user):
            target_ids = {employee_id} if can_input_own_report else set()
            same_team_ids: set[str] = set()
            assigned_subordinate_ids = set()
        else:
            small_team_id = str(current_user.get("small_team_id", "")).strip()
            same_team_ids = {
                target_id
                for target_id, row in users.items()
                if target_id != employee_id or can_input_own_report
                if small_team_id
                and str(row.get("small_team_id", "")).strip() == small_team_id
            }
            target_ids = {*same_team_ids, *assigned_subordinate_ids}
            if can_input_own_report:
                target_ids.add(employee_id)

        def display_order(row: dict[str, Any]) -> int:
            try:
                return int(row.get("display_order") or 999999)
            except (TypeError, ValueError):
                return 999999

        teams_by_id = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }

        def team_order(row: dict[str, Any]) -> tuple[tuple[int, str, str], ...]:
            team_id = str(row.get("small_team_id", "")).strip()
            orders: list[tuple[int, str, str]] = []
            visited: set[str] = set()
            while team_id and team_id not in visited:
                visited.add(team_id)
                team = teams_by_id.get(team_id)
                if team is None:
                    break
                try:
                    order = int(team.get("sort_order") or 999999)
                except (TypeError, ValueError):
                    order = 999999
                orders.insert(
                    0,
                    (
                        order,
                        str(team.get("team_name") or ""),
                        team_id,
                    ),
                )
                team_id = str(team.get("parent_team_id", "")).strip()
            return tuple(orders or [(999999, "", "")])

        members: list[dict[str, Any]] = []
        for target_id in target_ids:
            row = users.get(target_id, {})
            relations = []
            if target_id == employee_id:
                relations.append("self")
            if target_id in same_team_ids:
                relations.append("same_small_team")
            if target_id in assigned_subordinate_ids:
                relations.append("assigned_subordinate")
            members.append(
                {
                    "employee_id": target_id,
                    "display_name": str(row.get("display_name") or target_id),
                    "small_team_id": str(row.get("small_team_id", "")),
                    "team_path": self._team_path(
                        common, str(row.get("small_team_id", ""))
                    ),
                    "relations": relations,
                    "can_view_report": True,
                    "can_comment": target_id in assigned_subordinate_ids,
                    "display_order": display_order(row),
                }
            )

        members.sort(
            key=lambda member: (
                team_order(users.get(member["employee_id"], {})),
                member["display_order"],
                member["display_name"],
                member["employee_id"],
            )
        )
        return members

    def _build_new_viewable_members(
        self,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        assigned_subordinate_ids: set[str],
    ) -> list[dict[str, Any]]:
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        current_user = users.get(employee_id, {})
        can_input_own_report = self._user_can_input_own_report(current_user)
        is_temporary = self._is_temporary_user(current_user)
        direct_organization_id = str(current_user.get("organization_id", "")).strip()
        same_organization_ids = {
            target_id
            for target_id, row in users.items()
            if row.get("affiliation_type") == "organization"
            and str(row.get("organization_id", "")).strip()
            == direct_organization_id
            and self._user_can_input_own_report(row)
        }
        if is_temporary:
            assigned_subordinate_ids = set()
            target_ids = {employee_id} if can_input_own_report else set()
            same_organization_ids = set()
        else:
            target_ids = {
                target_id
                for target_id in {*same_organization_ids, *assigned_subordinate_ids}
                if self._user_can_input_own_report(users.get(target_id, {}))
                and users.get(target_id, {}).get("affiliation_type") != "director"
            }
            if can_input_own_report:
                target_ids.add(employee_id)

        global_order = self._global_user_order(common)
        order_index = {target_id: index for index, target_id in enumerate(global_order)}
        members: list[dict[str, Any]] = []
        for target_id in sorted(
            target_ids, key=lambda item: (order_index.get(item, 999999), item)
        ):
            row = users.get(target_id, {})
            organization_id = str(row.get("organization_id", ""))
            relations: list[str] = []
            if target_id == employee_id:
                relations.append("self")
            if target_id in same_organization_ids:
                relations.extend(("same_organization", "same_small_team"))
            if target_id in assigned_subordinate_ids:
                relations.append("assigned_subordinate")
            path = self._team_path(common, organization_id)
            relations.extend(
                f"organization:{item.get('team_id', '')}"
                for item in path
                if item.get("team_id")
            )
            members.append(
                {
                    "employee_id": target_id,
                    "display_name": str(row.get("display_name") or target_id),
                    "affiliation_type": str(row.get("affiliation_type", "")),
                    "organization_id": organization_id,
                    "team_path": path,
                    "relations": list(dict.fromkeys(relations)),
                    "can_view_report": True,
                    "can_comment": target_id in assigned_subordinate_ids,
                    "member_order": self._numeric_order(row.get("member_order")),
                }
            )
        return members

    @staticmethod
    def _team_path(
        common: dict[str, list[dict[str, Any]]], small_team_id: str
    ) -> list[dict[str, str]]:
        if not small_team_id:
            return []
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        path: list[dict[str, str]] = []
        team_id = small_team_id
        visited: set[str] = set()
        while team_id and team_id not in visited:
            visited.add(team_id)
            row = teams.get(team_id)
            if row is None:
                break
            path.append(
                {
                    "team_id": team_id,
                    "team_name": str(row.get("team_name") or team_id),
                    "team_type": str(row.get("team_type", "")),
                    "team_level": str(
                        row.get("team_level")
                        or {
                            "department": "department",
                            "section": "section",
                        }.get(str(row.get("team_type", "")), "")
                    ),
                }
            )
            team_id = str(row.get("parent_team_id", ""))
        path.reverse()
        return path

    def _previous_working_date(
        self,
        calendar_rows: list[dict[str, Any]],
        reference_date: date | None = None,
    ) -> date:
        holiday_dates = {
            calendar_date
            for row in calendar_rows
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        candidate = (reference_date or self.today_jst()) - timedelta(days=1)
        while candidate in holiday_dates:
            candidate -= timedelta(days=1)
        return candidate

    @staticmethod
    def _calendar_row_is_holiday(row: dict[str, Any]) -> bool:
        return "is_holiday" not in row or str(row.get("is_holiday", "0")) == "1"

    @staticmethod
    def _uses_new_organization_schema(
        common: dict[str, list[dict[str, Any]]]
    ) -> bool:
        schema_rows = common.get("organization_schema", [])
        if schema_rows:
            return str(schema_rows[0].get("mode", "")) == "new"
        users = common.get("user_master", [])
        teams = common.get("team_master", [])
        return (
            (not users or all("affiliation_type" in row for row in users))
            and (not teams or all("team_type" in row for row in teams))
            and "comment_assignment" in common
        )

    @staticmethod
    def _numeric_order(value: Any) -> int:
        text = str(value or "").strip()
        return int(text) if text.isdigit() else 999999

    def _global_user_order(
        self, common: dict[str, list[dict[str, Any]]]
    ) -> list[str]:
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        if not self._uses_new_organization_schema(common):
            return sorted(
                users,
                key=lambda employee_id: (
                    self._numeric_order(users[employee_id].get("display_order")),
                    str(users[employee_id].get("display_name", "")),
                    employee_id,
                ),
            )
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        departments = sorted(
            (
                row
                for row in teams.values()
                if str(row.get("team_type", "")) == "department"
            ),
            key=lambda row: (
                self._numeric_order(row.get("sort_order")),
                str(row.get("team_name", "")),
                str(row.get("team_id", "")),
            ),
        )

        def member_key(row: dict[str, Any]) -> tuple[int, str, str]:
            return (
                self._numeric_order(row.get("member_order")),
                str(row.get("display_name", "")),
                str(row.get("employee_id", "")),
            )

        ordered: list[str] = []
        covered_organizations: set[str] = set()
        for department in departments:
            department_id = str(department.get("team_id", ""))
            sections = sorted(
                (
                    row
                    for row in teams.values()
                    if str(row.get("team_type", "")) == "section"
                    and str(row.get("parent_team_id", "")) == department_id
                ),
                key=lambda row: (
                    self._numeric_order(row.get("sort_order")),
                    str(row.get("team_name", "")),
                    str(row.get("team_id", "")),
                ),
            )
            for section in sections:
                section_id = str(section.get("team_id", ""))
                covered_organizations.add(section_id)
                ordered.extend(
                    str(row.get("employee_id", ""))
                    for row in sorted(
                        (
                            user
                            for user in users.values()
                            if user.get("affiliation_type") == "organization"
                            and str(user.get("organization_id", "")) == section_id
                        ),
                        key=member_key,
                    )
                )
            covered_organizations.add(department_id)
            ordered.extend(
                str(row.get("employee_id", ""))
                for row in sorted(
                    (
                        user
                        for user in users.values()
                        if user.get("affiliation_type") == "organization"
                        and str(user.get("organization_id", "")) == department_id
                    ),
                    key=member_key,
                )
            )
        # Invalid legacy-like rows are never saved, but keeping them stable here
        # makes a partially edited migration screen deterministic.
        ordered.extend(
            str(row.get("employee_id", ""))
            for row in sorted(
                (
                    user
                    for user in users.values()
                    if user.get("affiliation_type") == "organization"
                    and str(user.get("organization_id", ""))
                    not in covered_organizations
                ),
                key=member_key,
            )
        )
        ordered.extend(
            str(row.get("employee_id", ""))
            for row in sorted(
                (
                    user
                    for user in users.values()
                    if user.get("affiliation_type") == "director"
                ),
                key=member_key,
            )
        )
        return list(dict.fromkeys(employee_id for employee_id in ordered if employee_id))

    def _organization_member_ids(
        self,
        common: dict[str, list[dict[str, Any]]],
        organization_id: str,
    ) -> set[str]:
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        organization = teams.get(organization_id, {})
        organization_ids = {organization_id}
        if str(organization.get("team_type", "")) == "department":
            organization_ids.update(
                team_id
                for team_id, team in teams.items()
                if str(team.get("team_type", "")) == "section"
                and str(team.get("parent_team_id", "")) == organization_id
            )
        return {
            str(row.get("employee_id", ""))
            for row in common.get("user_master", [])
            if row.get("affiliation_type") == "organization"
            and str(row.get("organization_id", "")) in organization_ids
        }

    def _resolved_comment_assignments(
        self, common: dict[str, list[dict[str, Any]]]
    ) -> tuple[dict[str, set[str]], dict[str, list[str]]]:
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        commenter_targets: dict[str, set[str]] = {}
        for assignment in common.get("comment_assignment", []):
            commenter_id = str(
                assignment.get("commenter_employee_id", "")
            ).strip()
            commenter = users.get(commenter_id)
            if not commenter or self._is_temporary_user(commenter):
                continue
            target_type = str(assignment.get("target_type", "none")).strip()
            organization_ids = [
                item.strip()
                for item in str(
                    assignment.get("target_organization_ids", "")
                ).split(";")
                if item.strip()
            ]
            employee_ids = [
                item.strip()
                for item in str(assignment.get("target_employee_ids", "")).split(";")
                if item.strip()
            ]
            target_ids: set[str] = set()
            if target_type == "organization" and len(organization_ids) == 1:
                target_ids = self._organization_member_ids(common, organization_ids[0])
            elif target_type == "departments" and commenter.get("affiliation_type") == "director":
                for organization_id in organization_ids:
                    if teams.get(organization_id, {}).get("team_type") == "department":
                        target_ids.update(
                            self._organization_member_ids(common, organization_id)
                        )
            elif target_type == "custom":
                target_ids.update(employee_ids)
            target_ids = {
                target_id
                for target_id in target_ids
                if target_id != commenter_id
                and target_id in users
                and users[target_id].get("affiliation_type") != "director"
                and self._user_can_input_own_report(users[target_id])
            }
            commenter_targets[commenter_id] = target_ids

        global_order = self._global_user_order(common)
        order_index = {employee_id: index for index, employee_id in enumerate(global_order)}
        target_commenters: dict[str, list[str]] = {}
        for commenter_id, target_ids in commenter_targets.items():
            for target_id in target_ids:
                target_commenters.setdefault(target_id, []).append(commenter_id)
        for target_id, commenter_ids in target_commenters.items():
            target_commenters[target_id] = sorted(
                set(commenter_ids),
                key=lambda item: (order_index.get(item, 999999), item),
            )
        return commenter_targets, target_commenters

    def _is_director(
        self, common: dict[str, list[dict[str, Any]]], employee_id: str
    ) -> bool:
        return any(
            str(row.get("employee_id", "")) == employee_id
            and row.get("affiliation_type") == "director"
            for row in common.get("user_master", [])
        )

    @staticmethod
    def _is_workday(target_date: date, holiday_dates: set[date]) -> bool:
        return target_date.weekday() < 5 and target_date not in holiday_dates

    @classmethod
    def _director_weekly_target_date(
        cls, target_date: date, holiday_dates: set[date]
    ) -> date | None:
        week_start = target_date - timedelta(days=target_date.weekday())
        for weekday in range(4, -1, -1):
            candidate = week_start + timedelta(days=weekday)
            if cls._is_workday(candidate, holiday_dates):
                return candidate
        return None

    def _get_my_rank(self, common: dict[str, Any], employee_id: str) -> int:
        if self._uses_new_organization_schema(common):
            try:
                return self._global_user_order(common).index(employee_id)
            except ValueError:
                return -1
        return self._superior_rank_map(common).get(employee_id, -1)

    def _superior_rank_map(self, common: dict[str, Any]) -> dict[str, int]:
        if self._uses_new_organization_schema(common):
            return {
                employee_id: index
                for index, employee_id in enumerate(self._global_user_order(common))
            }
        ordered_ids: list[str] = []
        teams = sorted(
            common.get("team_master", []),
            key=lambda row: (
                int(str(row.get("sort_order", "")))
                if str(row.get("sort_order", "")).isdigit()
                else 999999,
                str(row.get("team_id", "")),
            ),
        )
        for team in teams:
            for employee_id in self._team_commenter_ids(team):
                if employee_id not in ordered_ids:
                    ordered_ids.append(employee_id)
        if ordered_ids:
            return {employee_id: index for index, employee_id in enumerate(ordered_ids)}

        # Transitional support for pre-migration data supplied by tests or callers.
        ranks: dict[str, int] = {}
        for row in common.get("user_master", []):
            employee_id = str(row.get("employee_id", ""))
            raw_rank = row.get("superior_rank", "")
            if not employee_id or raw_rank in {"", None}:
                continue
            try:
                ranks[employee_id] = int(raw_rank)
            except (TypeError, ValueError):
                ranks[employee_id] = 9999

        # Tests and transitional callers may still provide the former structure.
        if ranks:
            return ranks
        for row in common.get("superior_master", []):
            employee_id = str(row.get("employee_id", ""))
            if not employee_id:
                continue
            try:
                ranks[employee_id] = int(row.get("rank") or 9999)
            except (TypeError, ValueError):
                ranks[employee_id] = 9999
        return ranks

    @staticmethod
    def _managed_team_ids(row: dict[str, Any]) -> set[str]:
        return {
            team_id.strip()
            for team_id in str(row.get("managed_team_ids", "")).split(";")
            if team_id.strip()
        }

    @staticmethod
    def _team_commenter_ids(row: dict[str, Any]) -> list[str]:
        return list(
            dict.fromkeys(
                employee_id.strip()
                for employee_id in str(
                    row.get("commenter_employee_ids", "")
                ).split(";")
                if employee_id.strip()
            )
        )

    @staticmethod
    def _team_target_ids(row: dict[str, Any]) -> set[str]:
        return {
            employee_id.strip()
            for employee_id in str(row.get("target_employee_ids", "")).split(";")
            if employee_id.strip()
        }

    @classmethod
    def _team_scope_applies(
        cls, team: dict[str, Any], target_employee_id: str,
        users: dict[str, dict[str, Any]], teams: dict[str, dict[str, Any]],
    ) -> bool:
        scope = str(team.get("commenter_scope", "custom")).strip() or "custom"
        target = users.get(target_employee_id, {})
        target_team_id = str(target.get("small_team_id", "")).strip()
        path: list[dict[str, Any]] = []
        visited: set[str] = set()
        while target_team_id and target_team_id not in visited:
            visited.add(target_team_id)
            current = teams.get(target_team_id)
            if not current: break
            path.append(current)
            target_team_id = str(current.get("parent_team_id", "")).strip()
        if scope == "custom":
            return (
                "commenter_scope" not in team
                or bool(team.get("_legacy_commenter_scope"))
                or target_employee_id in cls._team_target_ids(team)
            )
        team_id = str(team.get("team_id", ""))
        team_level = str(team.get("team_level", ""))
        path_ids = {str(item.get("team_id")) for item in path}
        def ancestor_id(start_id: str, wanted_level: str) -> str:
            seen: set[str] = set()
            current_id = start_id
            while current_id and current_id not in seen:
                seen.add(current_id)
                current = teams.get(current_id, {})
                if str(current.get("team_level")) == wanted_level:
                    return current_id
                current_id = str(current.get("parent_team_id", ""))
            return ""
        if scope == "large":
            large_id = ancestor_id(team_id, "large")
            return bool(large_id and large_id in path_ids)
        if team_level == "large":
            return any(
                str(item.get("team_level")) == "medium"
                and str(item.get("parent_team_id")) == team_id
                for item in path
            )
        medium_id = ancestor_id(team_id, "medium")
        return bool(medium_id and medium_id in path_ids)

    def _commenter_team_ids(
        self, common: dict[str, list[dict[str, Any]]], employee_id: str
    ) -> set[str]:
        managed_ids = {
            str(team.get("team_id", "")).strip()
            for team in common.get("team_master", [])
            if employee_id in self._team_commenter_ids(team)
        }
        if managed_ids:
            return managed_ids
        # Transitional support for old in-memory fixtures until their CSV is saved.
        supervisor = next(
            (
                row
                for row in common.get("user_master", [])
                if str(row.get("employee_id", "")) == employee_id
            ),
            {},
        )
        return self._managed_team_ids(supervisor)

    def _commenter_ids_for_target(
        self,
        common: dict[str, list[dict[str, Any]]],
        target_employee_id: str,
    ) -> list[str]:
        if self._uses_new_organization_schema(common):
            return self._resolved_comment_assignments(common)[1].get(
                target_employee_id, []
            )
        user = next(
            (
                row
                for row in common.get("user_master", [])
                if str(row.get("employee_id", "")) == target_employee_id
            ),
            {},
        )
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        team_id = str(user.get("small_team_id", "")).strip()
        ordered_ids: list[str] = []
        visited: set[str] = set()
        while team_id and team_id not in visited:
            visited.add(team_id)
            team = teams.get(team_id)
            if team is None:
                break
            for employee_id in self._team_commenter_ids(team):
                if not self._team_scope_applies(team, target_employee_id, users, teams):
                    continue
                if employee_id not in ordered_ids:
                    ordered_ids.append(employee_id)
            team_id = str(team.get("parent_team_id", "")).strip()
        return ordered_ids

    def _commenter_ids_for_targets(
        self,
        common: dict[str, list[dict[str, Any]]],
        target_employee_ids: list[str],
    ) -> list[str]:
        if self._uses_new_organization_schema(common):
            target_commenters = self._resolved_comment_assignments(common)[1]
            relevant = {
                commenter_id
                for target_id in target_employee_ids
                for commenter_id in target_commenters.get(target_id, [])
            }
            return [
                employee_id
                for employee_id in self._global_user_order(common)
                if employee_id in relevant
            ]
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        relevant_team_ids: set[str] = set()
        for target_employee_id in target_employee_ids:
            team_id = str(
                users.get(target_employee_id, {}).get("small_team_id", "")
            ).strip()
            visited: set[str] = set()
            while team_id and team_id not in visited:
                visited.add(team_id)
                team = teams.get(team_id)
                if team is None:
                    break
                relevant_team_ids.add(team_id)
                team_id = str(team.get("parent_team_id", "")).strip()

        def hierarchy_key(team: dict[str, Any]) -> tuple[tuple[int, str, str], ...]:
            path: list[tuple[int, str, str]] = []
            team_id = str(team.get("team_id", ""))
            visited: set[str] = set()
            while team_id and team_id not in visited:
                visited.add(team_id)
                current = teams.get(team_id)
                if current is None:
                    break
                raw_order = str(current.get("sort_order", ""))
                order = int(raw_order) if raw_order.isdigit() else 999999
                path.insert(
                    0,
                    (
                        order,
                        str(current.get("team_name", "")),
                        team_id,
                    ),
                )
                team_id = str(current.get("parent_team_id", "")).strip()
            return tuple(path)

        ordered_ids: list[str] = []
        has_explicit_scope = any("commenter_scope" in team for team in teams.values())
        candidate_team_ids = set(teams) if has_explicit_scope else relevant_team_ids
        for level in ("small", "medium", "large"):
            level_teams = sorted(
                (
                    teams[team_id]
                    for team_id in candidate_team_ids
                    if str(teams[team_id].get("team_level", "")) == level
                ),
                key=hierarchy_key,
            )
            for team in level_teams:
                for employee_id in self._team_commenter_ids(team):
                    if not any(self._team_scope_applies(team, target_id, users, teams) for target_id in target_employee_ids):
                        continue
                    if employee_id not in ordered_ids:
                        ordered_ids.append(employee_id)
        return ordered_ids

    @staticmethod
    def _user_can_input_own_report(row: dict[str, Any]) -> bool:
        return str(
            row.get(
                "can_input_own_report",
                USER_MASTER_DEFAULTS["can_input_own_report"],
            )
        ).strip() != "0"

    @staticmethod
    def _is_temporary_user(row: dict[str, Any]) -> bool:
        return str(row.get("employment_type", "")).strip() == "temporary"

    def _assigned_subordinate_ids(
        self, common: dict[str, list[dict[str, Any]]], employee_id: str
    ) -> set[str]:
        if self._uses_new_organization_schema(common):
            return set(
                self._resolved_comment_assignments(common)[0].get(employee_id, set())
            )
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        managed_ids = self._commenter_team_ids(common, employee_id)
        if not managed_ids:
            return set()
        children: dict[str, set[str]] = {}
        for team in common.get("team_master", []):
            parent_id = str(team.get("parent_team_id", "")).strip()
            team_id = str(team.get("team_id", "")).strip()
            if team_id:
                children.setdefault(parent_id, set()).add(team_id)
        covered_ids = set(managed_ids)
        pending = list(managed_ids)
        while pending:
            team_id = pending.pop()
            for child_id in children.get(team_id, set()):
                if child_id not in covered_ids:
                    covered_ids.add(child_id)
                    pending.append(child_id)
        managed_teams = [
            team for team in common.get("team_master", [])
            if str(team.get("team_id", "")).strip() in managed_ids
        ]
        has_explicit_scope = any("commenter_scope" in team for team in managed_teams)
        teams_by_id = {
            str(team.get("team_id", "")): team
            for team in common.get("team_master", []) if team.get("team_id")
        }
        return {
            target_id
            for target_id, row in users.items()
            if target_id != employee_id
            and (has_explicit_scope or str(row.get("small_team_id", "")).strip() in covered_ids)
            and any(
                self._team_scope_applies(
                    team, target_id, users, teams_by_id,
                )
                for team in common.get("team_master", [])
                if str(team.get("team_id", "")).strip() in managed_ids
            )
        }

    def _build_missing_comment_summary(
        self,
        users_df: pl.DataFrame,
        comments_df: pl.DataFrame,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        target_employee_ids: list[str],
    ) -> dict[str, Any]:
        if self._uses_new_organization_schema(common) and self._is_director(
            common, employee_id
        ):
            return self._build_director_missing_comment_summary(
                comments_df, common, employee_id, target_employee_ids
            )
        today = self.today_jst()
        range_end = (
            today
            if self.settings.include_today_in_missing_comments
            else today - timedelta(days=1)
        )
        range_start = self._to_date(self.settings.missing_comment_start_date)
        if range_start is None:
            range_start = DEFAULT_MISSING_COMMENT_START_DATE

        summary = {
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "dates": [],
            "member_counts": {},
        }
        if range_start > range_end:
            return summary

        subordinate_ids = [
            target_id
            for target_id in dict.fromkeys(target_employee_ids)
            if target_id and target_id != employee_id
        ]
        if not subordinate_ids:
            return summary

        holiday_dates = {
            calendar_date
            for row in common["calendar"]
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        comments = {
            (str(row.get("subordinate_employee_id", "")), comment_date): str(
                row.get("comment") or ""
            ).strip()
            for row in comments_df.to_dicts()
            if str(row.get("superior_employee_id", "")) == employee_id
            and (comment_date := self._to_date(row.get("date"))) is not None
            and range_start <= comment_date <= range_end
        }

        missing_dates: list[str] = []
        member_counts = {subordinate_id: 0 for subordinate_id in subordinate_ids}
        for offset in range((range_end - range_start).days + 1):
            target_date = range_start + timedelta(days=offset)
            if target_date in holiday_dates:
                continue
            date_is_missing = False
            for subordinate_id in subordinate_ids:
                report_key = (subordinate_id, target_date)
                if not comments.get(report_key, ""):
                    member_counts[subordinate_id] += 1
                    date_is_missing = True
            if date_is_missing:
                missing_dates.append(target_date.isoformat())

        summary["dates"] = missing_dates
        summary["member_counts"] = member_counts
        return summary

    def _build_director_missing_comment_summary(
        self,
        comments_df: pl.DataFrame,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        target_employee_ids: list[str],
    ) -> dict[str, Any]:
        today = self.today_jst()
        configured_start = self._to_date(self.settings.missing_comment_start_date)
        if configured_start is None:
            configured_start = DEFAULT_MISSING_COMMENT_START_DATE
        holiday_dates = {
            calendar_date
            for row in common.get("calendar", [])
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        targets = [
            target_id
            for target_id in dict.fromkeys(target_employee_ids)
            if target_id and target_id != employee_id
        ]
        latest: dict[str, date] = {}
        for row in comments_df.to_dicts():
            if str(row.get("superior_employee_id", "")) != employee_id:
                continue
            target_id = str(row.get("subordinate_employee_id", ""))
            if target_id not in targets or not str(row.get("comment") or "").strip():
                continue
            comment_date = self._to_date(row.get("date"))
            if comment_date is None or comment_date > today:
                continue
            if target_id not in latest or comment_date > latest[target_id]:
                latest[target_id] = comment_date

        member_counts: dict[str, int] = {}
        calculation_starts: dict[str, str] = {}
        last_confirmed_dates: dict[str, str] = {}
        start_dates: list[date] = []
        for target_id in targets:
            last_confirmed = latest.get(target_id)
            calculation_start = (
                last_confirmed + timedelta(days=1)
                if last_confirmed is not None
                else configured_start
            )
            start_dates.append(min(calculation_start, today))
            calculation_starts[target_id] = calculation_start.isoformat()
            if last_confirmed is not None:
                last_confirmed_dates[target_id] = last_confirmed.isoformat()
            elapsed = 0
            if calculation_start <= today:
                for offset in range((today - calculation_start).days + 1):
                    candidate = calculation_start + timedelta(days=offset)
                    if self._is_workday(candidate, holiday_dates):
                        elapsed += 1
            member_counts[target_id] = elapsed

        range_start = min(start_dates) if start_dates else min(configured_start, today)
        weekly_target_dates: list[str] = []
        week_cursor = range_start - timedelta(days=range_start.weekday())
        final_week = today - timedelta(days=today.weekday())
        while week_cursor <= final_week:
            weekly_target = self._director_weekly_target_date(
                week_cursor, holiday_dates
            )
            if (
                weekly_target is not None
                and range_start <= weekly_target <= today
            ):
                weekly_target_dates.append(weekly_target.isoformat())
            week_cursor += timedelta(days=7)

        maximum = max(member_counts.values(), default=0)
        return {
            "mode": "weekly_director",
            "start_date": range_start.isoformat(),
            "end_date": today.isoformat(),
            "dates": weekly_target_dates,
            "weekly_target_dates": weekly_target_dates,
            "member_counts": member_counts,
            "member_elapsed_workdays": member_counts,
            "member_start_dates": calculation_starts,
            "last_confirmed_dates": last_confirmed_dates,
            "max_elapsed_workdays": maximum,
            "director_missing_days": maximum,
        }

    @staticmethod
    def _row_has_report_data(row: dict[str, Any]) -> bool:
        return bool(
            str(row.get("business_name") or "").strip()
            or str(row.get("business_detail") or "").strip()
        )

    def save_updates(
        self,
        employee_id: str,
        user_updates: list[dict[str, Any]],
        comment_updates: list[dict[str, Any]],
        common: dict[str, list[dict[str, Any]]] | None = None,
        cached_comments: pl.DataFrame | None = None,
    ) -> dict[str, Any]:
        employee_id = validate_employee_id(employee_id)
        self._authorize_updates(
            employee_id,
            user_updates,
            comment_updates,
            common=common,
            cached_comments=cached_comments,
        )
        update_targets = (
            ("user", user_updates, self._upsert_user_rows),
            ("comment", comment_updates, self._upsert_comment_rows),
        )
        result = {
            name: {"needed": bool(updates), "saved": False, "error": ""}
            for name, updates, _ in update_targets
        }
        for name, updates, writer in update_targets:
            if not updates:
                continue
            try:
                partition_path, partition_frame = writer(employee_id, updates)
                result[name]["saved"] = True
                result[name]["_cache_path"] = str(partition_path)
                result[name]["_cache_frame"] = partition_frame
            except Exception:
                logger.exception("Failed to save %s updates", name)
                result[name]["error"] = "保存先への書き込みに失敗しました。"

        return result

    def _authorize_updates(
        self,
        employee_id: str,
        user_updates: list[dict[str, Any]],
        comment_updates: list[dict[str, Any]],
        common: dict[str, list[dict[str, Any]]] | None = None,
        cached_comments: pl.DataFrame | None = None,
    ) -> None:
        if common is None and (user_updates or comment_updates):
            common = self.load_common()
        current_user = next(
            (
                row
                for row in (common or {}).get("user_master", [])
                if str(row.get("employee_id", "")) == employee_id
            ),
            {},
        )
        if user_updates and not self._user_can_input_own_report(
            current_user
        ):
            raise PermissionError("自分の日報入力が無効になっています。")

        if comment_updates:
            if self._is_temporary_user(current_user):
                raise PermissionError("派遣社員は他の利用者へのコメントを更新できません。")
            allowed_subordinates = self._assigned_subordinate_ids(common, employee_id)
            is_director = self._is_director(common, employee_id)
            holiday_dates = {
                calendar_date
                for row in common.get("calendar", [])
                if self._calendar_row_is_holiday(row)
                and (calendar_date := self._to_date(row.get("date"))) is not None
            }
            for update in comment_updates:
                subordinate_id = validate_employee_id(
                    update.get("subordinate_employee_id"), "コメント対象者ID"
                )
                if subordinate_id not in allowed_subordinates:
                    raise PermissionError("担当外の利用者へのコメント更新です。")
                if is_director:
                    comment_date = self._to_date(update.get("date"))
                    if (
                        comment_date is None
                        or self._director_weekly_target_date(
                            comment_date, holiday_dates
                        )
                        != comment_date
                    ):
                        raise PermissionError(
                            "部長コメントは週の最終稼働日にだけ更新できます。"
                        )

        requested_replies: set[tuple[str, str]] = set()
        for update in user_updates:
            report_date = self._date_key(update.get("date"))
            if not report_date:
                raise ValueError("日報の日付が不正です。")
            replies = update.get("replies", []) or []
            if not isinstance(replies, list):
                raise ValueError("返信の形式が不正です。")
            for reply in replies:
                if not isinstance(reply, dict):
                    raise ValueError("返信の形式が不正です。")
                superior_id = validate_employee_id(
                    reply.get("superior_employee_id"), "返信先の上司ID"
                )
                requested_replies.add((superior_id, report_date))

        if requested_replies:
            existing_comments = (
                cached_comments
                if cached_comments is not None
                else self._load_all_comment_rows()
            ).to_dicts()
            authorized_replies = {
                (
                    str(row.get("superior_employee_id", "")),
                    self._date_key(row.get("date")),
                )
                for row in existing_comments
                if str(row.get("subordinate_employee_id", "")) == employee_id
                and str(row.get("comment") or "").strip()
                and self._date_key(row.get("date"))
            }
            if not requested_replies.issubset(authorized_replies):
                raise PermissionError("存在しない上司コメントへの返信更新です。")

    def load_report_partition(
        self, path: Path, employee_id: str
    ) -> pl.DataFrame:
        if not path.exists():
            return self._empty_df(USER_COLUMNS)
        rows = self._normalize_rows(
            self._read_csv_frame(path).to_dicts(), USER_COLUMNS
        )
        rows = [
            row
            for row in rows
            if str(row.get("employee_id", "")) == employee_id
        ]
        return self._dedupe_rows_to_df(
            rows, USER_COLUMNS, ["employee_id", "date"]
        )

    def load_comment_partition(
        self, path: Path, allowed_employee_ids: set[str]
    ) -> pl.DataFrame:
        if not path.exists():
            return self._empty_df(COMMENT_COLUMNS)
        rows = self._normalize_rows(
            self._read_csv_frame(path).to_dicts(), COMMENT_COLUMNS
        )
        rows = [
            row
            for row in rows
            if str(row.get("subordinate_employee_id", ""))
            in allowed_employee_ids
        ]
        return self._dedupe_rows_to_df(
            rows,
            COMMENT_COLUMNS,
            ["superior_employee_id", "subordinate_employee_id", "date"],
        )

    def combine_report_partitions(
        self, partitions: list[pl.DataFrame]
    ) -> pl.DataFrame:
        rows = [row for frame in partitions for row in frame.to_dicts()]
        return self._dedupe_rows_to_df(
            rows, USER_COLUMNS, ["employee_id", "date"]
        )

    def combine_comment_partitions(
        self, partitions: list[pl.DataFrame]
    ) -> pl.DataFrame:
        rows = [row for frame in partitions for row in frame.to_dicts()]
        return self._dedupe_rows_to_df(
            rows,
            COMMENT_COLUMNS,
            ["superior_employee_id", "subordinate_employee_id", "date"],
        )

    def load_calendar_master(self) -> list[dict[str, Any]]:
        return self._load_calendar(Path(self.settings.common_dir))

    def _load_all_user_rows(self, allowed_employee_ids: list[str]) -> pl.DataFrame:
        rows: list[dict[str, Any]] = []
        users_dir = Path(self.settings.users_dir)
        files = [
            safe_employee_csv_path(users_dir, employee_id)
            for employee_id in dict.fromkeys(allowed_employee_ids)
            if employee_id
        ]
        for file in files:
            if not file.exists():
                continue
            try:
                rows.extend(
                    self.load_report_partition(file, file.stem).to_dicts()
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

    def _load_all_comment_rows(
        self, allowed_employee_ids: list[str] | None = None
    ) -> pl.DataFrame:
        rows: list[dict[str, Any]] = []
        comments_dir = Path(self.settings.comments_dir)
        files = list(comments_dir.glob("*.csv")) if comments_dir.exists() else []
        allowed_ids = set(allowed_employee_ids or [])
        for file in files:
            try:
                if allowed_employee_ids is None:
                    rows.extend(
                        self._normalize_rows(
                            self._read_csv_frame(file).to_dicts(), COMMENT_COLUMNS
                        )
                    )
                else:
                    rows.extend(
                        self.load_comment_partition(file, allowed_ids).to_dicts()
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
        assigned_subordinate_ids: set[str],
        target_employee_ids: list[str],
        start_date: str | None = None,
        end_date: str | None = None,
        missing_comment_summary: dict[str, Any] | None = None,
    ) -> tuple[list[dict[str, Any]], date | None, date | None]:
        user_master = {row.get("employee_id", ""): row for row in common["user_master"]}
        holiday_dates = {
            str(row.get("date", ""))
            for row in common["calendar"]
            if self._calendar_row_is_holiday(row) and row.get("date")
        }
        new_schema = self._uses_new_organization_schema(common)
        target_commenters = (
            self._resolved_comment_assignments(common)[1] if new_schema else {}
        )
        superior_ids = self._commenter_ids_for_targets(
            common, target_employee_ids
        )
        if not superior_ids and not new_schema:
            legacy_ranks = self._superior_rank_map(common)
            superior_ids = sorted(
                legacy_ranks,
                key=lambda item: legacy_ranks.get(item, 9999),
            )
        if comments_df.height and not new_schema:
            historical_ids = sorted(
                {
                    str(row.get("superior_employee_id", ""))
                    for row in comments_df.to_dicts()
                    if row.get("superior_employee_id")
                }
            )
            superior_ids.extend(
                employee_id
                for employee_id in historical_ids
                if employee_id not in superior_ids
            )
        superior_ranks = {
            superior_id: index for index, superior_id in enumerate(superior_ids)
        }

        today = self.today_jst()
        holiday_date_values = {
            calendar_date
            for row in common.get("calendar", [])
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        director_ids = {
            superior_id
            for superior_id in superior_ids
            if self._is_director(common, superior_id)
        }
        current_user_is_director = employee_id in director_ids
        director_member_counts = (
            (missing_comment_summary or {}).get("member_counts", {})
            if current_user_is_director
            else {}
        )
        director_member_start_dates = (
            (missing_comment_summary or {}).get("member_start_dates", {})
            if current_user_is_director
            else {}
        )

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
            assigned_commenters = (
                set(target_commenters.get(target_employee_id, []))
                if new_schema
                else set(superior_ids)
            )
            for superior_id in superior_ids:
                applies = superior_id in assigned_commenters
                superior_is_director = superior_id in director_ids
                weekly_target = (
                    self._director_weekly_target_date(d, holiday_date_values)
                    if superior_is_director
                    else None
                )
                is_weekly_target = bool(weekly_target == d)
                can_edit = (
                    applies
                    and target_employee_id in assigned_subordinate_ids
                    and superior_id == employee_id
                )
                comment_cells.append(
                    {
                        "superior_employee_id": superior_id,
                        "superior_name": user_master.get(superior_id, {}).get(
                            "display_name"
                        )
                        or superior_id,
                        "comment": (
                            comment_map.get((superior_id, target_employee_id, d), "")
                            if applies
                            else ""
                        ),
                        "reply": replies.get(superior_id, "") if applies else "",
                        "editable": can_edit,
                        "applies": applies,
                        "comment_mode": "weekly" if superior_is_director else "daily",
                        "is_weekly_target": is_weekly_target,
                        "rank": superior_ranks.get(superior_id, 9999),
                    }
                )
            is_holiday = date_text in holiday_dates
            my_comment = comment_map.get((employee_id, target_employee_id, d), "")
            if current_user_is_director:
                calculation_start = self._to_date(
                    director_member_start_dates.get(target_employee_id)
                )
                needs_review = (
                    target_employee_id in assigned_subordinate_ids
                    and int(director_member_counts.get(target_employee_id, 0) or 0) > 0
                    and (calculation_start is None or d >= calculation_start)
                    and self._director_weekly_target_date(d, holiday_date_values) == d
                    and d <= today
                    and not str(my_comment).strip()
                )
            else:
                needs_review = (
                    target_employee_id in assigned_subordinate_ids
                    and not is_holiday
                    and d <= today
                    and (d < today or self.settings.include_today_in_missing_comments)
                    and not str(my_comment).strip()
                )
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
                "is_holiday": is_holiday,
                "holiday_description": "",
                "is_today": d == today,
                "can_edit_report": (
                    target_employee_id == employee_id
                    and self._user_can_input_own_report(
                        user_master.get(target_employee_id, {})
                    )
                ),
                "can_edit_my_comment": target_employee_id in assigned_subordinate_ids,
                "needs_review": needs_review,
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
        member_order = {target_id: index for index, target_id in enumerate(target_ids)}
        view_rows.sort(
            key=lambda item: (
                member_order.get(item["employee_id"], len(member_order)),
                date.fromisoformat(item["date"]).toordinal(),
            )
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
    ) -> tuple[Path, pl.DataFrame]:
        user_path = safe_employee_csv_path(self.settings.users_dir, employee_id)
        rows = self._read_csv_or_empty(user_path, USER_COLUMNS).to_dicts()
        existing = self._dedupe_rows(rows, ["employee_id", "date"])
        rows_by_date = {
            self._date_key(row.get("date")): dict(row)
            for row in existing
            if self._date_key(row.get("date"))
        }
        now = self.now_jst()
        for update in updates:
            report_date = self._to_date(update.get("date"))
            if report_date is None:
                raise ValueError("日報の日付が不正です。")
            date_text = report_date.isoformat()
            row = rows_by_date.get(
                date_text,
                {
                    "employee_id": employee_id,
                    "date": report_date,
                    "business_name": "",
                    "business_detail": "",
                    "replies": "[]",
                    "updated_at": now,
                },
            )
            row["employee_id"] = employee_id
            row["date"] = report_date
            if "business_name" in update:
                row["business_name"] = str(update.get("business_name", ""))
            if "business_detail" in update:
                row["business_detail"] = str(update.get("business_detail", ""))

            replies = self._parse_replies(row.get("replies", "[]"))
            for reply_item in update.get("replies", []) or []:
                sid = str(reply_item.get("superior_employee_id", ""))
                if sid:
                    replies[sid] = str(reply_item.get("reply", ""))
            row["replies"] = json.dumps(
                [
                    {"superior_employee_id": key, "reply": value}
                    for key, value in replies.items()
                ],
                ensure_ascii=False,
            )
            row["updated_at"] = now
            rows_by_date[date_text] = row

        df = self._dedupe_rows_to_df(
            list(rows_by_date.values()), USER_COLUMNS, ["employee_id", "date"]
        )
        self._write_csv_atomically(df, user_path, "users")
        return user_path, df

    def _upsert_comment_rows(
        self, employee_id: str, updates: list[dict[str, Any]]
    ) -> tuple[Path, pl.DataFrame]:
        comment_path = safe_employee_csv_path(self.settings.comments_dir, employee_id)
        rows = self._read_csv_or_empty(comment_path, COMMENT_COLUMNS).to_dicts()
        existing = self._dedupe_rows(
            rows, ["superior_employee_id", "subordinate_employee_id", "date"]
        )
        rows_by_key = {
            (
                str(row.get("superior_employee_id", "")),
                str(row.get("subordinate_employee_id", "")),
                self._date_key(row.get("date")),
            ): dict(row)
            for row in existing
        }
        now = self.now_jst()
        for update in updates:
            subordinate_id = str(update.get("subordinate_employee_id", "")).strip()
            report_date = self._to_date(update.get("date"))
            if not subordinate_id or report_date is None:
                raise ValueError("コメントの対象者または日付が不正です。")
            key = (employee_id, subordinate_id, report_date.isoformat())
            rows_by_key[key] = {
                "superior_employee_id": employee_id,
                "subordinate_employee_id": subordinate_id,
                "date": report_date,
                "comment": str(update.get("comment", "")),
                "updated_at": now,
            }
        df = self._dedupe_rows_to_df(
            list(rows_by_key.values()),
            COMMENT_COLUMNS,
            ["superior_employee_id", "subordinate_employee_id", "date"],
        )
        self._write_csv_atomically(df, comment_path, "comments")
        return comment_path, df

    def _write_csv_atomically(
        self, df: pl.DataFrame, target_path: Path, backup_group: str
    ) -> None:
        """Write a CSV completely, then replace the destination in one operation."""
        self._write_csv_frames_atomically([(df, target_path)], backup_group)

    def _write_csv_frames_atomically(
        self,
        frames: list[tuple[pl.DataFrame, Path]],
        backup_group: str,
    ) -> None:
        staged: dict[Path, Path | None] = {}
        originals: dict[Path, Path | None] = {}
        replaced: list[Path] = []
        try:
            for df, target_path in frames:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    prefix=f".{target_path.stem}.",
                    suffix=".tmp",
                    dir=target_path.parent,
                    delete=False,
                ) as temporary:
                    staged[target_path] = Path(temporary.name)
                stage_path = staged[target_path]
                if stage_path is None:
                    raise RuntimeError("一時CSVを作成できませんでした。")
                df.write_csv(stage_path)
                with stage_path.open("rb+") as completed_file:
                    os.fsync(completed_file.fileno())

            for _, target_path in frames:
                originals[target_path] = None
                if target_path.exists():
                    with tempfile.NamedTemporaryFile(
                        mode="wb",
                        prefix=f".{target_path.stem}.",
                        suffix=".rollback",
                        dir=target_path.parent,
                        delete=False,
                    ) as original:
                        originals[target_path] = Path(original.name)
                    original_path = originals[target_path]
                    if original_path is not None:
                        shutil.copy2(target_path, original_path)
                    self._backup_csv(target_path, backup_group)

            for _, target_path in frames:
                stage_path = staged[target_path]
                if stage_path is None:
                    raise RuntimeError("保存対象の一時CSVがありません。")
                os.replace(stage_path, target_path)
                staged[target_path] = None
                replaced.append(target_path)
        except Exception:
            for target_path in reversed(replaced):
                original_path = originals.get(target_path)
                try:
                    if original_path is None:
                        target_path.unlink(missing_ok=True)
                    else:
                        os.replace(original_path, target_path)
                        originals[target_path] = None
                except Exception:
                    logger.critical(
                        "Failed to roll back a common CSV transaction: %s",
                        target_path,
                        exc_info=True,
                    )
            raise
        finally:
            for path in (*staged.values(), *originals.values()):
                if path is not None:
                    path.unlink(missing_ok=True)

    def _backup_csv(self, target_path: Path, backup_group: str) -> None:
        backup_dir = self.base_dir / "cache" / "csv_backups" / backup_group
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = self.now_jst().strftime("%Y%m%d_%H%M%S_%f")
        backup_path = backup_dir / f"{target_path.stem}_{timestamp}.csv"
        shutil.copy2(target_path, backup_path)
        self._prune_backups(backup_dir, target_path.stem)

    def _prune_backups(self, backup_dir: Path, target_stem: str) -> None:
        backups = sorted(
            backup_dir.glob(f"{target_stem}_*.csv"),
            key=lambda path: path.name,
            reverse=True,
        )
        for stale_backup in backups[max(0, self.backup_limit) :]:
            try:
                stale_backup.unlink()
            except OSError:
                # バックアップ整理の失敗で、本体CSVの保存成功を失敗扱いにしない。
                continue

    def _read_csv_or_empty(self, path: Path, columns: list[str]) -> pl.DataFrame:
        if not path.exists():
            return self._empty_df(columns)
        return self._ensure_columns(self._read_csv_frame(path), columns)

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
        return [
            {
                column: row.get(column, "[]" if column == "replies" else "")
                for column in columns
            }
            for row in rows
        ]

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
        fallback_updated_at = self.now_jst()
        for row in rows:
            dt = self._to_datetime(row.get("updated_at")) or fallback_updated_at
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

