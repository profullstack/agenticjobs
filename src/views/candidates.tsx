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
import { AuthorSocial, type SocialProps } from './updates.tsx';
import { RecommendationList, RecommendForm, type RecommendFormProps } from './recommendations.tsx';
import type { Recommendation } from '../core/recommendations.ts';
import type { OpenResume } from '../markup/resume.ts';
import { formatCapacity, type SwarmCapacity } from '../core/capacity.ts';

/** Where a tag badge points. Multiple tags narrow, so they accumulate. */
function tagHref(tags: string[]): string {
  return tags.length === 0
    ? '/candidates'
    : `/candidates?tags=${encodeURIComponent(tags.join(','))}`;
}

function addTag(tags: string[], tag: string): string[] {
  return tags.some((item) => item.toLowerCase() === tag.toLowerCase()) ? tags : [...tags, tag];
}

export interface CandidateSummary {
  slug: string;
  name: string;
  headline: string | null;
  location: string | null;
  /** All distinct skills for filtering; cards limit the badges they display. */
  skills: string[];
  /**
   * How many agents this candidate runs and what they cost, when the resume
   * says. Null on every resume written before the convention existed, which
   * today is most of them.
   */
  capacity: SwarmCapacity | null;
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
  /** The tags being filtered on, if any. */
  tags?: string[];
  /** Every tag anyone lists, for browsing. */
  index?: { tag: string; count: number }[];
}> = ({ candidates, publicUrl, tags = [], index = [] }) => (
  <div class="stack">
    <div class="stack-sm">
      <h1>Candidates</h1>
      <p class="lede">
        People who published a resume here. Every one of these is a person who chose to be
        listed, not a profile scraped from somewhere else.
      </p>
      {tags.length > 0 && (
        <p class="row" style="align-items:center;flex-wrap:wrap;gap:.5rem">
          <span class="small muted">Listing everyone who has all of:</span>
          {tags.map((tag) => (
            <a
              class="badge"
              title={`Remove ${tag}`}
              href={tagHref(tags.filter((other) => other !== tag))}
            >
              {tag} x
            </a>
          ))}
          <a class="small" href="/candidates">
            Clear
          </a>
          {/*
            * /candidates/feed, not /feed.rss. The latter is the everything
            * feed (jobs, employers and people), so subscribing from a page
            * of candidates filtered to a skill delivered mostly job posts.
            */}
          <a class="small" href={`/candidates/feed?tags=${encodeURIComponent(tags.join(','))}`}>
            Subscribe
          </a>
        </p>
      )}
    </div>

    {candidates.length === 0 ? (
      <div class="empty">
        <h2>{tags.length === 0 ? 'Nobody is listed yet' : `Nobody lists all of ${tags.join(', ')}`}</h2>
        {tags.length === 0 ? (
          <>
            <p>
              A resume is private until its owner says otherwise. When someone sets one to
              public, it appears here.
            </p>
            <p>
              <a class="btn" href="/me/resumes/new">
                Publish yours
              </a>
            </p>
          </>
        ) : (
          <p>
            <a class="btn btn-secondary" href="/candidates">
              See everyone
            </a>
          </p>
        )}
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
              {/*
                * Capacity is a badge rather than another muted line, because
                * it is the number an employer is shopping on. An unstated one
                * says so instead of being omitted: a blank row reads as "one
                * agent" to anyone skimming, and that is exactly the wrong
                * default for someone running ten.
                */}
              {candidate.capacity === null ? (
                <p class="small muted">Capacity not stated</p>
              ) : (
                <p>
                  <span class="badge">{formatCapacity(candidate.capacity)}</span>
                </p>
              )}
              {candidate.skills.length > 0 && (
                <div class="row" style="flex-wrap:wrap;gap:.35rem">
                  {candidate.skills.slice(0, 8).map((item) => (
                    <a class="badge badge-outline" href={tagHref(addTag(tags, item))}>
                      {item}
                    </a>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      </>
    )}

    {index.length > 0 && (
      <div class="stack-sm">
        <h2 class="card-title">Every skill listed here</h2>
        <div class="row" style="flex-wrap:wrap;gap:.35rem">
          {index.map((entry) => (
            <a class="badge badge-outline" href={tagHref([entry.tag])}>
              {entry.tag} {entry.count}
            </a>
          ))}
        </div>
      </div>
    )}

    <p class="small muted">
      This page is a feed: <a href="/candidates/feed">/candidates/feed</a>. So is any set of
      tags, at <code>/candidates/feed?tags=javascript,react</code>. Jobs have their own at{' '}
      <a href="/feed">/feed</a>, updates at <a href="/updates/feed">/updates/feed</a>, and{' '}
      <a href={`${publicUrl}/feed.rss`}>/feed.rss</a> is everything.
    </p>
  </div>
);

export const CandidateDetail: FC<{
  candidate: CandidateSummary;
  parsed: OpenResume | null;
  html: string;
  markdownUrl: string;
  listed: boolean;
  /** True when this viewer is being shown the resume without its contact block. */
  contactRedacted?: boolean;
  /** Follow, updates and, for the person themselves, the composer. */
  social?: SocialProps;
  /** Approved recommendations, shown to everyone. */
  recommendations?: Recommendation[];
  /** The form to write one, for a signed-in reader who is not this person. */
  recommend?: RecommendFormProps | null;
}> = ({ candidate, parsed, html, markdownUrl, listed, contactRedacted = false, social, recommendations = [], recommend = null }) => (
  <div class="grid-2">
    <article class="stack">
      <div class="stack-sm">
        <h1 style="margin-bottom:0">{candidate.name}</h1>
        {candidate.headline !== null && <p class="lede">{candidate.headline}</p>}
      </div>
      {social !== undefined && <AuthorSocial {...social} />}
      <Prose html={html} />
      <RecommendationList items={recommendations} about={candidate.name} />
      {recommend !== null && <RecommendForm {...recommend} />}
    </article>

    <aside class="stack">
      {candidate.skills.length > 0 && (
        <Card>
          <div class="card-header">
            <h2 class="card-title">Skills</h2>
            <p class="card-description">Each one finds everybody else who lists it.</p>
          </div>
          <div class="row" style="flex-wrap:wrap;gap:.35rem">
            {candidate.skills.map((item) => (
              <a class="badge badge-outline" href={tagHref([item])}>
                {item}
              </a>
            ))}
          </div>
        </Card>
      )}
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
          {contactRedacted && (
            <p class="small muted">
              <a href={`/login?next=${encodeURIComponent(`/candidates/${candidate.slug}`)}`}>
                Sign in
              </a>{' '}
              to see how to reach {candidate.name}. An agent holding a token sees them too.
            </p>
          )}
        </Card>
      )}

      <Card>
        <div class="card-header">
          <h2 class="card-title">Download</h2>
          <p class="card-description">
            Made from the Markdown when you ask, so a file is never out of date with the page.
          </p>
        </div>
        <div class="row" style="flex-wrap:wrap;gap:.4rem">
          <a class="btn btn-secondary btn-sm" href={`/candidates/${candidate.slug}/resume.pdf`}>
            PDF
          </a>
          <a class="btn btn-secondary btn-sm" href={`/candidates/${candidate.slug}/resume.docx`}>
            DOCX
          </a>
          <a class="btn btn-secondary btn-sm" href={`/candidates/${candidate.slug}/resume.md`}>
            Markdown
          </a>
        </div>
      </Card>

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
        {contactRedacted && (
          <p class="small muted">
            Called without a token it comes back with the contact block withheld and{' '}
            <code>contactRedacted</code> set, the same as this page.
          </p>
        )}
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
