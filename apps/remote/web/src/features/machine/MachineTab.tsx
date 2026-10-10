import { MachineScreen, type MachineScreenProps } from "./MachineScreen";
import { useFeatureUsageRows } from "./FeatureUsage";
export type MachineTabProps = Omit<MachineScreenProps, "clientRevision" | "features">;
export function MachineTab(screen: MachineTabProps) {
  const features = useFeatureUsageRows();
  return <MachineScreen {...screen} features={features} clientRevision={__PI_REMOTE_REVISION__} />;
}
