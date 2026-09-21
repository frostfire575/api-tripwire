import { Hono } from 'hono';
const app = new Hono();
app.get('/api/users', (c) => c.json({ id: 1 }));
