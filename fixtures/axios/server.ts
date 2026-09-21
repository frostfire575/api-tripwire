import express from 'express';
const app = express();
app.get('/api/users', (req, res) => res.json({ id: 1 }));
