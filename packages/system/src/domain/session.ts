/**
 * The session and project vocabulary: how a session is listed, and how a project
 * groups sessions. Both are Morse's shapes — a harness supplies the data, but a
 * sidebar page is Morse's.
 *
 * Shapes only — no I/O, no ports, no framework imports (R2/R8). The wire DTOs are
 * already these shapes, so they are re-exported rather than written twice.
 */

export type { ProjectSummary, SessionSummary } from '@morse/protocol';
