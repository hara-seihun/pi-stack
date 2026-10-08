import { MachineScreen, type MachineScreenProps } from "./MachineScreen";
export type MachineTabProps = Omit<MachineScreenProps, "environment" | "permissions" | "clientRevision">;
export function MachineTab(screen: MachineTabProps) {
  return <MachineScreen {...screen} environment={null} permissions={null} clientRevision={__PI_REMOTE_REVISION__} />;
}
