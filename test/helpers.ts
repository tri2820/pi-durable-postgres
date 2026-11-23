import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Seq, StorageWrite } from "@earendil-works/pi-durable";
import pg from "pg";
import { PostgresStorage } from "../src/storage.js";
import { nodePostgresDatabase } from "../src/node.js";

export const connectionString =
	process.env.PI_DURABLE_POSTGRES_TEST_URL ?? "postgres://postgres:postgres@localhost:5433/postgres";

/** Every fixture owns a random schema. Never truncate or drop application tables. */
export async function testDatabase() {
	const admin = new pg.Pool({ connectionString, max: 1 });
	const schema = `durable_test_${randomUUID().replaceAll("-", "")}`;
	try {
		await admin.query(`CREATE SCHEMA "${schema}"`);
	} catch (error) {
		await admin.end();
		throw error;
	}
	const config: pg.PoolConfig = { connectionString, options: `-c search_path=${schema}`, max: 1 };
	const databases = new Set<ReturnType<typeof nodePostgresDatabase>>();
	const storages = new Set<PostgresStorage>();
	const createDatabase = () => {
		const database = nodePostgresDatabase(new pg.Pool(config));
		databases.add(database);
		return database;
	};
	const openStorage = async () => {
		const database = createDatabase();
		const storage = await PostgresStorage.open(database);
		storages.add(storage);
		return { storage, database };
	};
	return {
		config,
		createDatabase,
		openStorage,
		async cleanup() {
			try {
				await Promise.all([...storages].map((storage) => storage.close(BACKGROUND_CONTEXT)));
				await Promise.all([...databases].map((database) => database.close()));
				await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
			} finally {
				await admin.end();
			}
		},
	};
}

export async function freshStorage() {
	const fixture = await testDatabase();
	try {
		return { ...fixture, ...await fixture.openStorage() };
	} catch (error) {
		await fixture.cleanup();
		throw error;
	}
}

/** Commit one batch the way upstream tests do: resolves with its seq, throws a refusal. */
export async function commitWrites(
	storage: PostgresStorage,
	writes: readonly StorageWrite[],
	context: Context = BACKGROUND_CONTEXT,
): Promise<Seq> {
	const seqs: Seq[] = [];
	const result = await storage.commit([writes], (index, seq) => {
		seqs[index] = seq;
	}, context);
	if (result.refused !== undefined) throw result.refused;
	return seqs[0]!;
}

export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
