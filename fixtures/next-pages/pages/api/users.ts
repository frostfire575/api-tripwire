export default function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ id: 1 });
  if (req.method === 'POST') return res.status(201).json({ created: true });
}
