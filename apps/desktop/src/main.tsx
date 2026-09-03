import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, loadSettings } from "./settings";
import "./hw.css";

// Theme before first paint so the window never flashes the wrong ground.
applyTheme(loadSettings().theme);
document.documentElement.classList.add("hw-root");
document.body.classList.add("hw-body");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
