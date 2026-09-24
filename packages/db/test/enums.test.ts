import { describe, expect, it } from "vitest";
import { PRISMA_ENUMS } from "@enmo/shared";
import * as prismaEnums from "../src/generated/enums";

describe("Prisma enums ↔ @enmo/shared zod enums", () => {
  it("mirror the same set of enums", () => {
    expect(Object.keys(prismaEnums).sort()).toEqual(Object.keys(PRISMA_ENUMS).sort());
  });

  for (const [name, schema] of Object.entries(PRISMA_ENUMS)) {
    it(`${name} has identical values in identical order`, () => {
      const prismaEnum = (prismaEnums as Record<string, Record<string, string>>)[name];
      expect(prismaEnum).toBeDefined();
      expect(Object.values(prismaEnum ?? {})).toEqual(schema.options);
    });
  }
});
