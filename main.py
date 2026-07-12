from __future__ import annotations

import sys
import os
from pathlib import Path
from typing import Callable

import webview

from app.api import DailyReportApi
from app.instance_lock import SingleInstanceLock

# アプリケーションのベースディレクトリを取得する
def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


# PyInstallerでexeにまとめたときに一時フォルダを使うための処理
def get_asset_dir(base_dir: Path) -> Path:
    bundled_dir = Path(getattr(sys, "_MEIPASS", base_dir))
    web_dir = bundled_dir / "web"
    if web_dir.exists():
        return web_dir
    return base_dir / "web"


def confirm_discard_unsaved() -> bool:
    message = "未保存の変更があります。保存せずに終了しますか？"
    if os.name == "nt":
        import ctypes

        # MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2
        return ctypes.windll.user32.MessageBoxW(None, message, "日報", 0x134) == 6
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        answer = messagebox.askyesno("日報", message, default="no", parent=root)
        root.destroy()
        return bool(answer)
    except Exception:
        return False


def build_closing_handler(
    api: DailyReportApi, confirm: Callable[[], bool] = confirm_discard_unsaved
) -> Callable[..., bool]:
    def on_closing(*_: object) -> bool:
        if not api.has_unsaved_changes:
            return True
        return confirm()

    return on_closing


def show_already_running_message() -> None:
    message = "このユーザーの日報アプリは既に起動しています。"
    if os.name == "nt":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "日報", 0x30)
        return
    print(message)


# アプリケーションのメイン処理
def main() -> None:
    base_dir = get_base_dir()
    # ここから読む
    api = DailyReportApi(base_dir)
    instance_lock = SingleInstanceLock(base_dir / "cache" / "locks", api.employee_id)
    if not instance_lock.acquire():
        show_already_running_message()
        return
    html_path = get_asset_dir(base_dir) / "index.html"
    try:
        window = webview.create_window(
            "日報",
            html_path.as_uri(),
            js_api=api,
            width=1280,
            height=800,
            min_size=(960, 600),
        )
        window.events.closing += build_closing_handler(api)
        webview.start(debug=True)
    finally:
        instance_lock.release()


if __name__ == "__main__":
    main()
