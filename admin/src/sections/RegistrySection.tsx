import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"

import { QUERY_KEYS } from "@/constants"
import { listVmRegistry, type VmRegistryEntry } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

function formatDate(ms: number | null): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString()
}

function statusVariant(status: VmRegistryEntry["status"]): "success" | "warning" | "destructive" | "outline" {
  switch (status) {
    case "ready":
      return "success"
    case "cloning":
      return "warning"
    case "error":
      return "destructive"
    default:
      return "outline"
  }
}

/**
 * Read-only view of the VM registry (app-side VM identity ↔ ESXi identity).
 * Entries are keyed by the real ESXi inventory name; app names repeat across
 * projects, so vmName is the natural stable identity to scan for.
 */
export function RegistrySection() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: QUERY_KEYS.registry,
    queryFn: listVmRegistry,
    refetchInterval: 15_000,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>VM registry</CardTitle>
        <CardDescription>
          App-side identity and status cache for cloned machines, across every project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-(--gap-inline) py-(--pad-section) text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading registry…
          </div>
        ) : isError ? (
          <p className="py-(--pad-section) text-xs text-destructive">
            {error instanceof Error ? error.message : "Could not load the VM registry."}
          </p>
        ) : data && data.entries.length === 0 ? (
          <p className="py-(--pad-section) text-xs text-muted-foreground">
            No VMs have been registered yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>VM name</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Power</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.entries.map((entry) => (
                <TableRow key={entry.vmName}>
                  <TableCell className="font-mono text-xs">{entry.vmName}</TableCell>
                  <TableCell className="text-xs">{entry.appName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{entry.projectId ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(entry.status)}>{entry.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{entry.powerState ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{entry.ip ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(entry.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
