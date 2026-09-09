/**
 * Candidates: the other half of a job board.
 *
 * The board had listings and no people, so a resume set to "public" went
 * nowhere. These pages are the counterpart to the job pages, and they follow
 * the same rule: a person reads the page, an agent reads the JSON, and neither
 * has to scrape the other's format.
 *
 * What a candidate card shows is taken from the parsed resume rather than
 * typed twice. A resume that says nothing is rendered as what it is instead of
 * padded out with placeholders.
 */

import type { FC } from 'hono/jsx';
import { Card, Prose } from './layout.tsx';
import type { OpenResume } from '../markup/resume.ts';

export interface CandidateSummary {
  slug: string;
  name: string;
  headline: string | null;
  location: string | null;
  skills: string[];
  updatedAt: string;
}

/**
 * The contact block is deliberately not in the summary.
 *
 * A directory page listing a hundred email addresses is a mailing list for
 * whoever fetches it once. The detail page shows what the resume says, because
 * that is the page the candidate chose to publish.
 */
export const CandidateList: FC<{
  candidates: CandidateSummary[];
  publicUrl: string;
}> = ({ candidates, publicUrl }) => (
  <div class="stack">
    <div class="stack-sm">
      <h1>Candidates</h1>
      <p class="lede">
        People who published a resume here. Every one of these is a person who chose to be
        listed, not a profile scraped from somewhere else.
      </p>
    </div>

    {candidates.length === 0 ? (
      <div class="empty">
        <h2>Nobody is listed yet</h2>
        <p>
          A resume is private until its owner says otherwise. When someone sets one to public,
          it appears here.
        </p>
        <p>
          <a class="btn" href="/me/resumes/new">
            Publish yours
          </a>
        </p>
      </div>
    ) : (
      <>
        <p class="small muted">
          {candidates.length} {candidates.length === 1 ? 'candidate' : 'candidates'}. As data:{' '}
          <a href="/api/v1/candidates">/api/v1/candidates</a>
        </p>
        <div class="stack">
          {candidates.map((candidate) => (
            <Card>
              <h2 class="card-title" style="margin:0">
                <a href={`/candidates/${candidate.slug}`}>{candidate.name}</a>
              </h2>
              {candidate.headline !== null && <p class="card-description">{candidate.headline}</p>}
              {candidate.location !== null && (
                <p class="small muted">{candidate.location}</p>
              )}
              {candidate.skills.length > 0 && (
                <div class="row" style="flex-wrap:wrap;gap:.35rem">
                  {candidate.skills.map((skill) => (
                    <span class="badge badge-outline">{skill}</span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      </>
    )}

    <p class="small muted">
      This page is also a feed: <a href={`${publicUrl}/feed.rss`}>/feed.rss</a>
    </p>
  </div>
);

export const CandidateDetail: FC<{
  candidate: CandidateSummary;
  parsed: OpenResume | null;
  html: string;
  markdownUrl: string;
  listed: boolean;
}> = ({ candidate, parsed, html, markdownUrl, listed }) => (
  <div class="grid-2">
    <article class="stack">
      <div class="stack-sm">
        <h1 style="margin-bottom:0">{candidate.name}</h1>
        {candidate.headline !== null && <p class="lede">{candidate.headline}</p>}
      </div>
      <Prose html={html} />
    </article>

    <aside class="stack">
      {parsed !== null && parsed.contact.length > 0 && (
        <Card>
          <div class="card-header">
            <h2 class="card-title">Contact</h2>
          </div>
          <ul class="stack-sm" style="list-style:none;margin:0;padding:0">
            {parsed.contact.map((item) => (
              <li class="small">
                <span class="muted">{item.key}: </span>
                {item.href === null ? (
                  item.value
                ) : (
                  <a href={item.href} rel="nofollow">
                    {item.value}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div class="card-header">
          <h2 class="card-title">For agents</h2>
          <p class="card-description">
            This resume is OpenResume Markdown. Read it as data rather than parsing this page.
          </p>
        </div>
        <pre class="code-block">GET {markdownUrl}</pre>
        <p class="small muted">
          The Markdown is the canonical document. <a href="/docs/openresume">The spec</a>.
        </p>
      </Card>

      {!listed && (
        <p class="small muted">
          This page is not in the candidate directory. Whoever published it shared the link
          directly.
        </p>
      )}
    </aside>
  </div>
);
