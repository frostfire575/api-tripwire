async function load() {
  const result = await (await fetch('/api/users')).json();
  return result.users[0].id;
}
