import * as cheerio from "cheerio";

export function parseLumaCalendarPage(html, currentUrl) {
  const initialData = parseInitialData(html);
  const calendar = initialData.calendar;
  if (!calendar || typeof calendar.api_id !== "string") {
    throw new Error("找不到 Luma Calendar 資料；請確認網址指向公開的 Calendar 頁面。");
  }

  return {
    id: calendar.api_id,
    slug: calendar.slug ?? calendarSlugFromUrl(currentUrl),
    name: calendar.name ?? calendar.slug ?? "Luma Calendar",
    description: calendar.description_short ?? null,
    timezone: calendar.timezone ?? calendar.location?.timezone ?? null,
    city: calendar.geo_city ?? calendar.city?.city ?? null,
    country: calendar.geo_country ?? calendar.city?.country ?? null,
    url: `https://luma.com/${encodeURIComponent(calendar.slug ?? calendarSlugFromUrl(currentUrl))}`,
  };
}

export function parseLumaCalendarItems(payload) {
  if (!payload || !Array.isArray(payload.entries)) {
    throw new Error("Luma Calendar API 未回傳活動清單。");
  }

  return payload.entries.map((entry) => normalizeCalendarEntry(entry)).filter(Boolean);
}

export function parseLumaEventPage(html, currentUrl) {
  const initialData = parseInitialData(html);
  const event = initialData.event;
  if (!event || typeof event.name !== "string") {
    throw new Error("找不到 Luma 活動資料；請確認網址指向公開活動頁面。");
  }

  const structured = parseStructuredEvent(html);
  const slug = event.url ?? eventSlugFromUrl(currentUrl);
  const ticketInfo = initialData.ticket_info ?? {};
  const tickets = Array.isArray(initialData.ticket_types)
    ? initialData.ticket_types.map(normalizeTicketType)
    : [];

  return {
    platform: "luma",
    id: event.api_id ?? null,
    slug,
    url: `https://luma.com/${encodeURIComponent(slug)}`,
    name: event.name,
    description: structured?.description ?? null,
    startAt: event.start_at ?? initialData.start_at ?? structured?.startDate ?? null,
    endAt: event.end_at ?? structured?.endDate ?? null,
    timezone: event.timezone ?? initialData.calendar?.timezone ?? null,
    status: schemaTerm(structured?.eventStatus),
    attendanceMode: schemaTerm(structured?.eventAttendanceMode),
    location: normalizeLocation(event, structured?.location),
    calendar: initialData.calendar
      ? {
          id: initialData.calendar.api_id ?? null,
          slug: initialData.calendar.slug ?? null,
          name: initialData.calendar.name ?? null,
          url: initialData.calendar.slug ? `https://luma.com/${initialData.calendar.slug}` : null,
        }
      : null,
    organizers: toArray(structured?.organizer).map((organizer) => ({
      type: organizer?.["@type"] ?? null,
      name: organizer?.name ?? null,
      url: organizer?.url ?? null,
    })),
    hosts: Array.isArray(initialData.hosts)
      ? initialData.hosts.map((host) => ({ name: host.name ?? null, username: host.username ?? null }))
      : [],
    registration: {
      availability: initialData.registration_availability ?? null,
      currentlyOpen:
        initialData.registration_availability === "open" &&
        !Boolean(initialData.sold_out ?? ticketInfo.is_sold_out),
      guestCount: finiteNumber(initialData.guest_count),
      ticketCount: finiteNumber(initialData.ticket_count),
      spotsRemaining: finiteNumber(ticketInfo.spots_remaining),
      isFree: booleanOrNull(ticketInfo.is_free),
      soldOut: Boolean(initialData.sold_out ?? ticketInfo.is_sold_out),
      nearCapacity: booleanOrNull(ticketInfo.is_near_capacity),
      requireApproval: booleanOrNull(ticketInfo.require_approval),
      waitlistActive: Boolean(initialData.waitlist_active),
    },
    offers: toArray(structured?.offers).map((offer) => ({
      name: offer?.name ?? null,
      availability: schemaTerm(offer?.availability),
      price: finiteNumber(offer?.price),
      currency: typeof offer?.priceCurrency === "string" ? offer.priceCurrency.toUpperCase() : null,
    })),
    tickets,
    coverUrl: event.cover_url ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeCalendarEntry(entry) {
  const event = entry?.event;
  if (!event || typeof event.name !== "string") return null;

  const platform = entry.platform ?? (isLumaEvent(event) ? "luma" : "external");
  const ticketInfo = entry.ticket_info ?? {};
  const slug = platform === "luma" ? event.url ?? null : null;
  const url = platform === "luma" && slug ? `https://luma.com/${slug}` : event.url ?? null;

  return {
    id: event.api_id ?? entry.api_id ?? null,
    slug,
    platform,
    name: event.name,
    url,
    startAt: event.start_at ?? entry.start_at ?? null,
    endAt: event.end_at ?? null,
    timezone: event.timezone ?? entry.calendar?.timezone ?? null,
    location: event.geo_address_info?.address ?? event.geo_address_info?.short_address ?? null,
    hosts: Array.isArray(entry.hosts)
      ? entry.hosts.map((host) => host.name).filter(Boolean)
      : typeof event.host === "string"
        ? [event.host]
        : [],
    registration:
      platform === "luma"
        ? {
            availability: entry.registration_availability ?? null,
            currentlyOpen:
              entry.registration_availability === "open" && !Boolean(ticketInfo.is_sold_out),
            guestCount: finiteNumber(entry.guest_count),
            ticketCount: finiteNumber(entry.ticket_count),
            spotsRemaining: finiteNumber(ticketInfo.spots_remaining),
            isFree: booleanOrNull(ticketInfo.is_free),
            soldOut: Boolean(ticketInfo.is_sold_out),
            nearCapacity: booleanOrNull(ticketInfo.is_near_capacity),
            requireApproval: booleanOrNull(ticketInfo.require_approval),
            waitlistActive: Boolean(entry.waitlist_active),
          }
        : null,
  };
}

function normalizeTicketType(ticket) {
  const cents = finiteNumber(ticket?.cents ?? ticket?.min_cents);
  return {
    id: ticket?.api_id ?? null,
    name: ticket?.name ?? null,
    type: ticket?.type ?? null,
    price: cents === null ? null : cents / 100,
    currency: typeof ticket?.currency === "string" ? ticket.currency.toUpperCase() : null,
    registered: finiteNumber(ticket?.num_tickets_registered ?? ticket?.num_guests),
    spotsRemaining: finiteNumber(ticket?.spots_remaining),
    requireApproval: booleanOrNull(ticket?.require_approval),
    hidden: Boolean(ticket?.is_hidden),
    disabled: Boolean(ticket?.is_disabled),
    validStartAt: ticket?.valid_start_at ?? null,
    validEndAt: ticket?.valid_end_at ?? null,
  };
}

function normalizeLocation(event, structuredLocation) {
  const address = event.geo_address_info;
  if (!address && !structuredLocation) return null;
  return {
    type: event.location_type ?? null,
    name: address?.address ?? structuredLocation?.name ?? null,
    description: address?.description ?? null,
    fullAddress: address?.full_address ?? postalAddress(structuredLocation?.address),
    city: address?.city ?? structuredLocation?.address?.addressLocality ?? null,
    region: address?.region ?? structuredLocation?.address?.addressRegion ?? null,
    country: address?.country ?? structuredLocation?.address?.addressCountry ?? null,
    latitude: finiteNumber(event.coordinate?.latitude ?? structuredLocation?.geo?.latitude),
    longitude: finiteNumber(event.coordinate?.longitude ?? structuredLocation?.geo?.longitude),
  };
}

function parseInitialData(html) {
  const $ = cheerio.load(html);
  const source = $("script#__NEXT_DATA__").first().text();
  if (!source) throw new Error("Luma 頁面缺少 __NEXT_DATA__。");
  try {
    const parsed = JSON.parse(source);
    const initialData = parsed?.props?.pageProps?.initialData?.data;
    if (!initialData || typeof initialData !== "object") throw new Error("initialData 不存在");
    return initialData;
  } catch (error) {
    throw new Error(`無法解析 Luma 頁面資料：${error.message}`);
  }
}

function parseStructuredEvent(html) {
  const $ = cheerio.load(html);
  for (const element of $("script[type='application/ld+json']").toArray()) {
    try {
      const parsed = JSON.parse($(element).text());
      const candidates = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ?? [parsed];
      const event = candidates.find((item) => toArray(item?.["@type"]).includes("Event"));
      if (event) return event;
    } catch {
      // Ignore unrelated malformed JSON-LD and continue looking for the Event object.
    }
  }
  return null;
}

function calendarSlugFromUrl(value) {
  const slug = pathSlug(value);
  if (!slug) throw new Error("無法從網址判斷 Luma Calendar slug。");
  return slug;
}

function eventSlugFromUrl(value) {
  const slug = pathSlug(value);
  if (!slug) throw new Error("無法從網址判斷 Luma 活動 slug。");
  return slug;
}

function pathSlug(value) {
  try {
    return decodeURIComponent(new URL(value, "https://luma.com").pathname.split("/").filter(Boolean)[0] ?? "");
  } catch {
    return "";
  }
}

function isLumaEvent(event) {
  return typeof event.url === "string" && !/^https?:\/\//i.test(event.url);
}

function schemaTerm(value) {
  if (typeof value !== "string") return null;
  return value.split(/[\/#]/).filter(Boolean).at(-1) ?? null;
}

function postalAddress(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return [value.streetAddress, value.addressLocality, value.addressRegion, value.addressCountry]
    .filter(Boolean)
    .join(", ") || null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
