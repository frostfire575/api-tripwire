import express from 'express';
const app = express();
const router = express.Router();
router.get('/users/:id', (req, res) => res.json({ id: 'one', profile: { name: 'Ada' } }));
app.use('/api', router);
