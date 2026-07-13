import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useVisibleTabs } from './useVisibleTabs'

const SWIPE_THRESHOLD_PX = 60
const SWIPE_DIRECTION_RATIO = 2

// Swipe-Navigation zwischen den BottomNav-Tabs. Nutzt dieselbe gefilterte
// Tab-Liste wie BottomNav (useVisibleTabs), damit Reihenfolge und Sichtbarkeit
// nie auseinanderlaufen. Aktiv ist die Geste nur, wenn der aktuelle Pfad
// tatsächlich einem der 5 Haupt-Tabs entspricht — auf allen anderen Routen
// (/activity/:id, /onboarding, /auth/callback, /) bleibt sie automatisch aus,
// ganz ohne dass der Aufrufer das explizit steuern muss.
//
// Elemente mit [data-swipe-ignore] (z.B. DayCard in WeeklyPlan, deren
// dnd-kit-Drag und Long-Press-Kontextmenü dieselben Touch-Events nutzen)
// unterbrechen die Geste komplett, sobald sie dort beginnt.
export function useTabSwipeNavigation() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const tabs = useVisibleTabs()
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-swipe-ignore]')) {
        touchStart.current = null
        return
      }
      const touch = e.touches[0]
      touchStart.current = { x: touch.clientX, y: touch.clientY }
    }

    function onTouchEnd(e: TouchEvent) {
      const start = touchStart.current
      touchStart.current = null
      if (!start) return

      const touch = e.changedTouches[0]
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (Math.abs(dx) <= SWIPE_THRESHOLD_PX) return
      if (Math.abs(dx) <= SWIPE_DIRECTION_RATIO * Math.abs(dy)) return

      const currentIndex = tabs.findIndex(tab => pathname.startsWith(tab.path))
      if (currentIndex === -1) return

      const nextIndex = dx < 0 ? currentIndex + 1 : currentIndex - 1
      if (nextIndex < 0 || nextIndex >= tabs.length) return

      navigate(tabs[nextIndex].path)
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [tabs, pathname, navigate])
}
