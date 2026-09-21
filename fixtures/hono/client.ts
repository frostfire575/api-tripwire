async function load() {
  const user = await (await fetch('/api/users')).json();
  return user.id;
}
