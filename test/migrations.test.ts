import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "bun:test";
import { applyPostgresMigrations, CURRENT_POSTGRES_SCHEMA_VERSION, POSTGRES_MIGRATIONS } from "../src/migrations.js";
import { freshStorage, testDatabase, commitWrites } from "./helpers.ts";

describe("migrations and persistence", () => {
	it("applies migrations idempotently", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await applyPostgresMigrations(database);
			await applyPostgresMigrations(database);
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: CURRENT_POSTGRES_SCHEMA_VERSION });
		} finally { await fixture.cleanup(); }
	});

	it("rolls back DDL and the version marker when a migration fails", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await applyPostgresMigrations(database);
			const next = CURRENT_POSTGRES_SCHEMA_VERSION + 1;
			await expect(applyPostgresMigrations(database, [...POSTGRES_MIGRATIONS, {
				version: next, statements: ["CREATE TABLE migration_probe (value integer)", "SELECT * FROM missing_migration_table"],
			}])).rejects.toThrow();
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: CURRENT_POSTGRES_SCHEMA_VERSION });
			expect(await database.get("SELECT to_regclass('migration_probe') AS relation", [])).toEqual({ relation: null });
			await applyPostgresMigrations(database);
		} finally { await fixture.cleanup(); }
	});

	it("rejects non-contiguous history and a newer schema without overwriting it", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			const next = CURRENT_POSTGRES_SCHEMA_VERSION + 1;
			await expect(applyPostgresMigrations(database, [{ version: next, statements: [] }])).rejects.toThrow(/contiguous/);
			await applyPostgresMigrations(database, [...POSTGRES_MIGRATIONS, { version: next, statements: [] }]);
			await expect(fixture.openStorage()).rejects.toThrow(/newer than supported/);
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: next });
			// Failed open must release its ownership lock and connection.
			await database.transaction.maintenance(async () => undefined);
		} finally { await fixture.cleanup(); }
	});

	it("restores records, document history and ID allocation after closing and reopening", async () => {
		const fixture = await freshStorage();
		try {
			const id = await fixture.storage.mintId<ConversationId>();
			const documentId = await fixture.storage.mintId<DocumentId>();
			const seq = await commitWrites(fixture.storage, [
				{ type: "conversation", value: { id } },
				{ type: "document.create", record: {
					id: documentId, kind: "test", scope: { kind: "conversation", conversationId: id }, history: "rewindable", fork: "initial",
				}, content: { kind: "base", version: 1, value: { count: 1 } } },
			], context);
			await commitWrites(fixture.storage, [{ type: "document.change", id: documentId,
				content: { kind: "base", version: 1, value: { count: 2 } } }], context);
			await fixture.storage.close(context);
			const { storage } = await fixture.openStorage();
			expect(await storage.conversation(id, context)).toEqual({ id });
			expect((await storage.document(documentId, seq, context))?.value).toEqual({ count: 1 });
			expect((await storage.document(documentId, "current", context))?.value).toEqual({ count: 2 });
			expect(await storage.mintId()).toBeGreaterThan(documentId);
			const later = await commitWrites(storage, [
				{ type: "conversation", value: { id: await storage.mintId<ConversationId>() } },
			]);
			expect(later).toBeGreaterThan(seq);
		} finally { await fixture.cleanup(); }
	});
});
