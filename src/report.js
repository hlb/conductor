export async function fetchUnifiedReport({ lumaClient, kktixClient, quiet = false }) {
  let lumaResult;
  try {
    await lumaClient.start();
    lumaResult = await lumaClient.listEvents();
  } finally {
    await lumaClient.close();
  }

  const kktixCandidateMap = new Map();
  for (const event of lumaResult.events) {
    const slug = extractKktixEventSlug(event.url);
    if (slug && !kktixCandidateMap.has(slug)) {
      kktixCandidateMap.set(slug, { slug, name: event.name, status: null, schedule: null });
    }
  }
  const kktixCandidates = [...kktixCandidateMap.values()];

  let kktixResult = {
    organization: kktixClient.organization,
    scanned: 0,
    succeeded: 0,
    events: [],
    failures: [],
    fetchedAt: null,
  };

  if (kktixCandidates.length > 0) {
    if (!quiet) process.stderr.write(`找到 ${kktixCandidates.length} 個 KKTIX 活動，正在補上售票狀態。\n`);
    try {
      await kktixClient.start();
      kktixResult = await kktixClient.getEventStatuses(kktixCandidates);
    } finally {
      await kktixClient.close();
    }
  }

  return mergeUnifiedReport(lumaResult, kktixResult);
}

export function mergeUnifiedReport(lumaResult, kktixResult) {
  const kktixEvents = new Map(kktixResult.events.map((event) => [event.slug, event]));
  const kktixFailures = new Map(kktixResult.failures.map((failure) => [failure.slug, failure]));

  const events = lumaResult.events.map((event) => {
    const kktixSlug = extractKktixEventSlug(event.url);
    if (kktixSlug) {
      const detail = kktixEvents.get(kktixSlug) ?? null;
      const failure = kktixFailures.get(kktixSlug) ?? null;
      return {
        source: "kktix",
        slug: kktixSlug,
        name: event.name,
        url: event.url,
        startAt: event.startAt,
        endAt: event.endAt,
        timezone: event.timezone,
        location: event.location,
        registration: detail ? normalizeKktixRegistration(detail) : null,
        tickets: detail?.tickets ?? [],
        detail,
        failure: failure?.reason ?? null,
      };
    }

    if (event.platform === "luma") {
      return {
        source: "luma",
        slug: event.slug,
        name: event.name,
        url: event.url,
        startAt: event.startAt,
        endAt: event.endAt,
        timezone: event.timezone,
        location: event.location,
        registration: event.registration
          ? {
              status: lumaRegistrationStatus(event.registration),
              currentlyOpen: Boolean(event.registration.currentlyOpen),
              registered: event.registration.guestCount,
              remaining: event.registration.spotsRemaining,
              capacity: sumKnown(event.registration.guestCount, event.registration.spotsRemaining),
              requireApproval: event.registration.requireApproval,
              soldOut: Boolean(event.registration.soldOut),
              waitlistActive: Boolean(event.registration.waitlistActive),
            }
          : null,
        tickets: [],
        detail: event,
        failure: null,
      };
    }

    return {
      source: "external",
      slug: null,
      name: event.name,
      url: event.url,
      startAt: event.startAt,
      endAt: event.endAt,
      timezone: event.timezone,
      location: event.location,
      registration: null,
      tickets: [],
      detail: event,
      failure: null,
    };
  });

  return {
    calendar: lumaResult.calendar,
    count: events.length,
    summary: {
      luma: events.filter((event) => event.source === "luma").length,
      kktix: events.filter((event) => event.source === "kktix").length,
      external: events.filter((event) => event.source === "external").length,
      failures: events.filter((event) => event.failure).length,
    },
    events,
    failures: events
      .filter((event) => event.failure)
      .map((event) => ({ source: event.source, slug: event.slug, name: event.name, reason: event.failure })),
    fetchedAt: new Date().toISOString(),
  };
}

export function extractKktixEventSlug(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const isKktix =
    hostname === "kktix.cc" ||
    hostname.endsWith(".kktix.cc") ||
    hostname === "kktix.com" ||
    hostname.endsWith(".kktix.com");
  if (url.protocol !== "https:" || !isKktix) return null;

  const match = url.pathname.match(/^\/events\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/?$/);
  return match?.[1] ?? null;
}

function normalizeKktixRegistration(event) {
  const sold = finiteNumber(event.inventory?.sold);
  const remaining = finiteNumber(event.inventory?.remaining);
  const soldOut = remaining === 0;
  return {
    status: event.currentlySelling ? "selling" : soldOut ? "sold-out" : "not-selling",
    currentlyOpen: Boolean(event.currentlySelling),
    registered: sold,
    remaining,
    capacity: sumKnown(sold, remaining),
    requireApproval: null,
    soldOut,
    waitlistActive: false,
  };
}

function lumaRegistrationStatus(registration) {
  if (registration.soldOut) return "sold-out";
  if (registration.waitlistActive) return "waitlist";
  if (registration.currentlyOpen) return "open";
  return registration.availability ?? "not-open";
}

function sumKnown(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left + right : null;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}
