export function listenForFileDrops(
  target: Window,
  canAttach: () => boolean,
  attach: (files: File[]) => void,
  show: (active: boolean) => void,
): () => void {
  let depth = 0;
  const isFile = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const reset = () => { depth = 0; show(false); };
  const enter = (event: DragEvent) => {
    if (!isFile(event)) return;
    event.preventDefault();
    depth++;
    show(canAttach());
  };
  const over = (event: DragEvent) => {
    if (!isFile(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = canAttach() ? "copy" : "none";
  };
  const leave = (event: DragEvent) => {
    if (!isFile(event)) return;
    if (--depth <= 0) reset();
  };
  const drop = (event: DragEvent) => {
    reset();
    if (!isFile(event)) return;
    event.preventDefault();
    if (canAttach()) attach(Array.from(event.dataTransfer?.files ?? []));
  };
  target.addEventListener("dragenter", enter, true);
  target.addEventListener("dragover", over, true);
  target.addEventListener("dragleave", leave, true);
  target.addEventListener("drop", drop, true);
  target.addEventListener("dragend", reset, true);
  target.addEventListener("blur", reset);
  return () => {
    target.removeEventListener("dragenter", enter, true);
    target.removeEventListener("dragover", over, true);
    target.removeEventListener("dragleave", leave, true);
    target.removeEventListener("drop", drop, true);
    target.removeEventListener("dragend", reset, true);
    target.removeEventListener("blur", reset);
  };
}
