/**
 * Provides context about where this script call came from.
 */
export interface Trace {
	rayId: string;
	entries: TraceEntry[];
}

/**
 * Single entry in the trace.
 */
export interface TraceEntry {
	requestId: string;
	startedAt: string;
	type: TraceEntryType;
}

/**
 * Infomration about the type of the trace entry.
 */
export type TraceEntryType = { httpRequest: TraceEntryTypeHttpRequest } | {
	script: TraceEntryTypeScript;
} | { test: TraceEntryTypeTest } | { internalTest: TraceEntryTypeInternalTest };

export interface TraceEntryTypeHttpRequest {
	method: string;
	path: string;
}

export interface TraceEntryTypeScript {
	module: string;
	script: string;
}

export interface TraceEntryTypeTest {
	module: string;
	name: string;
}

export interface TraceEntryTypeInternalTest {
	
}

export function newTrace(entryType: TraceEntryType): Trace {
	const entry: TraceEntry = {
		requestId: crypto.randomUUID(),
		startedAt: new Date().toISOString(),
		type: entryType,
	};

	return {
		rayId: crypto.randomUUID(),
		entries: [entry],
	};
}

/**
 * Returns a new trace with the given entry appended to it.
 */
export function appendTraceEntry(
	trace: Trace,
	entryType: TraceEntryType,
): Trace {
	const entry: TraceEntry = {
		requestId: crypto.randomUUID(),
		startedAt: new Date().toISOString(),
		type: entryType,
	};

	return {
		rayId: trace.rayId,
		entries: [...trace.entries, entry],
	};
}
