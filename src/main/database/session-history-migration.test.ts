import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

let root: string | undefined
let client: PrismaClient | undefined
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
it('upgrades 0050 with an empty derived history index and preserves existing application data', async () => {
  root = await mkdtemp(join(tmpdir(), 'history-migration-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  const project = await client.project.create({
    data: { id: 'existing', name: 'Existing project' }
  })
  await client.$executeRawUnsafe('DROP TABLE SessionHistoryItem')
  await client.$executeRawUnsafe('DROP TABLE SessionHistoryIndex')
  await client.$executeRawUnsafe(
    'DELETE FROM _open_science_migrations WHERE id = ?',
    '0051_session_history'
  )
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: '0050_literature_translation',
    to: '0051_session_history',
    applied: ['0051_session_history']
  })
  expect(await client.project.findUnique({ where: { id: project.id } })).toEqual(project)
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
  expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
  const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(
    'EXPLAIN QUERY PLAN SELECT payloadJson FROM SessionHistoryItem WHERE sessionId = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT 80',
    'session-1',
    100
  )
  expect(
    plan.some(({ detail }) => detail.includes('SessionHistoryItem_sessionId_ordinal_idx'))
  ).toBe(true)
})
