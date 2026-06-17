# airtable-proxy (Cloudflare Worker)

`airtable-proxy.js` = `airtable-proxy.gchota.workers.dev` の**ソース・オブ・トゥルース**。
このファイルが正本。Worker を変更するときは **まずここを編集 → commit → dashboard に貼り付けて Deploy**
(逆順=dashboard 直編集だと repo と乖離するので避ける)。

## ルート
- `GET /v0/{baseId}/{tableId}[/{recordId}]` … Airtable REST proxy(PAT をクライアントから隠す)
- `GET /img/{tableId}/{recordId}/{fieldId}/{attachmentId}?s=large|full` … 安定URL画像proxy
  (Airtable 署名URLの回転で起きる「ロード前テンプレ残り」を解消。1年 immutable cache)

## デプロイ / 復元
1. https://dash.cloudflare.com → Workers & Pages → airtable-proxy → Edit code
2. 全選択削除 → `airtable-proxy.js` を貼り付け → Deploy
3. シークレット **`AIRTABLE_TOKEN`**(read-only Airtable PAT)が必須。値はコード/repo に**置かない**。
   未設定時は Settings → Variables and Secrets → Add (Type=Secret, Name=`AIRTABLE_TOKEN`)。

## バックアップ
このファイルは catalog repo に含まれるため、週次バックアップ(repo clone)で自動的に保存される。
