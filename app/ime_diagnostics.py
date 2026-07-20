from __future__ import annotations

import json
import os
import platform
import sys
import threading
import uuid
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any


MAX_LOG_BYTES = 1_000_000
LOG_BACKUP_COUNT = 2


class ImeDiagnosticRecorder:
    """Write privacy-safe IME event metadata to a small rotating JSONL log."""

    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir.resolve()
        self._log_dir = self._base_dir / "logs"
        self._path = self._log_dir / "ime-diagnostics.jsonl"
        self._session_id = uuid.uuid4().hex[:16]
        self._lock = threading.Lock()
        self._session_started = False

    @property
    def path(self) -> Path:
        return self._path

    def append(self, client: dict[str, str], events: list[dict[str, Any]]) -> int:
        if not events:
            return 0

        with self._lock:
            records: list[dict[str, Any]] = []
            if not self._session_started:
                records.append(
                    {
                        "record_type": "session_start",
                        "recorded_at": _utc_now(),
                        "session_id": self._session_id,
                        "runtime": _runtime_metadata(),
                        "client": client,
                    }
                )
            recorded_at = _utc_now()
            records.extend(
                {
                    "record_type": "ime_event",
                    "recorded_at": recorded_at,
                    "session_id": self._session_id,
                    **event,
                }
                for event in events
            )
            serialized = "".join(
                f"{json.dumps(record, ensure_ascii=False, separators=(',', ':'))}\n"
                for record in records
            )
            self._prepare_log_path()
            self._rotate_if_needed(len(serialized.encode("utf-8")))
            with self._path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(serialized)
            self._session_started = True
        return len(events)

    def _prepare_log_path(self) -> None:
        self._log_dir.mkdir(parents=True, exist_ok=True)
        resolved_log_dir = self._log_dir.resolve()
        resolved_log_dir.relative_to(self._base_dir)
        resolved_path = (resolved_log_dir / self._path.name).resolve()
        resolved_path.relative_to(resolved_log_dir)
        self._log_dir = resolved_log_dir
        self._path = resolved_path

    def _rotate_if_needed(self, incoming_bytes: int) -> None:
        current_bytes = self._path.stat().st_size if self._path.exists() else 0
        if current_bytes + incoming_bytes <= MAX_LOG_BYTES:
            return

        oldest = self._path.with_suffix(f"{self._path.suffix}.{LOG_BACKUP_COUNT}")
        oldest.unlink(missing_ok=True)
        for index in range(LOG_BACKUP_COUNT - 1, 0, -1):
            source = self._path.with_suffix(f"{self._path.suffix}.{index}")
            if source.exists():
                source.replace(
                    self._path.with_suffix(f"{self._path.suffix}.{index + 1}")
                )
        if self._path.exists():
            self._path.replace(self._path.with_suffix(f"{self._path.suffix}.1"))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _runtime_metadata() -> dict[str, str]:
    try:
        pywebview_version = metadata.version("pywebview")
    except metadata.PackageNotFoundError:
        pywebview_version = "unknown"
    if os.name == "nt":
        windows_version = sys.getwindowsversion()
        os_version = (
            f"Windows {windows_version.major}.{windows_version.minor}."
            f"{windows_version.build}"
        )
    else:
        os_version = f"{platform.system()} {platform.release()}"
    return {
        "os": os_version,
        "python": platform.python_version(),
        "pywebview": pywebview_version,
    }
