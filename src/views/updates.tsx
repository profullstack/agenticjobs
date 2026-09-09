/**
 * Updates: the short posts an employer or a candidate makes between jobs.
 *
 * Deliberately plain. There is no like, no repost, no counter that rewards
 * posting more often, because the failure mode of this feature is a feed
 * nobody reads, and every one of those is an incentive to post noise.
 *
 * What an update does have is an author with a page and, at most, one link.
 */

import type { FC } from 'hono/jsx';
import { Card, Empty, Field } from './layout.tsx';
import { ago } from '../schema/text.ts';
import type { Following, Update } from '../core/updates.ts';

/** Where an author's own page is, when they have one. */
function authorHref(author: Update['author']): string | null {
  if (author.slug === null) return null;
  return author.kind === 'employer' ? `/employers/${author.slug}` : `/candidates/${author.slug}`;
}

/** A link, shown as its host so the destination is legible before the click. */
function hostOf(link: string): string {
  try {
    return new URL(link).host.replace(/^www\./, '');
  } catch {
    return link;
  }
}

export const UpdateItem: FC<{ update: Update; showAuthor?: boolean }> = ({
  update,
  showAuthor = true,
}) => {
  const href = authorHref(update.author);
  return (
    // The id is the feed's anchor: every entry's guid points at this element,
    // so an item opened from a reader lands on the update it came from.
    <li class="update" id={update.id}>
      {showAuthor && (
        <p class="update-author">
          {href === null ? (
            <strong>{update.author.name}</strong>
          ) : (
            <a href={href}>
              <strong>{update.author.name}</strong>
            </a>
          )}{' '}
          <span class="small muted">
            {update.author.kind === 'employer' ? 'employer' : 'candidate'} &middot;{' '}
            {ago(update.createdAt)}
          </span>
        </p>
      )}
      {/* The body is text, and it is rendered as text. Nothing an author
          typed becomes markup on somebody else's page. */}
      <p class="update-body">{update.body}</p>
      {update.link !== null && (
        <p class="small">
          {/* nofollow, because a board with an open posting form is a link
              farm the moment it passes PageRank on. */}
          <a href={update.link} rel="nofollow noopener" class="update-link">
            {hostOf(update.link)}
          </a>
        </p>
      )}
      {!showAuthor && <p class="small muted">{ago(update.createdAt)}</p>}
    </li>
  );
};

export const UpdateList: FC<{ updates: Update[]; showAuthor?: boolean }> = ({
  updates,
  showAuthor = true,
}) => (
  <ul class="update-list">
    {updates.map((update) => (
      <UpdateItem update={update} showAuthor={showAuthor} />
    ))}
  </ul>
);

/**
 * The composer.
 *
 * `action` is where it posts, so the same form serves an employer page and a
 * candidate's own dashboard without either growing a hidden "who am I" field
 * that a caller could change.
 */
export const UpdateComposer: FC<{
  action: string;
  as: string;
  max: number;
  error?: string;
  value?: string;
}> = ({ action, as, max, error, value }) => (
  <Card>
    <div class="card-header">
      <h2 class="card-title">Post an update</h2>
      <p class="card-description">
        As <strong>{as}</strong>. What changed: a role filled, something shipped, when you are
        free next. Five a day, {max} characters, one link.
      </p>
    </div>
    <form method="post" action={action} class="stack-sm">
      <Field label="Update" name="body" error={error}>
        <textarea
          id="body"
          name="body"
          rows={3}
          maxlength={max}
          required
          placeholder="We just closed the backend role. Two more open next month."
        >
          {value ?? ''}
        </textarea>
      </Field>
      <Field label="Link" name="link" hint="Optional. One public URL.">
        <input id="link" name="link" type="url" placeholder="https://" />
      </Field>
      <div class="row">
        <button class="btn" type="submit">
          Post
        </button>
      </div>
    </form>
  </Card>
);

/**
 * Follow, as a form rather than a link.
 *
 * A GET that changes state is a state change any prefetching browser, mail
 * scanner or crawler can make on the reader's behalf.
 */
