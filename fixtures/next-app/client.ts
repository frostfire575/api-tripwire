async function load() {
  const user = await (await fetch('/api/users/1')).json();
  return user.id;
}
