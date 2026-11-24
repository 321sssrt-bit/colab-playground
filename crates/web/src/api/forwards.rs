use std::{net::IpAddr, sync::Arc};

use axum::{
    Json,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::StatusCode,
};
use colab_playground_core::{
    plugins::ResolvedEndpoint,
    tunnel::{ForwardBind, TunnelId, TunnelInfo, TunnelSpec},
};
use colab_playground_shared::i18n::keys;
use colab_playground_web::state::{AccountContext, Submission};
use serde::{Deserialize, Serialize, de::IgnoredAny};

use super::ApiError;
use crate::{
    http::{RequestHost, StateData, is_loopback_host},
    i18n,
};

#[derive(Deserialize)]
pub(super) struct OpenForward {
    account_context: AccountContext,
    #[serde(flatten)]
    spec: TunnelSpec,
}

#[derive(Serialize)]
pub(super) struct ForwardAddresses {
    open_url: Option<String>,
    copy_url: Option<String>,
    openai_base_url: Option<String>,
    notice_key: Option<&'static str>,
    warning_key: Option<&'static str>,
}

impl ForwardAddresses {
    /// Build links for the current Browser Client. Plugin Endpoints supply their declared path.
    pub(super) fn for_request(
        host: &RequestHost,
        spec: &TunnelSpec,
        endpoint: Option<&ResolvedEndpoint>,
    ) -> Self {
        let (base, notice_key) = if host.direct_loopback {
            (Some(spec.local_url()), None)
        } else if spec.bind == ForwardBind::Loopback {
            (None, Some(i18n::FORWARD_SERVER_LOCAL))
        } else if is_loopback_host(&host.name)
            || host
                .name
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| {
                    let ip = ip.to_canonical();
                    ip.is_ipv6() || ip.is_unspecified()
                })
        {
            (None, Some(i18n::FORWARD_EXTERNAL_HOST))
        } else {
            // The direct Forward bypasses the Web Server's TLS-terminating proxy.
            (
                Some(format!("http://{}:{}", host.name, spec.local_port)),
                None,
            )
        };

        let (open_url, copy_url, openai_base_url) = match (base, endpoint) {
            (None, _) => (None, None, None),
            (Some(base), Some(endpoint)) => {
                let url = format!("{base}{}", endpoint.path.trim_end_matches('/'));
                if endpoint.kind == "openai" {
                    (Some(base), Some(url.clone()), Some(url))
                } else {
                    (Some(url.clone()), Some(url), None)
                }
            }
            (Some(base), None) => (
                Some(base.clone()),
                Some(base.clone()),
                Some(format!("{base}/v1")),
            ),
        };
        Self {
            copy_url,
            open_url,
            openai_base_url,
            notice_key,
            warning_key: (spec.bind == ForwardBind::AllInterfaces)
                .then_some(i18n::FORWARD_DOWNSTREAM_AUTH),
        }
    }
}

#[derive(Serialize)]
pub(super) struct ForwardView {
    #[serde(flatten)]
    info: TunnelInfo,
    addresses: ForwardAddresses,
}

impl ForwardView {
    fn new(info: TunnelInfo, host: &RequestHost, endpoint: Option<&ResolvedEndpoint>) -> Self {
        Self {
            addresses: ForwardAddresses::for_request(host, &info.spec, endpoint),
            info,
        }
    }
}

pub(super) async fn list(
    State(state): State<StateData>,
    Extension(host): Extension<Arc<RequestHost>>,
) -> Json<Vec<ForwardView>> {
    let snapshot = state.web.snapshot();
    Json(
        snapshot
            .tunnels
            .iter()
            .cloned()
            .map(|info| {
                let endpoint = snapshot.forward_endpoint(info.id);
                ForwardView::new(info, &host, endpoint)
            })
            .collect(),
    )
}

pub(super) async fn open(
    State(state): State<StateData>,
    Extension(host): Extension<Arc<RequestHost>>,
    payload: Result<Json<OpenForward>, JsonRejection>,
) -> Result<(StatusCode, Json<ForwardView>), ApiError> {
    let Json(payload) = payload?;
    let job = state
        .web
        .open_forward(payload.account_context, payload.spec)?;
    Ok((
        StatusCode::CREATED,
        Json(ForwardView::new(finish(job).await?, &host, None)),
    ))
}

#[derive(Serialize)]
pub(super) struct ClosedForward {
    billing_continues: bool,
    notice_key: &'static str,
}

pub(super) async fn close(
    State(state): State<StateData>,
    Path(id): Path<TunnelId>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<Json<ClosedForward>, ApiError> {
    let Json(_) = payload?;
    finish(state.web.close_forward(id)?).await?;
    Ok(Json(ClosedForward {
        billing_continues: true,
        notice_key: keys::FORWARD_CLOSED_BILLING,
    }))
}

async fn finish<T>(submission: Submission<T>) -> Result<T, ApiError> {
    match submission {
        Submission::Started { job, .. } => Ok(job.await??),
        Submission::AlreadyRunning { id } => Err(ApiError::busy(id)),
    }
}

#[cfg(test)]
mod tests {
    use colab_playground_core::{accounts::AccountId, plugins::LocalizedText};

    use super::*;

    #[test]
    fn plugin_links_use_the_endpoint_path_and_current_host() {
        let spec = TunnelSpec {
            account: AccountId::new("demo").unwrap(),
            session: "demo".into(),
            bind: ForwardBind::AllInterfaces,
            local_port: 18000,
            remote_port: 8000,
            health_path: Some("/health".into()),
        };
        let endpoint = ResolvedEndpoint {
            id: "api".into(),
            remote_port: spec.remote_port,
            path: "/custom/v1/".into(),
            health: spec.health_path.clone(),
            kind: "openai".into(),
            label: LocalizedText(Default::default()),
        };
        let host = RequestHost {
            name: "plugin.example.test".into(),
            direct_loopback: false,
        };
        let addresses = ForwardAddresses::for_request(&host, &spec, Some(&endpoint));
        let expected = Some("http://plugin.example.test:18000/custom/v1");
        assert_eq!(
            addresses.open_url.as_deref(),
            Some("http://plugin.example.test:18000")
        );
        assert_eq!(addresses.copy_url.as_deref(), expected);
        assert_eq!(addresses.openai_base_url.as_deref(), expected);

        let local = RequestHost {
            name: "[::1]".into(),
            direct_loopback: true,
        };
        let addresses = ForwardAddresses::for_request(&local, &spec, None);
        assert_eq!(
            addresses.open_url.as_deref(),
            Some("http://127.0.0.1:18000")
        );
    }
}
