import "./person";
import "./native";
import "./voice";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ImagePreviewScope } from "./ImagePreview";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Pi Remote root element is missing");
createRoot(root).render(<StrictMode><ImagePreviewScope><App /></ImagePreviewScope></StrictMode>);
