import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabNav } from "./src/app/Shell";

for (const layout of ["phone", "desktop"] as const) {
  test(`${layout} replaces the entire Machine action with update and restores navigation when current`, () => {
    const selected: string[] = [];
    let installs = 0;
    const props = { layout, active: "chats" as const, badges: {}, onSelect: (tab: string) => selected.push(tab) };
    const update = { visible: true, busy: false, status: "Finish the update in Android", onClick: () => installs++ };
    const pending = TabNav({ ...props, update });
    const machine = pending.props.children.at(-1);
    expect(machine.props["aria-label"]).toBe("Update");
    machine.props.onClick();
    expect(installs).toBe(1);
    expect(selected).toEqual([]);
    const html = renderToStaticMarkup(createElement(TabNav, { ...props, update: { ...update, busy: true } }));
    expect(html).toContain('aria-label="Update" aria-busy="true" disabled=""');
    expect(html).not.toContain('aria-label="Machine"');
    expect(html).toContain('tab-update-label">Update</span>');
    const current = TabNav({ ...props, update: { ...update, visible: false } });
    current.props.children.at(-1).props.onClick();
    expect(selected).toEqual(["machine"]);
    expect(current.props.children.at(-1).props["aria-label"]).toBe("Machine");
  });
}
