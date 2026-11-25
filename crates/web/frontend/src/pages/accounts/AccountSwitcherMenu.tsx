/**
 * Shell account switcher popup menu for both the desktop sidebar and the mobile
 * topbar. Uses native Popover + CSS Anchor Positioning + Invoker Commands when
 * supported, falling back cleanly to positioned menu markup and manual arrow/Esc
 * navigation on older engines.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { AccountSlotPlacement } from "../../components/AppShell.tsx";
import { AccountsIcon, UserIcon } from "../../components/Icons.tsx";
import { resolveActiveAccount } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { routeToHash } from "../../lib/router.ts";
import type { Snapshot } from "../../lib/types.ts";
import { ChevronDownIcon, UserPlusIcon } from "./Icons.tsx";
import { isAccountChangeBlocked, type SwitchTarget } from "./model.ts";

export interface AccountSwitcherMenuProps {
  readonly placement: AccountSlotPlacement;
  readonly snapshot: Snapshot | null;
  readonly t: TranslateFn;
  readonly onNavigateAccounts: () => void;
  readonly onRequestSwitch: (target: SwitchTarget) => void;
  readonly onRequestAddAccount: () => void;
  readonly onCloseDrawer?: () => void;
}

const FOCUSABLE_MENU_ITEM_SELECTOR = "button:not(:disabled)";

function detectNativeAnchoredPopover(): boolean {
  if (typeof HTMLElement === "undefined" || typeof CSS === "undefined") {
    return false;
  }
  return (
    "popover" in HTMLElement.prototype &&
    typeof CSS.supports === "function" &&
    CSS.supports("position-area", "block-end")
  );
}

function detectInvokerCommands(): boolean {
  return (
    typeof HTMLButtonElement !== "undefined" &&
    "commandForElement" in HTMLButtonElement.prototype
  );
}

function detectNativeFocusGroup(): boolean {
  return typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype;
}

function getEnabledMenuItems(container: HTMLElement | null): HTMLButtonElement[] {
  if (!container) {
    return [];
  }
  return Array.from(container.querySelectorAll<HTMLButtonElement>(FOCUSABLE_MENU_ITEM_SELECTOR));
}

function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function AccountSwitcherMenu({
  placement,
  snapshot,
  t,
  onNavigateAccounts,
  onRequestSwitch,
  onRequestAddAccount,
  onCloseDrawer,
}: AccountSwitcherMenuProps) {
  const triggerId = useId();
  const menuId = useId();
  const groupHeadingId = useId();

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const enterOnOpenRef = useRef(false);
  const pointerPressedRef = useRef(false);

  const [useNativePopover] = useState<boolean>(detectNativeAnchoredPopover);
  const [useInvokerCommands] = useState<boolean>(detectInvokerCommands);
  const [useNativeFocusGroup] = useState<boolean>(detectNativeFocusGroup);

  const activeAccount = resolveActiveAccount(snapshot, t);
  const accountsView = snapshot?.accounts ?? null;
  const showMenu = activeAccount.signedIn && accountsView !== null;

  const hideMenu = useCallback(
    (restoreFocus: boolean) => {
      const popover = popoverRef.current;
      if (useNativePopover && popover) {
        if (popover.matches(":popover-open")) {
          popover.hidePopover();
        }
      } else {
        setOpen(false);
      }
      if (restoreFocus) {
        triggerRef.current?.focus();
      }
    },
    [useNativePopover],
  );

  // Sync native Popover `toggle` events with `aria-expanded` and keyboard entry focus.
  useEffect(() => {
    if (!showMenu || !useNativePopover) {
      return;
    }
    const popover = popoverRef.current;
    if (!popover) {
      return;
    }

    const onToggle = (event: Event) => {
      const nextOpen =
        "newState" in event
          ? (event as ToggleEvent).newState === "open"
          : popover.matches(":popover-open");
      setOpen(nextOpen);
      if (nextOpen) {
        const shouldEnter = enterOnOpenRef.current || !pointerPressedRef.current;
        enterOnOpenRef.current = false;
        pointerPressedRef.current = false;
        if (shouldEnter) {
          const items = getEnabledMenuItems(listRef.current);
          items[0]?.focus({ preventScroll: true });
        }
      } else {
        enterOnOpenRef.current = false;
        pointerPressedRef.current = false;
      }
    };

    popover.addEventListener("toggle", onToggle);
    return () => {
      popover.removeEventListener("toggle", onToggle);
    };
  }, [showMenu, useNativePopover]);

  // Close the menu if focus leaves the trigger + popup menu system (or outside click in fallback mode).
  useEffect(() => {
    if (!open) {
      return;
    }
    const onFocusIn = (event: FocusEvent) => {
      const targetNode = event.target as Node | null;
      if (!targetNode) {
        return;
      }
      const insideTrigger = triggerRef.current?.contains(targetNode) ?? false;
      const insidePopover = popoverRef.current?.contains(targetNode) ?? false;
      if (!insideTrigger && !insidePopover) {
        hideMenu(false);
      }
    };
    document.addEventListener("focusin", onFocusIn);

    if (useNativePopover) {
      return () => {
        document.removeEventListener("focusin", onFocusIn);
      };
    }

    const onPointerDown = (event: PointerEvent) => {
      const targetNode = event.target as Node | null;
      if (!targetNode) {
        hideMenu(false);
        return;
      }
      const insideTrigger = triggerRef.current?.contains(targetNode) ?? false;
      const insidePopover = popoverRef.current?.contains(targetNode) ?? false;
      if (!insideTrigger && !insidePopover) {
        hideMenu(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [hideMenu, open, useNativePopover]);

  // Close when transitioning back to signed-out state.
  useEffect(() => {
    if (!showMenu && openRef.current) {
      setOpen(false);
    }
  }, [showMenu]);

  const handleFallbackTriggerClick = useCallback(() => {
    const nextOpen = !openRef.current;
    const shouldEnter = enterOnOpenRef.current || !pointerPressedRef.current;
    enterOnOpenRef.current = false;
    pointerPressedRef.current = false;
    setOpen(nextOpen);
    if (nextOpen && shouldEnter) {
      window.requestAnimationFrame(() => {
        const items = getEnabledMenuItems(listRef.current);
        items[0]?.focus({ preventScroll: true });
      });
    }
  }, []);

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (openRef.current) {
          const items = getEnabledMenuItems(listRef.current);
          items[0]?.focus({ preventScroll: true });
          return;
        }
        enterOnOpenRef.current = true;
        pointerPressedRef.current = false;
        triggerRef.current?.click();
      } else if ((event.key === "Enter" || event.key === " ") && !openRef.current) {
        enterOnOpenRef.current = true;
        pointerPressedRef.current = false;
      } else if (event.key === "Escape" && openRef.current) {
        event.preventDefault();
        hideMenu(true);
      }
    },
    [hideMenu],
  );

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideMenu(true);
        return;
      }
      if (event.key === "Tab") {
        hideMenu(false);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        const items = getEnabledMenuItems(listRef.current);
        if (items.length === 0) {
          return;
        }
        event.preventDefault();
        const targetItem = event.key === "Home" ? items[0] : items[items.length - 1];
        targetItem.focus({ preventScroll: true });
        return;
      }
      if (!useNativeFocusGroup && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const items = getEnabledMenuItems(listRef.current);
        if (items.length === 0) {
          return;
        }
        const active = document.activeElement as HTMLButtonElement | null;
        const currentIndex = active ? items.indexOf(active) : -1;
        const step = event.key === "ArrowUp" ? -1 : 1;
        const nextIndex =
          currentIndex < 0
            ? event.key === "ArrowUp"
              ? items.length - 1
              : 0
            : (currentIndex + step + items.length) % items.length;
        event.preventDefault();
        items[nextIndex].focus({ preventScroll: true });
      }
    },
    [hideMenu, useNativeFocusGroup],
  );

  const handleSignedOutClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(event)) {
        return;
      }
      event.preventDefault();
      onCloseDrawer?.();
      onNavigateAccounts();
    },
    [onCloseDrawer, onNavigateAccounts],
  );

  if (!showMenu || accountsView === null) {
    const accountTitle = activeAccount.signedIn
      ? activeAccount.label
      : t("app.shell.account.hint");
    return (
      <a
        href={routeToHash("accounts")}
        className={placement === "sidebar" ? "sidebar-account" : "topbar-account"}
        title={accountTitle}
        onClick={handleSignedOutClick}
      >
        <UserIcon />
        <span className={placement === "sidebar" ? "sidebar-account-text" : "topbar-account-text"}>
          {activeAccount.label}
        </span>
      </a>
    );
  }

  const accountChangeBlocked = isAccountChangeBlocked(snapshot);
  const shuttingDown = snapshot?.shutting_down === true;
  const blockedTitle = accountChangeBlocked ? t("app.b2.account_change_blocked") : undefined;

  const triggerInvokeProps: Record<string, string> = useNativePopover
    ? useInvokerCommands
      ? { commandfor: menuId, command: "toggle-popover" }
      : { popoverTarget: menuId }
    : {};

  const popoverHostProps: Record<string, string | boolean | undefined> = useNativePopover
    ? { popover: "auto" }
    : { hidden: !open };

  const menuListProps: Record<string, string | undefined> = useNativeFocusGroup
    ? { focusgroup: "menu nomemory" }
    : { focusgroup: "menu nomemory", role: "menu" };

  const commandItemRole = useNativeFocusGroup ? undefined : "menuitem";

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={
          placement === "sidebar" ? "sidebar-account" : "btn btn-ghost topbar-account"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={activeAccount.label}
        onPointerDown={() => {
          pointerPressedRef.current = true;
        }}
        onClick={useNativePopover ? undefined : handleFallbackTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        {...triggerInvokeProps}
      >
        <UserIcon />
        <span className={placement === "sidebar" ? "sidebar-account-text" : "topbar-account-text"}>
          {activeAccount.label}
        </span>
        <ChevronDownIcon />
      </button>

      <div
        ref={popoverRef}
        id={menuId}
        className="account-menu-popover"
        {...popoverHostProps}
      >
        <div
          ref={listRef}
          className="account-menu-list"
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
          {...menuListProps}
        >
          <div id={groupHeadingId} className="account-menu-heading">
            {t("app.switcher.group")}
          </div>

          <div className="account-menu-group" role="group" aria-labelledby={groupHeadingId}>
            {accountsView.accounts.map((account) => {
              const isActive = accountsView.active === account.id;
              const emailLabel = account.email ?? t("app.accounts.no_email");
              const switchDisabled = !isActive && (accountChangeBlocked || shuttingDown);
              return (
                <button
                  key={account.id}
                  type="button"
                  className="account-menu-item"
                  role="menuitemradio"
                  aria-checked={isActive}
                  disabled={switchDisabled}
                  title={switchDisabled ? blockedTitle : emailLabel}
                  onClick={() => {
                    hideMenu(false);
                    if (!isActive) {
                      onCloseDrawer?.();
                      onRequestSwitch({ id: account.id, emailLabel });
                    }
                  }}
                >
                  <span className="account-menu-item-label">{emailLabel}</span>
                </button>
              );
            })}
          </div>

          <hr className="account-menu-separator" />

          <button
            type="button"
            className="account-menu-item"
            role={commandItemRole}
            disabled={accountChangeBlocked || shuttingDown}
            title={blockedTitle}
            onClick={() => {
              hideMenu(false);
              onCloseDrawer?.();
              onRequestAddAccount();
            }}
          >
            <UserPlusIcon />
            <span className="account-menu-item-label">{t("app.switcher.add")}</span>
          </button>

          <button
            type="button"
            className="account-menu-item"
            role={commandItemRole}
            onClick={() => {
              hideMenu(false);
              onCloseDrawer?.();
              onNavigateAccounts();
            }}
          >
            <AccountsIcon />
            <span className="account-menu-item-label">{t("app.switcher.manage")}</span>
          </button>
        </div>
      </div>
    </>
  );
}
