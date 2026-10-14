// Grid maths for custom pane layouts (Settings → Pane layouts), kept free of UI imports so it can be
// unit-tested. A cell is a rectangle of unit cells: row r, column c, spanning rs rows and cs columns.

export interface Cell {
  r: number;
  c: number;
  rs: number;
  cs: number;
}

export const unitCells = (rows: number, cols: number): Cell[] => Array.from({ length: rows * cols }, (_, i) => ({ r: Math.floor(i / cols), c: i % cols, rs: 1, cs: 1 }));
export const hits = (a: Cell, r: number, c: number) => r >= a.r && r < a.r + a.rs && c >= a.c && c < a.c + a.cs;
export const overlap = (a: Cell, b: Cell) => a.r < b.r + b.rs && b.r < a.r + a.rs && a.c < b.c + b.cs && b.c < a.c + a.cs;
export const unit = (r: number, c: number): Cell => ({ r, c, rs: 1, cs: 1 });
export const sameCell = (a: Cell, b: Cell) => a.r === b.r && a.c === b.c && a.rs === b.rs && a.cs === b.cs;

/** main first, the rest in reading order */
export function order(cells: Cell[], main: Cell | undefined): Cell[] {
  const m = (main && cells.find((x) => hits(x, main.r, main.c))) ?? cells[0];
  const rest = cells.filter((x) => x !== m).sort((a, b) => a.r - b.r || a.c - b.c);
  return [m, ...rest];
}

/** merge a rectangle into one cell; cells cut by it fall apart into unit cells */
export function merge(cells: Cell[], R: Cell): Cell[] {
  const out: Cell[] = [];
  for (const x of cells) {
    if (!overlap(x, R)) {
      out.push(x);
      continue;
    }
    for (let r = x.r; r < x.r + x.rs; r++) for (let c = x.c; c < x.c + x.cs; c++) if (!hits(R, r, c)) out.push({ r, c, rs: 1, cs: 1 });
  }
  out.push(R);
  return out;
}

/** smallest rectangle holding both cells (a drag from one pane to another, in any direction) */
export function bounds(a: Cell, b: Cell): Cell {
  const r0 = Math.min(a.r, b.r), c0 = Math.min(a.c, b.c);
  const r1 = Math.max(a.r + a.rs, b.r + b.rs), c1 = Math.max(a.c + a.cs, b.c + b.cs);
  return { r: r0, c: c0, rs: r1 - r0, cs: c1 - c0 };
}

/** does every unit cell of a rows × cols grid belong to exactly one cell? */
export function tiles(cells: Cell[], rows: number, cols: number): boolean {
  const n = new Array(rows * cols).fill(0);
  for (const x of cells)
    for (let r = x.r; r < x.r + x.rs; r++)
      for (let c = x.c; c < x.c + x.cs; c++) {
        if (r >= rows || c >= cols) return false;
        n[r * cols + c]++;
      }
  return n.every((v) => v === 1);
}
