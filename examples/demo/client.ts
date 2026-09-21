async function loadUser() {
  const response = await fetch('/api/users/123');
  const user = await response.json();
  return user.userId;
}
