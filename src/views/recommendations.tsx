/**
 * Recommendations: the ones on a page, the form that writes one, and the
 * section of /me where they are approved or rejected.
 *
 * A recommendation is plain text or Markdown, rendered the way every other
 * body on the board is. It carries a name and a link to the page that name
 * has, because a paragraph nobody signed is a review, and this is not a review.
 */

import type { FC } from 'hono/jsx';
import type { Recommendation, RecommendationParty } from '../core/recommendations.ts';
import { ago } from '../schema/text.ts';
import { Alert, Badge, Card, Field, MARKDOWN_HINT, Markdown } from './layout.tsx';

function pageOf(party: RecommendationParty): string | null {
  if (party.slug === null) return null;
  return party.kind === 'employer' ? `/employers/${party.slug}` : `/candidates/${party.slug}`;
}

const PartyName: FC<{ party: RecommendationParty }> = ({ party }) => {
  const href = pageOf(party);
  return href === null ? <span>{party.name}</span> : <a href={href}>{party.name}</a>;
};

export const RecommendationItem: FC<{ item: Recommendation; showSubject?: boolean }> = ({
  item,
  showSubject = false,
}) => (
  <div class="recommendation">
    <Markdown source={item.body} class="prose-compact recommendation-body" />
    <p class="small muted recommendation-meta">
      <strong>
        <PartyName party={item.author} />
      </strong>
      {showSubject && (
        <>
          {' '}
          about <PartyName party={item.subject} />
        </>
      )}
      {item.relationship !== null && <> - {item.relationship}</>}
      {' - '}
      {ago(item.decidedAt ?? item.createdAt)}
    </p>
  </div>
);

/** The approved ones, on a candidate's or an employer's page. */
export const RecommendationList: FC<{ items: Recommendation[]; about: string }> = ({
  items,
  about,
}) =>
  items.length === 0 ? (
    <></>
  ) : (
    <section class="stack-sm" id="recommendations">
      <h2 class="card-title">
        {items.length} {items.length === 1 ? 'recommendation' : 'recommendations'}
      </h2>
      <p class="small muted">
        Written by people and employers who worked with {about}, and shown because {about} approved
        each one.
      </p>
      <ul class="recommendations">
        {items.map((item) => (
          <li>
            <RecommendationItem item={item} />
          </li>
        ))}
      </ul>
    </section>
  );

/**
 * The form on a page, for a signed-in reader who is not the subject.
 *
 * `existing` is what this reader already wrote, so the form is a rewrite
 * rather than a second copy, and says what state the earlier one is in.
 */
export interface RecommendFormProps {
  action: string;
  asOptions: { slug: string; name: string }[];
  canWriteAsSelf: boolean;
  existing: Recommendation | null;
  values?: Record<string, string>;
  error?: string;
}

