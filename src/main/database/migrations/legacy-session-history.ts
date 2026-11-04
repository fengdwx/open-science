// Frozen fork migration; used only to recognize and upgrade its exact released ledger.
// Derived display history; existing authoritative Session files are unchanged.
const legacySessionHistoryMigration = {
  id: '0051_session_history',
  statements: [
    `CREATE TABLE IF NOT EXISTS "SessionHistoryIndex" (
    "sessionId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "headerJson" TEXT NOT NULL,
    "totalItems" INTEGER NOT NULL
);`,
    `CREATE TABLE IF NOT EXISTS "SessionHistoryItem" (
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "ordinal" INTEGER,
    "promptMessageId" TEXT,
    "groupId" TEXT,
    "payloadJson" TEXT NOT NULL,

    PRIMARY KEY ("sessionId", "kind", "itemId"),
    CONSTRAINT "SessionHistoryItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SessionHistoryIndex" ("sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE INDEX IF NOT EXISTS "SessionHistoryIndex_projectId_idx" ON "SessionHistoryIndex"("projectId");`,
    `CREATE INDEX IF NOT EXISTS "SessionHistoryItem_sessionId_ordinal_idx" ON "SessionHistoryItem"("sessionId", "ordinal");`
  ],
  operations: [],
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'SessionHistoryIndex' },
    { kind: 'table-exists', version: 1, table: 'SessionHistoryItem' },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'SessionHistoryItem_sessionId_ordinal_idx',
          sql: 'CREATE INDEX "SessionHistoryItem_sessionId_ordinal_idx" ON "SessionHistoryItem"("sessionId", "ordinal")'
        }
      ]
    }
  ]
} as const

export { legacySessionHistoryMigration }
