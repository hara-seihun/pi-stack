import { MachineScreen, type MachineScreenProps } from "./MachineScreen";
import { FeatureUsagePanel } from "./FeatureUsage";
export type MachineTabProps = Omit<MachineScreenProps, "clientRevision" | "features">;
export function MachineTab(screen: MachineTabProps) {
  return <MachineScreen {...screen} features={<FeatureUsagePanel />} clientRevision={__PI_REMOTE_REVISION__} />;
}
