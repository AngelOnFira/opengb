import { resolve } from "../../deps.ts";
import { Command, glob } from "../deps.ts";
import { GlobalOpts, initProject } from "../common.ts";
import { build, DbDriver, Format, Runtime } from "../../build/mod.ts";
import { ensurePostgresRunning } from "../../utils/postgres_daemon.ts";

// TODO: https://github.com/rivet-gg/open-game-services-engine/issues/86
export const testCommand = new Command<GlobalOpts>()
	.description("Run tests")
	.arguments("[modules...:string]")
	.option("--no-build", "Don't build source files")
	.option("--no-check", "Don't check source files before running")
	.option(
		"--unstable-watch",
		"Automatically restart server on changes. This does not support all features yet.",
	)
	.action(
		async (opts, ...modulesFilter: string[]) => {
			const project = await initProject(opts);

			await ensurePostgresRunning(project);

			// Build project
			if (opts.build) {
				await build(project, {
					runtime: Runtime.Deno,
					format: Format.Native,
					dbDriver: DbDriver.NodePostgres,
				});
			}

			// Determine args
			const args = [
				"--allow-env",
				"--allow-net",
				"--allow-read",
			];
			if (opts.check) args.push("--check");
			if (opts.unstableWatch) args.push("--watch");

			// Find test scripts
			for (const module of project.modules.values()) {
				// Filter modules
				if (modulesFilter.length == 0) {
					// Only test local modules
					if (module.registry.isExternal) continue;
				} else {
					// Only test specified modules. This allows for testing remote modules.
					if (!modulesFilter.includes(module.name)) continue;
				}

				// Test all modules or filter module tests
				const testPaths = (await glob.glob("*.ts", {
					cwd: resolve(module.path, "tests"),
				}))
					.map((path) => resolve(module.path, "tests", path));
				args.push(...testPaths);
			}

			// Run entrypoint
			const cmd = await new Deno.Command("deno", {
				args: [
					"test",
					...args,
				],
				stdout: "inherit",
				stderr: "inherit",
			})
				.output();
			if (!cmd.success) throw new Error("Entrypoint failed");
		},
	);