export const RecommendForm: FC<RecommendFormProps> = ({
  action,
  asOptions,
  canWriteAsSelf,
  existing,
  values = {},
  error,
}) => (
  <details class="card" id="recommend">
    <summary class="card-title" style="cursor:pointer">
      {existing === null ? 'Write a recommendation' : 'Rewrite your recommendation'}
    </summary>
    <div class="stack-sm" style="margin-top:.75rem">
      {error !== undefined && <Alert variant="error">{error}</Alert>}
      {existing !== null && (
        <p class="small muted">
          You wrote one {ago(existing.createdAt)}; it is{' '}
          <Badge variant={existing.status === 'approved' ? 'primary' : 'outline'}>
            {existing.status}
          </Badge>
          . Writing again replaces it and asks them to read it again.
        </p>
      )}
      {!canWriteAsSelf && asOptions.length === 0 ? (
        <p class="small muted">
          A recommendation is signed by a page. <a href="/me/resumes/new">Publish a resume</a> to
          write one as yourself, or add the employer you are writing for.
        </p>
      ) : (
        <form class="stack-sm" method="post" action={action}>
          {(asOptions.length > 0 || !canWriteAsSelf) && (
            <Field
              label="From"
              name="as"
              hint={
                canWriteAsSelf
                  ? 'Yourself, or an employer you post for.'
                  : 'An employer you post for.'
              }
            >
              <select class="select" id="as" name="as">
                {canWriteAsSelf && (
                  <option value="" selected={(values['as'] ?? '') === ''}>
                    Yourself
                  </option>
                )}
                {asOptions.map((option) => (
                  <option value={option.slug} selected={values['as'] === option.slug}>
                    {option.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label="How you know them"
            name="relationship"
            hint='"Hired them for a three-month contract", "Worked together at Acme". Optional.'
          >
            <input
              class="input"
              type="text"
              id="relationship"
              name="relationship"
              maxlength={120}
              value={values['relationship'] ?? existing?.relationship ?? ''}
            />
          </Field>
          <Field
            label="What you would say"
            name="body"
            hint={`At least 20 characters. ${MARKDOWN_HINT} It goes on their page with your name on it, once they approve it.`}
          >
            <textarea
              class="textarea"
              id="body"
              name="body"
              rows={5}
              required
              minlength={20}
              maxlength={2000}
            >
              {values['body'] ?? existing?.body ?? ''}
            </textarea>
          </Field>
          <div class="row">
            <button class="btn" type="submit">
              Send for approval
            </button>
          </div>
        </form>
      )}
    </div>
  </details>
);

const DecisionButtons: FC<{ item: Recommendation }> = ({ item }) => (
  <div class="row">
    {item.status !== 'approved' && (
      <form method="post" action={`/me/recommendations/${item.id}/approve`}>
        <button class="btn btn-sm" type="submit">
          Approve
        </button>
      </form>
    )}
    {item.status !== 'rejected' && (
      <form method="post" action={`/me/recommendations/${item.id}/reject`}>
        <button class="btn btn-secondary btn-sm" type="submit">
          {item.status === 'approved' ? 'Take it down' : 'Reject'}
        </button>
      </form>
    )}
  </div>
);

/** The /me section: what is waiting, what is up, and what you wrote. */
export const RecommendationsSection: FC<{
  received: Recommendation[];
  given: Recommendation[];
  error?: string;
}> = ({ received, given, error }) => {
  const pending = received.filter((item) => item.status === 'pending');
  const decided = received.filter((item) => item.status !== 'pending');
  return (
    <section class="stack" id="recommendations">
      <h2>Recommendations</h2>
      {error !== undefined && <Alert variant="error">{error}</Alert>}
      <p class="small muted">
        What people and employers who worked with you say about you. Nothing is shown on your page
        until you approve it, and you can take one down later. There is a form on every candidate
        and employer page to write one.
      </p>
      {pending.length > 0 && (
        <Card>
          <div class="card-header">
            <h3 class="card-title">{pending.length} waiting for you</h3>
          </div>
          <ul class="recommendations">
            {pending.map((item) => (
              <li class="stack-sm">
                <RecommendationItem item={item} showSubject />
                <DecisionButtons item={item} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {decided.length > 0 && (
        <Card>
          <div class="card-header">
            <h3 class="card-title">About you</h3>
          </div>
          <ul class="recommendations">
            {decided.map((item) => (
              <li class="stack-sm">
                <RecommendationItem item={item} showSubject />
                <div class="row" style="align-items:center;gap:.6rem">
                  <Badge variant={item.status === 'approved' ? 'primary' : 'outline'}>
                    {item.status === 'approved' ? 'on your page' : 'rejected'}
                  </Badge>
                  <DecisionButtons item={item} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {given.length > 0 && (
        <Card>
          <div class="card-header">
            <h3 class="card-title">You wrote</h3>
          </div>
          <ul class="recommendations">
            {given.map((item) => (
              <li class="stack-sm">
                <RecommendationItem item={item} showSubject />
                <div class="row" style="align-items:center;gap:.6rem">
                  <Badge variant={item.status === 'approved' ? 'primary' : 'outline'}>
                    {item.status}
                  </Badge>
                  <form method="post" action={`/me/recommendations/${item.id}/withdraw`}>
                    <button class="btn btn-ghost btn-sm" type="submit">
                      Withdraw
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {received.length === 0 && given.length === 0 && (
        <p class="small muted">None yet, in either direction.</p>
      )}
    </section>
  );
};
