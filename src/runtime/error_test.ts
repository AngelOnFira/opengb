import { assertEquals, assertExists } from "../deps.ts";
import { ActorDriver } from "./actor.ts";
import { ModuleContext } from "./context.ts";
import { RuntimeError } from "./error.ts";
import { newTrace } from "./mod.ts";
import { Runtime } from "./runtime.ts";

type ErrDepSnake = { test_module: Record<string, never> };
type ErrDepCamel = { testModule: Record<string, never> };

type ErrActorSnake = { test_module: Record<string, never> };
type ErrActorCamel = { testModule: Record<string, never> };


type RuntimeType = Runtime<ErrDepSnake, ErrDepCamel, ErrActorSnake, ErrActorCamel>;
type ModuleCtxType = ModuleContext<ErrDepSnake, ErrDepCamel, ErrActorSnake, ErrActorCamel, null, undefined>;

Deno.test("error", async () => {
	const actorDriver: ActorDriver = {
		getId: async () => "",
		getActor: async () => ({}),
		callActor: async () => ({}),
		createActor: async () => {},
		actorExists: async () => false,
	};
	const dependencyCaseConversionMap = { testModule: {} } as const;
	const actorCaseConversionMap = { testModule: {} } as const;

	// Setup
	const runtime: RuntimeType = new Runtime({
		modules: {
			test_module: {
				scripts: {},
				routes: {},
				actors: {},
				errors: {
					"TEST_ERROR": {},
				},
				dependencies: new Set(["test_module"]),
				userConfig: null,
			},
		},
	}, actorDriver, dependencyCaseConversionMap, actorCaseConversionMap);
	const moduleContext: ModuleCtxType = new ModuleContext(
		runtime,
		newTrace({ internalTest: {} }),
		"test_module",
		undefined,
		dependencyCaseConversionMap,
		actorCaseConversionMap,
	);

	// Create error
	const error = new RuntimeError("TEST_ERROR");
	assertEquals(error.message.split("\n")[0], "TEST_ERROR");

	// Erich error
	error.enrich(runtime, moduleContext);
	assertExists(error.moduleName);
	assertExists(error.trace);
	assertExists(error.errorConfig);
	assertEquals(error.message.split("\n")[0], "test_module[TEST_ERROR]");
});
