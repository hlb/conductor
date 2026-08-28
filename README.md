# Conductor

透過 [`agent-browser`](https://github.com/vercel-labs/agent-browser) 唯讀查詢不同活動平台。目前支援 KKTIX 主辦方後台，以及 Luma Calendar 的公開活動與報名狀況。

## 安裝

需要 Node.js 20 以上，以及 Google Chrome。

```sh
npm install
```

## 準備 KKTIX 登入狀態

以下兩種方式擇一即可。

### 方式一：從已登入的 Chrome 初始化

1. 在平常使用的 Chrome 登入 KKTIX，確認能開啟 [platform 活動列表](https://kktix.com/dashboard/organizations/platform/events)。
2. 在 Chrome 開啟 `chrome://inspect/#remote-debugging`，啟用 **Remote debugging／遠端偵錯**。
3. 執行：

```sh
npm run conductor -- kktix auth --auto-connect
```

若 Chrome 詢問是否允許遠端偵錯，請按 **允許**。工具只會保存 KKTIX 網域的 Cookie，接著用全新的 headless session 驗證。看到以下訊息才表示初始化成功：

```text
agent-browser 登入狀態已保存，並已通過全新 headless session 驗證
```

成功後會在專案目錄建立：

```text
.kktix-auth-state.json
.kktix-auth-state.json.meta.json
```

之後可以關閉 Chrome 與遠端偵錯，日常查詢不需要 `--headed`、`--auto-connect` 或 Cookie。

如果最後仍被 Cloudflare 阻擋，代表登入狀態無法移轉到 headless 瀏覽器。此時讓 Chrome 保持開啟，並在每個查詢命令加上 `--auto-connect`。

### 方式二：提供既有的 auth state

將已成功驗證的 `.kktix-auth-state.json` 放在專案根目錄。若來源同時提供 `.kktix-auth-state.json.meta.json`，也請放在相同目錄，以沿用匹配的 Chrome User-Agent。

也可以把檔案放在其他位置，並在命令中指定：

```sh
npm run conductor -- kktix events --auth-state /path/to/.kktix-auth-state.json
```

auth state 等同登入憑證。請將檔案權限設為 `0600`，不要分享、提交到 Git 或貼到對話中：

```sh
chmod 600 .kktix-auth-state.json*
```

## 統一活動報表（建議）

```sh
npm run conductor -- report
```

統一報表會以 Luma Calendar 的未來活動為清單來源：

- Luma 原生活動使用公開的報名人數、剩餘名額與審核狀態。
- 連到 KKTIX 的外部活動會自動解析 event slug，使用既有 KKTIX auth state 補上已售、剩餘、容量與販售狀態。
- 其他外部平台仍會保留在報表，但沒有可取得的售票數字。
- 單一 KKTIX 活動讀取失敗不會中止整張報表，該列會標示「取得失敗」並輸出警告。
- KKTIX 預設以 3 個互相隔離的 headless session 平行查詢；每個 session 用完都會清理。

完整結構化資料與 KKTIX 票種明細可輸出為 JSON：

```sh
npm run conductor -- report --json
```

所有命令都支援 `--silent`（等同 `--quiet`），可隱藏 Conductor 的查詢進度：

```sh
npm run conductor -- report --json --silent
```

若要連 npm 自己的執行標頭也一起隱藏，npm 的 `--silent` 必須放在 script 名稱之前：

```sh
npm run --silent conductor -- report --json --silent
```

如需其他 Luma Calendar 或 KKTIX 組織：

```sh
npm run conductor -- report --calendar <calendar-slug> --organization <organization-slug>
```

可用 `--concurrency` 在 1 到 8 之間調整平行數；通常建議 2 到 4。設為 `1` 可恢復循序查詢：

```sh
npm run conductor -- report --concurrency 3
```

使用 `--auto-connect` 或 `--headed` 時會自動維持循序，避免同時操作日常 Chrome 或開出多個驗證視窗。

## KKTIX 操作

### 列出組織活動

```sh
npm run conductor -- kktix events
```

會列出活動 slug、狀態、日期與名稱，並自動讀取所有分頁。

### 查看單一活動售票狀況

```sh
npm run conductor -- kktix event originals-20261003
```

會顯示活動時間、已售與剩餘數量，以及每個票種的狀態、價格、數量、付款狀態和販售期間。

### 一次取得所有活動的售票狀況

```sh
npm run conductor -- kktix status
```

會先列出組織內全部活動，再以預設 3 個獨立、用完即清理的 agent-browser session 平行取得售票摘要，避免某個頁面的 Cloudflare 驗證污染後續結果。單一活動讀取失敗不會中止整批結果，失敗項目會另外列出。也可用 `--concurrency 1` 改回循序查詢。

若需要每個活動的完整票種明細，使用 JSON：

```sh
npm run conductor -- kktix status --json
```

### 列出目前正在售票的活動

```sh
npm run conductor -- kktix selling
```

會取得組織目前舉辦中的活動，逐一檢查票種，只輸出仍有票種正在販售的活動。

### 輸出 JSON

任何查詢命令都可以加上 `--json`，供 agent 或其他程式處理：

```sh
npm run conductor -- kktix status --json
```

### 查詢其他組織

預設組織是 `platform`。查詢其他組織時加上：

```sh
npm run conductor -- kktix events --organization <organization-slug>
```

若必須保持 Chrome 連線，以上查詢命令都可再加上 `--auto-connect`。

## Luma 公開活動

Luma 查詢不需要登入、Cookie、auth state 或 `--auto-connect`。預設 Calendar 是 `theplatform`。

### 列出 Calendar 未來活動

```sh
npm run conductor -- luma events
```

會同時列出 Luma 原生活動與 Calendar 收錄的外部活動。Luma 原生活動會顯示公開的報名人數、剩餘名額、是否額滿及是否需要審核；外部活動則保留原始活動網址。

查詢其他 Calendar：

```sh
npm run conductor -- luma events --calendar <calendar-slug>
```

### 查看單一 Luma 活動

可提供活動 slug 或完整網址：

```sh
npm run conductor -- luma event pzkyaeuz
npm run conductor -- luma event https://luma.com/pzkyaeuz
```

會顯示活動時間、地點、主辦人、報名狀態、公開人數、剩餘名額與票種資訊。需要完整描述與所有結構化欄位時加上 `--json`：

```sh
npm run conductor -- luma event pzkyaeuz --json
```

## 限制與安全性

- 目前功能完全唯讀，不會建立、修改或取消活動與訂單。
- Luma 僅讀取公開頁面提供的資料，不會取得來賓個資或主辦方後台收入。
- KKTIX 或 Cloudflare 可能撤銷登入狀態；失效時重新執行 `kktix auth --auto-connect`。
- 腳本不會嘗試繞過 Cloudflare 或 CAPTCHA。
- `.kktix-auth-state.json`、除錯 HTML 與售票資料都不應提交或分享。

## 驗證

```sh
npm test
npm run check
```
