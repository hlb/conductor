import * as cheerio from "cheerio";

const GENERIC_EVENT_LINK_TEXT = new Set([
  "活動主控台",
  "主控台",
  "dashboard",
  "event dashboard",
  "訂單",
  "簽到簿",
  "活動頁面",
  "檢視",
  "編輯",
]);

const RESERVED_EVENT_SLUGS = new Set(["new"]);

const GENERIC_HEADINGS = new Set([
  "綜覽",
  "活動主控台",
  "票種銷售狀況",
  "售出方式統計",
  "最近訂單",
  "活動資訊",
  "活動設定",
]);

const EVENT_STATUS_TERMS = [
  "販售中",
  "售票中",
  "開賣中",
  "尚未開賣",
  "等待販售",
  "結束販售",
  "停止販售",
  "已售完",
  "售罄",
  "已發布",
  "已發佈",
  "未發布",
  "未發佈",
  "未發行",
  "草稿",
  "已結束",
  "已取消",
  "Published",
  "Unpublished",
  "Draft",
  "Ended",
  "Cancelled",
];

const TICKET_HEADER_ALIASES = {
  name: ["票種", "票券", "ticket type", "ticket"],
  salePeriod: ["販售時間", "銷售時間", "sale period", "sales period"],
  status: ["狀態", "status"],
  price: ["價格", "售價", "price"],
  quantity: ["數量", "可售", "quantity", "capacity"],
  paid: ["已付款", "已繳費", "paid"],
  pending: ["待繳費", "未付款", "pending"],
  invalid: ["無效票", "invalid"],
  void: ["廢票", "void"],
};

export function parseOrganizationEvents(html, currentUrl) {
  const $ = cheerio.load(html);
  const baseUrl = new URL(currentUrl);
  const eventMap = new Map();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }

    const match = url.pathname.match(/^\/dashboard\/events\/([^/?#]+)\/?$/);
    if (!match) return;

    const slug = decodeURIComponent(match[1]);
    if (RESERVED_EVENT_SLUGS.has(slug.toLowerCase())) return;
    if (eventMap.has(slug)) return;

    const rowMetadata = findEventRowMetadata($, element);
    const container = rowMetadata?.container ?? findEventContainer($, element);
    const text = normalizeText(container.text());
    const linkText = normalizeText($(element).text());
    const title = rowMetadata?.name ?? findEventTitle($, container, linkText, slug);

    eventMap.set(slug, {
      slug,
      name: title,
      status: rowMetadata?.status ?? findStatus(text),
      schedule: rowMetadata?.schedule ?? findSchedule(text),
      dashboardUrl: new URL(`/dashboard/events/${encodeURIComponent(slug)}`, baseUrl).href,
    });
  });

  const nextUrl = findNextPageUrl($, baseUrl);
  return { events: [...eventMap.values()], nextUrl };
}

export function parseEventDashboard(html, currentUrl) {
  const $ = cheerio.load(html);
  const bodyText = normalizeText($("body").text());
  const slug = eventSlugFromUrl(currentUrl);
  const table = findTicketTable($);
  const tickets = table ? parseTicketTable($, table) : [];
  const inventory = parseInventorySummary(bodyText, tickets);
  const warnings = [];

  if (!table) warnings.push("找不到票種銷售狀況表；KKTIX 頁面結構可能已變更。");
  if (table && tickets.length === 0) warnings.push("找到票種表，但沒有可辨識的票種資料列。");

  return {
    slug,
    name: findDashboardEventName($, bodyText, slug),
    schedule: findScheduleBeforeTicketTable($, table, bodyText),
    inventory,
    totalAmount: parseTotalAmount(bodyText),
    tickets,
    currentlySelling: tickets.some((ticket) => isSellingStatus(ticket.status)),
    dashboardUrl: currentUrl,
    fetchedAt: new Date().toISOString(),
    warnings,
  };
}

export function detectPageProblem(html, url) {
  const $ = cheerio.load(html);
  const title = normalizeText($("title").text()).toLowerCase();
  const body = normalizeText($("body").text()).toLowerCase();
  const pathname = safePathname(url);

  if (
    title.includes("just a moment") ||
    body.includes("performing security verification") ||
    body.includes("verify you are human") ||
    body.includes("verifying you are human") ||
    body.includes("security service to protect against malicious bots") ||
    body.includes("enable javascript and cookies to continue")
  ) {
    return "cloudflare";
  }

  if (
    pathname.startsWith("/users/sign_in") ||
    $("#user_login, input[name='user[login]'], input[type='password']").length > 0 ||
    body.includes("登入 kktix") ||
    body.includes("sign in to kktix")
  ) {
    return "authentication";
  }

  if (
    body.includes("沒有權限") ||
    body.includes("權限不足") ||
    body.includes("access denied") ||
    body.includes("not authorized")
  ) {
    return "authorization";
  }

  return null;
}

