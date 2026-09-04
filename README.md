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

保存先は設定画面では変更できません。配布した `storage.example.ini` をアプリ（`NIPPO.exe`）と同じフォルダの `storage.ini` にコピーし、`[storage]` の `root_path` に共有ルートを設定してからアプリを起動してください。変更は外部で `storage.ini` を置換し、アプリを再起動して反映します。

`storage.example.ini` は配布用の設定例です。実際の `storage.ini` と `settings.ini` は環境・個人設定を含むためGit管理しません。`settings.ini` は表示や未コメント集計などの個人/UI設定だけを保持します。

## 管理者機能

管理画面は、`user_master.csv` の `is_admin` が `1` の正社員だけが利用できます。`is_admin` が `1` でも派遣社員は管理者として扱われず、管理APIも処理を拒否します。初回の管理者登録は、運用担当者が `user_master.csv` の該当ユーザーを正社員として登録し、`is_admin` に `1` を設定してください。

## 管理と組織・コメント担当

共有ルート直下には次の固定フォルダを用意します（アプリは不足フォルダを自動作成しません）。

- `common_data`: `user_master.csv`、`team_master.csv`、`comment_assignment.csv`、`calendar.csv`
- `supervisor_comments`: 上司IDごとのコメントCSV
- `regular_employee_reports`: 正社員の日報CSV
- `temporary_employee_reports`: 派遣社員の日報CSV

共通情報の `employment_type` に応じて日報フォルダを選択します。派遣社員の画面では正社員日報フォルダを確認・走査しません。

- `team_master.csv`: `team_id,team_name,team_type,parent_team_id,sort_order`
- `user_master.csv`: `employee_id,display_name,can_input_own_report,employment_type,is_admin,affiliation_type,organization_id,member_order`
- `comment_assignment.csv`: `commenter_employee_id,target_type,target_organization_ids,target_employee_ids`
- `calendar.csv`: `date`

### 課・係とユーザー所属

通常組織は `department`（課）と `section`（係）の2階層だけです。課は親を持たず、係は必ず1つの課を親に持ちます。組織IDは1始まりの整数を自動生成し、削除済みの番号は再利用できます。IDは画面から変更できません。同一親の直下に同名組織は作成できません。

ユーザーは `affiliation_type=organization` で課または係へ所属するか、`affiliation_type=director` で部長になります。部長は通常組織へ所属せず、`organization_id` は空、`can_input_own_report` は必ず `0` です。所属未設定のユーザーは保存できません。派遣社員は管理者・コメント担当者にできませんが、`target_type=none` の正規化行は保持できます。

チーム管理では、課・係の作成、ユーザーの所属移動、組織内の並び替えを行います。組織順は `sort_order`、直接所属ユーザー順は `member_order` に保存され、保存時に10、20、30の連番へ正規化されます。日報行とコメント担当者列は、課ごとに「配下の係所属者→課直所属者」の順で表示し、部長列は最後尾です。

### コメント担当

コメント担当はユーザー管理で設定し、`comment_assignment.csv` へ保存します。`target_type` は次のいずれかです。

- `none`: コメント担当なし
- `organization`: 許可された課または係を1つ指定
- `custom`: 所属範囲内の日報入力ユーザーを複数指定
- `departments`: 部長だけが使用できる複数課指定

係所属者は自係または親課を組織指定でき、個別指定は自係の直接所属者に限られます。課直所属者は自課または配下係を組織指定でき、個別指定は自課全体から選べます。部長は複数課だけを指定します。解決後の対象は、日報入力が有効で、部長ではなく、担当者本人でもないユーザーだけです。

同じ日報ユーザーを複数人が担当する場合は、担当者ごとに独立したコメント列と未確認状態を生成します。表示可否は常に現在の担当設定で決まり、担当解除後は過去コメント列も非表示になります。CSV上の過去コメントは削除せず、同じ担当関係を再設定すると再表示します。

所属変更時は、そのユーザーのコメント担当設定を `none` へ戻します。チーム・ユーザー・コメント担当の保存はリビジョン競合を確認し、3ファイルを1つの論理トランザクションとして置換します。途中で失敗した場合は3ファイルとも元へ戻します。保存後はキャッシュ内の所属・対象対応表、日報表示範囲、コメント列、未確認集計を再計算します。

### 部長の週次コメント

部長は日次コメントを行いません。月曜始まりの各週について金曜を候補とし、休日なら木曜、水曜、火曜、月曜の順に繰り上げた最終稼働日だけに「サイン」「コメント入力」を表示します。月曜から金曜がすべて休日の週には入力日を作りません。

部長の未確認ボタンは件数ではなく、現在の対象ユーザーごとに「前回の空でないコメント翌日から今日まで」を数えた稼働日数の最大値を表示します。一部ユーザーへサインした後も、未確認ユーザーが残ればその最大値を維持します。未確認フィルターは経過稼働日数が1日以上の対象者だけを表示し、全対象者が0日になった時点で解除します。

### 日報フィルターと権限

課フィルターは課直所属者と配下の係所属者、係フィルターはその係の直接所属者を表示します。個人フィルターは日報行と同じ全体順です。本人は「自分」でだけ表示し、「全員」・課・係・個人には含めません。本人の日報入力が有効なら、表示設定で個人フィルターを隠しても「自分」は常に表示します。

派遣社員の日報画面は本人の日報だけを対象とし、他ユーザーの閲覧・コメント更新をサーバー側でも拒否します。通常ユーザーの未確認日数は従来どおり、設定した集計開始日、カレンダー休日、当日を含める設定に基づいて算出します。

### 旧データからの移行

旧 `large` は課候補、親が `large` の `medium` は係候補として管理画面へ展開します。意味が一意でない `small`、不正な親子関係、所属先を確定できないユーザー、旧チーム側コメント担当は自動確定しません。管理画面に移行案内を表示し、管理者が課・係所属とユーザー別コメント担当を確認してから新形式で保存します。既存のコメント・返信CSVは変更しません。

管理画面の稼働日カレンダーは4月1日から翌年3月31日までを1年度として表示します。`calendar.csv` は休日の日付だけを保持し、行がない平日は稼働日として扱います。従来の `date,is_holiday,description` 形式は読み込み時に休日行だけへ変換され、次回保存時に1列形式へ移行します。

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
