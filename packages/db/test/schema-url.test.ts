import { describe, expect, it } from "vitest";
import { splitSchema } from "../src/index";

describe("splitSchema", () => {
  it("leaves URLs without ?schema= untouched", () => {
    const url = "postgresql://u:p@host:5432/db?connect_timeout=10";
    expect(splitSchema(url)).toEqual({ connectionString: url, schema: null });
  });

  it("takes ?schema= off the URL for the pg driver and keeps the other parameters", () => {
    const { connectionString, schema } = splitSchema(
      "postgresql://u:p@host:5432/db?schema=enmo&connect_timeout=10",
    );
    expect(schema).toBe("enmo");
    expect(connectionString).toBe("postgresql://u:p@host:5432/db?connect_timeout=10");
  });

  it("gives sslmode its libpq meaning, as the Prisma CLI reads it", () => {
    expect(splitSchema("postgresql://u:p@h/db?sslmode=require&schema=enmo")).toEqual({
      connectionString: "postgresql://u:p@h/db?sslmode=require&uselibpqcompat=true",
      schema: "enmo",
    });
    const explicit = "postgresql://u:p@h/db?sslmode=require&uselibpqcompat=false";
    expect(splitSchema(explicit).connectionString).toBe(explicit);
  });

  it("treats public as the default schema", () => {
    expect(splitSchema("postgresql://u@h/db?schema=public").schema).toBeNull();
  });

  it("refuses schema names that aren't plain identifiers", () => {
    expect(() => splitSchema("postgresql://u@h/db?schema=enmo;drop")).toThrow(/identifier/);
    expect(() => splitSchema("postgresql://u@h/db?schema=")).toThrow(/identifier/);
  });
});
