// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * `rtdbctl` output helpers (byte formatting / table rendering / JSON)
 *
 * The CLI prints "key: value" lines plus an optional table by default, and switches to a single JSON document
 * when `--json` is set; every command emits the same underlying record either way, so scripts can rely on
 * `--json` while humans keep the compact form.
 */

/** IEC byte formatting (e.g. `209715200` -> `200.0 MiB`) */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${bytes} B`;
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Decimal number with thousands separators */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Millisecond epoch -> ISO-8601 local-zone rendering (`-` for non-finite input) */
export function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return '-';
  return new Date(timestampMs).toISOString();
}

/**
 * Render a UTF-8 aligned table (CJK and ASCII widths are mixed; the caller supplies already-measured widths)
 *
 * Rows are padded by column display width using `stringWidth` so that a terminal keeps the columns aligned.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, columnIndex) => {
    let width = stringWidth(header);
    for (const row of rows) {
      const cell = row[columnIndex] ?? '';
      const cellWidth = stringWidth(cell);
      if (cellWidth > width) width = cellWidth;
    }
    return width;
  });

  const lines: string[] = [formatRow(headers, widths)];
  lines.push(widths.map((width) => '-'.repeat(width)).join('-+-'));
  for (const row of rows) lines.push(formatRow(row, widths));
  return lines;
}

function formatRow(cells: readonly string[], widths: readonly number[]): string {
  return widths
    .map((width, columnIndex) => {
      const cell = cells[columnIndex] ?? '';
      return cell + ' '.repeat(Math.max(0, width - stringWidth(cell)));
    })
    .join(' | ')
    .trimEnd();
}

/** Display width: treat East Asian wide characters (CJK / full-width forms) as two columns */
function stringWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += isWideCharacter(character) ? 2 : 1;
  }
  return width;
}

function isWideCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}
