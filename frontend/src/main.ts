// Vue application entry point. Wires Pinia (state), Vue Query (server cache),
// and vue-i18n (translations), then mounts the root App.

import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import i18n from "./i18n";
import { reportError } from "./stores/toasts";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/newsreader/wght-italic.css";
import "./styles.css";

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(VueQueryPlugin);

// Global error handler — Vue has no <ErrorBoundary>; surface a crash as an
// error toast instead of a silent failure.
app.config.errorHandler = (err) => {
  console.error(err);
  try {
    reportError(err);
  } catch {
    /* pinia not ready yet — already logged */
  }
};

// Suppress the webview's native context menu so our own ContextMenu owns
// right-click.
window.addEventListener("contextmenu", (e) => e.preventDefault());

app.mount("#app");
