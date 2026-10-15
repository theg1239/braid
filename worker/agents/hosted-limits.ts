import * as v from 'valibot';

export const TASK_MINUTES = 27;
export const COMMAND_TIMEOUT = 10 * 60_000;
export const MODEL_TIMEOUT = 2 * 60_000;
export { hostedTiming } from '../schemas';
import { hostedTiming } from '../schemas';
export type HostedTiming = v.InferOutput<typeof hostedTiming>;
export const duration = (ms: number) => ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}-minute` : `${Math.ceil(ms / 1000)}-second`;
