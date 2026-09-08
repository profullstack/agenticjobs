/**
 * The package's public surface.
 *
 * Kept to the parts another program has a reason to import: the schema (so a
 * tool can speak OpenJob without this board), the client (so it can talk to
 * one), and the markup pipeline. The server half is reachable by path but is
 * not part of the promise.
 */

export * from './schema/index.ts';
export * from './client/index.ts';
export { renderMarkdown, renderInline, toPlainText } from './markup/markdown.ts';
export { parseResume, resumeTemplate, resumeSearchText } from './markup/resume.ts';
export type { OpenResume, ResumeEntry, ResumeSection } from './markup/resume.ts';
export { VERSION, SOFTWARE_NAME } from './config.ts';
