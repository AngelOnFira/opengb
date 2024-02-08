import { TraceEntry } from '../../../engine/runtime/src/index.ts';

export interface Token {
    id: string,
    type: string,
    meta: any,
    trace: TraceEntry[],
    created_at: string,
    expire_at?: string,
    revoked_at?: string,
}