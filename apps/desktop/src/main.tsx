import "./legacyStorage"; // first: moves pre-rename storage keys before anything reads them
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAppearance, loadSettings } from "./settings";
import "./win98/base.css";

// Appearance before first paint so the window never flashes the wrong scheme.
applyAppearance(loadSettings());
document.documentElement.classList.add("w98-root");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
