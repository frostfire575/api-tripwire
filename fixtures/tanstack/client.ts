import { useQuery } from '@tanstack/react-query';
const query = useQuery({
  queryKey: ['users'],
  queryFn: async () => (await fetch('/api/users')).json(),
});
const id = query.data?.id;
