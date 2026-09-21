import { Hono } from 'hono';
const app = new Hono();
const sub = new Hono();
sub.get('/users', (c) => c.json({ id: 1 }));
app.route('/api', sub);
