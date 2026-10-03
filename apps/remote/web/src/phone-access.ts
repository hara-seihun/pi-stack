import type { PhoneSetupStep, PhoneStatus } from "./native";

export const phoneGrants: readonly { step: PhoneSetupStep; label: string; help: string }[] = [
  { step: "accessibility", label: "App control and screenshots", help: "Enable Kenan Phone control, then return to Kenan. Pi Stack Write is a separate service." },
  { step: "notificationAccess", label: "Notification access", help: "Allow Kenan to read notifications and use their actions and replies." },
  { step: "notifications", label: "Show notifications", help: "Allow the ongoing phone-control notification." },
  { step: "sms", label: "SMS", help: "Allow reading and sending SMS. Setup never sends a message." },
  { step: "contacts", label: "Contacts", help: "Allow reading and updating contacts." },
  { step: "calendar", label: "Calendar", help: "Allow reading and updating calendar events." },
  { step: "callLog", label: "Call history", help: "Allow reading call history." },
  { step: "phone", label: "Calls", help: "Allow placing calls. Setup never places a call." },
  { step: "location", label: "Location", help: "Allow location access; approximate location is enough." },
  { step: "backgroundLocation", label: "Background location", help: "Choose Permissions → Location → Allow all the time, then return to Kenan." },
  { step: "allFiles", label: "Shared files", help: "Allow access to shared files. Other apps’ private storage stays protected." },
  { step: "usage", label: "App usage", help: "Allow usage access for Kenan." },
  { step: "overlay", label: "Display over other apps", help: "Allow Kenan to display over other apps. Android may ask you to select Kenan first." },
  { step: "camera", label: "Camera", help: "Allow camera for supported foreground features, not unattended capture." },
  { step: "microphone", label: "Microphone", help: "Allow microphone for supported recording features, not unattended capture." },
  { step: "writeSettings", label: "System settings", help: "Allow modifying supported system settings." },
  { step: "battery", label: "Background operation", help: "Allow unrestricted battery use to keep phone control connected." },
  { step: "deviceAdmin", label: "Screen locking", help: "Optional device administrator access allows remote screen locking, not Device Owner powers." },
];

export interface PhoneAccessDriver {
  status(): Promise<PhoneStatus>;
  request(step: PhoneSetupStep): Promise<unknown>;
  active(): boolean;
  progress(step: PhoneSetupStep, index: number): void;
}

/** A settings request settles only after Android returns, never merely after opening it. */
export async function requestPhoneAccess(driver: PhoneAccessDriver) {
  const failures: Partial<Record<PhoneSetupStep, string>> = {};
  let status = await driver.status();
  for (const [index, grant] of phoneGrants.entries()) {
    if (!driver.active()) return { status, failures, completed: false };
    if (status.capabilities[grant.step] === true) continue;
    if (grant.step === "backgroundLocation" && status.capabilities.location !== true) {
      failures[grant.step] = "Location must be granted first";
      continue;
    }
    driver.progress(grant.step, index);
    try { await driver.request(grant.step); }
    catch (failure) { failures[grant.step] = String(failure); }
    if (!driver.active()) return { status, failures, completed: false };
    status = await driver.status();
  }
  return { status, failures, completed: driver.active() };
}
