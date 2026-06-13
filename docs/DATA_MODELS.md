# データモデル定義 — MISE TASK

## User（スタッフ）
```typescript
interface User {
  id: number;
  name: string;
  role: "本部" | "店長" | "スタッフ" | "アルバイト";
  store: number;        // Store.id
  color: string;        // アバターカラー（HEX）
  avatar: string;       // アバター文字（名前の1文字）
  commission?: number;  // コミッション率（%）
}
```

## Store（店舗）
```typescript
interface Store {
  id: number;
  name: string;
}
```

## Supplier（業者）
```typescript
interface Supplier {
  id: string;           // "s" + timestamp
  name: string;
  contactName?: string; // 担当者名
  tel?: string;
  token: string;        // "tok_" + timestamp（QR/URL用）
  orderMethods: Array<"email"|"line"|"instagram"|"twitter"|"other">;
  contact?: string;     // メールアドレス
  lineId?: string;      // LINE User ID（"U"から始まる）またはLINE ID
  instagramId?: string; // @username
  twitterId?: string;   // @username
  otherDesc?: string;   // その他の受注方法説明
  selfRegistered: boolean;
  registeredAt?: string; // "YYYY/MM/DD"
  // 旧フィールド（後方互換）
  sendMethod?: string;
  fax?: string;
}
```

## InventoryItem（在庫）
```typescript
interface InventoryItem {
  id: string;
  name: string;
  unit: string;         // "g" | "kg" | "本" | "枚" など
  stock: number;        // 現在在庫
  minStock: number;     // 最低在庫（これを下回ると発注候補）
  orderQty: number;     // 発注量
  unitPrice: number;    // 単価（円）
  supplierId: string;   // Supplier.id
  storeId: number;      // Store.id
}
```

## Order（発注）
```typescript
interface Order {
  id: string;           // "o" + timestamp
  supplierId: string;
  storeId: number;
  items: Array<{
    itemId: string;
    name: string;
    qty: number;
    unit: string;
    unitPrice: number;
  }>;
  status: "sent" | "delivered";
  sentAt: string;       // ISO 8601
  deliveredAt: string | null;
  sendMethod: string;
  inspected: boolean;
  inspectionLog: Array<{
    itemId: string;
    received: number;
    note?: string;
  }>;
}
```

## Routine（ルーティンタスク設定）
```typescript
interface Routine {
  id: string;
  name: string;
  category: "prep" | "clean";
  store: number;
  freq: "daily" | "weekday" | "custom" | "once";
  customDays: number[]; // 0=日, 1=月, ...6=土
  onceDate: string;     // "YYYY-MM-DD"（onceの場合）
  deadline: string;     // "HH:MM" or "閉店後" etc.
  assignedTo: number | null; // User.id
  recipeId: string;
  order: number;
  active: boolean;
}
```

## PrepTask（仕込みタスク実績）
```typescript
interface PrepTask {
  id: string;
  routineId: string;
  name: string;
  store: number;
  date: string;         // "YYYY-MM-DD"
  deadline: string;
  assignedTo: number | null;
  recipeId: string;
  completedAt: string | null;  // ISO 8601
  completedBy: number[];
  carriedFrom?: string; // 繰り越し元タスクID
}
```

## OpsCheckItem（開閉店チェック項目）
```typescript
interface OpsCheckItem {
  id: string;
  label: string;
  category: "open" | "close";
  checkedAt: string | null;  // ISO 8601
  checkedBy: number | null;  // User.id
}
```

## PriceHistory（単価変更履歴）
```typescript
interface PriceHistory {
  itemId: string;
  date: string;    // "YYYY/MM/DD"
  price: number;
}
```