export const FollowButton: FC<{
  action: string;
  following: boolean;
  followers: number;
  signedIn: boolean;
  /** Where to send a signed-out reader back to after they sign in. */
  next: string;
}> = ({ action, following, followers, signedIn, next }) => (
  <div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap">
    {signedIn ? (
      <form method="post" action={action}>
        <input type="hidden" name="following" value={following ? 'yes' : 'no'} />
        <button class={following ? 'btn btn-secondary btn-sm' : 'btn btn-sm'} type="submit">
          {following ? 'Following' : 'Follow'}
        </button>
      </form>
    ) : (
      <a class="btn btn-sm" href={`/login?next=${encodeURIComponent(next)}`}>
        Follow
      </a>
    )}
    <span class="small muted">
      {followers} {followers === 1 ? 'follower' : 'followers'}
    </span>
  </div>
);

/**
 * Everything social about one author, in one block.
 *
 * The employer page and the candidate page get the identical thing rather
 * than each growing their own follow button and their own list, because two
 * of these would drift the first time one is changed.
 */
export interface SocialProps {
  /** The name of whoever this page is about, for the composer. */
  as: string;
  updates: Update[];
  follow: {
    action: string;
    following: boolean;
    followers: number;
    signedIn: boolean;
    next: string;
  };
  /** Present only when the viewer is allowed to post as this author. */
  composer: { action: string; max: number } | null;
  error?: string;
}

export const AuthorSocial: FC<SocialProps> = ({ as, updates, follow, composer, error }) => (
  <div class="stack">
    <FollowButton {...follow} />
    {composer !== null && (
      <UpdateComposer action={composer.action} as={as} max={composer.max} error={error} />
    )}
    {updates.length > 0 && (
      <div class="stack-sm">
        <h2 class="card-title">Updates</h2>
        <UpdateList updates={updates} showAuthor={false} />
      </div>
    )}
  </div>
);

/** The board's news page: everything anybody posted. */
export const UpdatesPage: FC<{
  updates: Update[];
  boardName: string;
  followed: Update[] | null;
  following: Following[];
}> = ({ updates, boardName, followed, following }) => (
  <div class="stack">
    <div class="stack-sm">
      <h1>Updates</h1>
      <p class="lede">
        Short posts from the employers and candidates on {boardName}. Everyone here is a real
        employer or a person with a resume, and nobody can post more than five a day.
      </p>
    </div>

    {followed !== null && (
      <Card>
        <div class="card-header">
          <h2 class="card-title">From the {following.length} you follow</h2>
        </div>
        {followed.length === 0 ? (
          <p class="small muted">
            {following.length === 0
              ? 'You do not follow anybody yet. There is a Follow button on every employer and candidate page.'
              : 'Nothing yet from anybody you follow.'}
          </p>
        ) : (
          <UpdateList updates={followed} />
        )}
        {following.length > 0 && (
          <p class="small muted" style="margin-top:.6rem">
            Following:{' '}
            {following.map((entry, index) => (
              <>
                {index > 0 && ', '}
                {entry.slug === null ? (
                  entry.name
                ) : (
                  <a
                    href={
                      entry.kind === 'employer'
                        ? `/employers/${entry.slug}`
                        : `/candidates/${entry.slug}`
                    }
                  >
                    {entry.name}
                  </a>
                )}
              </>
            ))}
          </p>
        )}
      </Card>
    )}

    <h2 class="card-title">Everyone</h2>
    {updates.length === 0 ? (
      <Empty>
        <h2>Nothing posted yet</h2>
        <p>
          An employer or a candidate posts here from their own page. It is the space between
          "posted a job" and silence.
        </p>
      </Empty>
    ) : (
      <UpdateList updates={updates} />
    )}

    <p class="small muted">
      This page is a feed: <a href="/updates/feed">/updates/feed</a>, as Markdown at{' '}
      <a href="/updates.md">/updates.md</a>, as JSON at <a href="/api/v1/updates">/api/v1/updates</a>.
      One author at a time with <code>?org=slug</code> or <code>?candidate=slug</code>.
    </p>
  </div>
);
