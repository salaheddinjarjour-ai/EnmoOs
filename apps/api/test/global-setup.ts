import { prepareDatabase, testDatabaseUrl } from "./helpers/databases";

/** Integration project only: make sure the test database exists and is fully migrated. */
export default async function setup(): Promise<void> {
  await prepareDatabase(testDatabaseUrl());
}
