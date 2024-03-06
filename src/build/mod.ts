import {
	assertExists,
	denoPlugins,
	esbuild,
	exists,
	join,
	tjs,
} from "../deps.ts";
import { crypto, encodeHex } from "./deps.ts";
import { compileSchema } from "./schema.ts";
import { generateEntrypoint } from "./entrypoint.ts";
import { generateOpenApi } from "./openapi.ts";
import {
	compileModuleHelper,
	compileScriptHelper,
	compileTestHelper,
	compileTypeHelpers,
} from "./gen.ts";
import { Project } from "../project/project.ts";
import { generateDenoConfig } from "./deno_config.ts";
import { inflateRuntimeArchive } from "./inflate_runtime_archive.ts";
import { Module, Script } from "../project/mod.ts";
import { shutdownAllPools } from "../utils/worker_pool.ts";
import { migrateDev } from "../migrate/dev.ts";
import { compileModuleTypeHelper } from "./gen.ts";

/**
 * Which format to use for building.
 */
export enum Format {
	Native,
	Bundled,
}

/**
 * Which runtime to target when building.
 */
export enum Runtime {
	Deno,
	Cloudflare,
}

/**
 * Which DB driver to use for the runtime.
 */
export enum DbDriver {
	NodePostgres,
	NeonServerless,
}

/**
 * Stores options used in the build command.
 */
export interface BuildOpts {
	format: Format;
	runtime: Runtime;
	dbDriver: DbDriver;
}

/**
 * Stores the state of all of the generated files to speed up subsequent build
 * steps.
 */
export interface BuildCache {
	oldCache: BuildCachePersist;
	newCache: BuildCachePersist;
}

/**
 * Data from `BuildCache` that gets persisted.
 */
interface BuildCachePersist {
	version: number;
	fileHashes: Record<string, string>;
	scriptSchemas: Record<
		string,
		Record<string, { request: tjs.Definition; response: tjs.Definition }>
	>;
}

/**
 * Checks if the hash of a file has changed. Returns true if file changed.
 */
export async function compareHash(
	cache: BuildCache,
	paths: string[],
): Promise<boolean> {
	// We hash all files regardless of if we already know there was a change so
	// we can re-use these hashes on the next run to see if anything changed.
	let hasChanged = false;
	for (const path of paths) {
		const oldHash = cache.oldCache.fileHashes[path];
		const newHash = await hashFile(cache, path);
		if (newHash != oldHash) {
			hasChanged = true;
			console.log(`✏️ ${path}`);
		}
	}

	return hasChanged;
}

export async function hashFile(
	cache: BuildCache,
	path: string,
): Promise<string> {
	// Return already calculated hash
	let hash = cache.newCache.fileHashes[path];
	if (hash) return hash;

	// Calculate hash
	const file = await Deno.open(path, { read: true });
	const fileHashBuffer = await crypto.subtle.digest(
		"SHA-256",
		file.readable,
	);
	hash = encodeHex(fileHashBuffer);
	cache.newCache.fileHashes[path] = hash;

	return hash;
}

/**
 * State for the current build process.
 */
interface BuildState {
	cache: BuildCache;
	promises: Promise<void>[];
}

interface BuildStepOpts {
	name: string;
	module?: Module;
	script?: Script;
	build: () => Promise<void>;
	alreadyCached?: () => Promise<void>;
	finally?: () => Promise<void>;
	always?: boolean;
	files?: string[];
}

// TODO: Convert this to a build flag
const FORCE_BUILD = false;

/**
 * Plans a build step.
 */
export function buildStep(
	buildState: BuildState,
	opts: BuildStepOpts,
) {
	// Build step name
	let stepName = opts.name;
	if (opts.module && opts.script) {
		stepName += ` (${opts.module.name}.${opts.script.name})`;
	} else if (opts.module) {
		stepName += ` (${opts.module.name})`;
	}

	const fn = async () => {
		// TODO: max parallel build steps
		// TODO: error handling
		if (
			FORCE_BUILD ||
			opts.always ||
			(opts.files && await compareHash(buildState.cache, opts.files))
		) {
			console.log(`🔨 ${stepName}`);
			await opts.build();
		} else {
			if (opts.alreadyCached) await opts.alreadyCached();
		}

		if (opts.finally) await opts.finally();
	};

	buildState.promises.push(fn());
}

async function waitForBuildPromises(buildState: BuildState): Promise<void> {
	const promises = buildState.promises;
	buildState.promises = [];
	await Promise.all(promises);
}

export async function build(project: Project, opts: BuildOpts) {
	const buildCachePath = join(project.path, "_gen", "cache.json");

	// Read hashes from file
	let oldCache: BuildCachePersist;
	if (await exists(buildCachePath)) {
		oldCache = JSON.parse(await Deno.readTextFile(buildCachePath));
	} else {
		oldCache = {
			version: 1,
			fileHashes: {},
			scriptSchemas: {},
		};
	}

	// Build cache
	const buildCache = {
		oldCache,
		newCache: {
			version: 1,
			fileHashes: {},
			scriptSchemas: {},
		} as BuildCachePersist,
	} as BuildCache;

	// Build state
	const buildState = {
		cache: buildCache,
		promises: [],
	} as BuildState;

	// Run build
	await buildSteps(buildState, project, opts);

	// Write cache
	// const writeCache = {
	// 	version: buildState.cache.newCache.version,
	// 	hashCache: Object.assign({} as Record<string, string>, buildState.cache.oldCache, buildState.cache.newCache),
	// } as BuildCachePersist;
	await Deno.writeTextFile(
		buildCachePath,
		JSON.stringify(buildState.cache.newCache),
	);

	console.log("✅ Finished");

	shutdownAllPools();
}

