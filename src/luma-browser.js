import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { parseLumaCalendarItems, parseLumaCalendarPage, parseLumaEventPage } from "./luma-parsers.js";

const execFileAsync = promisify(execFile);
const LUMA_ORIGIN = "https://luma.com";
const HTML_EXPRESSION = Buffer.from("document.documentElement.outerHTML", "utf8").toString("base64");

export class LumaClient {
  constructor(options = {}) {
    this.calendar = normalizeLumaSlug(options.calendar ?? "theplatform", "Calendar");
    this.headed = Boolean(options.headed);
    this.executablePath = options.executablePath || undefined;
    this.agentBrowserCommand = options.agentBrowserCommand || process.env.AGENT_BROWSER_BIN || "agent-browser";
    this.quiet = Boolean(options.quiet);
    this.session = `conductor-luma-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.started = false;
  }

  async start() {
    try {
      await execFileAsync(this.agentBrowserCommand, ["--version"], {
        env: this.agentBrowserEnvironment(),
        timeout: 15_000,
      });
      this.started = true;
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("找不到 agent-browser。請先執行 npm install，或用 AGENT_BROWSER_BIN 指定執行檔。");
      }
      throw new Error(`agent-browser 無法啟動：${processError(error)}`);
    }
  }

  async close() {
    try {
      await this.run(["close"], { expectJson: false, tolerateFailure: true, requireStarted: false });
    } finally {
      this.started = false;
    }
  }

  async listEvents() {
    this.ensureStarted();
    const calendarUrl = `${LUMA_ORIGIN}/${encodeURIComponent(this.calendar)}`;
    const page = await this.load(calendarUrl);
    const calendar = parseLumaCalendarPage(page.html, page.url);
    const events = [];
    const seen = new Set();
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const apiUrl = new URL("https://api.luma.com/calendar/get-items");
      apiUrl.searchParams.set("calendar_api_id", calendar.id);
      apiUrl.searchParams.set("pagination_limit", "100");
      apiUrl.searchParams.set("period", "future");
      if (cursor) apiUrl.searchParams.set("pagination_cursor", cursor);

      const payload = await this.fetchJson(apiUrl.href);
      for (const event of parseLumaCalendarItems(payload)) {
        const key = event.id ?? event.url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        events.push(event);
      }

      hasMore = Boolean(payload.has_more);
      const nextCursor = payload.next_cursor ?? payload.pagination_cursor ?? payload.cursor ?? null;
      if (!hasMore || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    return {
      calendar,
      count: events.length,
      events,
      fetchedAt: new Date().toISOString(),
    };
  }

  async getEvent(input) {
    this.ensureStarted();
    const slug = normalizeLumaSlug(input, "活動");
    const page = await this.load(`${LUMA_ORIGIN}/${encodeURIComponent(slug)}`);
    return parseLumaEventPage(page.html, page.url);
  }

  async load(targetUrl) {
    assertAllowedLumaUrl(targetUrl);
    await this.run(["open", targetUrl], { timeout: 60_000 });
    await this.run(["wait", "--load", "networkidle"], { timeout: 12_000, tolerateFailure: true });
    const page = await this.readPage();
    if (/page not found/i.test(page.title ?? "")) throw new Error("Luma 找不到這個頁面。");
    return page;
  }

  async readPage() {
    const urlResult = await this.run(["get", "url"]);
    const url = urlResult?.url;
    assertAllowedLumaUrl(url);
    const titleResult = await this.run(["get", "title"]);
    const htmlResult = await this.run(["eval", "-b", HTML_EXPRESSION]);
    if (typeof htmlResult?.result !== "string") throw new Error("agent-browser 未回傳 Luma 頁面 HTML。");
    return { html: htmlResult.result, url, title: titleResult?.title ?? null };
  }

  async fetchJson(targetUrl) {
    assertAllowedLumaApiUrl(targetUrl);
    const expression = Buffer.from(
      `fetch(${JSON.stringify(targetUrl)}, { credentials: "omit" }).then(async (response) => { if (!response.ok) throw new Error("HTTP " + response.status); return response.json(); })`,
      "utf8",
    ).toString("base64");
    const result = await this.run(["eval", "-b", expression]);
    if (!result?.result || typeof result.result !== "object") throw new Error("Luma API 未回傳 JSON。");
    return result.result;
  }

  async run(args, options = {}) {
    const {
      expectJson = true,
      tolerateFailure = false,
      requireStarted = true,
      timeout = 60_000,
    } = options;
    if (requireStarted && !this.started) throw new Error("LumaClient 尚未啟動。");

    const globalArgs = ["--session", this.session];
    if (expectJson) globalArgs.push("--json");
    if (this.headed) globalArgs.push("--headed");
    if (this.executablePath) globalArgs.push("--executable-path", this.executablePath);

    try {
      const result = await execFileAsync(this.agentBrowserCommand, [...globalArgs, ...args], {
        env: this.agentBrowserEnvironment(),
        timeout,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (!expectJson) return result.stdout;

      const payload = parseAgentBrowserJson(result.stdout);
      if (!payload.success || payload.error) {
        throw new Error(typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error));
      }
      return payload.data;
    } catch (error) {
      if (tolerateFailure) return null;
      if (error.code === "ENOENT") {
        throw new Error("找不到 agent-browser。請先執行 npm install，或用 AGENT_BROWSER_BIN 指定執行檔。");
      }
      throw new Error(`agent-browser 執行失敗：${processError(error)}`, { cause: error });
    }
  }

  agentBrowserEnvironment() {
    return {
      ...process.env,
      AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
      AGENT_BROWSER_MAX_OUTPUT: String(64 * 1024 * 1024),
      AGENT_BROWSER_DEFAULT_TIMEOUT: this.headed ? "300000" : "45000",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "30000",
      AGENT_BROWSER_ALLOWED_DOMAINS:
        "luma.com,*.luma.com,lu.ma,*.lu.ma,lumacdn.com,*.lumacdn.com",
    };
  }

  ensureStarted() {
    if (!this.started) throw new Error("LumaClient 尚未啟動。");
  }
}

export function normalizeLumaSlug(value, label = "Luma") {
  let text = String(value ?? "").trim();
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`${label}網址格式不正確。`);
    }
    if (!isLumaHostname(url.hostname)) throw new Error(`${label}網址必須位於 luma.com 或 lu.ma。`);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) throw new Error(`${label}網址必須直接指向 Calendar 或活動頁面。`);
    text = decodeURIComponent(segments[0]);
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(text)) {
    throw new Error(`${label} slug 格式不正確：${text || "(空白)"}`);
  }
  return text;
}

function assertAllowedLumaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`無效網址：${value}`);
  }
  if (url.protocol !== "https:" || !isLumaHostname(url.hostname)) {
    throw new Error(`基於安全考量，拒絕前往非 Luma 網址：${url.href}`);
  }
}

function assertAllowedLumaApiUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "api.luma.com" || url.pathname !== "/calendar/get-items") {
    throw new Error(`基於安全考量，拒絕呼叫非預期的 Luma API：${url.href}`);
  }
}

function isLumaHostname(value) {
  const hostname = String(value ?? "").toLowerCase();
  return hostname === "luma.com" || hostname === "www.luma.com" || hostname === "lu.ma" || hostname === "www.lu.ma";
}

function parseAgentBrowserJson(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // agent-browser may print a short status line before its JSON result.
    }
  }
  throw new Error(`無法解析 agent-browser 輸出：${String(output ?? "").slice(0, 300)}`);
}

function processError(error) {
  const stderr = String(error.stderr ?? "").trim();
  const stdout = String(error.stdout ?? "").trim();
  return stderr || stdout || error.message;
}
