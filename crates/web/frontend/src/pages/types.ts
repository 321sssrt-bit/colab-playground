/**
 * Shared page contract passed by `App.tsx` to each independent top-level page module.
 */

import type { TranslateFn } from "../lib/i18n.ts";
import type { NavigateOptions, RouteId } from "../lib/router.ts";
import type { ToastInput } from "../lib/toast.ts";
import type { Locale, Snapshot } from "../lib/types.ts";

export interface PageProps {
  readonly snapshot: Snapshot | null;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId, options?: NavigateOptions) => void;
  readonly pushToast: (toast: ToastInput) => number;
}
