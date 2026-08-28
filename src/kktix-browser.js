import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  detectPageProblem,
  isAuthenticatedDashboard,
  parseEventDashboard,
  parseOrganizationEvents,
} from "./kktix-parsers.js";

const execFileAsync = promisify(execFile);
const KKTIX_ORIGIN = "https://kktix.com";
const HTML_EXPRESSION = Buffer.from("document.documentElement.outerHTML", "utf8").toString("base64");
const USER_AGENT_EXPRESSION = Buffer.from("navigator.userAgent", "utf8").toString("base64");
const CHALLENGE_CLEARED_EXPRESSION = [
  "!document.title.toLowerCase().includes('just a moment')",
  "!document.body.innerText.toLowerCase().includes('performing security verification')",
  "!document.body.innerText.toLowerCase().includes('verify you are human')",
  "!document.body.innerText.toLowerCase().includes('verifying you are human')",
].join(" && ");
const AUTHENTICATED_EXPRESSION = [
  "location.hostname === 'kktix.com'",
  "location.pathname.startsWith('/dashboard/')",
  "!document.querySelector(\"input[type='password']\")",
  CHALLENGE_CLEARED_EXPRESSION,
  "(document.querySelector(\"a[href^='/dashboard/events/'], a[href^='/dashboard/organizations/']\") || /活動列表|活動主控台|組織名稱|組織帳務|票種銷售狀況|event dashboard|organization settings/i.test(document.body.innerText))",
].join(" && ");

