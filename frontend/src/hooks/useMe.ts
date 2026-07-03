/**
 * The signed-in identity from GET /auth/me — username, role, and the
 * capability allowlist. Enabled only while a token is held; the query result
 * changes with the user (unlike GET /auth/mode, which is deploy-level), so it
 * is keyed per token and dropped on logout.
 */

import { useQuery } from "@tanstack/react-query"
import { QUERY_KEYS } from "@/constants"
import { getMe, type Me } from "@/lib/api"
import { useAuthStore } from "@/store/auth"

export function useMe(): Me | undefined {
  const token = useAuthStore((s) => s.token)
  const { data } = useQuery({
    queryKey: [...QUERY_KEYS.me, token],
    queryFn: getMe,
    enabled: !!token,
    staleTime: 5 * 60 * 1000,
  })
  return data
}
