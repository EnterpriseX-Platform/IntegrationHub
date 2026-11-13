// Scheduler parameter resolution utility
// Resolves template variables in scheduler parameters
// Supports (date/time):
//   {{date}} {{year}} {{month}} {{day}} {{timestamp}} {{datetime}} {{yearMonth}}
//   with offsets: {{date+1}}, {{year-1}}, {{month+2}}, {{day-7}}, {{year+543}}
// Also supports (FileWriteExecutor-style for parity with filename placeholders):
//   {{YYYY}} {{YY}} {{MM}} {{DD}} {{HH}} {{mm}} {{ss}}
//   {{YYYYMMDD}} {{HHmm}} {{HHmmss}}
//   {{BYYYY}} {{BYY}} {{buddhistYear}}

export interface ScheduleParameter {
  name: string;
  value: string;
  description?: string;
}

const VALID_VARS = ['date', 'year', 'month', 'day', 'timestamp', 'datetime', 'yearMonth'];

/**
 * Resolve filename-style placeholders ({{YYYYMMDD}}, {{HHmm}}, {{BYY}} …)
 * in a single string. Used both by scheduler defaults and flow variable defaults
 * so the two stay in sync with the placeholders that FileWriteExecutor recognizes.
 */
export function resolveDateTimePlaceholders(
  input: string,
  timezone: string = 'Asia/Bangkok',
  now: Date = new Date()
): string {
  if (typeof input !== 'string' || !input.includes('{{')) return input;

  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    now.toLocaleDateString('en-CA', { timeZone: timezone, ...opts });
  const ftime = (opts: Intl.DateTimeFormatOptions) =>
    now.toLocaleTimeString('en-GB', { timeZone: timezone, hour12: false, ...opts });

  const YYYY = fmt({ year: 'numeric' });
  const MM = fmt({ month: '2-digit' });
  const DD = fmt({ day: '2-digit' });
  const HH = ftime({ hour: '2-digit' });
  const mm = ftime({ minute: '2-digit' });
  const ss = ftime({ second: '2-digit' });
  const BYYYY = String(parseInt(YYYY, 10) + 543);

  const repl: Record<string, string> = {
    YYYYMMDD: `${YYYY}${MM}${DD}`,
    HHmmss: `${HH}${mm}${ss}`,
    HHmm: `${HH}${mm}`,
    YYYY,
    YY: YYYY.slice(-2),
    MM, DD, HH, mm, ss,
    BYYYY,
    BYY: BYYYY.slice(-2),
    buddhistYear: BYYYY,
  };

  return input.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(repl, name) ? repl[name] : match
  );
}

function formatDate(date: Date, format: string, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone };

  switch (format) {
    case 'date':
      return date.toLocaleDateString('en-CA', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' });
    case 'year':
      return date.toLocaleDateString('en-CA', { ...options, year: 'numeric' });
    case 'month':
      return date.toLocaleDateString('en-CA', { ...options, month: '2-digit' });
    case 'day':
      return date.toLocaleDateString('en-CA', { ...options, day: '2-digit' });
    case 'timestamp':
      return Math.floor(date.getTime() / 1000).toString();
    case 'datetime':
      return date.toISOString();
    case 'yearMonth':
      return date.toLocaleDateString('en-CA', { ...options, year: 'numeric', month: '2-digit' }).replace('-', '');
    default:
      return date.toISOString();
  }
}

function calculateWithOffset(baseDate: Date, type: string, offset: number): Date {
  const newDate = new Date(baseDate);
  switch (type) {
    case 'date':
    case 'day':
      newDate.setDate(newDate.getDate() + offset);
      break;
    case 'month':
      newDate.setMonth(newDate.getMonth() + offset);
      break;
    case 'year':
      newDate.setFullYear(newDate.getFullYear() + offset);
      break;
    case 'timestamp':
      return new Date(newDate.getTime() + offset * 1000);
  }
  return newDate;
}

/**
 * Resolve parameter values with template variables.
 * Returns an object mapping parameter name to resolved value (auto-typed if numeric/boolean).
 */
export function resolveScheduleParameters(
  parameters: ScheduleParameter[] | undefined | null,
  timezone: string = 'Asia/Bangkok',
  now: Date = new Date()
): Record<string, any> {
  const result: Record<string, any> = {};
  if (!parameters || !Array.isArray(parameters)) return result;

  for (const param of parameters) {
    if (!param.name) continue;

    let value = param.value ?? '';

    // First, resolve any FileWriteExecutor-style placeholders ({{YYYYMMDD}}, {{BYY}}, etc.)
    // so users can mix them with the offset-style ones in the same parameter value.
    value = resolveDateTimePlaceholders(String(value), timezone, now);

    value = String(value).replace(/\{\{(\w+)([+-]?\d+)\}\}/g, (match, varName, offsetStr) => {
      // Special case: year+543 (Buddhist year)
      if (varName === 'year' && offsetStr === '+543') {
        const christianYear = parseInt(formatDate(now, 'year', timezone), 10);
        return String(christianYear + 543);
      }

      if (!VALID_VARS.includes(varName)) {
        return match;
      }

      const offset = offsetStr ? parseInt(offsetStr, 10) : undefined;

      if (varName === 'timestamp' && offset !== undefined) {
        return Math.floor((now.getTime() + offset * 1000) / 1000).toString();
      }

      const date = offset !== undefined ? calculateWithOffset(now, varName, offset) : now;
      return formatDate(date, varName, timezone);
    });

    // Auto-typing
    if (/^-?\d+$/.test(value)) {
      result[param.name] = parseInt(value, 10);
    } else if (/^-?\d+\.\d+$/.test(value)) {
      result[param.name] = parseFloat(value);
    } else if (value === 'true' || value === 'false') {
      result[param.name] = value === 'true';
    } else {
      result[param.name] = value;
    }
  }

  return result;
}

/**
 * Parse parameters JSON string safely.
 */
export function parseParametersJson(json: string | null | undefined): ScheduleParameter[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
