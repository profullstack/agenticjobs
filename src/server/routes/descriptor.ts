/**
 * What this instance says about itself at /.well-known/agenticjobs.
 *
 * Built from live counts rather than from configuration, so an instance cannot
 * advertise a hundred openings it does not have. The directory re-reads this
 * on its own schedule; nothing here is cached longer than a request.
 */

import type pg from 'pg';
import type { Config } from '../../config.ts';
import { SOFTWARE_NAME } from '../../config.ts';
import { countJobs } from '../../core/jobs.ts';
import { PROTOCOL_VERSION, type InstanceDescriptor } from '../../schema/instance.ts';

export async function descriptorFor(pool: pg.Pool, config: Config): Promise<InstanceDescriptor> {
  const jobs = await countJobs(pool);
  return {
    protocol: PROTOCOL_VERSION,
    url: config.publicUrl,
    name: config.boardName,
    tagline: config.boardTagline,
    topics: config.topics,
    software: { name: SOFTWARE_NAME, version: config.version },
    jobs,
    endpoints: {
      search: `${config.publicUrl}/api/v1/jobs`,
      openapi: `${config.publicUrl}/api/v1/openapi.json`,
      mcp: `${config.publicUrl}/api/mcp`,
      feed: `${config.publicUrl}/jobs.json`,
    },
    directory: config.isDirectory,
    contact: null,
  };
}
