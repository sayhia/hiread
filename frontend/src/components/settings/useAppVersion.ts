// The app version, shared between the Settings sidebar footer and the About
// pane. Read from the backend's AppInfo binding (the Go-side const is the
// single source of truth); the one round-trip is cached in a module-level
// promise so both consumers share it.

import { onScopeDispose, ref, type Ref } from "vue";
import * as api from "../../api";

let versionPromise: Promise<string> | null = null;

export function useAppVersion(): Ref<string> {
  const version = ref("");
  versionPromise ??= api
    .appInfo()
    .then((info) => info.version)
    .catch(() => "");
  let live = true;
  versionPromise.then((v) => {
    if (live) version.value = v;
  });
  onScopeDispose(() => {
    live = false;
  });
  return version;
}
