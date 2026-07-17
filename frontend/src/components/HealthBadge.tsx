import { useQuery } from "@tanstack/react-query"
import { getHealth } from "@/lib/api"
import { QUERY_KEYS } from "@/constants"
import { useIsOperator } from "@/hooks/useIsOperator"
import { Badge } from "@/components/ui/badge"

/** Live backend reachability indicator, polled via TanStack Query.
 *
 * Guests get plain product language ("Online") with no library-name tooltip —
 * which libraries back the API is an infra internal. Operators keep the
 * diagnostic variant.
 */
export function HealthBadge() {
  const isOperator = useIsOperator()
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.health,
    queryFn: getHealth,
    refetchInterval: 15_000,
  })

  if (isLoading)
    return (
      <Badge variant="secondary">
        {isOperator ? "API: checking…" : "Checking…"}
      </Badge>
    )
  if (isError || data?.status !== "ok")
    return (
      <Badge variant="destructive">
        {isOperator ? "API: unreachable" : "Offline"}
      </Badge>
    )

  if (!isOperator)
    return <Badge className="bg-emerald-600 text-white">Online</Badge>

  const libs = Object.keys(data.libraries).join(", ")
  return (
    <Badge className="bg-emerald-600 text-white" title={`libraries: ${libs}`}>
      API: ok
    </Badge>
  )
}
