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

## ディレクトリ

- `app/`: Pythonアプリケーションコード
- `web/`: HTML、CSS、JavaScript
- `tests/`: Python自動テスト
- `tools/`: UI検証ツール

## ライセンス

ライセンスは未指定です。公開前に利用・改変・再配布条件を決定し、`LICENSE` を追加してください。
