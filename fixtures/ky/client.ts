import ky from 'ky';
const api = ky.create({ prefixUrl: '/api' });
async function load() {
  const user = await api.get('users').json();
  return user.id;
}
