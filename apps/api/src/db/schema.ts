import type { SchemaAdmin } from "./graph";

/** Split a schema file into statements, dropping `//` comments and blank lines. */
export function schemaStatements(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Apply every statement in db/schema/<dialect>.cypher, in order. */
export async function applySchema(client: SchemaAdmin, text: string): Promise<number> {
  const statements = schemaStatements(text);
  for (const statement of statements) await client.applySchemaStatement(statement);
  return statements.length;
}
