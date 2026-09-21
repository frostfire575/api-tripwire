import express from 'express';
const app = express();
app.get('/api/users/:id', (req, res) => {
  res.json({ id: 'u_123', name: 'Ada' });
});
