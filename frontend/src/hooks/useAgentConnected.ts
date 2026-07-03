/**
 * True if the given orchestrator vm_id currently has a connected agent.
 *
 * Polled via `GET /orchestrator/agents` (TanStack Query, same short-interval
 * polling pattern as `HealthBadge`) rather than pushed — there's no presence
 * WebSocket for this in v1; a dispatched command's own progress still
 * streams live over `/ws/jobs/{job_id}`, this is only for the idle
 * connected/not-connected indicator.
 */

import { useQuery } from "@tanstack/react-query"
import { QUERY_KEYS } from "@/constants"
import { listConnectedAgents } from "@/lib/api"

export function useAgentConnected(vmId: string | undefined): boolean {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.orchestratorAgents,
    queryFn: listConnectedAgents,
    refetchInterval: 5_000,
    enabled: !!vmId,
  })
  return !!vmId && !!data?.vm_ids.includes(vmId)
}
