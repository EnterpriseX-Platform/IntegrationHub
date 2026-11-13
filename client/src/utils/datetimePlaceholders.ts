/**
 * Resolve {{TOKEN}} placeholders in a default-value string into actual values
 * computed from "now" — mirrors the server-side resolver in
 * server/src/lib/scheduler-params.ts so the Run Flow modal can pre-fill
 * the displayed default with a real value (e.g. "68") instead of the raw
 * placeholder text (e.g. "{{BYY}}").
 *
 * Supported tokens (timezone-aware, default Asia/Bangkok):
 *   {{YYYY}} / {{YY}}             — AD year, 4- or 2-digit
 *   {{MM}} / {{DD}}               — month, day (zero-padded 2-digit)
 *   {{HH}} / {{mm}} / {{ss}}      — hour, minute, second
 *   {{YYYYMMDD}} {{HHmm}} {{HHmmss}}
 *   {{BYYYY}} / {{BYY}}           — Buddhist Era year (AD+543), 4- or 2-digit
 *   {{buddhistYear}}              — alias of {{BYYYY}}
 *
 * Returns the input unchanged if there are no placeholders, so plain text
 * defaults pass through.
 */
export function resolveDateTimePlaceholders(
  input: string,
  timezone: string = 'Asia/Bangkok',
  now: Date = new Date()
): string {
  if (typeof input !== 'string' || input.indexOf('{{') === -1) return input;

  // Format date parts in the target timezone via Intl.DateTimeFormat
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const YYYY = parts.year;
  const YY = YYYY.slice(-2);
  const MM = parts.month;
  const DD = parts.day;
  let HH = parts.hour;
  if (HH === '24') HH = '00';
  const mm = parts.minute;
  const ss = parts.second;
  const BYYYY = String(parseInt(YYYY, 10) + 543);
  const BYY = BYYYY.slice(-2);

  const table: Record<string, string> = {
    YYYYMMDD: YYYY + MM + DD,
    HHmmss: HH + mm + ss,
    HHmm: HH + mm,
    YYYY, YY, MM, DD, HH, mm, ss,
    BYYYY, BYY,
    buddhistYear: BYYYY,
  };

  return input.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_, key: string) => {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : `{{${key}}}`;
  });
}
