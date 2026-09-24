import { afterAll, beforeEach } from "vitest";
import { testDatabaseUrl } from "./helpers/databases";
import { disconnectTestDb, truncateAll } from "./helpers/db";

// Integration and pipeline-e2e files talk to the database the global setup migrated.
process.env.DATABASE_URL = testDatabaseUrl();

// Every test starts from empty tables.
beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnectTestDb();
});
