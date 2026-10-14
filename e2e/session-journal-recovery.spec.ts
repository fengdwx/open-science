import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'
import { openProjectSession } from './certification/helpers'

test('preserves a committed conversation through a forced crash and continues it once', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const project = 'Journal crash recovery'
  const prompt = 'Summarize the deterministic fixture.'
  await createProjectViaUi(page, project)
  await submitPromptViaUi(page, prompt)
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  // Observe the durable authority, not just the renderer's visible streaming result.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const session = (await window.api.sessions.loadAll()).sessions[0]
        return {
          status: session?.status,
          outcome: session?.messages.find((message) => message.role === 'user')?.turnOutcome?.kind
        }
      })
    )
    .toEqual({ status: 'idle', outcome: 'completed' })
  const before = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  const promptsBefore = await app.readFakeAgentPrompts()
  page = await app.restartAfterCrash({ force: true })
  const restored = await page.evaluate(
    ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
    before
  )
  expect(restored?.messages).toEqual(before.messages)
  expect(restored?.revision).toBeGreaterThanOrEqual(before.revision!)
  expect(restored?.status).toBe('idle')
  expect(await app.readFakeAgentPrompts()).toEqual(promptsBefore)
  await openProjectSession(page, project, prompt)
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  const followup = 'Continue after the journal restart.'
  await submitPromptViaUi(page, followup)
  await expect
    .poll(() =>
      page.evaluate(
        async ({ projectId, id, followup }) => {
          const session = await window.api.sessions.loadOne({ projectId, sessionId: id })
          return {
            status: session?.status,
            prompts: session?.messages.filter((message) => message.role === 'user').length,
            followups: session?.messages.filter(
              (message) => message.role === 'user' && message.content === followup
            ).length,
            outcome: session?.messages.find((message) => message.content === followup)?.turnOutcome
              ?.kind
          }
        },
        { projectId: before.projectId, id: before.id, followup }
      )
    )
    .toEqual({ status: 'idle', prompts: 2, followups: 1, outcome: 'completed' })
  await page.screenshot({ path: testInfo.outputPath('journal-crash-continued.png') })
})
