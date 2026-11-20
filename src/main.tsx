import { render } from "preact";
import { App } from "./App.tsx";
import "./styles.css";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal in private browsing or local preview without HTTPS
    });
  });
}

render(<App />, document.getElementById("app")!);
