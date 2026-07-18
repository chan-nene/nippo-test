# NIPPO

CSVをデータストアとして利用する、pywebview製の日報入力・上司コメント用デスクトップアプリです。

## 必要環境

- Windows
- Python 3.13
- Microsoft Edge WebView2 Runtime

## セットアップ

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python .\main.py
```

初回起動時に設定画面が開きます。日報、上司コメント、共通マスターの各フォルダを指定してください。

`settings.example.ini` は配布用の空ファイルです。実際の `settings.ini` はローカル設定を含むためGit管理しません。

## Pythonテスト

```powershell
python -m unittest discover -s tests -v
```

## UI検証

```powershell
npm install
npx playwright install chromium
npm run test:ui
```

## WebViewセキュリティ検証

Windows上で非表示のWebView2を起動し、CSP下でもPythonブリッジが動作することと、外部URL・新規ウィンドウへの遷移が遮断されることを確認します。

```powershell
python .\tools\verify-webview-security.py
```

## 依存関係の更新

`pywebview`は、Windowsで検証したバージョンを`requirements.txt`へ完全固定します。更新時はバージョンを書き換えて再インストールし、Pythonテスト、UI検証、WebViewセキュリティ検証をすべて実行してください。検証せずに`>=`などの可変範囲へ戻さないでください。

## IME診断ログ

セル編集時のIMEイベントは、`logs/ime-diagnostics.jsonl`へ記録されます。入力内容、氏名、日付は記録せず、イベント順序、変換状態、フォーカス、文字数、選択位置、入力欄の高さだけを保存します。イベントはブラウザー内で一時的にバッファし、変換中にはPython側へ送信しません。ログは約1MBでローテーションし、直近3ファイルまで保持します。

## ディレクトリ

- `app/`: Pythonアプリケーションコード
- `web/`: HTML、CSS、JavaScript
- `tests/`: Python自動テスト
- `tools/`: UI検証ツール

## ライセンス

現在、ライセンスは未指定です
