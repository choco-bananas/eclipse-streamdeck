# Eclipse HCI – Stream Deck Plugin

Clear-Com Eclipse HX インターカムマトリクスを Stream Deck で操作するプラグイン。

HCI 2.0 プロトコル（TCP）で Eclipse に直接接続し、以下を制御できます。

| 機能 | Stream Deck 操作 |
|---|---|
| クロスポイント Make / Break | ボタン押下（トグル） |
| クロスポイントレベル調整 | ロータリーエンコーダー回転 |
| 0 dB リセット | エンコーダー押し込み |
| ミュート（-72 dB）切替 | エンコーダータッチ |

---

## 必要環境

- Windows 10/11
- Stream Deck ソフトウェア v6.4 以上（Stream Deck+ 推奨）
- Clear-Com Eclipse HX（HCI ライセンス有効）
- Node.js v20 以上

---

## プロジェクト構成

```
eclipse-streamdeck/
├── bridge/          # HCI ブリッジ（単独起動可能な WebSocket サーバー）
│   └── src/
│       ├── hci-protocol.ts   HCI 2.0 パケットビルダー/パーサー
│       ├── hci-client.ts     TCP クライアント（自動再接続付き）
│       └── server.ts         WebSocket サーバー (ws://localhost:8765)
└── plugin/          # Stream Deck プラグイン
    ├── src/
    │   ├── hci/
    │   │   ├── protocol.ts   HCI プロトコル（プラグイン内蔵）
    │   │   └── client.ts     HCI TCP クライアント（シングルトン）
    │   ├── actions/
    │   │   ├── crosspoint-action.ts  クロスポイント トグルボタン
    │   │   └── level-action.ts       レベル エンコーダー
    │   └── plugin.ts         プラグインエントリポイント
    └── com.mtcjapan.eclipsehci.sdPlugin/
        ├── manifest.json
        └── pi/               Property Inspector（設定画面）
            ├── crosspoint.html
            └── level.html
```

---

## セットアップ

### 1. プラグインのビルド

```powershell
cd plugin
npm install
npm run build
```

### 2. Stream Deck にインストール

ビルド後、`plugin/com.mtcjapan.eclipsehci.sdPlugin` フォルダを  
`%APPDATA%\Elgato\StreamDeck\Plugins\` にコピーしてください。

Stream Deck を再起動すると「Eclipse HCI」カテゴリが追加されます。

### 3. HCI ブリッジ（オプション）

Stream Deck 以外のアプリからも Eclipse を操作したい場合：

```powershell
cd bridge
npm install
npm run build
# Eclipse IP を指定して起動
ECLIPSE_HOST=192.168.1.10 node dist/server.js
```

WebSocket API: `ws://localhost:8765`

---

## 使い方

### クロスポイントボタン
1. Stream Deck の「Crosspoint Toggle」アクションをボタンに追加
2. 設定画面で **From Port**（ソース）と **To Port**（デスティネーション）を入力
3. Eclipse の IP アドレスと HCI ポート（52001）を設定
4. ボタンを押すたびに Make ↔ Break がトグル

### レベルエンコーダー（Stream Deck+）
1. 「Crosspoint Level」アクションをエンコーダーに追加
2. ポート番号、ステップ幅（dB/クリック）を設定
3. ダイヤルを回してレベル調整
4. 押し込みで 0 dB にリセット
5. タッチでミュート切替

---

## HCI プロトコル詳細

- **通信**: TCP、ポート 52001–52020
- **パケット**: `[Start=0x5A0F][Length][MsgID][Flags=0x08][Magic=0xABBACEDE][Schema=0x01][Data][End=0x2E8D]`
- **ポート番号**: HCI は 0 始まり（EHX 表示の Port 1 = HCI Port 0）
- **ゲイン計算**: `gain_dB = (level_value − 204) × 0.355`（Appendix A）
- **参考文書**: HCI Reference 399G175 Rev F

---

## ライセンス

MIT
