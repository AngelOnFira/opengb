import { addFormats, Ajv } from "./deps.ts";
import { ScriptContext } from "./context.ts";
import { Context, TestContext } from "./context.ts";
import { Postgres, PrismaClientDummy } from "./postgres.ts";
import { serverHandler } from "./server.ts";
import { TraceEntryType } from "./trace.ts";
import { newTrace } from "./trace.ts";
import { RegistryCallMap } from "./proxy.ts";

export interface Config {
	modules: Record<string, Module>;
	cors?: CorsConfig;
}

export interface Module {
	scripts: Record<string, Script>;
	errors: Record<string, ErrorConfig>;
	db?: {
		name: string;
		createPrisma: (databaseUrl: string) => CreatePrismaOutput;
	};
	dependencies: Set<string>;
	userConfig: unknown;
}

export interface CorsConfig {
	origins: Set<string>;
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

export type ScriptRun<Req, Res, UserConfigT, DatabaseT> = (
	ctx: ScriptContext<any, any, UserConfigT, DatabaseT>,
	req: Req,
) => Promise<Res>;

export interface ErrorConfig {
	description?: string;
}

export class Runtime<DependenciesSnakeT, DependenciesCamelT> {
	public postgres: Postgres;

	public ajv: Ajv.default;

	public constructor(public config: Config, private dependencyCaseConversionMap: RegistryCallMap) {
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

	public createRootContext(traceEntryType: TraceEntryType): Context<DependenciesSnakeT, DependenciesCamelT> {
		return new Context(this, newTrace(traceEntryType), this.dependencyCaseConversionMap);
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
	public static test<DependenciesSnakeT, DependenciesCamelT, UserConfigT>(
		config: Config,
		moduleName: string,
		testName: string,
		fn: (ctx: TestContext<DependenciesSnakeT, DependenciesCamelT, UserConfigT, any>) => Promise<void>,
		dependencyCaseConversionMap: RegistryCallMap,
	) {
		Deno.test({
			name: testName,

			// TODO: https://github.com/rivet-gg/opengb-engine/issues/35
			sanitizeOps: false,
			sanitizeResources: false,

			async fn() {
				const runtime = new Runtime<DependenciesSnakeT, DependenciesCamelT>(config, dependencyCaseConversionMap);

				// Build context
				const module = config.modules[moduleName];
				const ctx = new TestContext<DependenciesSnakeT, DependenciesCamelT, UserConfigT, PrismaClientDummy | undefined>(
					runtime,
					newTrace({
						test: { module: moduleName, name: testName },
					}),
					moduleName,
					runtime.postgres.getOrCreatePool(module)?.prisma,
					dependencyCaseConversionMap,
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

	/**
	 * Only runs on a CORS preflight request— returns a response with the
	 * appropriate CORS headers & status.
	 * 
	 * @param req The preflight OPTIONS request
	 * @returns The full response to the preflight request
	 */
	public corsPreflight(req: Request): Response {
		const origin = req.headers.get("Origin");
		if (origin) {
			const normalizedOrigin = new URL(origin).origin;
			if (this.config.cors) {
				if (this.config.cors.origins.has(normalizedOrigin)) {
					return new Response(undefined, {
						status: 204,
						headers: {
							...this.corsHeaders(req),
							"Vary": "Origin",
						},
					});
				}
			}
		}

		// Origin is not allowed/no origin header on preflight
		return new Response(undefined, {
			status: 403,
			headers: {
				"Vary": "Origin",
				"See": "https://opengb.dev/docs/cors",
			},
		});
	}

	public corsHeaders(req: Request): Record<string, string> {
		const origin = req.headers.get("Origin");

		// Don't set CORS headers if there's no origin (e.g. a server-side
		// request)
		if (!origin) return {};

		// If the origin is allowed, return the appropriate headers.
		// Otherwise, return a non-matching cors header (empty object).
		if (this.config.cors?.origins.has(origin)) {
			return {
				"Access-Control-Allow-Origin": new URL(origin).origin,
				"Access-Control-Allow-Methods": "*",
				"Access-Control-Allow-Headers": "*",
			};
		} else {
			return {};
		}
	}

	public corsAllowed(req: Request): boolean {
		const origin = req.headers.get("Origin");

		if (!origin) return true;
		return this.config.cors?.origins.has(origin) ?? false;
	}
}
