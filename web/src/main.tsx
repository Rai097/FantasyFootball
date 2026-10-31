import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startImportHandoff } from "./import/useImportHandoff";
import "./styles.css";

// Before the first render: the Yahoo bookmarklet starts sending as soon as this window loads.
startImportHandoff();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