async function buildSteps(
	buildState: BuildState,
	project: Project,
	opts: BuildOpts,
) {
	const modules = Array.from(project.modules.values());

	buildStep(buildState, {
		name: "Prisma schema",
		files: modules.map((module) => join(module.path, "db", "schema.prisma")),
		async build() {
			await migrateDev(project, modules, {
				createOnly: false,
			});
		},
	});

	buildStep(buildState, {
		name: "Inflate runtime",
		// TODO: Add way to compare runtime version
		always: true,
		async build() {
			await inflateRuntimeArchive(project);
		},
	});

	// Wait for runtime since script schemas depend on this
	await waitForBuildPromises(buildState);

	for (const module of project.modules.values()) {
		await buildModule(buildState, project, module);
	}

	buildStep(buildState, {
		name: "Type helpers",
		files: [...project.modules.values()].map((m) =>
			join(m.path, "module.yaml")
		),
		async build() {
			await compileTypeHelpers(project);
		},
	});

	buildStep(buildState, {
		name: "Deno config",
		always: true,
		async build() {
			await generateDenoConfig(project);
		},
	});

	// Wait for module schemas requestSchema/responseSchema
	await waitForBuildPromises(buildState);

	buildStep(buildState, {
		name: "Entrypoint",
		always: true,
		async build() {
			await generateEntrypoint(project, opts);
		},
	});

	buildStep(buildState, {
		name: "OpenAPI",
		always: true,
		async build() {
			await generateOpenApi(project);
		},
	});

	if (opts.format == Format.Bundled) {
		buildStep(buildState, {
			name: "Bundle",
			always: true,
			async build() {
				const outfile = join(project.path, "_gen", "/output.js");

				await esbuild.build({
					entryPoints: [join(project.path, "_gen", "entrypoint.ts")],
					outfile,
					format: "esm",
					platform: "neutral",
					plugins: [
						...denoPlugins(),
					],
					external: ["*.wasm", "*.wasm?module"],
					bundle: true,
					minify: true,
				});

				await esbuild.stop();

				if (opts.runtime == Runtime.Cloudflare) {
					let data = await Deno.readTextFile(outfile);

					// Remove use of `FinalizationRegistry` (not supported in cf workers)
					// https://github.com/cloudflare/workers-sdk/issues/2258
					const registryMatch =
						/(?<varName>\w+)=new FinalizationRegistry\(\w+=>\w+\.__wbg_digestcontext_free\(\w+>>>0\)\),/
							.exec(data);
					if (registryMatch?.groups) {
						data = data.slice(0, registryMatch.index) +
							data.slice(registryMatch.index + registryMatch[0].length);

						const registryName = registryMatch.groups.varName;
						data = data.replace(
							new RegExp(`${registryName}.register\(\w+,\w+\.__wbg_ptr,\w+\),`),
							"",
						);
						data = data.replace(`${registryName}.unregister\(this\),`, "");
					}

					// Remove unused import (`node:timers` isn't available in cf workers)
					// https://developers.cloudflare.com/workers/runtime-apis/nodejs/
					data = data.replaceAll(`import"node:timers";`, "");

					await Deno.writeTextFile(outfile, data);
				}
			},
		});
	}

	// TODO: SDKs

	await waitForBuildPromises(buildState);
}

async function buildModule(
	buildState: BuildState,
	project: Project,
	module: Module,
) {
	buildStep(buildState, {
		name: "Module helper",
		module,
		files: [join(module.path, "module.yaml")],
		async build() {
			await compileModuleHelper(project, module);
		},
	});

	buildStep(buildState, {
		name: "Type helper",
		module,
		files: [join(module.path, "module.yaml")],
		async build() {
			await compileModuleTypeHelper(project, module);
		},
	});

	buildStep(buildState, {
		name: "Test helper",
		module,
		files: [join(module.path, "module.yaml")],
		async build() {
			await compileTestHelper(project, module);
		},
	});

	for (const script of module.scripts.values()) {
		await buildScript(buildState, project, module, script);
	}
}

async function buildScript(
	buildState: BuildState,
	project: Project,
	module: Module,
	script: Script,
) {
	buildStep(buildState, {
		name: "Script schema",
		module,
		script,
		// TODO: check sections of module config
		// TODO: This module and all of its dependent modules
		// TODO: use tjs.getProgramFiles() to get the dependent files?
		files: [join(module.path, "module.yaml"), script.path],
		async build() {
			// Compile schema
			//
			// This mutates `script`
			await compileSchema(project, module, script);
		},
		async alreadyCached() {
			// Read schemas from cache
			const schemas =
				buildState.cache.oldCache.scriptSchemas[module.name][script.name];
			assertExists(schemas);
			script.requestSchema = schemas.request;
			script.responseSchema = schemas.response;
		},
		async finally() {
			assertExists(script.requestSchema);
			assertExists(script.responseSchema);

			// Populate cache with response
			if (!buildState.cache.newCache.scriptSchemas[module.name]) {
				buildState.cache.newCache.scriptSchemas[module.name] = {};
			}
			buildState.cache.newCache.scriptSchemas[module.name][script.name] = {
				request: script.requestSchema,
				response: script.responseSchema,
			};
		},
	});

	buildStep(buildState, {
		name: "Script helper",
		module,
		script,
		// TODO: check sections of module config
		files: [join(module.path, "module.yaml"), script.path],
		async build() {
			await compileScriptHelper(project, module, script);
		},
	});
}
