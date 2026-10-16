import type { PhoneSetupStep, PhoneStatus } from "../native";

const setupSteps: ReadonlySet<string> = new Set<PhoneSetupStep>(["accessibility", "notificationAccess", "notifications", "battery", "allFiles", "contacts", "calendar", "location", "backgroundLocation", "sms", "callLog", "phone", "camera", "microphone", "usage", "overlay", "writeSettings", "deviceAdmin", "installPackages"]);

export function configureSettingsAuthPlatform(caseId: string | null, _parameters: URLSearchParams) {
  if (caseId === null) return;
  if (caseId === "network-ios") {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Synthetic iPhone" });
    return;
  }
  if (!caseId.startsWith("permissions-") && !caseId.startsWith("settings-native-") && caseId !== "network-android") return;
  const state: PhoneStatus = {
    enabled: caseId !== "permissions-off", connected: caseId !== "permissions-reconnecting" && caseId !== "permissions-off" && caseId !== "permissions-service-error",
    deviceId: "synthetic-device", name: caseId === "permissions-long" ? "Synthetic Android phone — a deliberately long device name for responsive review" : "Synthetic phone",
    environment: "synthetic", overlay: false, error: caseId === "permissions-service-error" ? { code: "synthetic_offline", message: "The synthetic phone transport is unavailable. Reconnect this device to continue." } : null,
    capabilities: { accessibility: true, notificationAccess: false, notifications: false, battery: true, allFiles: false, contacts: false, calendar: false, location: false, backgroundLocation: false, sms: false, callLog: false, phone: false, camera: false, microphone: false, usage: false, overlay: false, writeSettings: false, deviceAdmin: false, installPackages: false },
  };
  if (caseId === "permissions-unavailable") state.capabilities = {};
  if (caseId === "permissions-granted") state.capabilities = Object.fromEntries(Object.keys(state.capabilities).map(key => [key, true]));
  window.Capacitor = {
    isNativePlatform: () => true,
    registerPlugin: (name: string) => {
      if (name !== "KenanRemote") throw new Error(`Unconfigured synthetic native plugin: ${name}`);
      return {
        getState: async () => ({ routerUrl: location.origin }),
        syncSession: async () => undefined,
        phoneStatus: () => caseId === "permissions-loading" ? new Promise<PhoneStatus>(() => {}) : caseId === "permissions-error" ? Promise.reject(new Error("Synthetic phone status could not be read. Retry when this device reconnects.")) : Promise.resolve(state),
        phoneConfigure: async ({ enabled }: { enabled: boolean }) => { state.enabled = enabled; },
        phoneSetup: async ({ step }: { step: PhoneSetupStep }) => {
          if (!setupSteps.has(step)) throw new Error(`Unconfigured synthetic permission step: ${step}`);
          if (!Object.hasOwn(state.capabilities, step)) throw new Error(`Synthetic permission is unavailable: ${step}`);
          state.capabilities[step] = true; return state;
        },
        phoneOverlay: async ({ visible }: { visible: boolean }) => { state.overlay = visible; return state; },
        notifications: async () => ({ enabled: false }),
        checkAppUpdate: async () => ({ update: null, installed: { revision: "synthetic", versionCode: 1, applicationId: "synthetic", shellId: "synthetic", web: { revision: "synthetic", versionCode: 1, builtIn: true } } }),
        installAppUpdate: async () => ({ status: "installer-opened" }),
      };
    },
  };
}
