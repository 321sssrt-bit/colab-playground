/**
 * Ready-state Overview quick-deploy cards for enabled plugins.
 */

import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale } from "../../lib/types.ts";
import { resolveLocalizedText } from "../plugins/api.ts";
import { RocketIcon } from "../plugins/PluginDeployForm.tsx";
import type { PluginInfo } from "../plugins/types.ts";

export interface QuickDeploySectionProps {
  readonly plugins: readonly PluginInfo[];
  readonly locale: Locale;
  readonly shuttingDown: boolean;
  readonly t: TranslateFn;
  readonly onDeploy: (pluginId: string) => void;
}

export function QuickDeploySection({
  plugins,
  locale,
  shuttingDown,
  t,
  onDeploy,
}: QuickDeploySectionProps) {
  const enabledPlugins = plugins.filter((plugin) => plugin.enabled);
  if (enabledPlugins.length === 0) {
    return null;
  }

  return (
    <section className="section-stack" data-overview-quick-deploy="true">
      <div className="section-heading">
        <h2 className="section-title">{t("app.b2.deploy_title")}</h2>
        <p className="card-desc">{t("app.b2.deploy_subtitle")}</p>
      </div>

      <div className="deploy-list">
        {enabledPlugins.map((plugin) => {
          const id = plugin.manifest.id;
          const name = resolveLocalizedText(plugin.manifest.name, locale, id);
          const description = resolveLocalizedText(plugin.manifest.description, locale, "");

          return (
            <article className="card card-compact" key={id} data-overview-deploy-card={id}>
              <h3 className="deploy-card-title">
                <RocketIcon className="icon-accent" />
                <span>{name}</span>
              </h3>
              {description && <p className="card-desc">{description}</p>}
              <div className="card-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={shuttingDown}
                  data-overview-deploy={id}
                  onClick={() => onDeploy(id)}
                >
                  <RocketIcon />
                  <span>{t("app.b2.deploy_action")}</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
