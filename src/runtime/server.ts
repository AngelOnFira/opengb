import { Runtime } from "./runtime.ts";

const MODULE_CALL = /^\/modules\/(?<module>\w+)\/scripts\/(?<script>\w+)\/call\/?$/;

export function serverHandler<DependenciesSnakeT, DependenciesCamelT>(
	runtime: Runtime<DependenciesSnakeT, DependenciesCamelT>,
): Deno.ServeHandler {
	return async (
		req: Request,
		info: Deno.ServeHandlerInfo,
	): Promise<Response> => {
		const url = new URL(req.url);

		// Handle CORS preflight
		if (req.method === "OPTIONS") {
			return runtime.corsPreflight(req);
		}

		// Disallow even simple requests if CORS is not allowed
		if (!runtime.corsAllowed(req)) {
			return new Response(undefined, {
				status: 403,
				headers: {
					"Vary": "Origin",
					...runtime.corsHeaders(req),
				},
			});
		}

		// Only allow POST requests
		if (req.method !== "POST") return new Response(undefined, {
			status: 405,
			headers: {
				"Allow": "POST",
				...runtime.corsHeaders(req),
			},
		});

		// Get module and script name
		const matches = MODULE_CALL.exec(url.pathname);
		if (!matches?.groups) return new Response(
			JSON.stringify({
				"message": "Route not found. Make sure the URL and method are correct.",
			}),
			{
				headers: {
					"Content-Type": "application/json",
					...runtime.corsHeaders(req),
				},
				status: 404,
			},
		);


		// Lookup script
		const moduleName = matches.groups.module;
		const scriptName = matches.groups.script;
		const script = runtime.config.modules[moduleName]?.scripts[scriptName];

		// Confirm script exists and is public
		if (!script || !script.public) return new Response(
			JSON.stringify({
				"message": "Route not found. Make sure the URL and method are correct.",
			}),
			{
				headers: {
					"Content-Type": "application/json",
					...runtime.corsHeaders(req),
				},
				status: 404,
			},
		);
	
		// Create context
		const ctx = runtime.createRootContext({
			httpRequest: {
				method: req.method,
				path: url.pathname,
				remoteAddress: info.remoteAddr.hostname,
				headers: Object.fromEntries(req.headers.entries()),
			},
		});

		// Parse body
		let body;
		try {
			body = await req.json();
		} catch {
			const output = {
				message: "Request must have a valid JSON body.",
			};
			return new Response(JSON.stringify(output), {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					...runtime.corsHeaders(req),
				},
			});
		}

		try {
			// Call module
			const output = await ctx.call(
				moduleName as any,
				scriptName as any,
				body,
			);

			if (output.__tempPleaseSeeOGBE3_NoData) {
				return new Response(undefined, {
					status: 204,
					headers: {
						...runtime.corsHeaders(req),
					},
				});
			}

			return new Response(JSON.stringify(output), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					...runtime.corsHeaders(req),
				},
			});
		} catch (e) {
			// Error response
			const output = {
				message: e.message,
			};

			return new Response(JSON.stringify(output), {
				status: 500,
				headers: {
					"Content-Type": "application/json",
					...runtime.corsHeaders(req),
				},
			});
		}
	};
}
