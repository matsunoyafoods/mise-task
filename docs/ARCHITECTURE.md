# MISE TASK — システムアーキテクチャ

## コンポーネント構成

```
AppInner（メインコンポーネント）
├── Dashboard            ダッシュボード
├── PrepView             仕込みタスク
├── CleanView            クリーニングタスク
├── OrderView            発注管理
│   ├── IssueSupplierModal   業者QR発行
│   └── SupplierSelfRegModal 業者セルフ登録
├── InventoryView        在庫管理
├── TaskManagerView      タスク管理
├── OpsCheckView         開閉店チェック
├── CommissionView       評価・コミッション
├── AIInputView          AI自動入力
└── StaffView            スタッフ管理
    └── StoreSection     店舗管理
```

## State管理

すべてのStateはAppInner（ルートコンポーネント）で管理し、
propsでバケツリレーする構成（Context不使用）。

useLS()カスタムフックでlocalStorageと同期。

## LINE連携フロー

### 業者登録
1. 本部が「＋ 業者登録QR発行」→ 業者名入力 → QR/URL生成
2. 業者にQR/URLを送付（メール/LINE/FAX等）
3. 業者がURLアクセス → supplier-reg.html が表示
4. 3ステップで受注情報を登録（会社情報・方法選択・ID入力）
5. LINE選択時: 公式アカウントを友だち追加 → User IDが届く

### 発注
1. 在庫が最低在庫を下回ると発注候補に自動追加
2. 業者ごとにまとめて「発注する」
3. 確認モーダルで「LINEに自動送信する」ボタン押下
4. /.netlify/functions/send-line にPOST
5. LINE Messaging API経由で業者のLINEに発注内容が届く

## API エンドポイント

| エンドポイント | メソッド | 概要 |
|--------------|---------|------|
| `/.netlify/functions/send-line` | POST | LINE Push送信 |
| `/.netlify/functions/line-webhook` | POST | LINE Webhook受信 |

### send-line リクエスト形式

```json
{
  "userId": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "orderText": "【発注書】2026/03/06\n田中青果株式会社 御中\n\n・キャベツ  10kg\n・長ネギ  5kg\n\n以上、よろしくお願いいたします。",
  "supplierName": "田中青果株式会社"
}
```

## データモデル

### User（スタッフ）
```json
{
  "id": 1,
  "name": "山田太郎",
  "role": "スタッフ",  // 本部 / 店長 / スタッフ / アルバイト
  "store": 1,
  "color": "#E85D04",
  "avatar": "山"
}
```

### Store（店舗）
```json
{
  "id": 1,
  "name": "新宿本店"
}
```

### Supplier（業者）
```json
{
  "id": "s1",
  "name": "田中青果株式会社",
  "contactName": "田中 一郎",
  "tel": "090-1234-5678",
  "orderMethods": ["line", "email"],
  "contact": "order@tanaka.co.jp",
  "lineId": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "token": "tok_1234567890",
  "selfRegistered": true,
  "registeredAt": "2026/03/06"
}
```

### Order（発注）
```json
{
  "id": "o1234567890",
  "supplierId": "s1",
  "storeId": 1,
  "items": [
    { "itemId": "inv1", "name": "キャベツ", "qty": 10000, "unit": "g", "unitPrice": 150 }
  ],
  "status": "sent",   // sent / delivered
  "sentAt": "2026-03-06T10:00:00.000Z",
  "deliveredAt": null,
  "sendMethod": "line",
  "inspected": false,
  "inspectionLog": []
}
```

### InventoryItem（在庫）
```json
{
  "id": "inv1",
  "name": "キャベツ",
  "unit": "g",
  "stock": 5000,
  "minStock": 3000,
  "orderQty": 10000,
  "unitPrice": 150,
  "supplierId": "s1",
  "storeId": 1
}
```
