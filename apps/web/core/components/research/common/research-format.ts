/**
 * Format a timestamp as a stable research date-time string.
 *
 * Args:
 *   value: ISO timestamp, Date, or empty value from a backend response.
 *   locale: Current interface locale used by Intl formatting.
 *
 * Returns:
 *   A locale-aware date-time string, or an empty string for invalid input.
 */
export function formatResearchDateTime(value: string | Date | null | undefined, locale?: string): string {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale || undefined);
}

/**
 * Format a timestamp as a stable research date string.
 *
 * Args:
 *   value: ISO timestamp, Date, or empty value from a backend response.
 *   locale: Current interface locale used by Intl formatting.
 *
 * Returns:
 *   A locale-aware date string, or an empty string for invalid input.
 */
export function formatResearchDate(value: string | Date | null | undefined, locale?: string): string {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale || undefined);
}

/**
 * Format a read receipt timestamp with minute-level precision.
 *
 * Args:
 *   value: ISO timestamp returned by the backend, or an empty value.
 *   locale: Current interface locale used by Intl formatting.
 *
 * Returns:
 *   A date and clock-time string without seconds, or an empty string.
 */
export function formatResearchReadAt(value: string | Date | null | undefined, locale?: string): string {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale || undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a clock time for page metadata such as the last refresh moment.
 *
 * Args:
 *   value: Date captured by the page, or null before the first load.
 *   locale: Current interface locale used by Intl formatting.
 *
 * Returns:
 *   A locale-aware time string, or an empty string for invalid input.
 */
export function formatResearchTime(value: Date | null | undefined, locale?: string): string {
  if (!value || Number.isNaN(value.getTime())) return "";
  return value.toLocaleTimeString(locale || undefined);
}