export function isAuthenticatedDashboard(html, url) {
  const $ = cheerio.load(html);
  const pathname = safePathname(url);
  if (!pathname.startsWith("/dashboard/") || detectPageProblem(html, url)) return false;

  const body = normalizeText($("body").text());
  const hasDashboardLink = $(
    "a[href^='/dashboard/events/'], a[href^='/dashboard/organizations/'], a[href*='kktix.com/dashboard/events/']",
  ).length > 0;
  const hasDashboardText = /活動列表|活動主控台|組織名稱|組織帳務|票種銷售狀況|event dashboard|organization settings/i.test(body);
  return hasDashboardLink || hasDashboardText;
}

export function isSellingStatus(status) {
  const value = normalizeText(status).toLowerCase();
  if (/尚未|等待|結束|停止|售罄|已售完|sold out|closed|not available|unavailable/.test(value)) return false;
  return ["販售中", "售票中", "開賣中", "in stock", "on sale", "available"].some((term) =>
    value.includes(term),
  );
}

function findEventRowMetadata($, element) {
  const actionRow = $(element).closest("tr.minor");
  if (actionRow.length === 0) return null;

  const dataRow = actionRow.prev("tr");
  const cells = dataRow
    .children("td")
    .toArray()
    .map((cell) => normalizeText($(cell).text()));
  if (cells.length < 3 || !cells[0]) return null;

  return {
    name: cells[0],
    schedule: cells[1] || null,
    status: cells[2] || null,
    container: dataRow.add(actionRow),
  };
}

function findEventContainer($, element) {
  const candidates = $(element).parentsUntil("body").toArray();
  let fallback = $(element).parent();

  for (const candidate of candidates) {
    const node = $(candidate);
    const eventLinkCount = node
      .find("a[href]")
      .toArray()
      .filter((link) => /^\/dashboard\/events\/[^/?#]+\/?$/.test(safePathname($(link).attr("href")))).length;
    const textLength = normalizeText(node.text()).length;

    if (eventLinkCount === 1 && textLength >= 2 && textLength <= 2500) fallback = node;
    if (node.is("tr, article, li, .event, .event-item, .event-row, .panel, .well, .media")) return node;
  }

  return fallback;
}

function findEventTitle($, container, linkText, slug) {
  const headingTexts = container
    .find("h1, h2, h3, h4, h5, h6, [class*='event-title'], [class*='event-name']")
    .toArray()
    .map((element) => normalizeText($(element).text()))
    .filter((text) => text && !GENERIC_HEADINGS.has(text));
  if (headingTexts[0]) return headingTexts[0];

  if (linkText && !GENERIC_EVENT_LINK_TEXT.has(linkText.toLowerCase())) return linkText;

  const lines = textLines(container.text()).filter((line) => {
    if (GENERIC_EVENT_LINK_TEXT.has(line.toLowerCase())) return false;
    if (EVENT_STATUS_TERMS.some((status) => line === status)) return false;
    if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(line)) return false;
    return line.length > 1;
  });
  return lines[0] || slug;
}

function findStatus(text) {
  return EVENT_STATUS_TERMS.find((status) => text.includes(status)) ?? null;
}

function findSchedule(text) {
  const range = text.match(
    /(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\([^)]*\))?(?:\s+\d{1,2}:\d{2}(?:\([^)]*\))?)?)\s*[~～至-]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\([^)]*\))?(?:\s+\d{1,2}:\d{2}(?:\([^)]*\))?)?)/,
  );
  if (range) return `${range[1]} ~ ${range[2]}`;

  const single = text.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\([^)]*\))?(?:\s+\d{1,2}:\d{2}(?:\([^)]*\))?)?/);
  return single?.[0] ?? null;
}

function findNextPageUrl($, baseUrl) {
  const candidates = [
    "a[rel='next']",
    ".pagination .next:not(.disabled) a",
    ".pagination a.next",
  ];
  for (const selector of candidates) {
    const href = $(selector).first().attr("href");
    if (href) return new URL(href, baseUrl).href;
  }

  const next = $("a[href]")
    .toArray()
    .find((element) => /^(下一頁|下頁|next|›|»)$/i.test(normalizeText($(element).text())));
  const href = next ? $(next).attr("href") : null;
  return href ? new URL(href, baseUrl).href : null;
}

function findTicketTable($) {
  let best = null;
  let bestScore = 0;

  $("table").each((_, element) => {
    const headers = $(element)
      .find("thead th")
      .toArray()
      .map((header) => normalizeText($(header).text()).toLowerCase());
    const score = Object.values(TICKET_HEADER_ALIASES).filter((aliases) =>
      aliases.some((alias) => headers.some((header) => header.includes(alias))),
    ).length;
    const hasTicketName = TICKET_HEADER_ALIASES.name.some((alias) => headers.some((header) => header.includes(alias)));
    if (hasTicketName && score > bestScore) {
      best = element;
      bestScore = score;
    }
  });

  return bestScore >= 2 ? best : null;
}

