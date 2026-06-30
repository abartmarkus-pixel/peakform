// ISO 8601: Woche beginnt Montag, Sonntag ist letzter Tag

export function getISOMonday(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=So, 1=Mo, ..., 6=Sa
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

export function getISOSunday(monday: Date): Date {
  const d = new Date(monday)
  d.setDate(d.getDate() + 6)
  d.setHours(23, 59, 59, 999)
  return d
}

export function formatWeekRange(monday: Date): string {
  const sunday = getISOSunday(monday)
  const fmt = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.`
  const year = sunday.getFullYear()
  return `${fmt(monday)} – ${fmt(sunday)}${year}`
}
