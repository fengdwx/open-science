import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import * as sessionCodec from '../../shared/session-persistence'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  applyRuntimeSessionEvents,
  applyRuntimeSessionEventsWithChanges
} from '../../shared/runtime-session-projection'
import { initDataRoot } from '../storage-root'
import { sessionJournalPath, SessionJournalStore, type SessionBusinessRecord } from './journal'
import { normalizeJournalValue, type JournalValue } from './journal-codec'
import { loadSessionMutationAuthority, SessionRepository } from './repository'
import * as runtimeCodec from './runtime-session-file'
import { RuntimeSessionOwner, type RuntimeSessionTurnScope } from './runtime-session-owner'
import { encodeSessionDataPaths } from './session-data-paths'
import { SessionPersistenceStateOwner } from './state-owner'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

const roots: string[] = []
const history = 'Existing research must never be emitted again. '.repeat(200)
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fullFile = (session: PersistedChatSession): JournalValue =>
  normalizeJournalValue(
    sessionCodec.createSessionFile(
      encodeSessionDataPaths(sessionCodec.sanitizeSessionUploadedAttachments(session))
    )
  )

const load = async (repository: SessionRepository): Promise<PersistedChatSession> => {
  const result = await loadSessionMutationAuthority(repository, 'p', 's')
  expect(result.status).toBe('found')
  if (result.status !== 'found') throw new Error('Expected durable session')
  return result.session
}

type WireBatch = { type: 'session_update'; revision: number; records: SessionBusinessRecord[] }
const readBatches = async (path: string): Promise<WireBatch[]> => {
  return (await readFile(sessionJournalPath(path), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireBatch)
    .filter((record) => record.type === 'session_update')
}

const fixture = async (): Promise<{
  root: string
  path: string
  session: PersistedChatSession
  scope: RuntimeSessionTurnScope
  repository: SessionRepository
}> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-runtime-records-'))
  roots.push(root)
  initDataRoot(root)
  const session = sessionCodec.materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    agentFrameworkId: 'codex',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    activeRun: { promptMessageId: 'prompt', startedAt: 2 },
    messages: [
      {
        id: 'history',
        role: 'user',
        content: history,
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'prompt',
        role: 'user',
        content: 'Continue',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
  })
  const prompt = session.conversationGraph!.messages.find(({ id }) => id === 'prompt')!
  return {
    root,
    path: join(root, 'sessions', 'p', 's.json'),
    session,
    scope: {
      projectId: 'p',
      sessionId: 's',
      promptMessageId: 'prompt',
      executionId: 'execution',
      agentFrameId: prompt.agentFrameId,
      messageBranchId: prompt.introducedOnBranchId,
      runtimeSegmentId: prompt.runtimeSegmentId!
    },
    repository: new SessionRepository(root)
  }
}

const event = (fields: Partial<AcpRuntimeEvent> = {}): AcpRuntimeEvent =>
  ({
    id: 'chunk-1',
    kind: 'message',
    level: 'info',
    timestamp: 3,
    sessionId: 's',
    promptMessageId: 'prompt',
    promptExecutionId: 'execution',
    role: 'assistant',
    messageId: 'answer',
    text: 'Answer',
    ...fields
  }) as AcpRuntimeEvent

