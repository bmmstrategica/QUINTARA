/**
 * CSV for staff exports. Every cell is quoted, and a cell starting with = + - @ (or a tab or carriage return) gets a
 * leading apostrophe, so a spreadsheet never runs it as a formula (CSV injection).
 */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

export function toCsv(head: string[], rows: unknown[][]): string {
  return [head.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
