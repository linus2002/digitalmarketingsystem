import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles/app.css";
import { App } from "./App";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./components/Toast";
import { IconSprite } from "./components/Icons";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IconSprite />
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
