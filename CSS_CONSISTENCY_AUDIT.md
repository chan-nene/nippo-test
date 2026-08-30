# CSS 表示一貫性監査（リファクタリング前）

## 前提

- 対象は `web/styles.css`、`web/reports.css`、`web/settings.css`、`web/admin.css` の全行。
- 読み込み順は `styles.css → reports.css → settings.css → admin.css`。
- 表中の値は、同一セレクターへの後段上書きを反映した「現在の実効値」。
- 色は `Light / Dark` の順で併記する。
- アプリの初期文字サイズ設定は `large`。したがって初期表示では UI 基本文字が 16px、共通コントロール高が 40pxになる。
- `file://` のローカル画面はブラウザー制約により直接計測できなかったため、今回は CSS のカスケードを静的に追跡した監査である。

## 4ファイルの役割と依存

| ファイル | 現在の主責務 | 他ファイルへの依存・影響 |
|---|---|---|
| `styles.css` | 全画面の色、文字、寸法トークン、シェル、共通部品 | 3画面すべての基底。文字サイズモードから各画面を `!important` で上書きする箇所もある |
| `reports.css` | 日報画面、ツールバー、期間操作、表 | 共通トークンを利用しつつ、独自の `--report-*` 色を追加。設定画面の保存ボタンにも一部流入 |
| `settings.css` | 設定フォーム、テーマ選択、既定期間 | 共通トークンと `reports.css` の `.toolbar-button` に依存。後半の Graphite ブロックが前半を大量に上書き |
| `admin.css` | ユーザー、カレンダー、組織ツリー、各ダイアログ | 共通トークンに加え `--org-*` を持つ。後半で `--org-*` を共通トークンへ再マッピング |

## 色の横並び比較

| 表示用途 | 共通シェル | 日報 | 設定 | 管理（ユーザー・組織） | 管理（カレンダー） |
|---|---|---|---|---|---|
| 外側 canvas | `#f7f7f8 / #212121` | `#f7f7f8 / #212121` | `#f7f7f8 / #212121` | admin panel内は `#fff / #212121` | 同左 |
| 主 surface | `#fff / #212121` | `#fff / #212121` | `#fff / #212121` | `#fff / #212121` | 同左 |
| 補助 surface | `oklch(95% 0.004 260) / #282828` | 期間領域は `#ededed / #0d0d0d` | 基本は共通 surface | `--org-subtle` 経由で共通 soft | 同左 |
| hover | `#ebebed / #292929` | 操作ごとに共通または独自色 | `#ebebed / #292929` | `#ebebed / #292929` | 同左 |
| active / soft | `#e4e4e6 / #303030` | フィルター選択 `#343434 / #4a4a4a` | 選択枠が中心 | `#e4e4e6 / #303030` | 同左 |
| 本文 | `#242424 / #d1d1d1` | 共通 text | 共通 text | 共通 text | 共通 text |
| 強い文字 | `#111 / #e5e5e5` | 共通 strong | 共通 strong | 共通 strong | 共通 strong |
| 補助文字 | `#686868 / #afafaf` | 共通 muted（一部独自） | 共通 muted | 共通 muted | 共通 muted |
| border | `#dedee1 / white 12%` | 原則共通 | 共通 | 共通 | 共通 |
| strong border | `#b8b8bc / white 25%` | 原則共通 | 入力欄で使用 | 共通 | 共通 |
| 主操作背景 | `#242424 / #e3e3e3` | `#343434 / #e3e3e3` | 保存は共通 primary | 共通 primary | 共通 primary |
| 主操作文字 | `#fff / #161616` | `#fff / #161616` | 共通 primary-on | 共通 primary-on | 共通 primary-on |
| 表ヘッダー | `#f9f9f9 / #181818` | `#f9f9f9 / #181818` | 対象なし | 共通 surface 系 | 共通 surface 系 |
| 休日 | 共通は青みのある token | `#f4f4f5 / #263241` | 対象なし | 対象なし | `#e6e6e6 / #263241` |
| dirty / 編集中 | `#fef3c7 / amber 15%` | 同左 | エラー色を使用 | 管理固有の状態色あり | 管理固有の状態色あり |
| エラー | `oklch(52% 0.22 27) / #ff8a8a` | 共通 | 共通 | 共通中心 | 共通中心 |

### 色の評価

- 本文、強い文字、補助文字、border、Dark の基調色は概ね共通化されている。
- Light の主操作だけ、日報が `#343434`、共通・設定・管理が `#242424` で一致していない。
- Light の休日背景は日報 `#f4f4f5`、管理カレンダー `#e6e6e6` で一致していない。Dark は双方とも `#263241`。
- 設定と管理は canvas と surface の階層差が弱く、Dark では両方が `#212121` になるため面の境界を border に依存している。
- 日報の期間操作・フィルターに独自のグレー体系があり、共通の interactive / primary token と二重管理になっている。

