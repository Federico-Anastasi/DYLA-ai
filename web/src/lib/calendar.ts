// Working calendar. No external dependency: native Date plus day arithmetic, in line
// with the rest of the stack.
//
// Dates travel as "YYYY-MM-DD" strings (same format as the schema, and sortable
// lexicographically). Date objects are built in UTC so the local timezone cannot shift
// the day by one during conversions.

export type ISODate = string; // "YYYY-MM-DD"

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function fromISO(s: ISODate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = fromISO(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

/** Saturday or Sunday. */
export function isWeekend(s: ISODate): boolean {
  const d = fromISO(s).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * The Monday a project should start from: `s` itself when it already is a Monday,
 * otherwise the next one.
 *
 * A project always starts at the beginning of a week, so every band of the timeline is
 * a full Monday-to-Friday week and there are no half weeks at the front.
 */
export function mondayOf(s: ISODate): ISODate {
  let d = s;
  while (fromISO(d).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

/** Easter Sunday for a given year — Meeus/Jones/Butcher algorithm. */
export function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toISO(new Date(Date.UTC(year, month - 1, day)));
}

/** Public holidays for the year, including the movable Easter Monday. */
export function publicHolidays(year: number): { date: ISODate; name: string }[] {
  const fixed: [string, string][] = [
    ["01-01", "New Year's Day"],
    ["01-06", "Epiphany"],
    ["04-25", "Liberation Day"],
    ["05-01", "Labour Day"],
    ["06-02", "Republic Day"],
    ["08-15", "Mid-August Holiday"],
    ["11-01", "All Saints' Day"],
    ["12-08", "Immaculate Conception"],
    ["12-25", "Christmas Day"],
    ["12-26", "Boxing Day"],
  ];
  return [
    ...fixed.map(([md, name]) => ({ date: `${year}-${md}`, name })),
    { date: addDays(easterSunday(year), 1), name: "Easter Monday" },
  ];
}

/**
 * The project working calendar: it can tell whether a day is workable, either for the
 * whole team or for a single developer.
 *
 * Public holidays are generated on demand for each year that gets asked about and then
 * cached, so a project spanning several years never has to declare them.
 */
export class Calendar {
  private extraHolidays: Set<ISODate>;
  private publicByYear = new Map<number, Set<ISODate>>();
  private leave: Map<string, { from: ISODate; to: ISODate }[]>;

  constructor(
    extraHolidays: { date: ISODate }[] = [],
    team: { id: string; leave?: { from: ISODate; to: ISODate }[] }[] = [],
  ) {
    this.extraHolidays = new Set(extraHolidays.map((h) => h.date));
    this.leave = new Map(team.map((d) => [d.id, d.leave ?? []]));
  }

  private forYear(year: number): Set<ISODate> {
    let s = this.publicByYear.get(year);
    if (!s) {
      s = new Set(publicHolidays(year).map((h) => h.date));
      this.publicByYear.set(year, s);
    }
    return s;
  }

  /** A day nobody works: weekend, public holiday or declared extra holiday. */
  isHoliday(d: ISODate): boolean {
    if (isWeekend(d)) return true;
    if (this.extraHolidays.has(d)) return true;
    return this.forYear(Number(d.slice(0, 4))).has(d);
  }

  /** The developer is on leave on this day (both ends included). */
  isOnLeave(dev: string, d: ISODate): boolean {
    return (this.leave.get(dev) ?? []).some((p) => d >= p.from && d <= p.to);
  }

  /** The developer can work on this day. */
  isWorkable(dev: string, d: ISODate): boolean {
    return !this.isHoliday(d) && !this.isOnLeave(dev, d);
  }

  /**
   * First day from `d` onwards (inclusive) on which `dev` can work.
   *
   * The 3660-iteration cap (~10 years) prevents an infinite loop if the declared leave
   * were to cover an open-ended or nonsensical range: a wildly out-of-scale date is
   * better than a frozen browser.
   */
  nextWorkable(dev: string, d: ISODate): ISODate {
    let cur = d;
    for (let i = 0; i < 3660; i++) {
      if (this.isWorkable(dev, cur)) return cur;
      cur = addDays(cur, 1);
    }
    return cur;
  }
}
