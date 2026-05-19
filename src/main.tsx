import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const url = import.meta.env.VITE_CONVEX_URL;
if (!url) {
  throw new Error(
    "VITE_CONVEX_URL is not set. Add it to .env.local (same value as CONVEX_URL).",
  );
}

const convex = new ConvexReactClient(url);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