## 文字・高さ・角丸の横並び比較

| 表示用途 | 共通シェル | 日報 | 設定 | 管理 |
|---|---|---|---|---|
| フォント | IBM Plex Sans / IBM Plex Sans JP / Yu Gothic UI | 共通を継承 | 共通を継承 | 共通を継承 |
| 初期 UI 文字 | 16px（large） | 操作・表の主要文字は概ね16px | label/input/button は概ね16px | 主要 control は概ね16px |
| 初期 control 高 | 40px | 40px | 保存40px、text/date inputは固定38px、rangeは32px | 入力35px、検索34px、保存40px、その他ボタンはmin 34pxが混在 |
| 標準 control 高 | 32px | 32px | 保存32px、inputは固定38px | 入力35px、検索34px、保存32px |
| 入力欄 radius | 5px | 日付外枠8px、textarea3px | 5px | 主に8px系 |
| 主要 button radius | 5px | 8px、期間内側6px、メンバーpill | 保存5px、選択肢5/10px | 主に8px、dialog/cardは12pxも使用 |
| card / panel radius | 8px | 表は実質フラット | settings cardは最終0 | `--org-radius-sm/md` の8/12px |
| panel padding | 共通 contentは `6px 8px 8px` | toolbar `12px 18px 10px` | `28px 34px 40px` | 領域別に独自。組織cardは最終 `10px 11px` |
| 表 row / header | largeで50 / 43px | 50 / 43px | 対象なし | 一覧・カレンダーで独自の密度 |
| 見出し階層 | token 10〜18pxをprofile別に拡大 | titleはlargeで18px相当 | standard以外ではh2/h3が共に `font-18` となる | dialog title 21pxなど独自指定あり |

## 文字サイズプロファイル

| profile | UI基本 | control | table row | table header | 主な cell padding 横/縦 |
|---|---:|---:|---:|---:|---:|
| standard | 14px | 32px | 42px | 36px | 10 / 9px |
| compact | 13px | 30px | 38px | 34px | 8 / 7px |
| medium | 15px | 36px | 46px | 40px | 11 / 10px |
| large（初期値） | 16px | 40px | 50px | 43px | 12 / 11px |
| xlarge | 17px | 44px | 56px | 48px | 14 / 12px |

設定画面の input は全profileで38px、rangeは32pxのままであり、この仕組みから外れている。

## コンポーネント別の代表値

| 画面 | コンポーネント | 背景 / 文字 | 高さ | radius | padding / gap |
|---|---|---|---:|---:|---|
| 日報 | 日付フィールド | surface / text | control | 8px | 横 `--field-padding-x` |
| 日報 | 期間プリセット | `#ededed/#0d0d0d` | control | 外8px、内6px | 外2px、内横10px |
| 日報 | Refresh / Save | surface または report-primary | control | 8px | 横10 / 12px |
| 日報 | メンバー切替 | report filter色 | control | pill | 横16px、gap8px |
| 日報 | 表 | cell surface / text | profile連動 | header端5px | profile連動 |
| 設定 | text/date input | surface / strong | 38px固定 | 5px | profile連動の横padding |
| 設定 | member filter | transparent / strong | min 40px | 5px | 横14px、gap8px |
| 設定 | theme option | transparent / text | auto | 10px | 8px、gap8px |
| 設定 | theme preview | 固定Light/Dark見本 | 54px | 7px | － |
| 管理 | ユーザー検索 / 入力 | surface / text | 34 / 35px | 主に8px | 横paddingは部品別 |
| 管理 | 組織card | surface / text | auto | 8px | 10px 11px |
| 管理 | dialog | surface / text | auto | 12px | header/bodyで独自 |
| 管理 | カレンダー日 | surface系 / text | min 18px級 | 4px | 7px前後 |

## 一貫性を損ねている主な箇所

