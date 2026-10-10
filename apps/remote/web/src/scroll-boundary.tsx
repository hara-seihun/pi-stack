import { Component, createContext, type ReactNode, type RefObject } from "react";
import { ReadingAnchor, type ReadingSnapshot } from "./scroll-position";

export type ScrollPositionOwner = { active: boolean; scroller: RefObject<HTMLDivElement | null>; anchor: ReadingAnchor };
export const ScrollPositionContext = createContext<ScrollPositionOwner | null>(null);

/** Local row measurements and disclosure updates commit below ConversationView. */
export class ScrollPositionBoundary extends Component<{ owner: ScrollPositionOwner | null; children: ReactNode }> {
  getSnapshotBeforeUpdate(): ReadingSnapshot | null {
    const owner = this.props.owner;
    return owner?.active ? owner.anchor.beforeUpdate(owner.scroller.current) : null;
  }

  componentDidUpdate(_previous: Readonly<{ owner: ScrollPositionOwner | null; children: ReactNode }>, _state: Readonly<{}>, snapshot: ReadingSnapshot | null) {
    const owner = this.props.owner;
    if (owner?.active) owner.anchor.afterUpdate(owner.scroller.current, snapshot);
  }

  render() { return this.props.children; }
}
