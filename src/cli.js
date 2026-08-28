#!/usr/bin/env node

import { parseArgs } from "node:util";
import { parseCookieHeader, readCookieInput } from "./kktix-auth.js";
import { KktixClient } from "./kktix-browser.js";
import { LumaClient } from "./luma-browser.js";
import { isSellingStatus } from "./kktix-parsers.js";
import { fetchUnifiedReport } from "./report.js";

const HELP = `
Conductor（唯讀）

用法：
  conductor report [選項]
  conductor kktix auth [選項]
  conductor kktix events [選項]
  conductor kktix event <活動 slug> [選項]
  conductor kktix status [選項]
  conductor kktix selling [選項]
  conductor luma events [選項]
  conductor luma event <活動 slug 或網址> [選項]

資料來源與命令：
  report                以 Luma 未來活動為準，合併 Luma 報名與 KKTIX 售票狀態
  kktix auth           完成登入或從已登入的 Chrome 匯入狀態，驗證 headless 可重用
  kktix events         列出組織內全部活動
  kktix event <slug>   取得單一活動的售票摘要與票種明細
  kktix status         一次取得組織內全部活動的售票狀況
  kktix selling        列出組織綜覽中目前仍有票種販售中的活動
  luma events          列出 Luma Calendar 未來活動與公開報名狀況
  luma event           取得單一 Luma 公開活動資訊

驗證方式：
  kktix auth                 初始化後，一般查詢不必再提供 Cookie
  --cookie-stdin              從標準輸入讀取 Cookie header
  --cookie-file <path>        從檔案讀取 Cookie header
  KKTIX_COOKIE                從環境變數讀取

選項：
  -o, --organization <slug>   組織 slug（預設：platform）
  --calendar <slug>           Luma Calendar slug（預設：theplatform）
  --concurrency <1-8>         KKTIX 平行查詢數（預設：3）
  --json                      輸出 JSON，適合 agent 或其他程式使用
  --headed                    顯示瀏覽器；Cloudflare 要求驗證時使用
  --browser <path>            指定 Chrome/Chromium 執行檔
  --agent-browser <path>      指定 agent-browser 執行檔
  --auto-connect              連接平常使用的 Chrome（Cloudflare 卡住時建議）
  --auth-state <path>         登入狀態檔（預設：./.kktix-auth-state.json）
  --debug-html <dir>          明確儲存後台 HTML 供除錯（內含敏感資料）
  -q, --quiet, --silent       不顯示進度（--silent 是 --quiet 的別名）
  -h, --help                  顯示說明

範例：
  npm run conductor -- report
  npm run conductor -- report --json
  pbpaste | npm run conductor -- kktix auth --cookie-stdin
  npm run conductor -- kktix events
  npm run conductor -- kktix event originals-20261003
  npm run conductor -- kktix status --json
  npm run conductor -- kktix auth --auto-connect
  npm run conductor -- kktix selling --json
  npm run conductor -- luma events
  npm run conductor -- luma event https://luma.com/pzkyaeuz
`;

