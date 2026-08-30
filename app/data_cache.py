from __future__ import annotations

import logging
import os
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from threading import RLock
from time import perf_counter
from typing import Any

import polars as pl

from app.config import AppSettings
from app.repository import DailyReportRepository
from app.security import safe_employee_csv_path


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FileFingerprint:
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class CacheSnapshot:
    settings_paths: tuple[str, str, str]
    employee_id: str
    common: dict[str, list[dict[str, Any]]]
    common_revisions: dict[str, str]
    report_partitions: dict[str, pl.DataFrame]
    comment_partitions: dict[str, pl.DataFrame]
    file_manifest: dict[str, FileFingerprint]
    target_employee_ids: tuple[str, ...]
    migration_required: dict[str, bool]
    generation: int
    built_at: datetime
    warnings: tuple[dict[str, str], ...]


@dataclass(frozen=True)
class RefreshResult:
    changed: int = 0
    added: int = 0
    deleted: int = 0
    failed: int = 0

    @property
    def applied(self) -> int:
        return self.changed + self.added + self.deleted

    def to_dict(self) -> dict[str, int]:
        return {
            "changed": self.changed,
            "added": self.added,
            "deleted": self.deleted,
            "failed": self.failed,
        }


@dataclass(frozen=True)
class CacheAccess:
    snapshot: CacheSnapshot
    status: str
    refresh_result: RefreshResult = RefreshResult()


