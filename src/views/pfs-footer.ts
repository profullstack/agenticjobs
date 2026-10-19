/**
 * The shared Profullstack footer (@profullstack/footer): the board's link row,
 * the copyright line and the webring, from the package's @latest template, so a
 * release of the package reaches every board without a redeploy.
 *
 * Layout renders synchronously (pages and tests stringify it directly), so this
 * returns the last footer rendered for these options and refreshes it in the
 * background on each use; the package caches the template for an hour. Until
 * the first refresh lands it is the template from the installed package.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer';

type FooterOptions = Parameters<typeof footerHtmlSync>[0];

const rendered = new Map<string, string>();

export function pfsFooter(options: FooterOptions): string {
  const key = JSON.stringify(options);
  void footerHtml(options)
    .then((html) => rendered.set(key, html))
    .catch(() => undefined);
  return rendered.get(key) ?? footerHtmlSync(options);
}