async function main() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs[0] || rawArgs[0] === "help" || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(HELP.trimStart());
    return;
  }

  const invocation = resolveInvocation(rawArgs);
  const { provider, command } = invocation;
  const commandArgs = rawArgs.slice(invocation.consumed);
  const positional = [];
  while (commandArgs.length > 0 && !commandArgs[0].startsWith("-")) positional.push(commandArgs.shift());

  const { values } = parseArgs({
    args: commandArgs,
    options: {
      organization: { type: "string", short: "o", default: "platform" },
      calendar: { type: "string", default: "theplatform" },
      concurrency: { type: "string", default: "3" },
      "cookie-stdin": { type: "boolean", default: false },
      "cookie-file": { type: "string" },
      json: { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      browser: { type: "string" },
      "agent-browser": { type: "string" },
      "auto-connect": { type: "boolean", default: false },
      "auth-state": { type: "string" },
      "debug-html": { type: "string" },
      quiet: { type: "boolean", short: "q", default: false },
      silent: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  const quiet = values.quiet || values.silent;

  const providerCommands = {
    all: new Set(["report"]),
    kktix: new Set(["auth", "events", "event", "status", "selling"]),
    luma: new Set(["events", "event"]),
  };
  if (!providerCommands[provider]?.has(command)) throw new Error(`未知命令：${provider} ${command}\n\n${HELP}`);
  if (command === "event" && positional.length !== 1) {
    throw new Error(`${provider} event 命令需要一個活動 ${provider === "luma" ? "slug 或網址" : "slug"}。`);
  }
  if (command !== "event" && positional.length > 0) throw new Error(`${provider} ${command} 命令不接受位置參數。`);

  if (provider === "all") {
    const { cookies, authStatePath } = await resolveKktixAccess(values);
    const lumaClient = new LumaClient({
      calendar: values.calendar,
      headed: false,
      executablePath: values.browser,
      agentBrowserCommand: values["agent-browser"],
      quiet,
    });
    const kktixClient = new KktixClient({
      organization: values.organization,
      cookies,
      headed: values["auto-connect"] ? false : values.headed,
      executablePath: values.browser,
      agentBrowserCommand: values["agent-browser"],
      autoConnect: values["auto-connect"],
      authStatePath,
      eventScanConcurrency: values.concurrency,
      debugHtml: values["debug-html"],
      quiet,
    });
    outputUnifiedReport(
      await fetchUnifiedReport({ lumaClient, kktixClient, quiet }),
      values.json,
    );
    return;
  }

  if (provider === "luma") {
    if (values["cookie-stdin"] || values["cookie-file"] || values["auto-connect"] || values["auth-state"]) {
      throw new Error("Luma 公開活動查詢不需要 Cookie、auth state 或 --auto-connect。");
    }
    const client = new LumaClient({
      calendar: values.calendar,
      headed: values.headed,
      executablePath: values.browser,
      agentBrowserCommand: values["agent-browser"],
      quiet,
    });
    try {
      await client.start();
      if (command === "events") {
        outputLumaEvents(await client.listEvents(), values.json);
      } else {
        outputLumaEvent(await client.getEvent(positional[0]), values.json);
      }
    } finally {
      await client.close();
    }
    return;
  }

  const { cookies, authStatePath } = await resolveKktixAccess(values, { authCommand: command === "auth" });
  const client = new KktixClient({
    organization: values.organization,
    cookies,
    headed: values["auto-connect"] ? false : command === "auth" ? true : values.headed,
    executablePath: values.browser,
    agentBrowserCommand: values["agent-browser"],
    autoConnect: values["auto-connect"],
    authStatePath,
    eventScanConcurrency: values.concurrency,
    debugHtml: values["debug-html"],
    quiet,
  });

  try {
    await client.start();
    if (command === "auth") {
      const result = await client.authenticateState();
      process.stdout.write(`agent-browser 登入狀態已保存，並已通過全新 headless session 驗證：${result.authStatePath}\n`);
      process.stdout.write("之後可直接執行 kktix events、event、status 或 selling，不需要 Cookie，也不需要 --headed。\n");
    } else if (command === "events") {
      const events = await client.listEvents();
      outputEvents(events, values.json);
    } else if (command === "event") {
      const event = await client.getEvent(positional[0]);
      outputEvent(event, values.json);
    } else if (command === "status") {
      const result = await client.listEventStatuses();
      outputStatuses(result, values.json);
    } else {
      const result = await client.listSellingEvents();
      outputSelling(result, values.json);
    }
  } finally {
    await client.close();
  }
}

function resolveInvocation(rawArgs) {
  if (rawArgs[0] === "report") return { provider: "all", command: "report", consumed: 1 };
  if (rawArgs[0] === "kktix" || rawArgs[0] === "luma") {
    if (!rawArgs[1] || rawArgs[1].startsWith("-")) {
      throw new Error(`${rawArgs[0]} 需要指定命令。\n\n${HELP}`);
    }
    return { provider: rawArgs[0], command: rawArgs[1], consumed: 2 };
  }

  // Backward-compatible aliases from the original KKTIX-only CLI.
  if (new Set(["auth", "events", "event", "status", "selling"]).has(rawArgs[0])) {
    return { provider: "kktix", command: rawArgs[0], consumed: 1 };
  }
  if (rawArgs[0] === "luma-events") return { provider: "luma", command: "events", consumed: 1 };
  if (rawArgs[0] === "luma-event") return { provider: "luma", command: "event", consumed: 1 };
  throw new Error(`未知命令：${rawArgs[0]}\n\n${HELP}`);
}

async function resolveKktixAccess(values, { authCommand = false } = {}) {
  const hasCookieInput = Boolean(values["cookie-stdin"] || values["cookie-file"] || process.env.KKTIX_COOKIE);
  const cookies = hasCookieInput
    ? parseCookieHeader(
        await readCookieInput({
          cookieStdin: values["cookie-stdin"],
          cookieFile: values["cookie-file"],
        }),
      )
    : [];
  const defaultAuthState = process.env.KKTIX_AUTH_STATE || "./.kktix-auth-state.json";
  const authStatePath =
    authCommand || !hasCookieInput || values["auth-state"] ? values["auth-state"] || defaultAuthState : null;
  return { cookies, authStatePath };
}

function outputEvents(events, json) {
  if (json) {
    printJson({ count: events.length, events });
    return;
  }
  if (events.length === 0) {
    process.stdout.write("沒有找到活動。\n");
    return;
  }
  console.table(
    events.map((event) => ({
      slug: event.slug,
      狀態: event.status ?? "—",
      日期: event.schedule ?? "—",
      活動: event.name,
    })),
  );
}

function outputEvent(event, json) {
  if (json) {
    printJson(event);
    return;
  }

  process.stdout.write(`${event.name} (${event.slug})\n`);
  if (event.schedule) process.stdout.write(`活動時間：${event.schedule}\n`);
  process.stdout.write(
    `可售：${displayNumber(event.inventory.available)}  已售：${displayNumber(event.inventory.sold)}  剩餘：${displayNumber(event.inventory.remaining)}\n`,
  );
  if (event.totalAmount) process.stdout.write(`總金額：${event.totalAmount.display}\n`);

  console.table(
    event.tickets.map((ticket) => ({
      票種: ticket.name,
      狀態: ticket.status ?? "—",
      價格: ticket.price?.display ?? "—",
      數量: ticket.unlimited ? "不限定" : displayNumber(ticket.quantity),
      已付款: displayNumber(ticket.paid),
      待繳費: displayNumber(ticket.pending),
      無效票: displayNumber(ticket.invalid),
      廢票: displayNumber(ticket.void),
      販售時間: ticket.salePeriod ?? "—",
    })),
  );
  for (const warning of event.warnings) process.stderr.write(`警告：${warning}\n`);
}

function outputStatuses(result, json) {
  if (json) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `已檢查 ${result.scanned} 個活動；成功取得 ${result.succeeded} 個，失敗 ${result.failures.length} 個。\n`,
  );
  console.table(
    result.events.map((event) => ({
      slug: event.slug,
      活動: event.name,
      發布狀態: event.publicationStatus ?? "—",
      正在售票: event.currentlySelling ? "是" : "否",
      已售: displayNumber(event.inventory.sold),
      剩餘: displayNumber(event.inventory.remaining),
      票種: event.tickets.length,
    })),
  );
  for (const failure of result.failures) process.stderr.write(`警告：${failure.slug}：${failure.reason}\n`);
}

function outputSelling(result, json) {
  if (json) {
    printJson(result);
    return;
  }

  process.stdout.write(`已檢查 ${result.scanned} 個目前舉辦中的活動；${result.selling.length} 個正在售票。\n`);
  console.table(
    result.selling.map((event) => ({
      slug: event.slug,
      活動: event.name,
      已售: displayNumber(event.inventory.sold),
      剩餘: displayNumber(event.inventory.remaining),
      販售中票種: event.tickets.filter((ticket) => isSellingStatus(ticket.status)).length,
    })),
  );
  for (const failure of result.failures) process.stderr.write(`警告：${failure.slug}：${failure.reason}\n`);
}

function outputLumaEvents(result, json) {
  if (json) {
    printJson(result);
    return;
  }

  process.stdout.write(`${result.calendar.name}：${result.count} 個未來活動\n`);
  console.table(
    result.events.map((event) => ({
      平台: event.platform === "luma" ? "Luma" : "外部",
      開始: formatLumaDate(event.startAt, event.timezone),
      報名: event.registration ? registrationLabel(event.registration) : "—",
      已報名: displayNumber(event.registration?.guestCount),
      剩餘: displayNumber(event.registration?.spotsRemaining),
      活動: event.name,
      網址: event.url,
    })),
  );
}

function outputLumaEvent(event, json) {
  if (json) {
    printJson(event);
    return;
  }

  process.stdout.write(`${event.name} (${event.slug})\n`);
  process.stdout.write(`活動時間：${formatLumaRange(event.startAt, event.endAt, event.timezone)}\n`);
  if (event.location?.fullAddress || event.location?.name) {
    process.stdout.write(`地點：${event.location.fullAddress ?? event.location.name}\n`);
  }
  process.stdout.write(
    `報名：${registrationLabel(event.registration)}  已報名：${displayNumber(event.registration.guestCount)}  剩餘：${displayNumber(event.registration.spotsRemaining)}\n`,
  );
  if (event.registration.requireApproval) process.stdout.write("審核：需要主辦方核准\n");
  if (event.hosts.length > 0) process.stdout.write(`主辦人：${event.hosts.map((host) => host.name).filter(Boolean).join("、")}\n`);

  if (event.tickets.length > 0) {
    console.table(
      event.tickets.map((ticket) => ({
        票種: ticket.name,
        類型: ticket.type ?? "—",
        價格: formatLumaPrice(ticket),
        已登記: displayNumber(ticket.registered),
        剩餘: displayNumber(ticket.spotsRemaining),
        需審核: ticket.requireApproval ? "是" : "否",
      })),
    );
  }
}

function outputUnifiedReport(result, json) {
  if (json) {
    printJson(result);
    return;
  }

  const summary = result.summary;
  process.stdout.write(
    `${result.calendar.name} 統一報表：${result.count} 個未來活動（Luma ${summary.luma}、KKTIX ${summary.kktix}` +
      `${summary.external ? `、其他 ${summary.external}` : ""}）；狀態失敗 ${summary.failures} 個。\n`,
  );
  console.table(
    result.events.map((event) => ({
      來源: sourceLabel(event.source),
      開始: formatLumaDate(event.startAt, event.timezone),
      狀態: unifiedStatusLabel(event),
      已售或報名: displayNumber(event.registration?.registered),
      剩餘: displayNumber(event.registration?.remaining),
      容量: displayNumber(event.registration?.capacity),
      活動: event.name,
      網址: event.url,
    })),
  );
  for (const failure of result.failures) {
    process.stderr.write(`警告：${failure.source} ${failure.slug ?? failure.name}：${failure.reason}\n`);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function displayNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString("zh-TW") : "—";
}

function registrationLabel(registration) {
  if (!registration) return "—";
  if (registration.soldOut) return "已額滿";
  if (registration.waitlistActive) return "候補中";
  if (registration.currentlyOpen) return registration.requireApproval ? "開放（需審核）" : "開放";
  return registration.availability ?? "未開放";
}

function sourceLabel(source) {
  if (source === "luma") return "Luma";
  if (source === "kktix") return "KKTIX";
  return "外部";
}

function unifiedStatusLabel(event) {
  if (event.failure) return "取得失敗";
  const registration = event.registration;
  if (!registration) return "—";
  if (registration.soldOut) return event.source === "kktix" ? "已售完" : "已額滿";
  if (registration.waitlistActive) return "候補中";
  if (registration.currentlyOpen) {
    return registration.requireApproval ? "開放（需審核）" : event.source === "kktix" ? "販售中" : "開放";
  }
  return event.source === "kktix" ? "未販售" : registration.status ?? "未開放";
}

function formatLumaRange(startAt, endAt, timezone) {
  const start = formatLumaDate(startAt, timezone);
  const end = formatLumaDate(endAt, timezone);
  return end === "—" ? start : `${start} ~ ${end}`;
}

function formatLumaDate(value, timezone) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: timezone || "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatLumaPrice(ticket) {
  if (ticket.type === "free") return "免費";
  if (!Number.isFinite(ticket.price)) return "—";
  return `${ticket.currency ?? ""} ${ticket.price.toLocaleString("zh-TW")}`.trim();
}

main().catch((error) => {
  process.stderr.write(`錯誤：${error.message}\n`);
  process.exitCode = 1;
});
