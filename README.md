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

- `user_master.csv`:　`employee_id,display_name,can_input_own_report,employment_type,is_admin,affiliation_type,organization_id,member_order`
- `team_master.csv`: `team_id,team_name,team_type,parent_team_id,sort_order`
- `comment_assignment.csv`: `commenter_employee_id,target_type,target_organization_ids,target_employee_ids`
- `calendar.csv`: `date`

## 使用するJavaScriptライブラリ

- Flatpickr
- Tabulator
- SortableJS

## ライセンス

現在、ライセンスは未指定です
