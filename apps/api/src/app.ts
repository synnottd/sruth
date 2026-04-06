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

export async function buildApp() {
  const app = Fastify({ logger: false });

  // Parse form-encoded bodies (used by nginx-rtmp callbacks)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      const params = Object.fromEntries(new URLSearchParams(body as string));
      done(null, params);
    },
  );

  // Plugins
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(outputRoutes);
  await app.register(streamRoutes);
  await app.register(internalStreamRoutes);
  await app.register(streamsRoutes);

  // Error handler
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      statusCode,
      error: error.code ?? 'INTERNAL_ERROR',
      message: error.message,
    });
  });

  return app;
}