class DailyReportDataCache:
    """In-process, permission-scoped cache for daily-report CSV data."""

    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir
        self._lock = RLock()
        self._snapshot: CacheSnapshot | None = None
        self._generation = 0
        self._invalid_paths: set[str] = set()

    @property
    def is_loaded(self) -> bool:
        with self._lock:
            return self._snapshot is not None

    def invalidate_all(self, reason: str) -> None:
        with self._lock:
            if self._snapshot is not None:
                logger.info(
                    "daily-report cache invalidated generation=%s reason=%s",
                    self._snapshot.generation,
                    reason,
                )
            self._snapshot = None
            self._invalid_paths.clear()

    def invalidate_partition(self, path: Path | str, reason: str) -> None:
        key = self._path_key(path)
        with self._lock:
            self._invalid_paths.add(key)
            if self._snapshot is not None:
                manifest = dict(self._snapshot.file_manifest)
                manifest.pop(key, None)
                self._snapshot = self._replace_snapshot(
                    self._snapshot,
                    file_manifest=manifest,
                    warnings=self._merge_warning(
                        self._snapshot.warnings,
                        key,
                        f"キャッシュ同期失敗: {reason}",
                    ),
                )

    def ensure_loaded(
        self, settings: AppSettings, employee_id: str
    ) -> CacheAccess:
        with self._lock:
            expected_paths = self._settings_paths(settings)
            snapshot = self._snapshot
            if (
                snapshot is None
                or snapshot.settings_paths != expected_paths
                or snapshot.employee_id != employee_id
            ):
                previous = snapshot
                if previous is not None:
                    reason = (
                        "settings paths changed"
                        if previous.settings_paths != expected_paths
                        else "employee scope changed"
                    )
                    logger.info(
                        "daily-report cache fallback_rebuild_reason=%s generation=%s",
                        reason,
                        previous.generation,
                    )
                try:
                    built = self._build_snapshot(settings, employee_id)
                except Exception:
                    if previous is not None and previous.settings_paths != expected_paths:
                        self._snapshot = None
                        self._invalid_paths.clear()
                    raise
                self._snapshot = built
                self._invalid_paths.clear()
                return CacheAccess(
                    built,
                    "built" if previous is None else "rebuilt",
                )

            if self._invalid_paths:
                return self._refresh_changed_locked(settings, employee_id)
            return CacheAccess(snapshot, "hit")

    def refresh_changed(
        self, settings: AppSettings, employee_id: str
    ) -> CacheAccess:
        with self._lock:
            if self._snapshot is None:
                built = self._build_snapshot(settings, employee_id)
                self._snapshot = built
                self._invalid_paths.clear()
                return CacheAccess(built, "built")
            if (
                self._snapshot.settings_paths != self._settings_paths(settings)
                or self._snapshot.employee_id != employee_id
            ):
                reason = (
                    "settings paths changed"
                    if self._snapshot.settings_paths != self._settings_paths(settings)
                    else "employee scope changed"
                )
                logger.info(
                    "daily-report cache fallback_rebuild_reason=%s generation=%s",
                    reason,
                    self._snapshot.generation,
                )
                try:
                    built = self._build_snapshot(settings, employee_id)
                except Exception:
                    self._snapshot = None
                    self._invalid_paths.clear()
                    raise
                self._snapshot = built
                self._invalid_paths.clear()
                return CacheAccess(built, "rebuilt")
            return self._refresh_changed_locked(settings, employee_id)

    def load_view_data(
        self,
        settings: AppSettings,
        employee_id: str,
        start_date: str | None = None,
        end_date: str | None = None,
        period_preset: str | None = None,
        force_refresh: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        operation_started = perf_counter()
        access = (
            self.refresh_changed(settings, employee_id)
            if force_refresh
            else self.ensure_loaded(settings, employee_id)
        )
        snapshot = access.snapshot
        repository = DailyReportRepository(settings, self._base_dir)
        view_started = perf_counter()
        users_df = repository.combine_report_partitions(
            list(snapshot.report_partitions.values())
        )
        comments_df = repository.combine_comment_partitions(
            list(snapshot.comment_partitions.values())
        )
        data = repository.build_view_data_from_cache(
            employee_id,
            snapshot.common,
            users_df,
            comments_df,
            start_date=start_date,
            end_date=end_date,
            period_preset=period_preset,
            load_warning_count=len(snapshot.warnings),
        )
        data_load_diagnostics = self._classify_view_data_load(settings, snapshot)
        view_duration_ms = (perf_counter() - view_started) * 1000
        total_duration_ms = (perf_counter() - operation_started) * 1000
        logger.debug(
            "daily-report cache generation=%s status=%s view_build_ms=%.2f total_ms=%.2f",
            snapshot.generation,
            access.status,
            view_duration_ms,
            total_duration_ms,
        )
        diagnostics = {
            "cache_generation": snapshot.generation,
            "cache_status": access.status,
            "refresh_result": access.refresh_result.to_dict(),
            "cache_warning_count": len(snapshot.warnings),
            **data_load_diagnostics,
        }
        return data, diagnostics

    def _classify_view_data_load(
        self, settings: AppSettings, snapshot: CacheSnapshot
    ) -> dict[str, int | bool | str]:
        """Report whether expected report/comment CSV reads failed entirely or partially."""
        warning_paths = {
            self._path_key(str(item.get("file", "")))
            for item in snapshot.warnings
            if item.get("file")
        }

        def partition_status(
            paths: list[Path], partitions: dict[str, pl.DataFrame]
        ) -> tuple[int, int, int]:
            path_keys = {self._path_key(path): path for path in paths}
            candidates = {
                key
                for key, path in path_keys.items()
                if path.exists() or key in partitions or key in warning_paths
            }
            loaded = sum(1 for key in candidates if key in partitions)
            failed = sum(1 for key in candidates if key in warning_paths)
            return len(candidates), loaded, failed

        report_total, report_loaded, report_failed = partition_status(
            list(self._report_paths(settings, snapshot.target_employee_ids).values()),
            snapshot.report_partitions,
        )
        comment_paths = (
            self._csv_files(Path(settings.comments_dir))
            if snapshot.target_employee_ids
            else []
        )
        comment_total, comment_loaded, comment_failed = partition_status(
            comment_paths, snapshot.comment_partitions
        )
        total = report_total + comment_total
        loaded = report_loaded + comment_loaded
        failed = report_failed + comment_failed
        if total > 0 and failed == total and loaded == 0:
            status = "all_failed"
        elif failed > 0:
            status = "partial"
        else:
            status = "ok"
        return {
            "data_load_status": status,
            "data_load_all_failed": status == "all_failed",
            "report_csv_total": report_total,
            "report_csv_loaded": report_loaded,
            "report_csv_failed": report_failed,
            "comment_csv_total": comment_total,
            "comment_csv_loaded": comment_loaded,
            "comment_csv_failed": comment_failed,
        }

    def get_save_context(
        self, settings: AppSettings, employee_id: str
    ) -> tuple[dict[str, list[dict[str, Any]]], pl.DataFrame]:
        snapshot = self.ensure_loaded(settings, employee_id).snapshot
        repository = DailyReportRepository(settings, self._base_dir)
        comments = repository.combine_comment_partitions(
            list(snapshot.comment_partitions.values())
        )
        return snapshot.common, comments

    def get_admin_common(
        self, settings: AppSettings, employee_id: str
    ) -> tuple[
        dict[str, list[dict[str, Any]]], dict[str, bool], dict[str, str]
    ]:
        snapshot = self.ensure_loaded(settings, employee_id).snapshot
        return (
            snapshot.common,
            dict(snapshot.migration_required),
            dict(snapshot.common_revisions),
        )

    def get_common(
        self, settings: AppSettings, employee_id: str
    ) -> dict[str, list[dict[str, Any]]]:
        return self.ensure_loaded(settings, employee_id).snapshot.common

    def is_employee_registered(
        self, settings: AppSettings, employee_id: str
    ) -> bool:
        common = self.get_common(settings, employee_id)
        return any(
            str(row.get("employee_id", "")).strip() == employee_id
            for row in common.get("user_master", [])
        )

    def apply_saved_partitions(
        self,
        settings: AppSettings,
        employee_id: str,
        report_partition: tuple[Path | str, pl.DataFrame] | None = None,
        comment_partition: tuple[Path | str, pl.DataFrame] | None = None,
    ) -> bool:
        with self._lock:
            snapshot = self._snapshot
            if (
                snapshot is None
                or snapshot.settings_paths != self._settings_paths(settings)
                or snapshot.employee_id != employee_id
            ):
                return False

            reports = dict(snapshot.report_partitions)
            comments = dict(snapshot.comment_partitions)
            manifest = dict(snapshot.file_manifest)
            warnings = snapshot.warnings
            target_ids = set(snapshot.target_employee_ids)
            changed = False

            if report_partition is not None:
                path, frame = report_partition
                key = self._path_key(path)
                target_id = Path(path).stem
                if target_id in target_ids:
                    reports[key] = frame.clone()
                    fingerprint = self._fingerprint(Path(path))
                    if fingerprint is not None:
                        manifest[key] = fingerprint
                    warnings = self._remove_warning(warnings, key)
                    self._invalid_paths.discard(key)
                    changed = True

            if comment_partition is not None:
                path, frame = comment_partition
                key = self._path_key(path)
                filtered = self._filter_comment_frame(frame, target_ids)
                comments[key] = filtered
                fingerprint = self._fingerprint(Path(path))
                if fingerprint is not None:
                    manifest[key] = fingerprint
                warnings = self._remove_warning(warnings, key)
                self._invalid_paths.discard(key)
                changed = True

            if changed:
                self._snapshot = self._replace_snapshot(
                    snapshot,
                    report_partitions=reports,
                    comment_partitions=comments,
                    file_manifest=manifest,
                    warnings=warnings,
                )
            return changed

    def _build_snapshot(
        self, settings: AppSettings, employee_id: str
    ) -> CacheSnapshot:
        started = perf_counter()
        repository = DailyReportRepository(settings, self._base_dir)
        repository.validate_paths()
        csv_read_started = perf_counter()
        common = repository.load_common()
        common_revisions = repository.get_common_master_revisions()
        migration_required = self._migration_flags(repository)
        scope = repository.resolve_view_scope(common, employee_id)
        target_ids = tuple(scope["target_employee_ids"])
        target_set = set(target_ids)
        report_partitions: dict[str, pl.DataFrame] = {}
        comment_partitions: dict[str, pl.DataFrame] = {}
        manifest: dict[str, FileFingerprint] = {}
        warnings: list[dict[str, str]] = [dict(item) for item in repository.load_warnings]
        warning_names = {str(item.get("file", "")) for item in warnings}
        csv_read_count = sum(
            1
            for path in self._common_paths(settings).values()
            if path.exists() and path.name not in warning_names
        )

        for path in self._common_paths(settings).values():
            if path.name in warning_names:
                continue
            fingerprint = self._fingerprint(path)
            if fingerprint is not None:
                manifest[self._path_key(path)] = fingerprint

        for target_id in target_ids:
            path: Path | None = None
            try:
                path = safe_employee_csv_path(settings.users_dir, target_id)
                if not path.exists():
                    continue
                frame = repository.load_report_partition(path, target_id)
                key = self._path_key(path)
                report_partitions[key] = frame
                fingerprint = self._fingerprint(path)
                if fingerprint is not None:
                    manifest[key] = fingerprint
                csv_read_count += 1
            except Exception as exc:
                warnings.append(self._warning(path or target_id, exc))

        if target_set:
            for path in self._csv_files(Path(settings.comments_dir)):
                try:
                    frame = repository.load_comment_partition(path, target_set)
                    key = self._path_key(path)
                    comment_partitions[key] = frame
                    fingerprint = self._fingerprint(path)
                    if fingerprint is not None:
                        manifest[key] = fingerprint
                    csv_read_count += 1
                except Exception as exc:
                    warnings.append(self._warning(path, exc))

        csv_read_duration_ms = (perf_counter() - csv_read_started) * 1000

        snapshot = CacheSnapshot(
            settings_paths=self._settings_paths(settings),
            employee_id=employee_id,
            common=common,
            common_revisions=common_revisions,
            report_partitions=report_partitions,
            comment_partitions=comment_partitions,
            file_manifest=manifest,
            target_employee_ids=target_ids,
            migration_required=migration_required,
            generation=self._next_generation(),
            built_at=datetime.now(),
            warnings=tuple(warnings),
        )
        logger.info(
            "daily-report cache generation=%s status=built csv_reads=%s csv_read_ms=%.2f build_ms=%.2f warnings=%s",
            snapshot.generation,
            csv_read_count,
            csv_read_duration_ms,
            (perf_counter() - started) * 1000,
            len(warnings),
        )
        return snapshot

    def _refresh_changed_locked(
        self, settings: AppSettings, employee_id: str
    ) -> CacheAccess:
        snapshot = self._snapshot
        if snapshot is None:
            built = self._build_snapshot(settings, employee_id)
            self._snapshot = built
            return CacheAccess(built, "built")

        scan_started = perf_counter()
        try:
            current_manifest = self._scan_manifest(
                settings, snapshot.target_employee_ids
            )
        except Exception as exc:
            logger.exception("Failed to scan daily-report cache manifest")
            result = RefreshResult(failed=1)
            warned = self._replace_snapshot(
                snapshot,
                warnings=self._merge_warning(
                    snapshot.warnings, "manifest", str(exc)
                ),
            )
            self._snapshot = warned
            return CacheAccess(warned, "refreshed", result)
        manifest_scan_duration_ms = (perf_counter() - scan_started) * 1000

        reports = dict(snapshot.report_partitions)
        comments = dict(snapshot.comment_partitions)
        manifest = dict(snapshot.file_manifest)
        common = snapshot.common
        common_revisions = dict(snapshot.common_revisions)
        target_ids = tuple(snapshot.target_employee_ids)
        migration_required = dict(snapshot.migration_required)
        warnings = snapshot.warnings
        changed_count = 0
        added_count = 0
        deleted_count = 0
        failed_count = 0
        csv_read_count = 0
        csv_read_duration_ms = 0.0
        changed_state = False

        common_paths = self._common_paths(settings)
        common_keys = {self._path_key(path) for path in common_paths.values()}
        old_common_manifest = {
            key: value for key, value in manifest.items() if key in common_keys
        }
        new_common_manifest = {
            key: value for key, value in current_manifest.items() if key in common_keys
        }
        common_changed_keys = self._changed_keys(
            old_common_manifest, new_common_manifest
        )

        if common_changed_keys:
            repository = DailyReportRepository(settings, self._base_dir)
            common_read_started = perf_counter()
            previous_common = common
            previous_common_revisions = dict(common_revisions)
            previous_reports = dict(reports)
            previous_comments = dict(comments)
            previous_manifest = dict(manifest)
            previous_target_ids = target_ids
            previous_migration_required = dict(migration_required)
            previous_warnings = warnings
            previous_failed_count = failed_count
            previous_changed_state = changed_state
            previous_invalid_paths = set(self._invalid_paths)
            try:
                calendar_key = self._path_key(common_paths["calendar"])
                organization_changed = any(
                    key != calendar_key for key in common_changed_keys
                )
                if organization_changed:
                    candidate_common = repository.load_common()
                    candidate_migration_required = self._migration_flags(repository)
                    csv_read_count += sum(
                        1 for path in common_paths.values() if path.exists()
                    )
                    if repository.load_warnings:
                        raise RuntimeError(
                            " / ".join(
                                item.get("error", "")
                                for item in repository.load_warnings
                            )
                        )
                    candidate_scope = repository.resolve_view_scope(
                        candidate_common, employee_id
                    )
                    candidate_targets = tuple(
                        candidate_scope["target_employee_ids"]
                    )
                    common = candidate_common
                    migration_required = candidate_migration_required
                    if candidate_targets != target_ids:
                        reports, comments, manifest, scope_warnings, reads = (
                            self._reconcile_scope(
                                settings,
                                repository,
                                reports,
                                comments,
                                manifest,
                                target_ids,
                                candidate_targets,
                            )
                        )
                        warnings = self._merge_warnings(warnings, scope_warnings)
                        failed_count += len(scope_warnings)
                        csv_read_count += reads
                        target_ids = candidate_targets
                    changed_state = True
                else:
                    calendar = repository.load_calendar_master()
                    csv_read_count += int(common_paths["calendar"].exists())
                    if repository.load_warnings:
                        raise RuntimeError(
                            " / ".join(
                                item.get("error", "")
                                for item in repository.load_warnings
                            )
                        )
                    common = {**common, "calendar": calendar}
                    migration_required["calendar"] = (
                        repository.calendar_migration_required
                    )
                    changed_state = True

                for key in common_keys:
                    if key in new_common_manifest:
                        manifest[key] = new_common_manifest[key]
                        warnings = self._remove_warning(warnings, key)
                        self._invalid_paths.discard(key)
                    else:
                        manifest.pop(key, None)
                        self._invalid_paths.discard(key)
                for master, path in common_paths.items():
                    if self._path_key(path) in common_changed_keys:
                        common_revisions[master] = (
                            repository.get_common_master_revision(master)
                        )
                for key in common_changed_keys:
                    if key in old_common_manifest and key in new_common_manifest:
                        changed_count += 1
                    elif key in new_common_manifest:
                        added_count += 1
                    else:
                        deleted_count += 1
            except Exception as exc:
                logger.warning(
                    "Failed to refresh common masters; keeping previous snapshot",
                    exc_info=True,
                )
                common = previous_common
                common_revisions = previous_common_revisions
                reports = previous_reports
                comments = previous_comments
                manifest = previous_manifest
                target_ids = previous_target_ids
                migration_required = previous_migration_required
                warnings = previous_warnings
                failed_count = previous_failed_count + len(common_changed_keys)
                changed_state = previous_changed_state
                self._invalid_paths = previous_invalid_paths
                for key in common_changed_keys:
                    self._invalid_paths.add(key)
                    warnings = self._merge_warning(warnings, key, str(exc))
            finally:
                csv_read_duration_ms += (
                    perf_counter() - common_read_started
                ) * 1000

        next_scan_started = perf_counter()
        current_manifest = self._scan_manifest(settings, target_ids)
        manifest_scan_duration_ms += (perf_counter() - next_scan_started) * 1000
        report_paths = self._report_paths(settings, target_ids)
        report_path_by_key = {
            self._path_key(path): (target_id, path)
            for target_id, path in report_paths.items()
        }
        comment_paths = {
            self._path_key(path): path
            for path in self._csv_files(Path(settings.comments_dir))
        }

        data_keys = set(report_path_by_key) | set(comment_paths) | set(reports) | set(comments)
        for key in sorted(data_keys):
            if key in common_keys:
                continue
            old_fingerprint = manifest.get(key)
            new_fingerprint = current_manifest.get(key)
            invalid = key in self._invalid_paths
            if old_fingerprint == new_fingerprint and not invalid:
                continue

            existed = old_fingerprint is not None
            if new_fingerprint is None:
                removed = False
                if key in reports:
                    reports.pop(key, None)
                    removed = True
                if key in comments:
                    comments.pop(key, None)
                    removed = True
                manifest.pop(key, None)
                self._invalid_paths.discard(key)
                warnings = self._remove_warning(warnings, key)
                if removed or existed:
                    deleted_count += 1
                    changed_state = True
                continue

            repository = DailyReportRepository(settings, self._base_dir)
            read_started = perf_counter()
            try:
                if key in report_path_by_key:
                    target_id, path = report_path_by_key[key]
                    reports[key] = repository.load_report_partition(path, target_id)
                elif key in comment_paths:
                    path = comment_paths[key]
                    comments[key] = repository.load_comment_partition(
                        path, set(target_ids)
                    )
                else:
                    continue
                manifest[key] = new_fingerprint
                self._invalid_paths.discard(key)
                warnings = self._remove_warning(warnings, key)
                csv_read_count += 1
                if existed:
                    changed_count += 1
                else:
                    added_count += 1
                changed_state = True
            except Exception as exc:
                failed_count += 1
                warnings = self._merge_warning(warnings, key, str(exc))
                logger.warning(
                    "Failed to refresh cached CSV path=%s", key, exc_info=True
                )
            finally:
                csv_read_duration_ms += (perf_counter() - read_started) * 1000

        result = RefreshResult(
            changed=changed_count,
            added=added_count,
            deleted=deleted_count,
            failed=failed_count,
        )
        if changed_state or failed_count:
            refreshed = self._replace_snapshot(
                snapshot,
                common=common,
                common_revisions=common_revisions,
                report_partitions=reports,
                comment_partitions=comments,
                file_manifest=manifest,
                target_employee_ids=target_ids,
                migration_required=migration_required,
                warnings=warnings,
            )
            self._snapshot = refreshed
            status = "refreshed"
        else:
            refreshed = snapshot
            status = "unchanged"

        logger.info(
            "daily-report cache generation=%s status=%s manifest_scan_ms=%.2f csv_reads=%s csv_read_ms=%.2f changed=%s added=%s deleted=%s failed=%s",
            refreshed.generation,
            status,
            manifest_scan_duration_ms,
            csv_read_count,
            csv_read_duration_ms,
            result.changed,
            result.added,
            result.deleted,
            result.failed,
        )
        return CacheAccess(refreshed, status, result)

    def _reconcile_scope(
        self,
        settings: AppSettings,
        repository: DailyReportRepository,
        reports: dict[str, pl.DataFrame],
        comments: dict[str, pl.DataFrame],
        manifest: dict[str, FileFingerprint],
        old_target_ids: tuple[str, ...],
        new_target_ids: tuple[str, ...],
    ) -> tuple[
        dict[str, pl.DataFrame],
        dict[str, pl.DataFrame],
        dict[str, FileFingerprint],
        tuple[dict[str, str], ...],
        int,
    ]:
        new_reports: dict[str, pl.DataFrame] = {}
        new_comments: dict[str, pl.DataFrame] = {}
        new_manifest = dict(manifest)
        warnings: list[dict[str, str]] = []
        reads = 0
        old_report_keys = {
            self._path_key(path)
            for path in self._report_paths(settings, old_target_ids).values()
        }
        new_report_paths = self._report_paths(settings, new_target_ids)
        new_report_keys = {
            self._path_key(path) for path in new_report_paths.values()
        }
        for key in old_report_keys - new_report_keys:
            new_manifest.pop(key, None)
            self._invalid_paths.discard(key)

        for target_id, path in new_report_paths.items():
            key = self._path_key(path)
            if key in reports:
                new_reports[key] = reports[key]
                continue
            if not path.exists():
                continue
            try:
                new_reports[key] = repository.load_report_partition(path, target_id)
                fingerprint = self._fingerprint(path)
                if fingerprint is not None:
                    new_manifest[key] = fingerprint
                reads += 1
            except Exception as exc:
                warnings.append(self._warning(path, exc))

        comment_keys = set(comments)
        for key in comment_keys:
            new_manifest.pop(key, None)
        new_target_set = set(new_target_ids)
        if new_target_set:
            for path in self._csv_files(Path(settings.comments_dir)):
                key = self._path_key(path)
                try:
                    new_comments[key] = repository.load_comment_partition(
                        path, new_target_set
                    )
                    fingerprint = self._fingerprint(path)
                    if fingerprint is not None:
                        new_manifest[key] = fingerprint
                    reads += 1
                except Exception as exc:
                    old_frame = comments.get(key)
                    if old_frame is not None:
                        new_comments[key] = self._filter_comment_frame(
                            old_frame, new_target_set
                        )
                    warnings.append(self._warning(path, exc))

        return (
            new_reports,
            new_comments,
            new_manifest,
            tuple(warnings),
            reads,
        )

    def _scan_manifest(
        self, settings: AppSettings, target_employee_ids: tuple[str, ...]
    ) -> dict[str, FileFingerprint]:
        manifest: dict[str, FileFingerprint] = {}
        paths = [
            *self._common_paths(settings).values(),
            *self._report_paths(settings, target_employee_ids).values(),
            *self._csv_files(Path(settings.comments_dir)),
        ]
        for path in paths:
            fingerprint = self._fingerprint(path)
            if fingerprint is not None:
                manifest[self._path_key(path)] = fingerprint
        return manifest

    @staticmethod
    def _changed_keys(
        old: dict[str, FileFingerprint], new: dict[str, FileFingerprint]
    ) -> set[str]:
        return {
            key
            for key in set(old) | set(new)
            if old.get(key) != new.get(key)
        }

    @staticmethod
    def _filter_comment_frame(
        frame: pl.DataFrame, target_employee_ids: set[str]
    ) -> pl.DataFrame:
        if frame.is_empty() or not target_employee_ids:
            return frame.head(0)
        if "subordinate_employee_id" not in frame.columns:
            return frame.head(0)
        return frame.filter(
            pl.col("subordinate_employee_id").cast(pl.String).is_in(
                sorted(target_employee_ids)
            )
        )

    @staticmethod
    def _common_paths(settings: AppSettings) -> dict[str, Path]:
        root = Path(settings.common_dir)
        return {
            "user_master": root / "user_master.csv",
            "team_master": root / "team_master.csv",
            "comment_assignment": root / "comment_assignment.csv",
            "calendar": root / "calendar.csv",
        }

    @staticmethod
    def _migration_flags(repository: DailyReportRepository) -> dict[str, bool]:
        return {
            "user_master": repository.legacy_rank_migration_required,
            "team_master": repository.commenter_assignment_migration_required,
            "organization_schema": repository.organization_schema_migration_required,
            "comment_assignment": repository.commenter_assignment_migration_required,
            "calendar": repository.calendar_migration_required,
        }

    @staticmethod
    def _report_paths(
        settings: AppSettings, target_employee_ids: tuple[str, ...]
    ) -> dict[str, Path]:
        paths: dict[str, Path] = {}
        for target_id in target_employee_ids:
            try:
                paths[target_id] = safe_employee_csv_path(
                    settings.users_dir, target_id
                )
            except ValueError:
                logger.warning(
                    "Ignoring invalid employee id from cached master: %r", target_id
                )
        return paths

    @staticmethod
    def _csv_files(directory: Path) -> list[Path]:
        if not directory.exists():
            return []
        return sorted(
            (
                path
                for path in directory.glob("*.csv")
                if path.is_file()
                and not path.name.startswith((".", "~"))
                and not path.name.lower().endswith((".bak.csv", ".tmp.csv"))
            ),
            key=lambda path: os.path.normcase(str(path)),
        )

    @staticmethod
    def _fingerprint(path: Path) -> FileFingerprint | None:
        try:
            stat = path.stat()
        except FileNotFoundError:
            return None
        if not path.is_file():
            return None
        return FileFingerprint(size=stat.st_size, mtime_ns=stat.st_mtime_ns)

    @staticmethod
    def _path_key(path: Path | str) -> str:
        return os.path.normcase(str(Path(path).resolve(strict=False)))

    def _settings_paths(self, settings: AppSettings) -> tuple[str, str, str]:
        return (
            self._path_key(settings.users_dir),
            self._path_key(settings.comments_dir),
            self._path_key(settings.common_dir),
        )

    @staticmethod
    def _warning(path: Path | str, error: Exception) -> dict[str, str]:
        return {"file": str(path), "error": str(error)}

    @staticmethod
    def _warning_matches(item: dict[str, str], key: str) -> bool:
        file_value = str(item.get("file", ""))
        if file_value == key:
            return True
        return Path(key).name == Path(file_value).name

    def _remove_warning(
        self, warnings: tuple[dict[str, str], ...], key: str
    ) -> tuple[dict[str, str], ...]:
        return tuple(
            item for item in warnings if not self._warning_matches(item, key)
        )

    def _merge_warning(
        self,
        warnings: tuple[dict[str, str], ...],
        key: str,
        error: str,
    ) -> tuple[dict[str, str], ...]:
        return (
            *self._remove_warning(warnings, key),
            {"file": key, "error": error},
        )

    def _merge_warnings(
        self,
        existing: tuple[dict[str, str], ...],
        incoming: tuple[dict[str, str], ...],
    ) -> tuple[dict[str, str], ...]:
        merged = existing
        for warning in incoming:
            merged = self._merge_warning(
                merged,
                str(warning.get("file", "")),
                str(warning.get("error", "")),
            )
        return merged

    def _replace_snapshot(
        self, snapshot: CacheSnapshot, **changes: Any
    ) -> CacheSnapshot:
        return replace(
            snapshot,
            generation=self._next_generation(),
            built_at=datetime.now(),
            **changes,
        )

    def _next_generation(self) -> int:
        self._generation += 1
        return self._generation