function parseTicketTable($, table) {
  const headers = $(table)
    .find("thead th")
    .toArray()
    .map((header) => normalizeText($(header).text()));
  const indexes = Object.fromEntries(
    Object.entries(TICKET_HEADER_ALIASES).map(([field, aliases]) => [field, headerIndex(headers, aliases)]),
  );
  const tickets = [];

  $(table)
    .find("tbody tr")
    .each((_, row) => {
      const cells = $(row)
        .find(":scope > th, :scope > td")
        .toArray()
        .map((cell) => normalizeText($(cell).text()));
      if (cells.length === 0) return;

      const name = cellAt(cells, indexes.name);
      if (!name || /^(小計|合計|總計|subtotal|total)$/i.test(name)) return;

      const priceText = cellAt(cells, indexes.price);
      const quantityText = cellAt(cells, indexes.quantity);
      tickets.push({
        name,
        salePeriod: nullable(cellAt(cells, indexes.salePeriod)),
        status: nullable(cellAt(cells, indexes.status)),
        price: parseMoney(priceText),
        quantity: /不限定|unlimited/i.test(quantityText) ? null : parseNumber(quantityText),
        unlimited: /不限定|unlimited/i.test(quantityText),
        paid: parseNumber(cellAt(cells, indexes.paid)),
        pending: parseNumber(cellAt(cells, indexes.pending)),
        invalid: parseNumber(cellAt(cells, indexes.invalid)),
        void: parseNumber(cellAt(cells, indexes.void)),
      });
    });

  return tickets;
}

function parseInventorySummary(bodyText, tickets) {
  const available = numberAfterLabel(bodyText, ["可售", "可銷售", "available"]);
  const sold = numberAfterLabel(bodyText, ["已售", "售出", "sold"]);
  const remaining = numberAfterLabel(bodyText, ["剩餘", "remaining"]);
  const paidFromTickets = sumKnown(tickets.map((ticket) => ticket.paid));

  return {
    available,
    sold: sold ?? paidFromTickets,
    remaining,
  };
}

function findDashboardEventName($, bodyText, slug) {
  const labelled = bodyText.match(/活動名稱\s+(.+?)\s+(?:綜覽|活動主控台|可售|已售|剩餘)/);
  if (labelled?.[1]) return normalizeText(labelled[1]);

  const candidates = $("h1, h2, .event-title, .event-name, [class*='event-title'], [class*='event-name']")
    .toArray()
    .map((element) => normalizeText($(element).text()).replace(/^活動名稱\s*/, ""))
    .filter((text) => text && !GENERIC_HEADINGS.has(text));
  return candidates[0] || slug;
}

function findScheduleBeforeTicketTable($, table, bodyText) {
  if (table) {
    const priorText = normalizeText($(table).prevAll().slice(0, 8).text());
    const schedule = findSchedule(priorText);
    if (schedule) return schedule;
  }
  return findSchedule(bodyText);
}

function parseTotalAmount(text) {
  const match = text.match(/總金額\s*([A-Z]{3})?\s*\$?\s*([\d,.]+)/i);
  if (!match) return null;
  return {
    currency: match[1]?.toUpperCase() ?? null,
    amount: parseDecimal(match[2]),
    display: normalizeText(match[0].replace(/^總金額\s*/, "")),
  };
}

function parseMoney(text) {
  const value = normalizeText(text);
  if (!value) return null;
  const currency = value.match(/\b([A-Z]{3})\b/i)?.[1]?.toUpperCase() ?? null;
  const amount = value.match(/-?[\d,.]+/)?.[0];
  return {
    currency,
    amount: amount ? parseDecimal(amount) : null,
    display: value,
  };
}

function headerIndex(headers, aliases) {
  return headers.findIndex((header) => aliases.some((alias) => header.toLowerCase().includes(alias)));
}

function cellAt(cells, index) {
  return index >= 0 ? cells[index] ?? "" : "";
}

function numberAfterLabel(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp(`${escapeRegExp(label)}\\s*([\\d,]+)`, "i"));
    if (match) return parseNumber(match[1]);
  }
  return null;
}

function parseNumber(value) {
  const match = normalizeText(value).match(/-?[\d,]+/);
  return match ? Number.parseInt(match[0].replaceAll(",", ""), 10) : null;
}

function parseDecimal(value) {
  const parsed = Number.parseFloat(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function sumKnown(values) {
  const known = values.filter((value) => Number.isFinite(value));
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function eventSlugFromUrl(url) {
  const match = safePathname(url).match(/^\/dashboard\/events\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function safePathname(url) {
  try {
    return new URL(url, "https://kktix.com").pathname;
  } catch {
    return "";
  }
}

function nullable(value) {
  const text = normalizeText(value);
  return text || null;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function textLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map(normalizeText)
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
