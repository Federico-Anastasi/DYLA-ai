import { describe, expect, it } from "vitest";
import { Calendar, addDays, publicHolidays, isWeekend, mondayOf, easterSunday } from "./calendar";

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("handles leap years", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("does not slip by a day because of the timezone", () => {
    // With a local Date instead of UTC, this test fails in every timezone east of Greenwich.
    expect(addDays("2026-07-20", 0)).toBe("2026-07-20");
  });
});

describe("isWeekend", () => {
  it("recognises Saturday and Sunday", () => {
    expect(isWeekend("2026-07-18")).toBe(true); // Saturday
    expect(isWeekend("2026-07-19")).toBe(true); // Sunday
    expect(isWeekend("2026-07-20")).toBe(false); // Monday
  });
});

describe("mondayOf", () => {
  it("leaves a Monday untouched", () => {
    expect(mondayOf("2026-07-20")).toBe("2026-07-20");
  });

  it("pushes a mid-week date to the following Monday", () => {
    expect(mondayOf("2026-07-21")).toBe("2026-07-27"); // Tuesday
    expect(mondayOf("2026-07-24")).toBe("2026-07-27"); // Friday
    expect(mondayOf("2026-07-26")).toBe("2026-07-27"); // Sunday
  });

  it("crosses the month boundary", () => {
    expect(mondayOf("2026-09-30")).toBe("2026-10-05"); // Wednesday 30 Sep
  });
});

describe("easterSunday", () => {
  it("computes known Easter Sundays", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2024)).toBe("2024-03-31");
  });
});

describe("publicHolidays", () => {
  it("includes the 10 fixed dates plus Easter Monday", () => {
    const h = publicHolidays(2026);
    expect(h).toHaveLength(11);
    expect(h.map((x) => x.date)).toContain("2026-04-06"); // Easter Monday
    expect(h.map((x) => x.date)).toContain("2026-08-15");
  });
});

describe("Calendar", () => {
  it("treats weekends and public holidays as non-working", () => {
    const cal = new Calendar();
    expect(cal.isHoliday("2026-08-15")).toBe(true); // Mid-August Holiday
    expect(cal.isHoliday("2026-04-06")).toBe(true); // Easter Monday
    expect(cal.isHoliday("2026-07-20")).toBe(false); // an ordinary Monday
  });

  it("accepts extra holidays declared by hand", () => {
    const cal = new Calendar([{ date: "2026-07-20" }]);
    expect(cal.isHoliday("2026-07-20")).toBe(true);
  });

  it("covers any year without having to declare it", () => {
    const cal = new Calendar();
    expect(cal.isHoliday("2027-12-25")).toBe(true);
    expect(cal.isHoliday("2029-04-02")).toBe(true); // Easter Monday 2029
  });

  it("keeps leave per developer, both ends included", () => {
    const cal = new Calendar([], [
      { id: "ada", leave: [{ from: "2026-07-20", to: "2026-07-24" }] },
      { id: "bob" },
    ]);
    expect(cal.isOnLeave("ada", "2026-07-20")).toBe(true);
    expect(cal.isOnLeave("ada", "2026-07-24")).toBe(true);
    expect(cal.isOnLeave("ada", "2026-07-27")).toBe(false);
    expect(cal.isOnLeave("bob", "2026-07-20")).toBe(false);
  });

  it("skips leave and weekends when looking for the next workable day", () => {
    const cal = new Calendar([], [
      { id: "ada", leave: [{ from: "2026-07-20", to: "2026-07-24" }] },
    ]);
    // On leave from Monday 20 through Friday 24, then the weekend: work resumes Monday 27.
    expect(cal.nextWorkable("ada", "2026-07-20")).toBe("2026-07-27");
  });

  it("does not loop forever on leave with no plausible end", () => {
    const cal = new Calendar([], [
      { id: "ada", leave: [{ from: "2026-01-01", to: "2099-12-31" }] },
    ]);
    // Returns an out-of-scale date instead of freezing the browser.
    expect(cal.nextWorkable("ada", "2026-07-20") > "2036-01-01").toBe(true);
  });
});