export class KktixClient {
  constructor(options) {
    this.organization = validateIdentifier(options.organization, "organization");
    this.cookies = options.cookies || [];
    this.headed = Boolean(options.headed);
    this.executablePath = options.executablePath || undefined;
    this.agentBrowserCommand = options.agentBrowserCommand || process.env.AGENT_BROWSER_BIN || "agent-browser";
    this.authStatePath = options.authStatePath ? path.resolve(options.authStatePath) : null;
    this.autoConnect = Boolean(options.autoConnect);
    this.externalBrowser = this.autoConnect;
    this.externalIdleTimeoutMs = options.externalIdleTimeoutMs ?? 15_000;
    this.eventScanDelayMs = options.eventScanDelayMs ?? 1_000;
    this.eventScanConcurrency = validateConcurrency(options.eventScanConcurrency ?? 3);
    this.isolateEventScans = options.isolateEventScans ?? true;
    this.userAgent = null;
    this.debugHtml = options.debugHtml || null;
    this.quiet = Boolean(options.quiet);
    this.session = `conductor-kktix-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.started = false;
    this.externalTabCreated = false;
  }

  async start() {
    try {
      await execFileAsync(this.agentBrowserCommand, ["--version"], {
        env: this.agentBrowserEnvironment(),
        timeout: 15_000,
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("找不到 agent-browser。請先執行 npm install，或用 AGENT_BROWSER_BIN 指定執行檔。");
      }
      throw new Error(`agent-browser 無法啟動：${processError(error)}`);
    }

    if (this.externalBrowser) {
      if (this.cookies.length > 0) {
        throw new Error("--auto-connect 會直接使用 Chrome 的登入狀態，不能同時傳入 Cookie。");
      }
      this.started = true;
      if (!this.quiet) {
        process.stderr.write(
          "正在連接平常使用的 Chrome；若 Chrome 詢問是否允許遠端偵錯，請按「允許」。\n",
        );
      }
      try {
        await this.run(["get", "url"], { timeout: 120_000 });
      } catch (error) {
        this.started = false;
        throw new Error(
          `無法連接 Chrome。請先在 Chrome 開啟 chrome://inspect/#remote-debugging 並啟用遠端偵錯：${error.message}`,
          { cause: error },
        );
      }
      return;
    }

    if (this.authStatePath) await this.loadAuthMetadata();

    if (this.cookies.length === 0) {
      if (this.authStatePath && (await fileExists(this.authStatePath))) {
        await this.run(["state", "load", this.authStatePath], { requireStarted: false });
      }
      this.started = true;
      return;
    }

    const privateDirectory = await mkdtemp(path.join(tmpdir(), "conductor-kktix-auth-"));
    const statePath = path.join(privateDirectory, "state.json");
    try {
      await writeFile(statePath, JSON.stringify(toAgentBrowserState(this.cookies)), { mode: 0o600 });
      await this.run(["state", "load", statePath], { requireStarted: false });
      this.started = true;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      await rm(privateDirectory, { recursive: true, force: true });
    }
  }

  async close() {
    if (this.externalBrowser) {
      try {
        if (this.started && this.externalTabCreated) {
          await this.run(["tab", "close"], { tolerateFailure: true });
        }
      } finally {
        this.started = false;
        this.externalTabCreated = false;
        // Do not send `close`: for a CDP attachment that could close the user's Chrome.
        // The isolated agent-browser daemon exits by itself after the idle timeout.
      }
      return;
    }

    try {
      await this.run(["close"], { expectJson: false, tolerateFailure: true, requireStarted: false });
    } finally {
      this.started = false;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
  }

  async listEvents({ ongoingOnly = false } = {}) {
    this.ensureStarted();
    const firstUrl = ongoingOnly
      ? `${KKTIX_ORIGIN}/dashboard/organizations/${this.organization}`
      : `${KKTIX_ORIGIN}/dashboard/organizations/${this.organization}/events`;
    const events = new Map();
    const visited = new Set();
    let nextUrl = firstUrl;

    while (nextUrl && !visited.has(nextUrl)) {
      visited.add(nextUrl);
      const { html, url } = await this.load(nextUrl, ongoingOnly ? "ongoing-events" : `events-page-${visited.size}`);
      const parsed = parseOrganizationEvents(html, url);
      for (const event of parsed.events) events.set(event.slug, event);
      nextUrl = ongoingOnly ? null : parsed.nextUrl;
    }

    return [...events.values()];
  }

  async authenticateState() {
    this.ensureStarted();
    if (!this.authStatePath) throw new Error("auth 命令需要 agent-browser state 檔案路徑。");
    if (this.externalBrowser) return this.importConnectedChromeState();

    const targetUrl = `${KKTIX_ORIGIN}/dashboard/organizations/${this.organization}/events`;
    await this.run(["open", targetUrl], { timeout: 60_000 });
    if (!this.quiet) {
      process.stderr.write(
        "請在 agent-browser 視窗中完成 Cloudflare 驗證；若出現登入頁，也請登入 KKTIX。完成後工具會自動繼續（最多等待 5 分鐘）。\n",
      );
    }
    await this.run(["wait", "--load", "networkidle"], { timeout: 12_000, tolerateFailure: true });
    await this.run(["wait", "5000"]);
    const initialPage = await this.readPage();
    if (detectPageProblem(initialPage.html, initialPage.url) === "cloudflare") {
      throw new Error(
        "Cloudflare 已拒絕 agent-browser 新視窗；繼續等待不會完成。請改用平常 Chrome 的 --auto-connect 模式。",
      );
    }

    if (!isAuthenticatedDashboard(initialPage.html, initialPage.url)) {
      await this.run(["wait", "--fn", AUTHENTICATED_EXPRESSION], { timeout: 305_000 });
    }
    await this.run(["wait", "--load", "networkidle"], { timeout: 12_000, tolerateFailure: true });
    await this.run(["wait", "1500"]);

    const page = await this.readPage();
    const problem = detectPageProblem(page.html, page.url);
    if (problem === "cloudflare") throw new Error("Cloudflare 驗證尚未完成，請重新執行 auth。");
    if (problem === "authentication") throw new Error("KKTIX 尚未登入，請重新執行 auth 並完成登入。");
    if (problem === "authorization") throw new Error(`目前帳號沒有組織 ${this.organization} 的後台權限。`);
    if (!isAuthenticatedDashboard(page.html, page.url)) {
      throw new Error("尚未確認 KKTIX 後台內容已完整載入；登入狀態不會被保存，請重新執行 auth。");
    }

    const cookieResult = await this.run(["cookies"]);
    const kktixCookies = Array.isArray(cookieResult?.cookies)
      ? cookieResult.cookies.filter((cookie) => isKktixCookieDomain(cookie.domain))
      : [];
    if (kktixCookies.length === 0) {
      throw new Error("瀏覽器中沒有 KKTIX Cookie；登入狀態不會被保存，請重新執行 auth 並確認已登入。");
    }

    const userAgentResult = await this.run(["eval", "-b", USER_AGENT_EXPRESSION]);
    if (!isValidUserAgent(userAgentResult?.result)) throw new Error("agent-browser 未回傳有效的 User-Agent。");
    this.userAgent = userAgentResult.result;
    await mkdir(path.dirname(this.authStatePath), { recursive: true, mode: 0o700 });
    await this.saveCurrentState();
    const savedState = JSON.parse(await readFile(this.authStatePath, "utf8"));
    if (!Array.isArray(savedState.cookies) || !savedState.cookies.some((cookie) => isKktixCookieDomain(cookie.domain))) {
      throw new Error("agent-browser 保存的登入狀態不含 KKTIX Cookie；請重新執行 auth。");
    }
    await writeFile(
      this.authMetadataPath(),
      JSON.stringify(
        {
          organization: this.organization,
          userAgent: this.userAgent,
          authenticatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    await this.verifySavedStateHeadless(targetUrl);
    return { authStatePath: this.authStatePath, dashboardUrl: page.url, headlessVerified: true };
  }

  async importConnectedChromeState() {
    const targetUrl = `${KKTIX_ORIGIN}/dashboard/organizations/${this.organization}/events`;
    const page = await this.load(targetUrl, "auth-auto-connect");
    if (!isAuthenticatedDashboard(page.html, page.url)) {
      throw new Error("目前連接的 Chrome 尚未載入 KKTIX 組織後台，無法匯入登入狀態。");
    }

    const cookieResult = await this.run(["cookies"]);
    const kktixCookies = Array.isArray(cookieResult?.cookies)
      ? cookieResult.cookies.filter((cookie) => isKktixCookieDomain(cookie.domain))
      : [];
    if (kktixCookies.length === 0) {
      throw new Error("目前連接的 Chrome 沒有 KKTIX Cookie，無法建立 headless 登入狀態。");
    }

    const userAgentResult = await this.run(["eval", "-b", USER_AGENT_EXPRESSION]);
    if (!isValidUserAgent(userAgentResult?.result)) throw new Error("agent-browser 未回傳有效的 User-Agent。");
    this.userAgent = userAgentResult.result;

    await mkdir(path.dirname(this.authStatePath), { recursive: true, mode: 0o700 });
    await writeFile(
      this.authStatePath,
      JSON.stringify(
        {
          cookies: kktixCookies.map(normalizeAgentBrowserCookie),
          // Deliberately exclude storage and cookies belonging to every other Chrome site.
          origins: [],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await chmod(this.authStatePath, 0o600);
    await writeFile(
      this.authMetadataPath(),
      JSON.stringify(
        {
          organization: this.organization,
          userAgent: this.userAgent,
          authenticatedAt: new Date().toISOString(),
          importedFromChrome: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    await this.verifySavedStateHeadless(targetUrl);
    return { authStatePath: this.authStatePath, dashboardUrl: page.url, headlessVerified: true };
  }

  async verifySavedStateHeadless(targetUrl) {
    await this.close();
    this.autoConnect = false;
    this.externalBrowser = false;
    this.cookies = [];
    this.headed = false;
    this.session = `conductor-kktix-${process.pid}-${randomUUID().slice(0, 8)}`;

    try {
      await this.start();
      const page = await this.load(targetUrl, "auth-headless-verification");
      if (!isAuthenticatedDashboard(page.html, page.url)) {
        throw new Error("新 headless session 沒有載入到 KKTIX 後台內容。");
      }
      await this.saveCurrentState();
    } catch (error) {
      throw new Error(`可見瀏覽器已登入，但保存狀態無法在新的 headless session 使用：${error.message}`, {
        cause: error,
      });
    }
  }

  async getEvent(slug) {
    this.ensureStarted();
    const safeSlug = validateIdentifier(slug, "event slug");
    const targetUrl = `${KKTIX_ORIGIN}/dashboard/events/${encodeURIComponent(safeSlug)}`;
    const { html, url } = await this.load(targetUrl, `event-${safeSlug}`);
    return parseEventDashboard(html, url);
  }

  async listEventStatuses({ ongoingOnly = false } = {}) {
    const candidates = await this.listEvents({ ongoingOnly });
    return this.getEventStatuses(candidates);
  }

  async getEventStatuses(candidates) {
    this.ensureStarted();
    if (this.shouldParallelEventScans(candidates)) return this.getEventStatusesParallel(candidates);

    const events = [];
    const failures = [];

    for (const [index, event] of candidates.entries()) {
      if (!this.quiet) process.stderr.write(`檢查售票狀態 ${index + 1}/${candidates.length}：${event.slug}\n`);
      try {
        if (this.shouldIsolateEventScan()) await this.restartBrowserSession();
        if (this.eventScanDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.eventScanDelayMs));
        }
        const detail = await this.getEvent(event.slug);
        events.push(mergeEventCandidate(event, detail));
      } catch (error) {
        failures.push({ slug: event.slug, name: event.name, reason: error.message });
      }
    }

    return {
      organization: this.organization,
      scanned: candidates.length,
      succeeded: events.length,
      events,
      failures,
      fetchedAt: new Date().toISOString(),
    };
  }

  async getEventStatusesParallel(candidates) {
    if (!this.quiet) {
      process.stderr.write(`使用 ${Math.min(this.eventScanConcurrency, candidates.length)} 個平行 session。\n`);
    }
    const results = await mapWithConcurrency(candidates, this.eventScanConcurrency, async (event, index) => {
      if (!this.quiet) process.stderr.write(`檢查售票狀態 ${index + 1}/${candidates.length}：${event.slug}\n`);
      const client = this.createEventScanClient();
      try {
        await client.start();
        const detail = await client.getEvent(event.slug);
        return { event: mergeEventCandidate(event, detail), failure: null };
      } catch (error) {
        return {
          event: null,
          failure: { slug: event.slug, name: event.name, reason: error.message },
        };
      } finally {
        await client.close();
      }
    });

    return {
      organization: this.organization,
      scanned: candidates.length,
      succeeded: results.filter((result) => result.event).length,
      events: results.map((result) => result.event).filter(Boolean),
      failures: results.map((result) => result.failure).filter(Boolean),
      fetchedAt: new Date().toISOString(),
    };
  }

  shouldParallelEventScans(candidates) {
    return (
      candidates.length > 1 &&
      this.eventScanConcurrency > 1 &&
      !this.headed &&
      this.shouldIsolateEventScan()
    );
  }

  createEventScanClient() {
    return new KktixClient({
      organization: this.organization,
      cookies: this.cookies,
      headed: false,
      executablePath: this.executablePath,
      agentBrowserCommand: this.agentBrowserCommand,
      authStatePath: this.authStatePath,
      autoConnect: false,
      eventScanDelayMs: 0,
      eventScanConcurrency: 1,
      isolateEventScans: false,
      debugHtml: this.debugHtml,
      quiet: true,
    });
  }

  shouldIsolateEventScan() {
    return (
      this.isolateEventScans &&
      !this.externalBrowser &&
      (this.cookies.length > 0 || Boolean(this.authStatePath))
    );
  }

  async restartBrowserSession() {
    await this.close();
    this.session = `conductor-kktix-${process.pid}-${randomUUID().slice(0, 8)}`;
    await this.start();
  }

  async listSellingEvents() {
    const result = await this.listEventStatuses({ ongoingOnly: true });
    const warningFailures = result.events
      .filter((event) => event.warnings.length > 0)
      .map((event) => ({ slug: event.slug, name: event.name, reason: event.warnings.join(" ") }));

    return {
      organization: this.organization,
      scanned: result.scanned,
      selling: result.events.filter((event) => event.currentlySelling),
      failures: [...result.failures, ...warningFailures],
      fetchedAt: result.fetchedAt,
    };
  }

  async load(targetUrl, debugName) {
    assertAllowedUrl(targetUrl);
    if (this.externalBrowser && !this.externalTabCreated) {
      await this.run(["tab", "new", targetUrl], { timeout: 60_000 });
      this.externalTabCreated = true;
    } else {
      await this.run(["open", targetUrl], { timeout: 60_000 });
    }
    await this.run(["wait", "--load", "networkidle"], { timeout: 12_000, tolerateFailure: true });

    let page = await this.readPage();
    let problem = detectPageProblem(page.html, page.url);
    if (problem === "cloudflare" && this.headed) {
      if (!this.quiet) {
        process.stderr.write("請在 agent-browser 視窗中完成 KKTIX/Cloudflare 安全驗證（最多等待 2 分鐘）。\n");
      }
      await this.run(["wait", "--fn", CHALLENGE_CLEARED_EXPRESSION], {
        timeout: 125_000,
        tolerateFailure: true,
      });
      page = await this.readPage();
      problem = detectPageProblem(page.html, page.url);
    }

    if (problem === "cloudflare") {
      const recovery = this.externalBrowser
        ? "請先在同一個 Chrome 手動開啟 KKTIX dashboard 並完成驗證，再重新執行命令。"
        : this.authStatePath
        ? "保存的 Cloudflare 狀態已失效；請重新執行 npm run conductor -- kktix auth。"
        : "請加上 --headed 後手動完成驗證，或執行 npm run conductor -- kktix auth 建立可供 headless 重用的登入狀態。";
      throw new Error(`KKTIX/Cloudflare 安全驗證尚未通過。${recovery}`);
    }
    if (problem === "authentication") {
      if (this.externalBrowser) {
        throw new Error("目前連接的 Chrome 尚未登入 KKTIX；請先在同一個 Chrome 登入並開啟組織後台。");
      }
      throw new Error("KKTIX Cookie 已失效或不完整；請登入後從 dashboard request 重新複製完整 Cookie header。");
    }
    if (problem === "authorization") {
      throw new Error(`目前帳號沒有組織 ${this.organization} 的後台權限。`);
    }

    if (this.debugHtml) await this.saveDebugHtml(debugName, page.html);
    return page;
  }

  async readPage() {
    const urlResult = await this.run(["get", "url"]);
    const url = urlResult?.url;
    assertAllowedUrl(url);
    const htmlResult = await this.run(["eval", "-b", HTML_EXPRESSION]);
    if (typeof htmlResult?.result !== "string") throw new Error("agent-browser 未回傳頁面 HTML。");
    return { html: htmlResult.result, url };
  }

  async run(args, options = {}) {
    const {
      expectJson = true,
      tolerateFailure = false,
      requireStarted = true,
      timeout = 60_000,
    } = options;
    if (requireStarted && !this.started) throw new Error("KktixClient 尚未啟動。");

    const globalArgs = ["--session", this.session];
    if (expectJson) globalArgs.push("--json");
    if (this.autoConnect) globalArgs.push("--auto-connect");
    if (this.headed && !this.externalBrowser) globalArgs.push("--headed");
    if (this.executablePath) globalArgs.push("--executable-path", this.executablePath);
    if (this.userAgent && !this.externalBrowser) globalArgs.push("--user-agent", this.userAgent);

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
    const environment = {
      ...process.env,
      AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
      AGENT_BROWSER_MAX_OUTPUT: String(64 * 1024 * 1024),
      AGENT_BROWSER_DEFAULT_TIMEOUT: this.headed ? "300000" : "45000",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: this.externalBrowser ? String(this.externalIdleTimeoutMs) : "30000",
    };
    if (this.externalBrowser) {
      delete environment.AGENT_BROWSER_ALLOWED_DOMAINS;
    } else {
      environment.AGENT_BROWSER_ALLOWED_DOMAINS =
        "kktix.com,*.kktix.com,kktix.io,*.kktix.io,cloudflare.com,*.cloudflare.com";
    }
    return environment;
  }

  async saveDebugHtml(name, html) {
    await mkdir(this.debugHtml, { recursive: true, mode: 0o700 });
    const filename = path.join(this.debugHtml, `${name.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}.html`);
    await writeFile(filename, html, { mode: 0o600 });
    if (!this.quiet) process.stderr.write(`已儲存除錯 HTML：${filename}（可能含組織內部資料，請妥善保管）\n`);
  }

  async saveCurrentState() {
    const previousUmask = process.umask(0o077);
    try {
      await this.run(["state", "save", this.authStatePath]);
    } finally {
      process.umask(previousUmask);
    }
    await chmod(this.authStatePath, 0o600);
  }

  async loadAuthMetadata() {
    try {
      const metadata = JSON.parse(await readFile(this.authMetadataPath(), "utf8"));
      if (isValidUserAgent(metadata.userAgent)) this.userAgent = metadata.userAgent;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`無法讀取 agent-browser auth metadata：${error.message}`);
    }
  }

  authMetadataPath() {
    return `${this.authStatePath}.meta.json`;
  }

  ensureStarted() {
    if (!this.started) throw new Error("KktixClient 尚未啟動。");
  }
}

function isValidUserAgent(value) {
  return typeof value === "string" && value.length >= 10 && value.length <= 500 && !/[\r\n]/.test(value);
}

function isKktixCookieDomain(value) {
  const domain = String(value ?? "").replace(/^\./, "").toLowerCase();
  return domain === "kktix.com" || domain.endsWith(".kktix.com");
}

function normalizeAgentBrowserCookie(cookie) {
  const sameSite = ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : "Lax";
  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain),
    path: typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/",
    expires: Number.isFinite(cookie.expires) ? cookie.expires : -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite,
  };
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

export function toAgentBrowserState(cookies) {
  return {
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || new URL(cookie.url).hostname,
      path: cookie.path || "/",
      expires: -1,
      httpOnly: false,
      secure: cookie.secure ?? true,
      sameSite: "Lax",
    })),
    origins: [],
  };
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
      // Some versions may emit a short status line before the JSON result.
    }
  }
  throw new Error(`無法解析 agent-browser 輸出：${String(output ?? "").slice(0, 300)}`);
}

function processError(error) {
  const stderr = String(error.stderr ?? "").trim();
  const stdout = String(error.stdout ?? "").trim();
  return stderr || stdout || error.message;
}

function validateIdentifier(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(text)) {
    throw new Error(`${label} 格式不正確：${text || "(空白)"}`);
  }
  return text;
}

function validateConcurrency(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 8) {
    throw new Error(`concurrency 必須是 1 到 8 的整數：${value}`);
  }
  return number;
}

function mergeEventCandidate(event, detail) {
  return {
    ...detail,
    name: event.name || detail.name,
    schedule: detail.schedule ?? event.schedule,
    publicationStatus: event.status ?? null,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function assertAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`無效網址：${value}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "kktix.com") {
    throw new Error(`基於安全考量，拒絕前往非 kktix.com 網址：${url.href}`);
  }
}
