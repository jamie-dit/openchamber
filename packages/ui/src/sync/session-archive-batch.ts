/**
 * OpenChamber-owned session routes: archive, unarchive, metadata.
 *
 * Archiving the sessions linked to a worktree one request at a time is what
 * made removing a worktree with many sessions take tens of seconds: every
 * session cost its own round trip and its own store reconciliation. This asks
 * the OpenChamber server to archive the whole batch next to OpenCode, so the
 * browser spends one request and reconciles once.
 *
 * OpenCode 2.x has no HTTP route that sets `time.archived` or rewrites a
 * session's metadata after creation, so OpenChamber keeps both itself, next to
 * OpenCode, per data directory. These routes are an OpenChamber capability, not
 * an OpenCode one. Runtimes that do not serve them (the VS Code webview has no
 * server process) answer with a stable unsupported status, and callers fall
 * back to a per-session path or report failure.
 */

import type { JsonValue, Metadata } from "@/lib/opencode/model"
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The routes answer with the archive records the OpenChamber server owns: the
 * session id and the timestamp it wrote (`null` once cleared). These are not
 * sessions, and nothing here casts them to one. A record upserted as a session
 * replaces the held copy with an object that has no `time`, which is what
 * crashed the sidebar. Callers flag the session this client already holds
 * instead.
 */
const archivedRecordSchema = z.object({
  id: z.string().min(1),
  archivedAt: z.number().optional(),
});

export type SessionArchivedRecord = z.infer<typeof archivedRecordSchema>;

const archiveResponseSchema = z.object({
  archived: z.array(archivedRecordSchema),
  failedIds: z.array(z.string().min(1)),
});

export type SessionArchiveBatchResult =
  | { outcome: 'archived'; archived: SessionArchivedRecord[]; failedIds: string[] }
  | { outcome: 'unavailable'; reason: string };

export async function requestSessionArchiveBatch(
  directory: string,
  ids: string[],
  archivedAt: number,
): Promise<SessionArchiveBatchResult> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/openchamber/sessions/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory, ids, archivedAt }),
    });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'archive request failed' };
  }

  if (!response.ok) {
    return { outcome: 'unavailable', reason: `archive request failed with ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'archive response was not JSON' };
  }

  const parsed = archiveResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A body this layer cannot read is reported as unavailable rather than as
    // an empty success, so a caller never mistakes "the response made no
    // sense" for "nothing needed archiving" and drops the sessions.
    return { outcome: 'unavailable', reason: `malformed archive response: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` };
  }

  return {
    outcome: 'archived',
    archived: parsed.data.archived,
    failedIds: parsed.data.failedIds,
  };
}

const restoredRecordSchema = z.object({
  id: z.string().min(1),
  archivedAt: z.number().nullable().optional(),
});

export type SessionRestoredRecord = z.infer<typeof restoredRecordSchema>;

const unarchiveResponseSchema = z.object({
  restored: z.array(restoredRecordSchema),
  failedIds: z.array(z.string().min(1)),
});

export type SessionUnarchiveBatchResult =
  | { outcome: 'restored'; restored: SessionRestoredRecord[]; failedIds: string[] }
  | { outcome: 'unavailable'; reason: string };

/** Clears `time.archived` for a batch of sessions. Mirrors the archive route. */
export async function requestSessionUnarchiveBatch(ids: string[]): Promise<SessionUnarchiveBatchResult> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/openchamber/sessions/unarchive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'unarchive request failed' };
  }

  if (!response.ok) {
    return { outcome: 'unavailable', reason: `unarchive request failed with ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'unarchive response was not JSON' };
  }

  const parsed = unarchiveResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { outcome: 'unavailable', reason: `malformed unarchive response: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` };
  }

  return {
    outcome: 'restored',
    restored: parsed.data.restored,
    failedIds: parsed.data.failedIds,
  };
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

const metadataResponseSchema = z.object({
  metadata: z.record(z.string(), jsonValueSchema),
});

export type SessionMetadataUpdateResult =
  | { outcome: 'updated'; metadata: Metadata }
  | { outcome: 'unavailable'; reason: string };

/**
 * Applies a JSON Merge Patch (RFC 7386) to a session's metadata: nested
 * objects merge key by key and `null` deletes. OpenCode only accepts metadata
 * at creation time, so the merged record lives with the OpenChamber server,
 * which folds it into every session record it serves. Resolves with the
 * session's full metadata after the patch.
 */
export async function requestSessionMetadataUpdate(
  sessionID: string,
  patch: Metadata,
): Promise<SessionMetadataUpdateResult> {
  let response: Response;
  try {
    response = await runtimeFetch(`/api/openchamber/sessions/${encodeURIComponent(sessionID)}/metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'metadata request failed' };
  }

  if (!response.ok) {
    return { outcome: 'unavailable', reason: `metadata request failed with ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: 'unavailable', reason: error instanceof Error ? error.message : 'metadata response was not JSON' };
  }

  const parsed = metadataResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { outcome: 'unavailable', reason: `malformed metadata response: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` };
  }

  return { outcome: 'updated', metadata: parsed.data.metadata };
}
