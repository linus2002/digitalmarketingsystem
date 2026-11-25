import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles/app.css";
import "./styles/theme.css";
import { App } from "./App";
import { initTheme } from "./lib/theme";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./components/Toast";
import { IconSprite } from "./components/Icons";

// A data router (rather than <BrowserRouter>) so pages can ask before leaving with unsaved changes (useBlocker).
// Every path goes to <App>, which keeps declaring the routes with <Routes> as before.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    ),
  },
]);

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IconSprite />
    <RouterProvider router={router} />
  </StrictMode>,
);
