import { addFormats, Ajv } from "./deps.ts";
import { ScriptContext } from "./context.ts";
import { Context, TestContext, RouteContext } from "./context.ts";
import { Postgres, PrismaClientDummy } from "./postgres.ts";
import { serverHandler } from "./server.ts";
import { TraceEntryType } from "./trace.ts";
import { newTrace } from "./trace.ts";
import { RegistryCallMap } from "./proxy.ts";
import { ActorDriver } from "./actor.ts";
import { QualifiedPathPair } from "./path_resolver.ts";

export interface Config {
	modules: Record<string, Module>;
}

export interface Module {
	scripts: Record<string, Script>;
	actors: Record<string, Actor>;
	routes: Record<string, Route>;
	errors: Record<string, ErrorConfig>;
	db?: {
		name: string;
		createPrisma: (databaseUrl: string) => CreatePrismaOutput;
	};
	dependencies: Set<string>;
	userConfig: unknown;
}

interface CreatePrismaOutput {
	prisma: PrismaClientDummy;
	pgPool?: any;
}

export interface Script {
	// deno-lint-ignore no-explicit-any
	run: ScriptRun<any, any, any, any>;
	// deno-lint-ignore no-explicit-any
	requestSchema: any;
	// deno-lint-ignore no-explicit-any
	responseSchema: any;
	public: boolean;
}

export interface RouteBase {
	// deno-lint-ignore no-explicit-any
	run: RouteRun<any, any>;
	methods: Set<string>;
}

export interface PrefixRoute extends RouteBase {
	pathPrefix: string;
}

export interface ExactRoute extends RouteBase {
	path: string;
}

export type Route = ExactRoute | PrefixRoute;


export type ScriptRun<Req, Res, UserConfigT, DatabaseT> = (
	ctx: ScriptContext<any, any, any, any, UserConfigT, DatabaseT>,
	req: Req,
) => Promise<Res>;

export interface Actor {
	actor: any;
	storageId: string;
}

export type RouteRun<UserConfigT, DatabaseT> = (
	ctx: RouteContext<any, any, any, any, UserConfigT, DatabaseT>,
	req: Request,
) => Promise<Response>;

export interface ErrorConfig {
	description?: string;
}

export class Runtime<DependenciesSnakeT, DependenciesCamelT, ActorsSnakeT, ActorsCamelT> {
	public postgres: Postgres;

	public ajv: Ajv.default;

	public constructor(
		public config: Config,
		public actorDriver: ActorDriver,
		private dependencyCaseConversionMap: RegistryCallMap,
		private actorCaseConversionMap: RegistryCallMap,
	) {
		this.postgres = new Postgres();

		this.ajv = new Ajv.default({
			removeAdditional: true,
		});
		// TODO: Why are types incompatible
		addFormats.default(this.ajv as any);
	}

	private async shutdown() {
		await this.postgres.shutdown();
	}

	public createRootContext(
		traceEntryType: TraceEntryType
	): Context<DependenciesSnakeT, DependenciesCamelT, ActorsSnakeT, ActorsCamelT> {
		return new Context(this, newTrace(traceEntryType), this.dependencyCaseConversionMap, this.actorCaseConversionMap);
	}

	public createRootRouteContext(
		traceEntryType: TraceEntryType,
		moduleName: string,
		routeName: string,
	): RouteContext<DependenciesSnakeT, DependenciesCamelT, ActorsSnakeT, ActorsCamelT, unknown, PrismaClientDummy | undefined> {
		const module = this.config.modules[moduleName];
		if (!module) throw new Error(`Module not found: ${moduleName}`);

		return new RouteContext(
			this,
			newTrace(traceEntryType),
			moduleName,
			this.postgres.getOrCreatePool(module)?.prisma,
			routeName,
			this.dependencyCaseConversionMap,
			this.actorCaseConversionMap
		);
	}

	/**
	 * Serves the runtime as an HTTP server.
	 */
	public async serve() {
		const port = parseInt(Deno.env.get("PORT") ?? "8080");
		console.log(`Serving on port ${port}`);

		await Deno.serve({ port }, serverHandler(this)).finished;
	}

	/**
	 * Registers a module test with the Deno runtime.
	 */
	public static test<DependenciesSnakeT, DependenciesCamelT, ActorsSnakeT, ActorsCamelT, UserConfigT>(
		config: Config,
		actorDriver: ActorDriver,
		moduleName: string,
		testName: string,
		fn: (
			ctx: TestContext<DependenciesSnakeT, DependenciesCamelT, ActorsSnakeT, ActorsCamelT, UserConfigT, any>,
		) => Promise<void>,
		dependencyCaseConversionMap: RegistryCallMap,
		actorDependencyCaseConversionMap: RegistryCallMap,
	) {
		Deno.test({
			name: testName,

			// TODO: https://github.com/rivet-gg/opengb-engine/issues/35
			sanitizeOps: false,
			sanitizeResources: false,

			async fn() {
				const runtime = new Runtime<DependenciesSnakeT, DependenciesCamelT, ActorsSnakeT, ActorsCamelT>(
					config,
					actorDriver,
					dependencyCaseConversionMap,
					actorDependencyCaseConversionMap,
				);

				// Build context
				const module = config.modules[moduleName];
				const ctx = new TestContext<
					DependenciesSnakeT,
					DependenciesCamelT,
					ActorsSnakeT,
					ActorsCamelT,
					UserConfigT,
					PrismaClientDummy | undefined
				>(
					runtime,
					newTrace({
						test: { module: moduleName, name: testName },
					}),
					moduleName,
					runtime.postgres.getOrCreatePool(module)?.prisma,
					dependencyCaseConversionMap,
					actorDependencyCaseConversionMap,
				);

				// Run test
				try {
					await ctx.runBlock(async () => {
						await fn(ctx);
					});
				} catch (cause) {
					console.error(
						`Failed to execute test: ${moduleName}.${testName}`,
						cause,
					);
					throw cause;
				} finally {
					await runtime.shutdown();
				}
			},
		});
	}

	

	public routePaths(): QualifiedPathPair[] {
		const paths: QualifiedPathPair[] = [];
		for (const moduleName in this.config.modules) {
			const module = this.config.modules[moduleName];
			for (const routeName in module.routes) {
				const route = module.routes[routeName];
				if ("path" in route) {
					paths.push({
						module: moduleName,
						route: routeName,
						path: { path: route.path, isPrefix: false },
					});
				} else {
					paths.push({
						module: moduleName,
						route: routeName,
						path: { path: route.pathPrefix, isPrefix: true },
					});
				}
			}
		}

		return paths;
	}
}

export type PathPair = { path: string; isPrefix: boolean };
