import { appPath } from "./app-path";

export function iconUrl(icon: string) {
  return /^(data:|https?:|\/\/)/.test(icon) ? icon : appPath(icon.startsWith("/") ? icon : `${encodeURIComponent(icon)}.svg`);
}

export function ChatIcon({ icon }: { icon: string }) {
  return /\p{Extended_Pictographic}/u.test(icon) ? <span aria-hidden="true">{icon}</span> : <img className="thread-provider" src={iconUrl(icon)} alt="" />;
}

/** A contact's photo in place of a service glyph; falls back to the glyph when the picture cannot load. */
export function ChatAvatar({ avatar, icon }: { avatar?: string; icon: string }) {
  return avatar
    ? <img className="chat-avatar" src={avatar} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.replaceWith(Object.assign(document.createElement("img"), { className: "thread-provider", src: iconUrl(icon), alt: "" })); }} />
    : <ChatIcon icon={icon} />;
}
