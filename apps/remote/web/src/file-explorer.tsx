import { asyncDataLoaderFeature, buildProxiedInstance, hotkeysCoreFeature, selectionFeature } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef, useState } from "react";
import { API } from "../../server/api";
import { api } from "./client";

export interface FileBrowserEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "other" | "error";
}

const ROOT: FileBrowserEntry = { name: "/", path: "/", kind: "directory" };

function loadingEntry(): FileBrowserEntry {
  return { name: "Loading…", path: "", kind: "other" };
}

function errorEntry(path: string, cause: unknown): { id: string; data: FileBrowserEntry } {
  const message = cause instanceof Error ? cause.message : String(cause || "Could not read folder");
  return { id: `${path}\0pi-remote-error`, data: { name: message, path, kind: "error" } };
}

function download(entry: FileBrowserEntry) {
  const anchor = document.createElement("a");
  anchor.href = API.fileDownload.path({}, { path: entry.path });
  anchor.download = entry.name;
  anchor.rel = "noopener noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function FileIcon({ kind, open }: { kind: FileBrowserEntry["kind"]; open?: boolean }) {
  if (kind === "directory") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "M3 7.5h7l2 2h9l-2.2 9H4.5L3 7.5Z" : "M3 6.5h7l2 2h9v10H3v-12Z"} /></svg>;
  if (kind === "error") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Zm0 5.5v5m0 3v.2" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6v-17Zm8 0v4h4" /></svg>;
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 20h14" /></svg>;
}

export function FileExplorer({ hidden, onRootCount }: { hidden: boolean; onRootCount(count: number): void }) {
  const [selectedPath, setSelectedPath] = useState("/");
  const [refreshing, setRefreshing] = useState(false);
  const scrollElement = useRef<HTMLDivElement>(null);
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const tree = useTree<FileBrowserEntry>({
    instanceBuilder: buildProxiedInstance,
    rootItemId: ROOT.path,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().kind === "directory",
    createLoadingItemData: loadingEntry,
    dataLoader: {
      getItem: async (itemId) => itemId === ROOT.path ? ROOT : { name: itemId.split("/").pop() || itemId, path: itemId, kind: "other" },
      getChildrenWithData: async (itemId) => {
        try {
          const result = await api(API.files.method, API.files.path({}, { path: itemId }));
          const entries = Array.isArray(result?.directory?.entries) ? result.directory.entries as FileBrowserEntry[] : [];
          if (itemId === ROOT.path) onRootCount(entries.length);
          return entries.map((entry) => ({ id: entry.path, data: entry }));
        } catch (cause) {
          if (itemId === ROOT.path) onRootCount(0);
          return [errorEntry(itemId, cause)];
        }
      },
    },
    onPrimaryAction: (item) => {
      const entry = item.getItemData();
      if (entry.path) setSelectedPath(entry.path);
      if (entry.kind === "file") download(entry);
    },
    scrollToItem: (item) => virtualizerRef.current?.scrollToIndex(item.getItemMeta().index),
    indent: 17,
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  const items = tree.getItems();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement.current,
    getItemKey: (index) => items[index]?.getKey() || index,
    estimateSize: () => 38,
    overscan: 8,
    paddingStart: 5,
    paddingEnd: 12,
  });
  virtualizerRef.current = virtualizer;

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      let item = tree.getItemInstance(selectedPath);
      if (!item.isFolder()) {
        const separator = selectedPath.lastIndexOf("/");
        item = tree.getItemInstance(separator > 0 ? selectedPath.slice(0, separator) : ROOT.path);
      }
      await item.invalidateChildrenIds();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, selectedPath, tree]);

  return <section className="file-explorer" aria-label="File explorer" hidden={hidden}>
    <header className="file-explorer-toolbar">
      <span className="file-explorer-path" title={selectedPath}>{selectedPath}</span>
      <button type="button" className={`file-refresh${refreshing ? " refreshing" : ""}`} aria-label={`Refresh ${selectedPath}`} title="Refresh selected folder" disabled={refreshing} onClick={() => void refresh()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9A7 7 0 0 1 18.8 7.7L20 11M4 13l1.2 3.3A7 7 0 0 0 17.9 15" /></svg></button>
    </header>
    <div ref={scrollElement} className="file-tree-scroll">
      <div {...tree.getContainerProps("Files from root")} className="file-tree" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          const entry = item.getItemData();
          const folder = item.isFolder();
          const itemProps = item.getProps();
          const description = entry.kind === "directory" ? `${entry.name}, folder` : entry.kind === "file" ? `${entry.name}, file. Select to download` : entry.name;
          return <button {...itemProps} key={item.getKey()} type="button" className={`file-tree-row ${entry.kind}${item.isSelected() ? " selected" : ""}`} style={{ paddingLeft: `${10 + item.getItemMeta().level * 17}px`, transform: `translateY(${virtualItem.start}px)` }} aria-label={description} title={entry.path || entry.name}>
            <span className={`file-tree-chevron${folder && item.isExpanded() ? " open" : ""}`} aria-hidden="true">{folder ? "›" : ""}</span>
            <span className="file-tree-icon"><FileIcon kind={entry.kind} open={folder && item.isExpanded()} /></span>
            <span className="file-tree-name">{entry.name}</span>
            {item.isLoading() && <span className="file-tree-loading" aria-hidden="true" />}
            {entry.kind === "file" && <span className="file-tree-download"><DownloadIcon /></span>}
          </button>;
        })}
      </div>
    </div>
  </section>;
}
