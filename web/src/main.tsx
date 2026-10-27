import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TemplatesPage from "./TemplatesPage";
import ComponentsPage from "./ComponentsPage";
import SectionUsagePage from "./SectionUsagePage";
import UsagePage from "./UsagePage";
import "./styles.css";
import "./phase2.css";

// ?embed=1 = the chat inside the WordPress widget (iframe); otherwise the full app.
const WidgetApp = lazy(() => import("./widget/WidgetApp"));
const embed = new URLSearchParams(location.search).has("embed");
if (embed) document.documentElement.classList.add("embed");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {embed ? <Suspense fallback={null}><WidgetApp /></Suspense>
      : /^\/components\/?$/.test(location.pathname) ? <ComponentsPage />
      : /^\/templates\/?$/.test(location.pathname) ? <TemplatesPage />
      : /^\/section-usage\/?$/.test(location.pathname) ? <SectionUsagePage />
      : /^\/model-usage\/?$/.test(location.pathname) ? <UsagePage />
      : <App />}
  </StrictMode>,
);
