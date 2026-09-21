/**
 * Slack `<!date^ts^template|fallback>` tokens, formatted in the viewer's local timezone.
 * https://api.slack.com/reference/surfaces/formatting#date-formatting
 */
import { differenceInCalendarDays, format as formatDate, formatDistance } from 'date-fns';

const TOKEN_RE =
  /\{(day_divider_pretty|date_num|date_slash|date_long_full|date_long_pretty|date_long|date_pretty|date_short_pretty|date_short|date|time_secs|time|ago)\}/g;

const RELATIVE_DAYS: Record<number, string> = { [-1]: 'yesterday', 0: 'today', 1: 'tomorrow' };

function pretty(d: Date, now: Date, otherwise: string): string {
  return RELATIVE_DAYS[differenceInCalendarDays(d, now)] ?? otherwise;
}

function formatToken(token: string, d: Date, now: Date): string {
  switch (token) {
    case 'date_num':
      return formatDate(d, 'yyyy-MM-dd');
    case 'date_slash':
      return formatDate(d, 'MM/dd/yyyy');
    case 'date':
      return formatDate(d, 'MMMM do, yyyy');
    case 'date_short':
      return formatDate(d, 'MMM d, yyyy');
    case 'date_long':
    case 'date_long_full':
      return formatDate(d, 'EEEE, MMMM do, yyyy');
    case 'date_pretty':
      return pretty(d, now, formatDate(d, 'MMMM do, yyyy'));
    case 'date_short_pretty':
      return pretty(d, now, formatDate(d, 'MMM d, yyyy'));
    case 'date_long_pretty':
      return pretty(d, now, formatDate(d, 'EEEE, MMMM do, yyyy'));
    case 'day_divider_pretty': {
      const rel = pretty(d, now, '');
      if (rel) return rel[0].toUpperCase() + rel.slice(1);
      return formatDate(d, d.getFullYear() === now.getFullYear() ? 'EEEE, MMMM do' : 'EEEE, MMMM do, yyyy');
    }
    case 'time':
      return formatDate(d, 'h:mm a');
    case 'time_secs':
      return formatDate(d, 'h:mm:ss a');
    case 'ago':
      return formatDistance(d, now, { addSuffix: true });
    default:
      return token;
  }
}

/**
 * Expands a Slack date template. Unknown `{tokens}` and other text are kept as written.
 * Returns '' for an invalid timestamp.
 */
export function formatSlackDate(epochSeconds: number, template: string, now: Date = new Date()): string {
  const d = new Date(epochSeconds * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return template.replace(TOKEN_RE, (_, token: string) => formatToken(token, d, now));
}

/** Tooltip for a date reference: the formatted template, or a full date when it's empty. */
export function slackDateTitle(epochSeconds: number, template: string, now: Date = new Date()): string {
  const formatted = formatSlackDate(epochSeconds, template, now).trim();
  if (formatted) return formatted;
  const d = new Date(epochSeconds * 1000);
  return Number.isFinite(d.getTime()) ? formatDate(d, "EEEE, MMMM do, yyyy 'at' h:mm a") : '';
}
