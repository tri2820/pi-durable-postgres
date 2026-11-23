import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentId, EntryId, StorageWrite } from "@earendil-works/pi-durable";
import { describe, expect, it } from "bun:test";
import type { PostgresDatabase, PostgresExecutor } from "../src/database.ts";
import { PostgresStorage } from "../src/storage.ts";
import { testDatabase } from "./helpers.ts";

/**
 * A remote database charges for every round trip, so the number of statements a
 * commit issues is a performance contract, not an implementation detail. These
 * ceilings sit just above the current counts: the point is to fail loudly if a
 * change goes back to one statement per record.
 */
function counting(database: PostgresDatabase): {
	database: PostgresDatabase;
	statements: () => number;
	reset: () => void;
} {
	let count = 0;
	const wrap = (executor: PostgresExecutor): PostgresExecutor => ({
		exec: (sql) => {
			count += 1;
			return executor.exec(sql);
		},
		run: (sql, parameters) => {
			count += 1;
			return executor.run(sql, parameters);
		},
		get: (sql, parameters) => {
			count += 1;
			return executor.get(sql, parameters);
		},
		all: (sql, parameters) => {
			count += 1;
			return executor.all(sql, parameters);
		},
	});
	const wrapped: PostgresDatabase = {
		...wrap(database),
		acquireOwnership: () => database.acquireOwnership(),
		close: () => database.close(),
		transaction: Object.assign(
			<T>(callback: (transaction: PostgresExecutor) => Promise<T>) =>
				database.transaction((transaction) => callback(wrap(transaction))),
			{
				snapshot: <T>(callback: (transaction: PostgresExecutor) => Promise<T>) =>
					database.transaction.snapshot((transaction) => callback(wrap(transaction))),
				maintenance: <T>(callback: (transaction: PostgresExecutor) => Promise<T>) =>
					database.transaction.maintenance((transaction) => callback(wrap(transaction))),
			},
		),
	};
	return {
		database: wrapped,
		statements: () => count,
		reset: () => {
			count = 0;
		},
	};
}

async function open() {
	const fixture = await testDatabase();
	const counter = counting(fixture.createDatabase());
	const storage = await PostgresStorage.open(counter.database);
	counter.reset();
	const commit = async (batches: readonly StorageWrite[][]) => {
		counter.reset();
		const result = await storage.commit(batches, () => {}, context);
		return { stored: result.stored, statements: counter.statements() };
	};
	return { fixture, storage, commit };
}

describe("round trips per commit", () => {
	it("writes many records in one statement per table", async () => {
		const { fixture, storage, commit } = await open();
		try {
			const conversation = await storage.mintId<ConversationId>();
			// metadata read + id check + claim + entry insert + metadata write
			expect((await commit([[{ type: "conversation", value: { id: conversation } }]])).statements).toBeLessThanOrEqual(5);

			const entries = await Promise.all(
				Array.from({ length: 5 }, () => storage.mintId<EntryId>()),
			);
			const batched = await commit([
				entries.map((id) => ({ type: "entry" as const, value: { id, conversationId: conversation, kind: "test" } })),
			]);
			expect(batched.stored).toBe(1);
			// Five entries cost the same as one: the count does not grow with the batch.
			expect(batched.statements).toBeLessThanOrEqual(6);
		} finally {
			await fixture.cleanup();
		}
	});

	it("changes a document without re-reading it", async () => {
		const { fixture, storage, commit } = await open();
		try {
			const conversation = await storage.mintId<ConversationId>();
			await commit([[{ type: "conversation", value: { id: conversation } }]]);
			const document = await storage.mintId<DocumentId>();
			await commit([
				[
					{
						type: "document.create",
						record: {
							id: document,
							kind: "test",
							scope: { kind: "conversation", conversationId: conversation },
							history: "latest",
							fork: "initial",
						},
						content: { kind: "base", version: 1, value: { count: 1 } },
					},
				],
			]);

			const changed = await commit([
				[{ type: "document.change", id: document, content: { kind: "base", version: 1, value: { count: 2 } } }],
			]);
			// metadata read, id check, document read, replace-and-insert revision, metadata write
			expect(changed.statements).toBeLessThanOrEqual(5);
		} finally {
			await fixture.cleanup();
		}
	});

	it("keeps a two-batch save near the cost of two single saves", async () => {
		const { fixture, storage, commit } = await open();
		try {
			const conversation = await storage.mintId<ConversationId>();
			await commit([[{ type: "conversation", value: { id: conversation } }]]);
			const document = await storage.mintId<DocumentId>();
			await commit([
				[
					{
						type: "document.create",
						record: {
							id: document,
							kind: "test",
							scope: { kind: "conversation", conversationId: conversation },
							history: "latest",
							fork: "initial",
						},
						content: { kind: "base", version: 1, value: { count: 1 } },
					},
				],
			]);

			const pairs = await commit([
				[
					{ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId: conversation, kind: "test" } },
					{ type: "document.change", id: document, content: { kind: "base", version: 1, value: { count: 2 } } },
				],
				[
					{ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId: conversation, kind: "test" } },
					{ type: "document.change", id: document, content: { kind: "base", version: 1, value: { count: 3 } } },
				],
			]);
			expect(pairs.stored).toBe(2);
			expect(pairs.statements).toBeLessThanOrEqual(12);
		} finally {
			await fixture.cleanup();
		}
	});
});
