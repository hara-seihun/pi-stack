import { useEffect } from "react";
import { Toaster, toast } from "sonner";
import "./toasts.css";

export { toast };

const offset = { top: "calc(12px + env(safe-area-inset-top))", bottom: "var(--toast-bottom, calc(16px + env(safe-area-inset-bottom)))", left: 12, right: 12 };

export function ToastViewport({ scope, position = "bottom-center" }: { scope: string; position?: "top-center" | "bottom-center" }) {
  useEffect(() => () => { toast.dismiss(); }, [scope]);
  return <Toaster className="toast-viewport" position={position} duration={3000} offset={offset} mobileOffset={offset}
    swipeDirections={["left", "right"]} closeButton
    toastOptions={{ className: "toast", classNames: { description: "toast-description", actionButton: "toast-action", closeButton: "toast-dismiss" } }} />;
}
