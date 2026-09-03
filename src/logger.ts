import { pino, stdSerializers, type Logger } from 'pino';
import type { Context } from 'probot';

export type Log = Logger;

const { LOG_LEVEL = 'info', LOG_FORMAT, NODE_ENV } = process.env;
const isTest = NODE_ENV === 'test';
// Same rule probot uses: JSON in production unless LOG_FORMAT says otherwise
const pretty = !isTest && (LOG_FORMAT ? LOG_FORMAT === 'pretty' : NODE_ENV !== 'production');

// @octokit/webhooks attaches the full webhook event to handler errors; keep only what identifies it
const summarizeEvent = (event: unknown) => {
	if (!event || typeof event !== 'object') {
		return undefined;
	}
	const { id, name, payload } = event as { id?: string; name?: string; payload?: unknown };
	const action = payload && typeof payload === 'object' ? (payload as { action?: string }).action : undefined;
	return { id, name, action };
};

type SerializedError = ReturnType<typeof stdSerializers.err>;

// Octokit RequestError carries the whole request/response (headers, bodies); keep the useful part
export const trimSerializedError = (error: SerializedError): SerializedError => {
	if ('event' in error) {
		error.event = summarizeEvent(error.event);
	}
	if (Array.isArray(error.aggregateErrors)) {
		error.aggregateErrors = error.aggregateErrors.map((inner: SerializedError) => trimSerializedError(inner));
	}
	if (error.request && typeof error.request === 'object') {
		error.request = { method: error.request.method, url: error.request.url };
	}
	if (error.response && typeof error.response === 'object') {
		error.response = { status: error.response.status, message: error.response.data?.message };
	}
	return error;
};

// pino-http hands these the already std-serialized request/response
export const httpSerializers = {
	req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url }),
	res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
	err: trimSerializedError,
};

export const logger: Logger = pino({
	level: LOG_LEVEL,
	enabled: !isTest,
	base: undefined,
	serializers: {
		...httpSerializers,
		err: (error: Error) => trimSerializedError(stdSerializers.err(error)),
	},
	...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
});

type PayloadShape = Partial<{
	action: string;
	repository: { full_name?: string };
	pull_request: { number?: number };
	issue: { number?: number };
	number: number;
	sender: { login?: string };
}>;

/**
 * Logger for one webhook delivery. Create it once per handler and pass it down;
 * every line then carries the delivery id used as the "error id" in GitHub comments.
 */
export const eventLogger = (context: Context): Log => {
	const payload = context.payload as unknown as PayloadShape;
	return logger.child({
		name: 'app',
		delivery: context.id,
		event: context.name,
		action: payload.action,
		repo: payload.repository?.full_name,
		number: payload.pull_request?.number ?? payload.issue?.number ?? payload.number,
		sender: payload.sender?.login,
	});
};
