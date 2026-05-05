import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { migrateLegacyAuthKeys } from "./lib/auth.ts";
import "./styles.css";

migrateLegacyAuthKeys();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
