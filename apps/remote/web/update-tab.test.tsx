import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabNav } from "./src/app/Shell";

for (const layout of ["phone", "desktop"] as const) {
  test(`${layout} directs updates to Settings while Machine remains navigable`, () => {
    const selected: string[] = [];
    let installs = 0;
    const props = { layout, active: "chats" as const, badges: {}, onSelect: (tab: string) => selected.push(tab) };
    const update = { visible: true, busy: false, status: "Finish the update in Android", onClick: () => installs++ };
    const pending = TabNav({ ...props, update });
    const settings = pending.props.children.find((button: any) => button.key === "settings");
    const machine = pending.props.children.find((button: any) => button.key === "machine");
    expect(settings.props["aria-label"]).toBe("Settings");
    expect(settings.props.title).toContain(update.status);
    settings.props.onClick();
    machine.props.onClick();
    expect(installs).toBe(0);
    expect(selected).toEqual(["settings", "machine"]);
    const html = renderToStaticMarkup(createElement(TabNav, { ...props, update: { ...update, busy: true } }));
    expect(html).toContain('aria-label="Machine"');
    expect(html).toContain('tab-update-label">Update</span>');
    expect(html).not.toContain('disabled=""');
    const current = renderToStaticMarkup(createElement(TabNav, { ...props, update: { ...update, visible: false } }));
    expect(current).not.toContain('tab-update-label');
    expect(current).toContain('aria-label="Settings"');
  });
}
