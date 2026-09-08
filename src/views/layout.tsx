/**
 * The page shell and the shared components.
 *
 * These mirror shadcn/ui's anatomy - Card, Badge, Button, Alert - so the
 * markup reads the way a shadcn app's does, while rendering server-side
 * through Hono's JSX with no React and no Tailwind. The classes are defined in
 * web/public/app.css.
 */

import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Viewer } from '../core/auth.ts';
import { jsonForScript } from '../markup/escape.ts';

export interface PageProps {
  title: string;
  description?: string;
  viewer: Viewer | null;
  boardName: string;
  publicUrl: string;
  path: string;
  /** Rendered into a script[type=application/ld+json]. */
  jsonld?: unknown;
  canonical?: string;
  /** Hidden from search engines: dashboards, editors, one-off flows. */
  noindex?: boolean;
  isDirectory?: boolean;
}

export const Layout: FC<PropsWithChildren<PageProps>> = (props) => {
  const {
    title,
    description,
    viewer,
    boardName,
    publicUrl,
    path,
    jsonld,
    canonical,
    noindex,
    isDirectory,
    children,
  } = props;

  const full = title === boardName ? title : `${title} - ${boardName}`;
  const url = canonical ?? `${publicUrl}${path}`;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{full}</title>
        {description !== undefined && <meta name="description" content={description} />}
        <link rel="canonical" href={url} />
        {noindex === true && <meta name="robots" content="noindex, nofollow" />}
        <meta property="og:title" content={full} />
        {description !== undefined && <meta property="og:description" content={description} />}
        <meta property="og:url" content={url} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={boardName} />
        <meta name="twitter:card" content="summary" />
        {/* The theme meta is duplicated per scheme so the browser chrome
            matches whichever palette the page actually painted. */}
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111318" />
        <link rel="stylesheet" href="/assets/app.css" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/assets/icon.svg" type="image/svg+xml" />
        <link rel="alternate" type="application/json" href="/jobs.json" title={`${boardName} jobs`} />
        <link rel="alternate" type="application/rss+xml" href="/jobs.rss" title={`${boardName} jobs`} />
        {jsonld !== undefined && (
          <script
            type="application/ld+json"
            // Interpolating JSON into a script element without escaping the
            // angle brackets is stored XSS the first time a job title contains
            // the word "script".
            dangerouslySetInnerHTML={{ __html: jsonForScript(jsonld) }}
          />
        )}
      </head>
      <body>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="site-header">
          <div class="container">
            <a class="brand" href="/">
              <span class="brand-mark" aria-hidden="true">
                aj
              </span>
              {boardName}
            </a>
            <nav class="nav" aria-label="Main">
              <a href="/" aria-current={path === '/' ? 'page' : undefined}>
                Jobs
              </a>
              <a href="/employers" aria-current={path.startsWith('/employers') ? 'page' : undefined}>
                Employers
              </a>
              {isDirectory === true && (
                <a href="/network" aria-current={path.startsWith('/network') ? 'page' : undefined}>
                  Network
                </a>
              )}
              <a href="/docs" aria-current={path.startsWith('/docs') ? 'page' : undefined}>
                For agents
              </a>
              {viewer === null ? (
                <a class="btn btn-sm" href="/login">
                  Sign in
                </a>
              ) : (
                <>
                  <a href="/me" aria-current={path.startsWith('/me') ? 'page' : undefined}>
                    You
                  </a>
                  <a class="btn btn-sm" href="/post">
                    Post a job
                  </a>
                </>
              )}
            </nav>
          </div>
        </header>
        <main id="main">
          <div class="container">{children}</div>
        </main>
        <footer class="site-footer">
          <div class="container">
            <span>
              {boardName} runs on{' '}
              <a href="https://github.com/profullstack/agenticjobs">agenticjobs</a>, MIT licensed.
            </span>
            <a href="/docs">API</a>
            <a href="/api/v1/openapi.json">OpenAPI</a>
            <a href="/.well-known/agenticjobs">Instance</a>
            <a href="/jobs.json">Feed</a>
            <a href="/llms.txt">llms.txt</a>
          </div>
        </footer>
        <script src="/assets/app.js" defer></script>
      </body>
    </html>
  );
};

/** Rendered Markdown. The only place already-escaped HTML enters a page. */
export const Prose: FC<{ html: string; class?: string }> = ({ html, class: className }) => (
  <div class={className === undefined ? 'prose' : `prose ${className}`}>{raw(html)}</div>
);

export const Card: FC<PropsWithChildren<{ class?: string; id?: string; hidden?: boolean }>> = ({
  class: className,
  id,
  hidden,
  children,
}) => (
  <div class={className === undefined ? 'card' : `card ${className}`} id={id} hidden={hidden}>
    {children}
  </div>
);

export const Alert: FC<
  PropsWithChildren<{ variant?: 'error' | 'success' | 'warning' | 'info' }>
> = ({ variant = 'info', children }) => (
  <div class={`alert alert-${variant}`} role={variant === 'error' ? 'alert' : undefined}>
    {children}
  </div>
);

export const Badge: FC<PropsWithChildren<{ variant?: string; class?: string }>> = ({
  variant,
  class: className,
  children,
}) => (
  <span class={['badge', variant ? `badge-${variant}` : '', className ?? ''].filter(Boolean).join(' ')}>
    {children}
  </span>
);

/**
 * The agent policy, shown on every listing.
 *
 * It is the field the board exists for, so it is never hidden behind a detail
 * disclosure and never abbreviated to an icon on small screens.
 */
export const AgentPolicyBadge: FC<{ policy: string }> = ({ policy }) => {
  if (policy === 'welcome') {
    return (
      <Badge variant="welcome" class="badge-dot">
        Agents welcome
      </Badge>
    );
  }
  if (policy === 'human-only') {
    return (
      <Badge variant="human" class="badge-dot">
        Human-written
      </Badge>
    );
  }
  return (
    <Badge variant="disclose" class="badge-dot">
      Agents, disclosed
    </Badge>
  );
};

export const Empty: FC<PropsWithChildren> = ({ children }) => <div class="empty">{children}</div>;

export const Field: FC<
  PropsWithChildren<{ label: string; name: string; hint?: string; error?: string }>
> = ({ label, name, hint, error, children }) => (
  <div class={error === undefined ? 'field' : 'field field-error'}>
    <label class="label" for={name}>
      {label}
    </label>
    {children}
    {hint !== undefined && <span class="hint">{hint}</span>}
    {error !== undefined && <span class="error-text">{error}</span>}
  </div>
);
