async function load() {
  const user = await (await fetch('/api/users/one')).json();
  return user.profile.name;
}
