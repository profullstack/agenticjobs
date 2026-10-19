/**
 * One CrawlProof ad unit, as a script-free cross-origin iframe.
 *
 * `ad.js` fills a placeholder with a `srcdoc` iframe, and a srcdoc document
 * inherits this page's Content-Security-Policy: the creative's inline styles
 * and remote images would only render with a far looser policy than this
 * board sends. `/api/ads/frame` serves the same creative as a real
 * cross-origin document, so the cost here is one `frame-src` entry, no
 * third-party JavaScript and nothing written to this origin's storage.
 * Impressions are metered server-side exactly as on the script path.
 *
 * The format is `text_link`, the one fluid creative: 40px tall at any width,
 * with its own "Sponsored" mark. Banners are laid out at a fixed pixel width
 * and would be cropped in a narrow column, and choosing by viewport needs a
 * script. No `&theme=`: the frame answers prefers-color-scheme itself.
 */
import type { FC } from 'hono/jsx';

export const AD_ORIGIN = 'https://crawlproof.com';
export const AD_SLOT = '9c3d6e3d-ae1f-43ff-b6d9-4f42f11725ce';

/** First path segments that never carry an ad: flows, accounts, dashboards, admin. */
const NO_AD_SEGMENTS = new Set([
  'tracker',
  'fleets',
  'post',
  'post-a-job',
  'me',
  'inbox',
  'notifications',
  'applications',
  'admin',
  'login',
  'auth',
  'device',
  'invoices',
  'coinpay',
  'revisions',
]);

/** Public, indexable pages only. A noindex page is a dashboard or a one-off flow. */
export function showsAd(path: string, noindex?: boolean): boolean {
  if (noindex) return false;
  const first = path.split(/[/?#]/)[1] ?? '';
  return !NO_AD_SEGMENTS.has(first);
}

export const AdUnit: FC<{ format?: 'text_link' }> = ({ format = 'text_link' }) => {
  const src = `${AD_ORIGIN}/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&format=${encodeURIComponent(format)}`;
  return (
    <aside class="ad-unit" data-ad-format={format} aria-label="Advertisement">
      <div class="container">
        {/* No allow-scripts, no allow-same-origin: the creative is static HTML.
            The popup permissions let its click-through open a new tab. */}
        <iframe
          src={src}
          title="Advertisement"
          height="40"
          loading="lazy"
          scrolling="no"
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
        ></iframe>
      </div>
    </aside>
  );
};
