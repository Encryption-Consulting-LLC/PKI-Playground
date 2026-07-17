import { create } from "zustand"

export interface ConnectionGesture {
  sourceNodeId: string
  sourceHandleId: string
  targetNodeId?: string
  targetHandleId?: string
}

interface ConnectionGestureState {
  gesture: ConnectionGesture | null
  start: (sourceNodeId: string, sourceHandleId: string) => void
  hoverTarget: (targetNodeId?: string, targetHandleId?: string) => void
  end: () => void
}

/** Transient pointer/focus state; deliberately excluded from project snapshots. */
export const useConnectionGestureStore = create<ConnectionGestureState>()(
  (set) => ({
    gesture: null,
    start: (sourceNodeId, sourceHandleId) => {
      set({ gesture: { sourceNodeId, sourceHandleId } })
    },
    hoverTarget: (targetNodeId, targetHandleId) => {
      set((state) =>
        state.gesture
          ? { gesture: { ...state.gesture, targetNodeId, targetHandleId } }
          : state,
      )
    },
    end: () => set({ gesture: null }),
  }),
)
