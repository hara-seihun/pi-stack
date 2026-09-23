import "./person";
import "./native";
import { installLazyVoice } from "./voice-lazy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../styles.css";

installLazyVoice();

const root = document.getElementById("root");
if (!root) throw new Error("Pi Remote root element is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
