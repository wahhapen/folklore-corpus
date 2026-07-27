const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoCalendarDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
  );
}

export function serializeReviewedOn(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (isIsoCalendarDate(value)) {
    return value;
  }
  throw new TypeError(`Invalid rights reviewed_on value: ${String(value)}`);
}
