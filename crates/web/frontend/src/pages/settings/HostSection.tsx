/**
 * Colab CLI location card: optional WSL distribution selector (Windows/WSL)
 * and custom `colab` / Python interpreter paths, mirroring
 * `crates/app/src/ui/pages/defaults.rs::host_section`.
 */

import { memo, useEffect, useId, useMemo, useRef, type FormEvent } from "react";

import { AlertIcon, CheckCircleIcon } from "../../components/Icons.tsx";
import type { Dictionary, TranslateFn } from "../../lib/i18n.ts";
import { scrollSettingsToTop } from "./focus.ts";

export interface HostSaveError {
  readonly message: string;
  readonly interpreterAlone: boolean;
}

export interface HostSectionProps {
  readonly usesWsl: boolean;
  readonly wslDistro: string | null;
  readonly wslDistros: readonly string[];
  readonly colabPathDraft: string;
  readonly colabPythonDraft: string;
  readonly simulated: boolean;
  readonly busy: boolean;
  readonly saving: boolean;
  readonly focused: boolean;
  readonly hostError: HostSaveError | null;
  readonly savedNotice: boolean;
  readonly dict: Dictionary | null;
  readonly t: TranslateFn;
  readonly onWslDistroChange: (distro: string | null) => void;
  readonly onDraftChange: (colabPath: string, colabPython: string) => void;
  readonly onApplyPaths: (colabPath: string, colabPython: string) => Promise<boolean>;
}

export const HostSection = memo(function HostSection({
  usesWsl,
  wslDistro,
  wslDistros,
  colabPathDraft,
  colabPythonDraft,
  simulated,
  busy,
  saving,
  focused,
  hostError,
  savedNotice,
  t,
  onWslDistroChange,
  onDraftChange,
  onApplyPaths,
}: HostSectionProps) {
  const headingId = useId();
  const wslId = useId();
  const colabPathId = useId();
  const colabPythonId = useId();
  const pythonHintId = useId();
  const errorId = useId();

  const sectionRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const colabPathRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focused) {
      return;
    }
    scrollSettingsToTop(sectionRef.current);
    headingRef.current?.focus({ preventScroll: true });
  }, [focused]);

  useEffect(() => {
    if (hostError?.interpreterAlone) {
      colabPathRef.current?.focus();
    }
  }, [hostError]);

  const distroOptions = useMemo(() => {
    const list = [...wslDistros];
    if (wslDistro && !list.includes(wslDistro)) {
      list.push(wslDistro);
    }
    return list;
  }, [wslDistro, wslDistros]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || saving) {
      return;
    }
    await onApplyPaths(colabPathDraft, colabPythonDraft);
  };

  const interpreterAlone = hostError?.interpreterAlone === true;
  const applyNote = busy
    ? t("app.host.busy")
    : simulated
      ? t("app.host.mock_note")
      : null;

  return (
    <section
      ref={sectionRef}
      className={focused ? "card settings-section settings-focus-card" : "card settings-section"}
      data-settings-host="true"
      data-settings-host-focus={focused ? "true" : undefined}
    >
      <div className="card-heading">
        <h2
          ref={headingRef}
          id={headingId}
          tabIndex={focused ? -1 : undefined}
          className={focused ? "card-title settings-focus-heading" : "card-title"}
        >
          {t("app.host.title")}
        </h2>
        <p className="card-desc">{t("app.host.description")}</p>
      </div>

      <form
        aria-labelledby={headingId}
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
      >
        <div className="settings-list">
          {usesWsl && (
            <div className="settings-row">
              <div className="settings-row-info">
                <label className="settings-row-title" htmlFor={wslId}>
                  {t("app.host.wsl")}
                </label>
              </div>
              <div className="settings-row-control">
                <select
                  id={wslId}
                  name="wsl_distro"
                  className="select select-sm select-inline"
                  value={wslDistro ?? ""}
                  disabled={busy || saving}
                  data-host-wsl="true"
                  onChange={(event) => {
                    const value = event.target.value;
                    onWslDistroChange(value.length > 0 ? value : null);
                  }}
                >
                  <option value="">{t("app.host.wsl_default")}</option>
                  {distroOptions.map((distro) => (
                    <option key={distro} value={distro}>
                      {distro}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={colabPathId}>
                {t("app.host.colab_path")}
              </label>
            </div>
            <div className="settings-row-control settings-path-control">
              <input
                ref={colabPathRef}
                id={colabPathId}
                name="colab_path"
                type="text"
                className="input input-sm settings-path-input"
                placeholder={t("app.host.path_placeholder")}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={colabPathDraft}
                disabled={saving}
                aria-invalid={interpreterAlone ? "true" : undefined}
                aria-describedby={interpreterAlone ? errorId : undefined}
                data-host-colab-path="true"
                onChange={(event) => onDraftChange(event.target.value, colabPythonDraft)}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={colabPythonId}>
                {t("app.host.python_path")}
              </label>
              <p id={pythonHintId} className="settings-row-desc">
                {t("app.b3.host_python_hint")}
              </p>
            </div>
            <div className="settings-row-control settings-path-control">
              <input
                id={colabPythonId}
                name="colab_python"
                type="text"
                className="input input-sm settings-path-input"
                placeholder={t("app.host.path_placeholder")}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={colabPythonDraft}
                disabled={saving}
                aria-invalid={interpreterAlone ? "true" : undefined}
                aria-describedby={
                  interpreterAlone ? `${pythonHintId} ${errorId}` : pythonHintId
                }
                data-host-colab-python="true"
                onChange={(event) => onDraftChange(colabPathDraft, event.target.value)}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">{t("app.host.apply")}</span>
              {applyNote !== null && <p className="settings-row-desc">{applyNote}</p>}
            </div>
            <div className="settings-row-control">
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={busy || saving}
                aria-busy={saving || undefined}
                data-host-apply="true"
              >
                {saving && <span className="spinner" aria-hidden="true" />}
                <span>{t("app.host.apply")}</span>
              </button>
            </div>
          </div>
        </div>

        {hostError !== null ? (
          <div
            id={errorId}
            className={
              interpreterAlone
                ? "alert alert-warning settings-inline-alert"
                : "alert alert-danger settings-inline-alert"
            }
            role="alert"
            data-host-error={interpreterAlone ? "interpreter_alone" : "save_failed"}
          >
            <span className={interpreterAlone ? "alert-icon icon-warning" : "alert-icon icon-danger"}>
              <AlertIcon />
            </span>
            <div className="alert-text">
              {!interpreterAlone && (
                <p className="alert-title">{t("app.toast.save_failed.title")}</p>
              )}
              <p className="alert-body">{hostError.message}</p>
            </div>
          </div>
        ) : savedNotice ? (
          <div className="settings-host-feedback">
            <span className="inline-msg inline-msg-success" role="status">
              <CheckCircleIcon />
              <span className="inline-msg-text">{t("web.settings.saved")}</span>
            </span>
          </div>
        ) : null}
      </form>
    </section>
  );
});
