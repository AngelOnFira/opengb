// Generates & deploys SQL migrations. See `deploy.ts` to only deploy migrations.
//
// Wrapper around `prisma migrate dev`

import { assert, copy, emptyDir, exists, resolve } from "../deps.ts";
import { Module, Project } from "../project/mod.ts";
import { verbose } from "../term/status.ts";
import { runPrismaCommand } from "./mod.ts";
import { forEachPrismaSchema } from "./mod.ts";

export interface MigrateDevOpts {
	createOnly: boolean;
}

export async function migrateDev(
	project: Project,
	modules: Module[],
	opts: MigrateDevOpts,
) {
	assert(
		modules.every((m) => !m.registry.isExternal),
		"Only modules from local registries can run migrateDev because it generates migration files",
	);

	await forEachPrismaSchema(
		project,
		modules,
		async ({ databaseUrl, module, tempDir }) => {
			// Generate migrations
			await runPrismaCommand(project, {
				args: [
					"migrate",
					"dev",
					"--skip-generate",
					...(opts.createOnly ? ["--create-only"] : []),
				],
				env: {
					DATABASE_URL: databaseUrl,
				},
			});

			// Copy back migrations dir
			//
			// Copy for both `path` (that we'll use later in this script) and
			// `sourcePath` (which is the original module's source)
			const tempMigrationsDir = resolve(tempDir, "db", "migrations");
			assert(await exists(tempMigrationsDir, { isDirectory: true }), "Prisma did not generate migrations");

			const migrationsDir = resolve(module.path, "db", "migrations");
			verbose("Copying migrations", `${tempMigrationsDir} -> ${migrationsDir}`);
			await emptyDir(migrationsDir);
			await copy(tempMigrationsDir, migrationsDir, { overwrite: true });
		},
	);
}
