import { legacySessionHistoryMigration } from './legacy-session-history'

// Append after the upstream migrations; never reuse a released upstream number.
const sessionHistoryMigration = {
  ...legacySessionHistoryMigration,
  id: '0055_session_history'
} as const

export { sessionHistoryMigration }
