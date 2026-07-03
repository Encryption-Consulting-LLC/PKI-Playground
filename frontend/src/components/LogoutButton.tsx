import { useMutation } from "@tanstack/react-query"
import { LogOut } from "lucide-react"
import { logout } from "@/lib/api"
import { useAuthStore } from "@/store/auth"
import { Button } from "@/components/ui/button"

/** Logout button — POST /auth/logout (a courtesy ack; the JWT is stateless)
 *  then clears the local session. Always returns to the login form. */
export function LogoutButton() {
  const mutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      useAuthStore.getState().clear()
    },
  })

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <LogOut className="mr-1.5 h-3.5 w-3.5" />
      {mutation.isPending ? "Signing out…" : "Logout"}
    </Button>
  )
}
