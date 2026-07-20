import { supabase } from './supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i)
  return output
}

export function isIOSDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)
}

// iOS unterstützt Web Push nur für zum Home-Bildschirm hinzugefügte PWAs,
// nie im normalen Safari-Tab — display-mode:standalone erkennt genau das.
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

export type PushSupport = 'unsupported' | 'ios-needs-install' | 'ready'

export function getPushSupport(): PushSupport {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !VAPID_PUBLIC_KEY) return 'unsupported'
  if (isIOSDevice() && !isStandalone()) return 'ios-needs-install'
  return 'ready'
}

async function saveSubscription(athleteId: string, sub: PushSubscription) {
  const json = sub.toJSON()
  await supabase.from('push_subscriptions').upsert(
    {
      athlete_id: athleteId,
      endpoint: json.endpoint!,
      p256dh: json.keys!.p256dh,
      auth: json.keys!.auth,
    },
    { onConflict: 'endpoint' },
  )
}

export async function enablePushNotifications(athleteId: string): Promise<'granted' | 'denied' | 'unsupported'> {
  if (getPushSupport() !== 'ready') return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const registration = await navigator.serviceWorker.ready
  let sub = await registration.pushManager.getSubscription()
  if (!sub) {
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
    })
  }
  await saveSubscription(athleteId, sub)
  return 'granted'
}

export async function disablePushNotifications(athleteId: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.ready
  const sub = await registration.pushManager.getSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint).eq('athlete_id', athleteId)
  await sub.unsubscribe()
}

/**
 * Bekanntes iOS-Verhalten: Push-Subscriptions können nach längerer
 * Inaktivität serverseitig ungültig werden, ohne dass Permission-State
 * oder App davon etwas mitbekommen. Bei jedem App-Start still prüfen und
 * bei Bedarf neu registrieren/speichern — kein UI-Feedback nötig.
 */
export async function syncPushSubscription(athleteId: string): Promise<void> {
  if (getPushSupport() !== 'ready') return
  if (Notification.permission !== 'granted') return

  try {
    const registration = await navigator.serviceWorker.ready
    let sub = await registration.pushManager.getSubscription()
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
      })
    }
    await saveSubscription(athleteId, sub)
  } catch {
    // stiller Fehlschlag — nächster App-Start versucht es erneut
  }
}
