# NIPPO

CSVをデータストアとして利用する、pywebview製の日報デスクトップアプリです。

## 必要環境

- Windows
- Python 3.13
- Microsoft Edge WebView2 Runtime

## セットアップ

ルートフォルダを`storage.ini` に記載してからアプリを起動してください

## ルートフォルダ配下のフォルダ/ファイル構成

- `common_data`: `user_master.csv`、`team_master.csv`、`comment_assignment.csv`、`calendar.csv`
- `supervisor_comments`: employee_idごとのコメントCSV
- `regular_employee_reports`: employee_idごとの日報CSV
- `temporary_employee_reports`: employee_idの日報CSV

## CSVファイルのスキーマ

アプリからのCSV保存は、Excelで日本語を開けるようUTF-8 BOM付きで行います。既存のBOMなしUTF-8・CP932のCSVも読み込み可能で、次回保存時にUTF-8 BOM付きになります。

- `user_master.csv`:　`employee_id,display_name,can_input_own_report,employment_type,is_admin,affiliation_type,organization_id,member_order`
- `team_master.csv`: `team_id,team_name,team_type,parent_team_id,sort_order`
- `comment_assignment.csv`: `commenter_employee_id,target_type,target_organization_ids,target_employee_ids`
- `calendar.csv`: `date`

## 使用するJavaScriptライブラリ

WebView内では、次のライブラリを `web/vendor/` に配置して使用します。ライブラリ本体、ロケール、ライセンスファイルはGit管理せず、利用者が各自で公式配布元からダウンロードしてください。

- [Flatpickr](https://flatpickr.js.org/) `4.6.13` — 日付入力カレンダー。MIT License
- [Tabulator](https://tabulator.info/) `6.5.2` — 管理画面の一覧表示・並び替え・検索。MIT License
- [SortableJS](https://sortablejs.github.io/Sortable/) `1.15.7` — 組織・所属ユーザーのドラッグ＆ドロップによる並び替え。MIT License

Flatpickrの日本語表示には、Flatpickr `4.6.13` に対応する日本語ロケール `l10n/ja.js` を使用します。各ライブラリのライセンス本文も、ダウンロード元の同じバージョンから取得して `web/vendor/` に配置してください。

## ライセンス

現在、ライセンスは未指定です
