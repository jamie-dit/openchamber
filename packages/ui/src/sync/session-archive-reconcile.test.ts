import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import * as sessionRoutes from './session-archive-batch';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { archiveSession, archiveSessions, unarchiveSession } from './session-actions';

// The OpenChamber archive routes answer with `{ id, archivedAt }` records
// (`archive-store.js`), not sessions. These tests run the actions against the
// real global store to prove that the held sessions are flagged in place and
// that no record ever lands in a session list as a session without `time`.

const now = Date.now();
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, projectID: 'project', directory: '/reconcile-project', title: `Title ${id}`, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now - 2, updated: now - 1 }, ...patch,
});
const hasTime = (sessions: readonly Session[]) => sessions.every((item) => item.time !== undefined);

beforeEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://reconcile.test', runtimeKey: 'reconcile-test' });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => {
    const item = useGlobalSessionsStore.getState().entityById.get(id);
    if (!item) throw Object.assign(new Error('not found'), { status: 404 });
    return item;
  });
  spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { mock.restore(); });

describe('archiveSession against the real store', () => {
  test('flags the held session with the server timestamp and keeps its fields', async () => {
    const a = session('a');
    useGlobalSessionsStore.getState().applySnapshot([a, session('b')], []);
    const request = spyOn(sessionRoutes, 'requestSessionArchiveBatch')
      .mockResolvedValue({ outcome: 'archived', archived: [{ id: 'a', archivedAt: now }], failedIds: [] });

    expect(await archiveSession('a')).toBe(true);

    expect(request.mock.calls[0]?.slice(0, 2)).toEqual(['/reconcile-project', ['a']]);
    const state = useGlobalSessionsStore.getState();
    expect(state.activeSessions.map((item) => item.id)).toEqual(['b']);
    expect(state.archivedSessions).toEqual([{ ...a, time: { ...a.time, archived: now } }]);
    expect(hasTime(state.archivedSessions)).toBe(true);
  });

  test('does not insert a session this client does not hold', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('a')], []);
    spyOn(sessionRoutes, 'requestSessionArchiveBatch')
      .mockResolvedValue({ outcome: 'archived', archived: [{ id: 'a', archivedAt: now }], failedIds: [] });

    expect(await archiveSession('a')).toBe(true);
    // A second, already reconciled answer for the same id must not resurrect
    // anything or create a stub either.
    useGlobalSessionsStore.getState().removeSessions(['a']);
    expect(await archiveSession('a')).toBe(false);

    const state = useGlobalSessionsStore.getState();
    expect(state.entityById.has('a')).toBe(false);
    expect(state.archivedSessions).toEqual([]);
  });
});

describe('archiveSessions (bulk) against the real store', () => {
  test('moves every confirmed session in one write and reports the rest', async () => {
    const a = session('a');
    const b = session('b');
    useGlobalSessionsStore.getState().applySnapshot([a, b, session('c')], []);
    spyOn(sessionRoutes, 'requestSessionArchiveBatch').mockResolvedValue({
      outcome: 'archived',
      archived: [{ id: 'a', archivedAt: now }, { id: 'b', archivedAt: now }],
      failedIds: ['c'],
    });
    const revisionBefore = useGlobalSessionsStore.getState().mutationRevision;

    const result = await archiveSessions(['a', 'b', 'c']);

    expect(result).toEqual({ archivedIds: ['a', 'b'], failedIds: ['c'] });
    const state = useGlobalSessionsStore.getState();
    expect(state.mutationRevision).toBe(revisionBefore + 1);
    expect(state.activeSessions.map((item) => item.id)).toEqual(['c']);
    expect(state.archivedSessions.map((item) => item.id).sort()).toEqual(['a', 'b']);
    expect(state.entityById.get('a')).toEqual({ ...a, time: { ...a.time, archived: now } });
    expect(state.entityById.get('b')).toEqual({ ...b, time: { ...b.time, archived: now } });
    expect(hasTime(state.archivedSessions)).toBe(true);
  });
});

describe('unarchiveSession against the real store', () => {
  test('clears the flag on the held session and moves it back to the active list', async () => {
    const a = session('a', { time: { created: 1, updated: 2, archived: 3 } });
    useGlobalSessionsStore.getState().applySnapshot([], [a]);
    spyOn(sessionRoutes, 'requestSessionUnarchiveBatch')
      .mockResolvedValue({ outcome: 'restored', restored: [{ id: 'a', archivedAt: null }], failedIds: [] });

    expect(await unarchiveSession('a')).toBe(true);

    const state = useGlobalSessionsStore.getState();
    expect(state.archivedSessions).toEqual([]);
    expect(state.activeSessions).toEqual([{ ...a, time: { created: 1, updated: 2 } }]);
    expect(hasTime(state.activeSessions)).toBe(true);
  });

  test('fails when the server kept the session archived', async () => {
    const a = session('a', { time: { created: 1, updated: 2, archived: 3 } });
    useGlobalSessionsStore.getState().applySnapshot([], [a]);
    spyOn(sessionRoutes, 'requestSessionUnarchiveBatch')
      .mockResolvedValue({ outcome: 'restored', restored: [{ id: 'a', archivedAt: 3 }], failedIds: [] });

    expect(await unarchiveSession('a')).toBe(false);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([a]);
  });
});
