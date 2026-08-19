// Update check.
//
// Hiread has no packaged update channel yet, so this is the honest middle
// ground: the backend asks the repository's release feed for the newest
// version and we point the user at the release page. Called silently on
// startup (App.vue, a few seconds after mount) and loudly from the About
// pane's button.

import { Browser } from "@wailsio/runtime";
import * as api from "../api";
import i18n from "../i18n";
import { reportError, useToasts } from "../stores/toasts";

/**
 * Check for an update. With `silent` (the launch check) nothing surfaces
 * unless a newer release exists; the About button passes `false` and also
 * hears "you're up to date" / errors.
 */
export async function checkForUpdates(silent = false): Promise<void> {
  const t = i18n.global.t;
  try {
    const info = await api.checkForUpdate();
    if (info.hasUpdate) {
      useToasts().push({
        text: t("update.available", { version: info.latest }),
        tone: "default",
        duration: 8000,
        action: info.releaseUrl
          ? {
              label: t("update.download"),
              run: () => Browser.OpenURL(info.releaseUrl).catch(() => {}),
            }
          : undefined,
      });
    } else if (!silent) {
      useToasts().push({
        text: t("update.upToDate"),
        tone: "default",
        duration: 1900,
      });
    }
  } catch (e) {
    if (!silent) reportError(e);
  }
}
