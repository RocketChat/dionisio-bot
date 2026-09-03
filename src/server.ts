// Must run before ./logger reads LOG_LEVEL/LOG_FORMAT
import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createProbot } from 'probot';
import { createNodeMiddleware } from '@octokit/webhooks';
import { pinoHttp } from 'pino-http';
import app from './index';
import { httpSerializers, logger } from './logger';

const { APP_ID, PRIVATE_KEY, PRIVATE_KEY_PATH, PORT } = process.env;

if (!APP_ID || !(PRIVATE_KEY || PRIVATE_KEY_PATH)) {
	logger.fatal('APP_ID and PRIVATE_KEY (or PRIVATE_KEY_PATH) are required');
	process.exit(1);
}

// Errors carrying the webhook event were already logged by probot's onError handler
const alreadyReported = (error: unknown): boolean => typeof error === 'object' && error !== null && 'event' in error;

const main = async () => {
	// Pass a child, never the root: Probot rebinds every method of the logger it receives,
	// which would make all children created from the root lose their bindings and serializers
	const probot = createProbot({ overrides: { log: logger.child({ name: 'probot' }) } });
	await probot.load(app);

	const webhooks = createNodeMiddleware(probot.webhooks, {
		path: probot.webhookPath,
		log: {
			debug: (message) => logger.debug(message),
			info: (message) => logger.info(message),
			warn: (message) => logger.warn(message),
			error: (error) => {
				if (!alreadyReported(error)) {
					logger.error({ err: error }, 'webhook middleware error');
				}
			},
		},
	});

	const requestLogger = pinoHttp({
		logger: logger.child({ name: 'http' }),
		genReqId: (req) => (req.headers['x-github-delivery'] as string | undefined) ?? randomUUID(),
		// quietReqLogger puts the request id at the top level under the delivery key
		quietReqLogger: true,
		customAttributeKeys: { reqId: 'delivery' },
		customProps: (req) => ({ event: req.headers['x-github-event'] }),
		serializers: httpSerializers,
		customLogLevel: (_req, res, error) => {
			if (error || res.statusCode >= 500) {
				return 'error';
			}
			// 202 means a handler exceeded the 9s budget and GitHub got "still processing"
			if (res.statusCode >= 400 || res.statusCode === 202) {
				return 'warn';
			}
			return 'info';
		},
		customSuccessMessage: (req, res, responseTime) => `${req.method} ${req.url} ${res.statusCode} - ${responseTime}ms`,
		customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
		autoLogging: { ignore: (req) => req.url === '/ping' },
	});

	const server = createServer((req, res) => {
		requestLogger(req, res);

		if (req.url === '/ping') {
			res.end('PONG');
			return;
		}

		webhooks(req, res, () => {
			res.statusCode = 404;
			res.end();
		}).catch((error: unknown) => {
			logger.error({ err: error }, 'unhandled webhook middleware failure');
			if (!res.headersSent) {
				res.statusCode = 500;
				res.end();
			}
		});
	});

	const port = Number(PORT) || 3000;
	server.on('error', (error) => {
		logger.fatal({ err: error, port }, 'server failed to start');
		process.exit(1);
	});
	server.listen(port, () => logger.info({ port, path: probot.webhookPath }, 'listening'));

	const shutdown = (signal: NodeJS.Signals) => {
		logger.info({ signal }, 'shutting down');
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 10_000).unref();
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
};

main().catch((error: unknown) => {
	logger.fatal({ err: error }, 'failed to start');
	process.exit(1);
});
