import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionJournalStore, SessionJournalRevisionError, sessionJournalPath } from './journal'
const roots: string[] = []
type TestDocument = {
  version: number
  session: {
    id: string
    projectId: string
    revision: number
    messages: { id: string; content: string }[]
  }
}
const doc = (revision: number, content = 'history'): TestDocument => ({
  version: 2,
  session: { id: 's', projectId: 'p', revision, messages: [{ id: 'm', content }] }
})
const store = (): SessionJournalStore => new SessionJournalStore({ maxBytes: 1024 * 1024 })
const fixture = async (
  format: 'legacy' | 'journal' = 'journal'
): Promise<{ root: string; path: string; owner: SessionJournalStore }> => {
  const root = await mkdtemp(join(tmpdir(), 'simple-prepared-'))
  roots.push(root)
  const path = join(root, 's.json')
  const owner = store()
  if (format === 'legacy') await writeFile(path, JSON.stringify(doc(1)))
  else await owner.write(path, { document: doc(1), expectedRevision: 0 })
  return { root, path, owner }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('prepared business updates', () => {
  it.each(['legacy', 'journal'] as const)(
    'publishes an immutable %s result once and retains its format',
    async (format) => {
      const { path, owner } = await fixture(format)
      const raw = doc(2, 'continued')
      const prepared = owner.prepareWrite(path, raw, (await owner.read(path))!)
      raw.session.messages[0].content = 'changed after admission'
      expect(Object.isFrozen(prepared.document)).toBe(true)
      await owner.writePrepared(path, prepared, { expectedRevision: 1 })
      expect(await store().read(path)).toMatchObject({ format, document: doc(2, 'continued') })
      const authority = format === 'legacy' ? path : sessionJournalPath(path)
      const evidence = await readFile(authority, 'utf8')
      await expect(
        owner.writePrepared(path, prepared, { expectedRevision: 1 })
      ).rejects.toBeInstanceOf(SessionJournalRevisionError)
      expect(await readFile(authority, 'utf8')).toBe(evidence)
    }
  )
  it('rejects forged, foreign and other-path capabilities', async () => {
    const { path, owner, root } = await fixture()
    const previous = (await owner.read(path))!
    expect(() => owner.prepareWrite(path, doc(2), { ...previous })).toThrow('authority read')
    expect(() => store().prepareWrite(path, doc(2), previous)).toThrow('authority read')
    const prepared = owner.prepareWrite(path, doc(2), previous)
    await expect(
      owner.writePrepared(path, { ...prepared }, { expectedRevision: 1 })
    ).rejects.toThrow('another owner')
    await expect(
      owner.writePrepared(join(root, 'other.json'), prepared, { expectedRevision: 1 })
    ).rejects.toThrow('another owner')
    await expect(store().writePrepared(path, prepared, { expectedRevision: 1 })).rejects.toThrow(
      'another owner'
    )
  })
  it.each(['legacy', 'journal'] as const)(
    'binds %s authority when an external replacement keeps the same revision',
    async (format) => {
      const { path, owner } = await fixture(format)
      const previous = (await owner.read(path))!
      const proof = owner.authorityFingerprint(previous)
      owner.invalidate(path)
      expect(owner.authorityFingerprint((await owner.read(path))!)).toBe(proof)
      expect(() => owner.authorityFingerprint({ ...previous })).toThrow('authority proof')
      expect(() => store().authorityFingerprint(previous)).toThrow('authority proof')
      const prepared = owner.prepareWrite(path, doc(2), previous)
      await writeFile(
        format === 'legacy' ? path : sessionJournalPath(path),
        JSON.stringify(
          format === 'legacy'
            ? doc(1, 'external replacement')
            : {
                type: 'session_snapshot',
                document: doc(1, 'external replacement')
              }
        ) + '\n'
      )
      expect(owner.authorityFingerprint((await owner.read(path))!)).not.toBe(proof)
      await expect(owner.writePrepared(path, prepared, { expectedRevision: 1 })).rejects.toThrow(
        'authority changed'
      )
      expect((await store().read(path))?.document).toEqual(doc(1, 'external replacement'))
    }
  )
})
