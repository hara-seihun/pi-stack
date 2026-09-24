import { useId } from "react";
import { appPath } from "./app-path";

export function iconUrl(icon: string) {
  return /^(data:|https?:|\/\/)/.test(icon) ? icon : appPath(icon.startsWith("/") ? icon : `${encodeURIComponent(icon)}.svg`);
}

export function ChatIcon({ icon, color }: { icon: string; color?: string }) {
  const tintId = useId();
  const glyph = /\p{Extended_Pictographic}/u.test(icon) ? <span aria-hidden="true">{icon}</span> : <img className="thread-provider" src={iconUrl(icon)} alt="" />;
  if (!color) return glyph;
  return <>
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}><defs><filter id={tintId} colorInterpolationFilters="sRGB"><feFlood floodColor={color} /><feComposite in2="SourceAlpha" operator="in" /></filter></defs></svg>
    <span style={{ display: "grid", placeItems: "center", filter: `url(#${tintId})` }}>{glyph}</span>
  </>;
}

/** A contact's photo in place of a service glyph; falls back to the glyph when the picture cannot load. */
export function ChatAvatar({ avatar, icon, color }: { avatar?: string; icon: string; color?: string }) {
  return avatar
    ? <img className="chat-avatar" src={avatar} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.replaceWith(Object.assign(document.createElement("img"), { className: "thread-provider", src: iconUrl(icon), alt: "" })); }} />
    : <ChatIcon icon={icon} color={color} />;
}
