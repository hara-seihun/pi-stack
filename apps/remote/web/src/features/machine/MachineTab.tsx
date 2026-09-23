// Everything the Machine screen needs and nothing else does: the plan and
// governor cards, the environment picker, notification permission and the app
// updater. The app loads this chunk when the person opens Machine.

import { AppUpdateControl } from "../../app-update";
import { EnvironmentControl } from "../../EnvironmentControl";
import { NotificationControl } from "../../notification-control";
import { MachineScreen, type MachineScreenProps } from "./MachineScreen";

export type MachineTabProps = Omit<MachineScreenProps, "environment" | "notifications" | "appUpdate" | "clientRevision"> & {
  /** The open thread, whose notifications count as seen while it is on screen. */
  sessionId: string | null;
};

export function MachineTab({ sessionId, ...screen }: MachineTabProps) {
  return <MachineScreen {...screen}
    environment={<EnvironmentControl />}
    notifications={<NotificationControl sessionId={sessionId} />}
    appUpdate={<AppUpdateControl />}
    clientRevision={__PI_REMOTE_REVISION__} />;
}