describe('Runtime business records through the real repository', () => {
  it.each(['legacy', 'journal'] as const)(
    'coalesces partial text on the default 2-second schedule and preserves %s storage',
    async (format) => {
      const { root, path, session, scope, repository } = await fixture()
      if (format === 'legacy') {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify(fullFile({ ...session, revision: 1 })))
      } else await repository.saveSession(session, 0)
      const stateOwner = new SessionPersistenceStateOwner({
        repository,
        fileIndex: { syncSession: async () => [] },
        assertMutable: () => {},
        notifyFilesChanged: () => {},
        notifyRuntimeContextSessionUpdated: () => {},
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      })
      const scheduled: Array<{ flush: () => void; delayMs: number }> = []
      const owner = new RuntimeSessionOwner({
        loadSession: async () => load(repository),
        mutateSession: (turn, mutate, options) =>
          stateOwner.mutateRuntimeSession(turn, mutate, options),
        finalizeArtifacts: async () => [],
        scheduleFlush: (flush, delayMs) => {
          scheduled.push({ flush, delayMs })
          return () => {}
        },
        now: () => 2
      })
      await owner.begin(scope)
      const authority = format === 'legacy' ? path : sessionJournalPath(path)
      const before = await readFile(authority, 'utf8')
      const previous = await load(new SessionRepository(root))
      owner.accept(event({ text: 'Partial' }))
      owner.accept(event({ id: 'chunk-2', timestamp: 4, text: ' evidence' }))
      expect(scheduled).toHaveLength(1)
      expect(scheduled[0].delayMs).toBe(2_000)
      expect(await readFile(authority, 'utf8')).toBe(before)
      expect(
        (await load(new SessionRepository(root))).messages.some(({ role }) => role === 'agent')
      ).toBe(false)

      // Exercise the production callback and real filesystem without waiting two wall-clock
      // seconds. This verifies the requested scheduling delay, not physical timer precision.
      scheduled[0].flush()
      const readAnswer = async (): Promise<string | undefined> =>
        (await load(new SessionRepository(root))).messages.find(({ role }) => role === 'agent')
          ?.content
      await expect.poll(readAnswer, { interval: 10, timeout: 2_000 }).toBe('Partial evidence')
      const committed = await load(new SessionRepository(root))
      expect(committed.revision).toBe(previous.revision! + 1)
      expect(committed.messages.find(({ role }) => role === 'agent')).toMatchObject({
        content: 'Partial evidence',
        status: 'streaming',
        eventIds: ['chunk-1', 'chunk-2']
      })
      const cold = await new SessionRepository(root).loadSession('p', 's')
      expect(cold?.messages.find(({ role }) => role === 'agent')).toMatchObject({
        content: 'Partial evidence',
        status: 'error'
      })
      expect(cold?.resumeRecovery).toMatchObject({ cause: 'app-restart' })

      owner.accept(event({ id: 'chunk-3', timestamp: 5, text: ' continued' }))
      expect(scheduled).toHaveLength(2)
      expect(scheduled[1].delayMs).toBe(2_000)
      scheduled[1].flush()
      await expect
        .poll(readAnswer, { interval: 10, timeout: 2_000 })
        .toBe('Partial evidence continued')
      expect((await load(new SessionRepository(root))).revision).toBe(previous.revision! + 2)
      expect((await new SessionJournalStore({ maxBytes: 1024 * 1024 }).read(path))?.format).toBe(
        format
      )
      expect(await readdir(dirname(path))).toEqual([format === 'legacy' ? 's.json' : 's.jsonl'])
    }
  )

  it('appends changed messages, tools and groups, then restores the complete terminal state', async () => {
    const { root, path, session, scope, repository } = await fixture()
    await repository.saveSession(session, 0)
    // Only peripheral indexing/publication is stubbed. Both owners, the revision bridge, the
    // complete/narrow codecs and the durable journal are their production implementations.
    const stateOwner = new SessionPersistenceStateOwner({
      repository,
      fileIndex: { syncSession: async () => [] },
      assertMutable: () => {},
      notifyFilesChanged: () => {},
      notifyRuntimeContextSessionUpdated: () => {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    const owner = new RuntimeSessionOwner({
      loadSession: async () => load(repository),
      mutateSession: (turn, mutate, options) =>
        stateOwner.mutateRuntimeSession(turn, mutate, options),
      finalizeArtifacts: async () => [],
      scheduleFlush: () => () => {},
      now: () => 2
    })
    await owner.begin(scope)
    const full = vi.spyOn(sessionCodec, 'createSessionFile')
    const narrow = vi.spyOn(runtimeCodec, 'createRuntimeSessionFile')
    const batches: AcpRuntimeEvent[][] = [
      [event(), event({ id: 'chunk-2', timestamp: 4, text: ' continued' })],
      [
        event({
          kind: 'tool',
          id: 'group-start',
          timestamp: 5,
          toolCallId: 'group',
          providerToolName: 'mcp__open-science-activity__begin_activity_group',
          rawInput: { title: 'Analysis' }
        }),
        event({
          kind: 'tool',
          id: 'tool-start',
          timestamp: 6,
          toolCallId: 'tool',
          status: 'in_progress',
          rawInput: { command: 'calculate' }
        })
      ],
      [
        event({
          kind: 'tool',
          id: 'tool-end',
          timestamp: 7,
          toolCallId: 'tool',
          status: 'completed',
          rawOutput: { result: '42' }
        })
      ],
      [event({ id: 'chunk-3', timestamp: 8, text: '. Result: 42.' })]
    ]
    for (const batch of batches) {
      const previous = await load(repository)
      const before = await readBatches(path)
      full.mockClear()
      narrow.mockClear()
      for (const item of batch) owner.accept(item)
      await owner.flush('s', 'prompt')
      expect(full).not.toHaveBeenCalled()
      expect(narrow).toHaveBeenCalledOnce()
      expect(narrow.mock.results[0].value).toBeDefined()

      // Independent full encoding of the old reducer result checks actual stored content, not
      // merely the internal hint or a mocked save call. A fresh reader cannot use the warm cache.
      const candidate = {
        ...applyRuntimeSessionEvents(previous, scope, batch),
        runtimeTranscriptOwner: 'main' as const,
        revision: previous.revision! + 1
      }
      const expected = fullFile(candidate)
      const coldJournal = new SessionJournalStore({ maxBytes: 1024 * 1024 })
      expect((await coldJournal.read(path))?.document).toEqual(expected)
      const decoded = sessionCodec.decodeSessionFile(expected, { preserveRuntimeState: true })
      expect(decoded.status).toBe('ok')
      if (decoded.status !== 'ok') throw new Error('Invalid expected session')
      expect(await load(new SessionRepository(root))).toEqual(decoded.session)

      const appended = (await readBatches(path)).slice(before.length)
      expect(appended).toHaveLength(1)
      expect(appended[0].type).toBe('session_update')
      expect(appended[0].revision).toBe(candidate.revision)
      expect(Object.keys(appended[0]).sort()).toEqual(['records', 'revision', 'type'])
      expect(appended[0]).not.toHaveProperty('operations')
      expect(appended[0]).not.toHaveProperty('resultDigest')
      expect(appended[0]).not.toHaveProperty('documentBytes')
      expect(JSON.stringify(appended)).not.toContain(history)
      for (const record of appended[0].records) {
        if (record.type === 'entities')
          expect(record.upserts ?? []).not.toContainEqual(
            expect.objectContaining({ id: 'history' })
          )
      }
      if (batch[0].id === 'chunk-1') {
        expect(appended[0].records).toContainEqual(
          expect.objectContaining({
            type: 'entities',
            collection: 'graphMessages',
            upserts: [expect.objectContaining({ streamId: 'answer', content: 'Answer continued' })]
          })
        )
      }
      if (batch[0].id === 'chunk-3') {
        expect(appended[0].records).toContainEqual(
          expect.objectContaining({
            type: 'assistant_text_received',
            streamId: 'answer',
            chunks: [{ eventId: 'chunk-3', text: '. Result: 42.', timestamp: 8 }]
          })
        )
        expect(JSON.stringify(appended[0])).not.toContain('Answer continued')
        expect(
          appended[0].records.some(
            (record) =>
              record.type === 'entities' &&
              (record.collection === 'messages' || record.collection === 'graphMessages') &&
              record.upserts.length > 0
          )
        ).toBe(false)
        expect(decoded.session.activityGroups).toEqual([
          expect.objectContaining({ id: 'group', completedAt: 8, activityIds: ['tool'] })
        ])
        expect(appended[0].records).toContainEqual(
          expect.objectContaining({ type: 'entities', collection: 'graphActivityGroups' })
        )
      }
    }

    // A process restart before the terminal event keeps every committed partial chunk. The
    // normal restore path marks it interrupted; it must not require an in-memory runtime owner.
    const interrupted = await new SessionRepository(root).loadSession('p', 's')
    expect(interrupted?.messages.find(({ role }) => role === 'agent')).toMatchObject({
      content: 'Answer continued. Result: 42.',
      status: 'error'
    })
    expect(interrupted?.resumeRecovery).toMatchObject({ cause: 'app-restart' })

    const previous = await load(repository)
    const stop = event({
      id: 'stop',
      kind: 'stop',
      timestamp: 9,
      text: 'end_turn',
      turnUsage: { inputTokens: 2, cacheTokens: 0, outputTokens: 3, turnCount: 1 }
    })
    full.mockClear()
    narrow.mockClear()
    const publish = vi.fn()
    await owner.commitTerminal(stop, publish)
    await owner.flush('s', 'prompt')
    expect(publish).toHaveBeenCalledOnce()
    expect(full).toHaveBeenCalledOnce()
    expect(narrow.mock.results[0].value).toBeUndefined()
    const terminal = {
      ...applyRuntimeSessionEvents(previous, scope, [stop]),
      runtimeTranscriptOwner: 'main' as const,
      runtimeTranscriptLastRun: previous.activeRun,
      revision: previous.revision! + 1
    }
    const expected = fullFile(terminal)
    expect((await new SessionJournalStore({ maxBytes: 1024 * 1024 }).read(path))?.document).toEqual(
      expected
    )
    const restarted = await new SessionRepository(root).loadSession('p', 's')
    const decoded = sessionCodec.decodeSessionFile(expected)
    expect(decoded.status).toBe('ok')
    if (decoded.status !== 'ok') throw new Error('Invalid terminal session')
    expect(restarted).toEqual(decoded.session)
    expect(restarted).toMatchObject({ status: 'idle', revision: terminal.revision })
    expect(restarted?.messages.find(({ role }) => role === 'agent')).toMatchObject({
      content: 'Answer continued. Result: 42.',
      status: 'complete',
      turnUsage: stop.turnUsage
    })
    expect(restarted?.activities).toEqual([
      expect.objectContaining({ id: 'tool', status: 'completed', rawOutput: { result: '42' } })
    ])
    expect(restarted?.messages.find(({ id }) => id === 'history')?.content).toBe(history)
  })

  it('rejects stale source evidence after an external replacement at the same revision', async () => {
    const { root, path, session, scope, repository } = await fixture()
    await repository.saveSession(session, 0)
    const previous = await load(repository)
    const result = applyRuntimeSessionEventsWithChanges(previous, scope, [event()])
    expect(result.changes).toBeDefined()
    const external = {
      ...previous,
      messages: previous.messages.map((message) =>
        message.id === 'history' ? { ...message, content: 'External committed history' } : message
      ),
      conversationGraph: {
        ...previous.conversationGraph!,
        messages: previous.conversationGraph!.messages.map((message) =>
          message.id === 'history' ? { ...message, content: 'External committed history' } : message
        )
      }
    }
    // Replace the actual JSONL authority with a valid initial record at the exact same revision.
    // The cached previous read must not authorize changes against externally replaced history.
    const externalText =
      JSON.stringify({ type: 'session_snapshot', document: fullFile(external) }) + '\n'
    await writeFile(sessionJournalPath(path), externalText)
    await expect(
      repository.saveSession(result.session, previous.revision, {
        runtimeChanges: { previous, changes: result.changes! }
      })
    ).rejects.toThrow('Runtime Session authority changed after its read.')
    expect(await readFile(sessionJournalPath(path), 'utf8')).toBe(externalText)
    const restored = await load(new SessionRepository(root))
    expect(restored.messages.find(({ id }) => id === 'history')?.content).toBe(
      'External committed history'
    )
    expect(restored.messages.some(({ role }) => role === 'agent')).toBe(false)
    expect(restored.revision).toBe(previous.revision)
  })

  it('matches the full codec when the runtime scope is on an inactive branch', async () => {
    const { root, path, session, scope, repository } = await fixture()
    const graph = forkEditedConversationMessage(session.conversationGraph!, 'prompt', 'edited', 3)
    await repository.saveSession(
      {
        ...session,
        updatedAt: 3,
        conversationGraph: graph,
        messages: resolveActiveConversationMessages(graph).map(projectConversationMessage)
      },
      0
    )
    const batches = [
      [
        event({
          kind: 'tool',
          id: 'background-tool',
          timestamp: 4,
          toolCallId: 'background-tool',
          status: 'completed',
          rawOutput: { result: 'Background result' }
        })
      ],
      [event({ id: 'background-text', timestamp: 5 })]
    ]
    const full = vi.spyOn(sessionCodec, 'createSessionFile')
    const narrow = vi.spyOn(runtimeCodec, 'createRuntimeSessionFile')
    for (const batch of batches) {
      const previous = await load(repository)
      expect(previous.conversationGraph!.frames[0].activeBranchId).toBe('edited')
      expect(scope.messageBranchId).not.toBe('edited')
      const result = applyRuntimeSessionEventsWithChanges(previous, scope, batch)
      expect(result.changes).toBeDefined()
      full.mockClear()
      narrow.mockClear()
      const saved = await repository.saveSession(result.session, previous.revision, {
        runtimeChanges: { previous, changes: result.changes! }
      })
      expect(full).not.toHaveBeenCalled()
      expect(narrow.mock.results[0].value).toBeDefined()
      const expected = fullFile({ ...result.session, revision: saved.revision })
      expect(
        (await new SessionJournalStore({ maxBytes: 1024 * 1024 }).read(path))?.document
      ).toEqual(expected)
      const restored = await load(new SessionRepository(root))
      expect(restored.messages.map(({ id }) => id)).toEqual(['history'])
      expect(restored.activities).toEqual([])
      expect(
        restored.conversationGraph!.branches.find(({ id }) => id === 'edited')?.updatedAt
      ).toBe(batch[0].timestamp)
    }
    const restored = await load(new SessionRepository(root))
    expect(restored.conversationGraph!.messages).toContainEqual(
      expect.objectContaining({
        content: 'Answer',
        introducedOnBranchId: scope.messageBranchId,
        responseToMessageId: 'prompt'
      })
    )
    expect(restored.conversationGraph!.activities).toContainEqual(
      expect.objectContaining({ id: 'background-tool', rawOutput: { result: 'Background result' } })
    )
  })

  it('still rejects an unchanged legacy upload when appending a new assistant message', async () => {
    const { path, session, scope, repository } = await fixture()
    session.messages[0].uploads = [
      {
        id: 'legacy-upload',
        sessionId: 's',
        name: 'input.csv',
        originalName: 'input.csv',
        path: '/workspace/input.csv',
        size: 12
      }
    ]
    session.conversationGraph!.messages[0].uploads = session.messages[0].uploads
    // The current repository already refuses these uploads. Seed a historical document through
    // the real journal to exercise preservation of that guard on the optimized runtime path.
    await new SessionJournalStore({ maxBytes: 1024 * 1024 }).write(path, {
      document: fullFile({ ...session, revision: 1 }),
      expectedRevision: 0
    })
    const previous = await load(repository)
    expect(previous.messages[0].uploads?.[0].versionId).toBeUndefined()
    expect(previous.messages[0].uploads?.[0].id).toBe('legacy-upload')
    const result = applyRuntimeSessionEventsWithChanges(previous, scope, [event()])
    expect(result.changes).toBeDefined()
    const before = await readFile(sessionJournalPath(path), 'utf8')
    const logBefore = await readBatches(path)
    await expect(
      repository.saveSession(result.session, previous.revision, {
        runtimeChanges: { previous, changes: result.changes! }
      })
    ).rejects.toThrow('Session upload must be upgraded to an immutable Version')
    expect(await readFile(sessionJournalPath(path), 'utf8')).toBe(before)
    expect(await readBatches(path)).toEqual(logBefore)
    expect((await load(repository)).revision).toBe(1)
  })
})
