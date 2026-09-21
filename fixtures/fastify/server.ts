import fastify from 'fastify';
const app = fastify();
app.register(
  async function plugin(server) {
    server.get('/users', (request, reply) => reply.code(200).send({ users: [{ id: 1 }] }));
    server.route({
      method: 'POST',
      url: '/users',
      handler: (request, reply) => reply.send({ ok: true }),
    });
  },
  { prefix: '/api' },
);
