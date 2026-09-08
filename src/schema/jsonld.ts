/**
 * schema.org JobPosting.
 *
 * Two audiences, one document. Search engines want this because it is the
 * format they already index, and an agent wants it because it is the one job
 * description shape it has certainly seen before. Emitting it on the page and
 * from the API means neither audience needs a bespoke parser for this board.
 *
 * The `agentPolicy` and the application schema have no schema.org equivalent,
 * so they travel in an `additionalProperty` array, which is the vocabulary's
 * own escape hatch and survives every validator.
 */

import type { Job } from './job.ts';

export interface JsonLdJobPosting extends Record<string, unknown> {
  '@context': 'https://schema.org';
  '@type': 'JobPosting';
}

/** Annualise so `baseSalary` is comparable between listings. */
const PER_YEAR: Record<string, number> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
};

export function jobPostingJsonLd(job: Job, origin: string): JsonLdJobPosting {
  const url = `${origin}/jobs/${job.slug}`;
  const doc: JsonLdJobPosting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    '@id': url,
    url,
    title: job.title,
    description: job.description,
    datePosted: job.publishedAt ?? job.createdAt,
    employmentType: EMPLOYMENT[job.employmentType] ?? 'OTHER',
    hiringOrganization: {
      '@type': 'Organization',
      name: job.org.name,
      ...(job.org.website ? { sameAs: job.org.website } : {}),
      ...(job.org.logoUrl ? { logo: job.org.logoUrl } : {}),
    },
    directApply: job.apply.via === 'board',
  };

  if (job.expiresAt) doc['validThrough'] = job.expiresAt;
  if (job.tags.length > 0) doc['keywords'] = job.tags.join(', ');
  if (job.seniority) doc['experienceRequirements'] = job.seniority;
  if (job.requirements.length > 0) doc['qualifications'] = job.requirements.join('\n');
  if (job.responsibilities.length > 0) doc['responsibilities'] = job.responsibilities.join('\n');

  if (job.workplace === 'remote') {
    // Google's own requirement: TELECOMMUTE plus a location the hire may sit
    // in. Omitting jobLocation on a remote role is the single most common way
    // a correct-looking posting fails validation.
    doc['jobLocationType'] = 'TELECOMMUTE';
    if (job.remoteRegions.length > 0) {
      doc['applicantLocationRequirements'] = job.remoteRegions.map((code) => ({
        '@type': 'Country',
        name: code,
      }));
    }
  }
  if (job.location) {
    doc['jobLocation'] = {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressLocality: job.location },
    };
  }

  const salary = job.salary;
  if (salary.min !== null || salary.max !== null) {
    const min = salary.min ?? salary.max;
    const max = salary.max ?? salary.min;
    doc['baseSalary'] = {
      '@type': 'MonetaryAmount',
      currency: salary.currency.toUpperCase(),
      value: {
        '@type': 'QuantitativeValue',
        minValue: min,
        maxValue: max,
        unitText: salary.period.toUpperCase(),
      },
    };
    doc['estimatedSalary'] = {
      '@type': 'MonetaryAmount',
      currency: salary.currency.toUpperCase(),
      value: {
        '@type': 'QuantitativeValue',
        minValue: Math.round((min ?? 0) * (PER_YEAR[salary.period] ?? 1)),
        maxValue: Math.round((max ?? 0) * (PER_YEAR[salary.period] ?? 1)),
        unitText: 'YEAR',
      },
    };
  }

  const extra: Record<string, unknown>[] = [
    { '@type': 'PropertyValue', name: 'agentPolicy', value: job.agentPolicy },
    { '@type': 'PropertyValue', name: 'applyVia', value: job.apply.via },
  ];
  if (job.stack.length > 0) {
    extra.push({ '@type': 'PropertyValue', name: 'stack', value: job.stack.join(', ') });
  }
  if (job.apply.via === 'board') {
    // The whole point of the board: an agent can read the form it has to fill
    // in without rendering a page, and the endpoint it posts to is derivable
    // from the @id above.
    extra.push({
      '@type': 'PropertyValue',
      name: 'applySchemaUrl',
      value: `${origin}/api/v1/jobs/${job.slug}/apply-schema`,
    });
  }
  doc['additionalProperty'] = extra;

  return doc;
}

const EMPLOYMENT: Record<string, string> = {
  'full-time': 'FULL_TIME',
  'part-time': 'PART_TIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
  temporary: 'TEMPORARY',
};