| 重要度 | Tell（兆候） | 場所 | 影響 | リファクタリング時の扱い |
|---|---|---|---|---|
| Major | 同じ意味のtokenが複数系統 | 共通 `--primary-*` と日報 `--report-*`、管理 `--org-*` | 色変更時に画面ごとの追随漏れが起きる | semantic tokenを共通化し、画面固有tokenは本当に固有な値だけ残す |
| Major | 後段上書きで完成形を作っている | 4ファイル、とくにsettings/admin後半 | 宣言元を読んでも実効値が分からない | 各selectorは原則1か所へ集約し、互換上書きには期限・理由を書く |
| Major | サイズprofileから外れた固定高 | settings input 38px・range 32px、admin input 35px・検索34px | compact/large/xlargeで文字と箱の比率が変わり、同じ画面内でも保存ボタンと揃わない | control size tokenへ統一し、小型controlのみ別semantic tokenを設ける |
| Major | radius体系が画面ごとに異なる | 共通5/8、日報6/8/pill、設定5/7/10、管理8/12 | 同種操作でも見た目が揃わない | `control/card/dialog/pill` の役割別radiusに再定義する |
| Major | 同じ休日状態のLight色が異なる | reports と admin calendar | 同じ意味の状態が別の見え方になる | `--holiday-bg/hover` を1組に統一する |
| Minor | 見出し階層が文字サイズ設定で消える | settings h2/h3 | large等で情報階層が弱くなる | h2/h3を別tokenのままprofile連動させる |
| Minor | 未使用・無効な宣言が残る | `--toolbar-height`、`--settings-padding`、非表示header、無効justify等 | 理解コストと誤修正リスクが増える | 使用実績を検証して削除する |
| Minor | グローバル名のselectorが画面外へ漏れ得る | settings `.field-error`, `.actions` | 後続画面追加時に意図せず衝突する | `#settingsPanel` 等でscopeを限定する |
| Minor | focus表現が重なる可能性 | global `:focus-visible` と settings input focus | 二重ringになる場合がある | focus tokenと責務を共通側へ寄せる |

## 起動中アプリでの表示確認

2026-08-29に、起動中のNIPPOを実際に操作し、1280×800前後のウィンドウで次の表示を確認した。

- 日報：Light / Dark
- 設定：Light / Dark
- 管理：ユーザー、チーム、カレンダー設定（Light）
- 管理：カレンダー設定（Dark）

確認後は、元のLight・日報画面へ戻した。入力、保存、削除などデータを変更する操作は行っていない。

| 画面 | 実画面で確認できた状態 | 静的監査との照合 |
|---|---|---|
| 日報 Light | 上部操作は大きめで、選択filterは濃いグレー。表は白を基調とし、休日行は非常に薄いグレー | 40px control、report独自primary、休日 `#f4f4f5` と整合 |
| 日報 Dark | タイトル・sidebarは黒、作業面は濃いグレー。休日行の青が通常行より明確に目立つ | Darkの `#263241` はLightより状態色として強く知覚される |
| 設定 Light | cardの囲みはなく、横罫線でsectionを分離。入力は横長でフラット。見出しとlabelは太め | 最終的な `settings-card` のborder/radius/padding 0と整合 |
| 設定 Dark | canvasと入力背景の明度差が小さく、入力境界とsection罫線が主な階層表現 | Darkのsurface統合とborder依存を視覚的に確認 |
| 管理・ユーザー | tab、検索、追加button、一覧表の単純な構成。検索欄は日報のcontrolより小さく見える。下部の空白が大きい | 検索34px・入力35pxと、日報40pxとの差を確認 |
| 管理・チーム | 2列構成で組織cardを表示。cardは設定画面より明確にカード型で、残り領域の空白が大きい | admin独自8px card radius、固定幅レイアウトと整合 |
| 管理・カレンダー Light | 6か月×2段。月cardは8px角、日セルはかなり高密度。休日は淡いグレー | 18px級の日セルと `#e6e6e6` の休日背景に整合 |
| 管理・カレンダー Dark | 月cardとcanvasの背景差は小さい。休日の青は日報Darkと同系統で明瞭 | Dark休日色は日報と一貫。Lightだけ日報との濃度差が残る |

### 実画面で優先度が上がった論点

1. **control heightの統一**：large表示で日報40px、設定38px、管理34〜35pxの差が視認できる。最初に揃える価値が高い。
2. **休日状態の強度**：Darkは日報・カレンダーとも青が強く、Lightは薄いグレー。テーマ間で状態の強調度が異なる。
3. **画面ごとの密度差**：日報は大きめ、設定は中間、管理カレンダーは高密度。意図的な密度差として残す部分と、偶発的な固定値を分ける必要がある。
4. **surface表現の統一**：設定はフラット、管理チームはカード型、管理ユーザーは表型。同じcard tokenへ一律統合せず、`form-section`、`organization-card`、`data-table`として役割を分ける方が自然。

## 現時点の結論

色の基礎体系はかなり共通化されており、全面的なデザイン変更は不要。一方で、実際のメンテナンス性を悪化させているのは「4ファイルであること」そのものではなく、後段上書き、意味の重複したtoken、profile外の固定寸法、selectorのscope漏れである。

最初のリファクタリングでは、次の順序が安全である。

1. 現在の見た目を固定する回帰テストまたはcomputed-styleスナップショットを作る。
2. 共通semantic token（surface/text/border/action/state/control/radius）を `styles.css` に定義する。
3. 各画面内の重複selectorを最終実効値へ畳み、不要な前段宣言を削る。
4. settingsの固定高、休日色、primary色、radiusを、意図を確認しながら共通tokenへ寄せる。
5. 画面固有CSSは `#reportPanel`、`#settingsPanel`、`#adminPanel` 配下へscopeする。
