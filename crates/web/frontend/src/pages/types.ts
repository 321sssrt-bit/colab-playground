/**
 * Shared page contract passed by `App.tsx` to each independent top-level page module.
 */

import type { TranslateFn } from "../lib/i18n.ts";
import type { NavigateOptions, RouteId } from "../lib/router.ts";
import type { ToastInput } from "../lib/toast.ts";
import type { AccountId, Locale, Snapshot } from "../lib/types.ts";

export interface AccountSwitchRequest {
  readonly id: AccountId;
  readonly emailLabel: string;
}

export interface PageProps {
  readonly snapshot: Snapshot | null;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId, options?: NavigateOptions) => void;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onRequestSwitchAccount?: (target: AccountSwitchRequest) => void;
  readonly onRequestAddAccount?: () => void;
  readonly addAccountDialogOpen?: boolean;
}
