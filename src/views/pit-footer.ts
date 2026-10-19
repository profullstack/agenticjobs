/**
 * The pit.world global footer (site name, search, ring, publish), fetched on
 * the server from https://pit.world/snippets/footer.html?site=<board host> and
 * rendered as the last thing in <body>.
 *
 * Layout renders synchronously (pages and tests stringify it directly), so this
 * returns the last good copy for the host and refreshes it in the background
 * once it is an hour old (3s timeout). A failed refresh keeps the old copy; with
 * no copy yet it returns '' and the page simply has no global footer.
 */
const MAX_AGE_MS = 60 * 60 * 1000;

interface Entry {
  html: string;
  fetchedAt: number;
  inflight: Promise<void> | null;
}

const cache = new Map<string, Entry>();

function refresh(site: string, entry: Entry): Promise<void> {
  entry.inflight ??= fetch(
    `https://pit.world/snippets/footer.html?site=${encodeURIComponent(site)}`,
    { signal: AbortSignal.timeout(3000) },
  )
    .then(async (res) => {
      const text = res.ok ? await res.text() : '';
      if (!text.includes('data-pit-footer')) throw new Error(`pit footer: HTTP ${res.status}`);
      entry.html = text;
      entry.fetchedAt = Date.now();
    })
    .catch(() => {
      entry.fetchedAt = Date.now() - MAX_AGE_MS + 60_000; // try again in a minute
    })
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}

/** The footer fragment for a board's public URL ('' until the first fetch lands). */
export function pitFooter(publicUrl: string): string {
  let site: string;
  try {
    site = new URL(publicUrl).hostname;
  } catch {
    return '';
  }
  if (!site || site === 'localhost' || site.endsWith('.test')) return '';
  let entry = cache.get(site);
  if (!entry) {
    entry = { html: '', fetchedAt: 0, inflight: null };
    cache.set(site, entry);
  }
  if (Date.now() - entry.fetchedAt > MAX_AGE_MS) void refresh(site, entry);
  return entry.html;
}
