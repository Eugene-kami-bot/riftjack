export type ReminderSchedule = { frequency: 'daily' | 'weekly'; time: string; timezone: string; weekday?: number };

export function validSchedule(value: unknown): value is ReminderSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as ReminderSchedule;
  if (Object.keys(s).some(k => !['frequency', 'time', 'timezone', 'weekday'].includes(k)) ||
    !['daily', 'weekly'].includes(s.frequency) || typeof s.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time) ||
    typeof s.timezone !== 'string' || s.timezone.length > 100 ||
    (s.frequency === 'daily' ? s.weekday !== undefined : !Number.isInteger(s.weekday) || s.weekday! < 1 || s.weekday! > 7)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); return true; } catch { return false; }
}

// Calendar recurrence, rather than elapsed 24-hour intervals. On a DST gap skip
// that date; on a repeated clock time use its first occurrence only.
export function nextReminder(schedule: ReminderSchedule, after: number): number {
  const format = new Intl.DateTimeFormat('en', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wall = (stamp: number) => {
    const parts = Object.fromEntries(format.formatToParts(stamp).map(p => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  };
  const local = new Date(wall(after));
  const [hour, minute] = schedule.time.split(':').map(Number);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let day = 0; day < 15; day++) {
    const date = midnight + day * 86_400_000;
    if (schedule.frequency === 'weekly' && (new Date(date).getUTCDay() || 7) !== schedule.weekday) continue;
    const wanted = date + hour * 3_600_000 + minute * 60_000;
    const offsets = new Set([-1, 0, 1].map(d => { const probe = wanted + d * 86_400_000; return wall(probe) - probe; }));
    const candidates = [...offsets].map(offset => wanted - offset).filter(stamp => wall(stamp) === wanted).sort((a, b) => a - b);
    if (candidates.length && candidates[0] > after) return candidates[0];
  }
  throw new Error('Could not find the next reminder occurrence.');
}
