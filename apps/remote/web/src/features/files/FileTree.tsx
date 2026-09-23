import { asyncDataLoaderFeature, buildProxiedInstance, hotkeysCoreFeature, selectionFeature } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { API } from "../../../../server/api";
import { api } from "../../client";

import type { FileBrowserEntry as FileEntry } from "../../../../server/protocol";

type FileBrowserEntry = FileEntry | (Omit<FileEntry, "kind"> & { kind: "error" });

export interface FileTreeHandle {
  refresh(): Promise<void>;
}

export interface FileTreeProps {
  selectedPath: string | null;
  onSelect(path: string, kind: "directory" | "file"): void;
  onRootCount?(count: number): void;
}

const ROOT: FileBrowserEntry = { name: "/", path: "/", kind: "directory" };

function loadingEntry(): FileBrowserEntry {
  return { name: "Loading…", path: "", kind: "other" };
}

function errorEntry(path: string, cause: unknown): { id: string; data: FileBrowserEntry } {
  const message = cause instanceof Error ? cause.message : String(cause || "Could not read folder");
  return { id: `${path}\0pi-remote-error`, data: { name: message, path, kind: "error" } };
}

function FileIcon({ kind, open }: { kind: FileBrowserEntry["kind"]; open?: boolean }) {
  if (kind === "directory") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "M3 7.5h7l2 2h9l-2.2 9H4.5L3 7.5Z" : "M3 6.5h7l2 2h9v10H3v-12Z"} /></svg>;
  if (kind === "error") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Zm0 5.5v5m0 3v.2" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6v-17Zm8 0v4h4" /></svg>;
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree({ selectedPath, onSelect, onRootCount }, ref) {
  const [refreshing, setRefreshing] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const scrollElement = useRef<HTMLDivElement>(null);
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const tree = useTree<FileBrowserEntry>({
    instanceBuilder: buildProxiedInstance,
    rootItemId: ROOT.path,
    getItemName: item => item.getItemData().name,
    isItemFolder: item => item.getItemData().kind === "directory",
    createLoadingItemData: loadingEntry,
    dataLoader: {
      getItem: async itemId => itemId === ROOT.path ? ROOT : { name: itemId.split("/").pop() || itemId, path: itemId, kind: "other" },
      getChildrenWithData: async itemId => {
        try {
          const result = await api(API.files.method, API.files.path({}, { path: itemId }));
          const entries = Array.isArray(result?.directory?.entries) ? result.directory.entries as FileBrowserEntry[] : [];
          if (itemId === ROOT.path) onRootCount?.(entries.length);
          return entries.map(entry => ({ id: entry.path, data: entry }));
        } catch (cause) {
          if (itemId === ROOT.path) onRootCount?.(0);
          return [errorEntry(itemId, cause)];
        }
      },
    },
    onPrimaryAction: item => {
      const entry = item.getItemData();
      if (!entry.path || entry.kind === "error" || entry.kind === "other") return;
      if (entry.kind === "directory") item.expand();
      onSelect(entry.path, entry.kind);
    },
    scrollToItem: item => virtualizerRef.current?.scrollToIndex(item.getItemMeta().index),
    indent: 17,
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  useEffect(() => {
    setNavigationError(null);
    if (!selectedPath || selectedPath === "/") {
      tree.setSelectedItems(selectedPath ? [selectedPath] : []);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const parts = selectedPath.split("/").filter(Boolean);
        let parent = "/";
        for (let index = 0; index < parts.length; index += 1) {
          await tree.loadChildrenIds(parent);
          if (cancelled) return;
          const path = `/${parts.slice(0, index + 1).join("/")}`;
          const item = tree.getItemInstance(path);
          const entry = await tree.loadItemData(path);
          if (cancelled) return;
          if (entry.kind === "directory") item.expand();
          parent = path;
        }
        tree.setSelectedItems([selectedPath]);
      } catch (cause) {
        if (!cancelled) setNavigationError(cause instanceof Error ? cause.message : "Could not reveal this path");
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPath, tree]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const path = selectedPath && selectedPath !== "/" ? selectedPath : ROOT.path;
      let item = tree.getItemInstance(path);
      if (!item.isFolder()) {
        const separator = path.lastIndexOf("/");
        item = tree.getItemInstance(separator > 0 ? path.slice(0, separator) : ROOT.path);
      }
      await item.invalidateChildrenIds();
      setNavigationError(null);
    } catch (cause) {
      setNavigationError(cause instanceof Error ? cause.message : "Could not refresh this folder");
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, selectedPath, tree]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);
  const items = tree.getItems();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement.current,
    getItemKey: index => items[index]?.getKey() || index,
    estimateSize: () => 44,
    overscan: 8,
    paddingStart: 5,
    paddingEnd: 12,
  });
  virtualizerRef.current = virtualizer;

  return <div ref={scrollElement} className="files-tree-scroll">
    {navigationError && <p className="files-tree-error" role="alert">{navigationError}</p>}
    <div {...tree.getContainerProps("Files from root")} className="files-tree" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map(virtualItem => {
        const item = items[virtualItem.index];
        if (!item) return null;
        const entry = item.getItemData();
        const folder = item.isFolder();
        const description = entry.kind === "directory" ? `${entry.name}, folder` : entry.kind === "file" ? `${entry.name}, file` : entry.name;
        return <button {...item.getProps()} key={item.getKey()} type="button" className={`files-tree-row ${entry.kind}${item.isSelected() || entry.path === selectedPath ? " selected" : ""}`} style={{ paddingLeft: `${10 + item.getItemMeta().level * 17}px`, transform: `translateY(${virtualItem.start}px)` }} aria-label={description} title={entry.path || entry.name}>
          <span className={`files-tree-chevron${folder && item.isExpanded() ? " open" : ""}`} aria-hidden="true">{folder ? "›" : ""}</span>
          <span className="files-tree-icon"><FileIcon kind={entry.kind} open={folder && item.isExpanded()} /></span>
          <span className="files-tree-name">{entry.name}</span>
          {item.isLoading() && <span className="files-tree-loading" aria-label="Loading" />}
        </button>;
      })}
    </div>
  </div>;
});
