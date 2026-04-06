import Fastify from 'fastify';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import outputRoutes from './routes/outputs.js';
import streamRoutes from './routes/stream.js';
import internalStreamRoutes from './routes/internal/stream.js';
import streamsRoutes from './routes/streams.js';
import healthRoutes from './routes/health.js';

function addErrorHandler(app: ReturnType<typeof Fastify>) {
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      app.log.error(error);
    }
    reply.code(statusCode).send({
      statusCode,
      error: error.code ?? 'INTERNAL_ERROR',
      message: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });
}

function addFormParser(app: ReturnType<typeof Fastify>) {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      const params = Object.fromEntries(new URLSearchParams(body as string));
      done(null, params);
    },
  );
}

/** Public API server — auth, outputs, streams, health */
export async function buildApp() {
  const app = Fastify({ logger: false });

  addFormParser(app);

  // Plugins
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(outputRoutes);
  await app.register(streamRoutes);
  await app.register(streamsRoutes);

  addErrorHandler(app);

  return app;
}

/** Internal API server — nginx-rtmp callbacks, isolated port */
export async function buildInternalApp() {
  const app = Fastify({ logger: false });

  addFormParser(app);

  // Shared infrastructure plugins
  await app.register(prismaPlugin);
  await app.register(redisPlugin);

  // Shared secret gate
  app.addHook('onRequest', async (request, reply) => {
    const expected = process.env.INTERNAL_SECRET;
    if (!expected) {
      request.log.warn('INTERNAL_SECRET not configured');
      return reply.code(500).send({ error: 'Internal routes misconfigured' });
    }
    if (request.headers['x-internal-secret'] !== expected) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  });

  await app.register(internalStreamRoutes);

  addErrorHandler(app);

  return app;
}
