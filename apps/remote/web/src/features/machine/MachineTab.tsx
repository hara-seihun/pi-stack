// Everything the Machine screen needs and nothing else does: the plan and
// governor cards, the environment picker and notification permission.
// The app loads this chunk when the person opens Machine.
import { EnvironmentControl } from "../../EnvironmentControl";
import { NotificationControl } from "../../notification-control";
import { PermissionsSetup } from "../../permissions-setup";
import { nativePlatform } from "../../native";
import { MachineScreen, type MachineScreenProps } from "./MachineScreen";

export type MachineTabProps = Omit<MachineScreenProps, "environment" | "permissions" | "clientRevision">;

export function MachineTab(screen: MachineTabProps) {
  return <MachineScreen {...screen}
    environment={<EnvironmentControl />}
    permissions={nativePlatform ? <PermissionsSetup /> : <NotificationControl />}
    clientRevision={__PI_REMOTE_REVISION__} />;
}
