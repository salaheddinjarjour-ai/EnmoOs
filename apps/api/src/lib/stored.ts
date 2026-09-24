import { z } from "zod";

/**
 * A database value that no longer matches its schema: a server fault, not a bad request. Kept
 * distinct from ZodError, which the error plugin reports to the caller as 400 VALIDATION_FAILED;
 * this one surfaces as a logged 500 that names the row.
 */
export class StoredDataError extends Error {
  override readonly name = "StoredDataError";
}

/** Parses JSON read from the database; `where` names the row and column, e.g. "Client c1.visualStyle". */
export function parseStored<S extends z.ZodType>(
  schema: S,
  value: unknown,
  where: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new StoredDataError(
      `${where} does not match its schema:\n${z.prettifyError(result.error)}`,
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}
