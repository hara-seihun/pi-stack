import type { PhoneSetupStep, PhoneStatus } from "./native";

export const phoneGrants: readonly { step: PhoneSetupStep; label: string; help: string }[] = [
  { step: "accessibility", label: "App control and screenshots", help: "Enable Kenan Phone control, then return to Kenan." },
  { step: "notificationAccess", label: "Notification access", help: "Allow Kenan to read notifications and use their actions and replies." },
  { step: "notifications", label: "Show notifications", help: "Allow the ongoing phone-control notification." },
  { step: "sms", label: "SMS", help: "Allow reading and sending SMS. Setup never sends a message." },
  { step: "contacts", label: "Contacts", help: "Allow reading and updating contacts." },
  { step: "calendar", label: "Calendar", help: "Allow reading and updating calendar events." },
  { step: "callLog", label: "Call history", help: "Allow reading call history." },
  { step: "phone", label: "Calls", help: "Allow placing calls. Setup never places a call." },
  { step: "location", label: "Location", help: "Allow precise location access for Kenan." },
  { step: "backgroundLocation", label: "Background location", help: "Choose Permissions → Location → Allow all the time, then return to Kenan." },
  { step: "allFiles", label: "Shared files", help: "Allow access to shared files. Other apps’ private storage stays protected." },
  { step: "usage", label: "App usage", help: "Allow usage access for Kenan." },
  { step: "overlay", label: "Display over other apps", help: "Allow Kenan to display over other apps. Android may ask you to select Kenan first." },
  { step: "camera", label: "Camera", help: "Allow camera for supported foreground features, not unattended capture." },
  { step: "microphone", label: "Microphone", help: "Allow microphone for supported recording features, not unattended capture." },
  { step: "writeSettings", label: "System settings", help: "Allow modifying supported system settings." },
  { step: "battery", label: "Background operation", help: "Allow unrestricted battery use to keep phone control connected." },
  { step: "deviceAdmin", label: "Screen locking", help: "Activate device administrator access for screen locking. This does not reset or enroll your phone." },
  { step: "installPackages", label: "App updates", help: "Allow app installs from Kenan so it can offer Android updates. Setup does not install an app." },
];

export interface PhoneGrantDriver {
  status(): Promise<PhoneStatus>;
  request(step: PhoneSetupStep): Promise<unknown>;
  active(): boolean;
}

export type PhoneGrantResult =
  | { state: "granted" | "denied"; status: PhoneStatus }
  | { state: "cancelled" }
  | { state: "error"; message: string };

export async function requestPhoneGrant(driver: PhoneGrantDriver, step: PhoneSetupStep): Promise<PhoneGrantResult> {
  try {
    if (!driver.active()) return { state: "cancelled" };
    const before = await driver.status();
    if (!driver.active()) return { state: "cancelled" };
    if (!phoneGrants.some(grant => grant.step === step)) return { state: "error", message: "Unknown phone-control grant" };
    if (typeof before.capabilities[step] !== "boolean") return { state: "error", message: "This grant is unavailable in this Android shell" };
    if (before.capabilities[step] === true) return { state: "granted", status: before };
    if (step === "backgroundLocation" && before.capabilities.location !== true) return { state: "error", message: "Location must be granted first" };
    await driver.request(step);
    if (!driver.active()) return { state: "cancelled" };
    const status = await driver.status();
    if (!driver.active()) return { state: "cancelled" };
    if (typeof status.capabilities[step] !== "boolean") return { state: "error", message: "Android did not report the resulting grant" };
    return { state: status.capabilities[step] === true ? "granted" : "denied", status };
  } catch (failure) {
    return driver.active() ? { state: "error", message: failure instanceof Error ? failure.message : String(failure) } : { state: "cancelled" };
  }
}
