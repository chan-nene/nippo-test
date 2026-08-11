# NIPPO

CSVをデータストアとして利用する、pywebview製の日報デスクトップアプリです。本人の日報入力、チーム内の日報閲覧、担当部下への上司コメントを1つの画面で扱います。

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

## 共通マスターと所属チーム

共通マスターフォルダでは、次の4ファイルを使用します。アプリ内の「共通マスター」画面から、チーム・ユーザー・上司と部下の関係をまとめて保存できます。

- `team_master.csv`: `team_id,team_name,team_level,parent_team_id,sort_order,is_active`
- `user_master.csv`: `employee_id,display_name,superior_rank,small_team_id,display_order`
- `superior_config.csv`: `superior_employee_id,subordinate_employee_id`
- `calendar.csv`: `date,is_holiday,description`

`team_level` は `large`（大チーム）、`medium`（中チーム）、`small`（小チーム）のいずれかです。大チームには親を設定せず、中チームの親には大チーム、小チームの親には中チームを指定します。ユーザーの `small_team_id` には、有効な小チームのIDだけを設定できます。`sort_order` と `display_order` は整数、`is_active` は `1`（有効）または `0`（無効）です。

既存の `user_master.csv` に新しい列がない場合も読み込めます。先に共通マスター画面でチーム階層を作成し、各ユーザーへ小チームと表示順を割り当てて保存すると新形式へ移行します。`team_master.csv` がない従来環境では、所属未設定のまま従来の担当部下関係だけで表示されます。

日報の閲覧範囲は、ログイン中の本人、現在同じ小チームに所属するメンバー、`superior_config.csv` で現在の担当部下に設定されたユーザーの和集合です。過去の日報も現在の所属を基準に判定します。同じ小チームのメンバーには上司コメントと返信も表示されますが、コメントを編集できるのはその部下を担当する上司だけです。

「未確認」は、設定した集計開始日から今日（設定により今日を除外）までの非休日について、ログイン中の上司が担当部下へコメントしていない日数です。日報本文が未入力の日も数えます。

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
