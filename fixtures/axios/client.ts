import axios from 'axios';
const api = axios.create({ baseURL: 'https://example.test/api' });
async function load() {
  const { data } = await api.get('users');
  return data.id;
}
