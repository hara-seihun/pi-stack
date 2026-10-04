// Everything the Machine screen needs and nothing else does: the plan and
// governor cards, the environment picker, notification permission and the app
// updater. The app loads this chunk when the person opens Machine.

import { AppUpdateControl } from "../../app-update";
import { EnvironmentControl } from "../../EnvironmentControl";
import { NotificationControl } from "../../notification-control";
import { PermissionsSetup } from "../../permissions-setup";
import { nativePlatform } from "../../native";
import { MachineScreen, type MachineScreenProps } from "./MachineScreen";

export type MachineTabProps = Omit<MachineScreenProps, "environment" | "permissions" | "appUpdate" | "clientRevision">;

export function MachineTab(screen: MachineTabProps) {
  return <MachineScreen {...screen}
    environment={<EnvironmentControl />}
    permissions={nativePlatform ? <PermissionsSetup /> : <NotificationControl />}
    appUpdate={<AppUpdateControl />}
    clientRevision={__PI_REMOTE_REVISION__} />;
}
