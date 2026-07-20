import { describe, expect, it } from "vitest";
import { anchorLabelFor, anchorRefFor, componentTitle } from "./mockupLabels";
import type { MockupComponent, MockupPage } from "../types";

describe("componentTitle", () => {
  it("uses props.title for topbar/grid/form/detail", () => {
    expect(componentTitle({ id: "top", type: "topbar", props: { title: "Expenses Portal" } })).toBe(
      "Expenses Portal",
    );
    expect(componentTitle({ id: "g1", type: "grid", props: { title: "Requests", columns: [], rows: [] } })).toBe(
      "Requests",
    );
    expect(componentTitle({ id: "g2", type: "grid", props: { columns: [], rows: [] } })).toBe("Table");
  });

  it("builds breadcrumb and tabs by joining the labels", () => {
    const bc: MockupComponent = {
      id: "bc1",
      type: "breadcrumb",
      props: { items: [{ label: "Requests", page: "list" }, { label: "Details" }] },
    };
    expect(componentTitle(bc)).toBe("Requests > Details");

    const tabs: MockupComponent = {
      id: "t1",
      type: "tabs",
      props: { tabs: [{ label: "Details", components: [] }, { label: "Attachments", components: [] }] },
    };
    expect(componentTitle(tabs)).toBe("Details / Attachments");
  });

  it("falls back to the component id for unknown types", () => {
    expect(componentTitle({ id: "mystery1", type: "chart-3d", props: {} })).toBe("mystery1");
  });

  it("covers the types added by mockup-lib (section/filters/legend/statusbar/wizard/segmented/tiles)", () => {
    expect(componentTitle({ id: "s1", type: "section", props: { components: [] } })).toBe("Section");
    expect(componentTitle({ id: "s2", type: "section", props: { title: "Data", components: [] } })).toBe("Data");
    expect(componentTitle({ id: "f1", type: "filters", props: { fields: [] } })).toBe("Filters");
    expect(componentTitle({ id: "l1", type: "legend", props: { items: [] } })).toBe("Legend");
    expect(componentTitle({ id: "sb1", type: "statusbar", props: { label: "Import complete" } })).toBe("Import complete");
    expect(componentTitle({ id: "w1", type: "wizard-steps", props: { steps: ["Data", "Confirm"], current: 1 } })).toBe(
      "Data > Confirm",
    );
    expect(componentTitle({ id: "sp1", type: "state-progress", props: { states: [], current: 1 } })).toBe(
      "Progress",
    );
    expect(
      componentTitle({ id: "sg1", type: "segmented", props: { options: [{ label: "Activity" }, { label: "Account" }] } }),
    ).toBe("Activity / Account");
    expect(componentTitle({ id: "ti1", type: "tiles", props: { items: [{ label: "A", target: "a" }] } })).toBe(
      "Tiles (1)",
    );
  });

  it("covers 'sidebar-nav' (the vertical menu inside a dialog)", () => {
    expect(
      componentTitle({
        id: "sn1",
        type: "sidebar-nav",
        props: { title: "CASE: 1801", sections: [{ label: "Summary", components: [] }, { label: "Documents", components: [] }] },
      }),
    ).toBe("Summary / Documents");
    expect(componentTitle({ id: "sn2", type: "sidebar-nav", props: { title: "CASE: 1801", sections: [] } })).toBe(
      "Section menu",
    );
  });
});

describe("anchorRefFor / anchorLabelFor", () => {
  const page: MockupPage = { id: "list", name: "Request List", components: [] };
  const comp: MockupComponent = { id: "grid1", type: "grid", props: { title: "Expense Requests" } };

  it("builds the ref as pageId.componentId", () => {
    expect(anchorRefFor(page.id, comp.id)).toBe("list.grid1");
  });

  it("builds the descriptive page/type/title label", () => {
    expect(anchorLabelFor(page, comp)).toBe("page Request List — grid: Expense Requests");
  });
});
