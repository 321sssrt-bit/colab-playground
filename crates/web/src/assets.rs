//! Embedded zero-build frontend assets and 5-locale Web shell supplement dictionary.

use colab_playground_shared::i18n::Messages;

/// One embedded static file served directly from the binary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asset {
    pub path: &'static str,
    pub content_type: &'static str,
    pub body: &'static str,
}

const HTML: &str = "text/html; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";
const JS: &str = "text/javascript; charset=utf-8";
const SVG: &str = "image/svg+xml";

/// The HTML document served at `/`.
pub const INDEX: Asset = Asset {
    path: "index.html",
    content_type: HTML,
    body: include_str!("../assets/index.html"),
};

/// The SVG icon served at `/assets/favicon.svg` and `/favicon.ico`.
pub const FAVICON: Asset = Asset {
    path: "favicon.svg",
    content_type: SVG,
    body: include_str!("../assets/favicon.svg"),
};

/// Every static file served under `/assets/{path}`.
pub const STATIC_ASSETS: &[Asset] = &[
    FAVICON,
    Asset {
        path: "styles/tokens.css",
        content_type: CSS,
        body: include_str!("../assets/styles/tokens.css"),
    },
    Asset {
        path: "styles/base.css",
        content_type: CSS,
        body: include_str!("../assets/styles/base.css"),
    },
    Asset {
        path: "styles/shell.css",
        content_type: CSS,
        body: include_str!("../assets/styles/shell.css"),
    },
    Asset {
        path: "styles/pages.css",
        content_type: CSS,
        body: include_str!("../assets/styles/pages.css"),
    },
    Asset {
        path: "js/theme-init.js",
        content_type: JS,
        body: include_str!("../assets/js/theme-init.js"),
    },
    Asset {
        path: "js/icons.js",
        content_type: JS,
        body: include_str!("../assets/js/icons.js"),
    },
    Asset {
        path: "js/i18n.js",
        content_type: JS,
        body: include_str!("../assets/js/i18n.js"),
    },
    Asset {
        path: "js/theme.js",
        content_type: JS,
        body: include_str!("../assets/js/theme.js"),
    },
    Asset {
        path: "js/format.js",
        content_type: JS,
        body: include_str!("../assets/js/format.js"),
    },
    Asset {
        path: "js/api.js",
        content_type: JS,
        body: include_str!("../assets/js/api.js"),
    },
    Asset {
        path: "js/store.js",
        content_type: JS,
        body: include_str!("../assets/js/store.js"),
    },
    Asset {
        path: "js/components.js",
        content_type: JS,
        body: include_str!("../assets/js/components.js"),
    },
    Asset {
        path: "js/account-dialogs.js",
        content_type: JS,
        body: include_str!("../assets/js/account-dialogs.js"),
    },
    Asset {
        path: "js/session-dialogs.js",
        content_type: JS,
        body: include_str!("../assets/js/session-dialogs.js"),
    },
    Asset {
        path: "js/plugin-dialogs.js",
        content_type: JS,
        body: include_str!("../assets/js/plugin-dialogs.js"),
    },
    Asset {
        path: "js/pages/login.js",
        content_type: JS,
        body: include_str!("../assets/js/pages/login.js"),
    },
    Asset {
        path: "js/pages/overview.js",
        content_type: JS,
        body: include_str!("../assets/js/pages/overview.js"),
    },
    Asset {
        path: "js/pages/sessions.js",
        content_type: JS,
        body: include_str!("../assets/js/pages/sessions.js"),
    },
    Asset {
        path: "js/pages/plugins.js",
        content_type: JS,
        body: include_str!("../assets/js/pages/plugins.js"),
    },
    Asset {
        path: "js/pages/accounts.js",
        content_type: JS,
        body: include_str!("../assets/js/pages/accounts.js"),
    },
    Asset {
        path: "js/pages/settings.js",
        content_type: JS,
        body: include_str!("../assets/js/pages/settings.js"),
    },
    Asset {
        path: "js/pages/placeholder.js",
        content_type: JS,
        body: include_str!("../assets/js/pages/placeholder.js"),
    },
    Asset {
        path: "js/main.js",
        content_type: JS,
        body: include_str!("../assets/js/main.js"),
    },
];

/// Looks up an embedded static asset by its exact relative path under `/assets/`.
pub fn lookup(path: &str) -> Option<Asset> {
    STATIC_ASSETS
        .iter()
        .copied()
        .find(|asset| asset.path == path)
}

/// Web-shell and Bearer login-gate 5-locale supplement catalog merged into `/assets/i18n/{locale}.json`.
pub const SHELL_CATALOGS: [(&str, Messages); 5] = [
    ("en-US", SHELL_EN_US),
    ("zh-CN", SHELL_ZH_CN),
    ("zh-TW", SHELL_ZH_TW),
    ("ja-JP", SHELL_JA_JP),
    ("ko-KR", SHELL_KO_KR),
];

/// Returns the Web-shell supplement messages for one of the five supported locales.
pub fn shell_messages(locale: &str) -> Option<Messages> {
    SHELL_CATALOGS
        .iter()
        .find(|(tag, _)| *tag == locale)
        .map(|(_, messages)| *messages)
}

const SHELL_EN_US: Messages = &[
    ("web.login.title", "Sign in to Web Server"),
    (
        "web.login.subtitle",
        "Enter the Web access key printed once in the server terminal.",
    ),
    ("web.login.key_label", "Web access key"),
    ("web.login.key_placeholder", "Paste your Web access key"),
    (
        "web.login.key_hint",
        "Kept in memory for this browser tab only. Never stored in cookies.",
    ),
    ("web.login.submit", "Sign in"),
    ("web.login.submitting", "Signing in…"),
    (
        "web.login.invalid_key",
        "That Web access key was not accepted. Check the key printed by the Web Server and try again.",
    ),
    (
        "web.login.unavailable",
        "The Web Server could not verify your key right now. Try again shortly.",
    ),
    (
        "web.login.network_error",
        "Could not reach the Web Server. Check that it is running and try again.",
    ),
    (
        "web.login.session_expired",
        "Your session expired or the Web access key was rotated. Sign in again.",
    ),
    ("web.shell.sign_out", "Sign out"),
    ("web.shell.menu_open", "Open navigation"),
    ("web.shell.menu_close", "Close navigation"),
    ("web.shell.primary_nav", "Primary"),
    ("web.shell.skip_to_content", "Skip to main content"),
    ("web.shell.reconnecting", "Connection lost. Reconnecting…"),
    (
        "web.shell.shutting_down",
        "The Web Server is shutting down.",
    ),
    ("web.shell.copied", "Copied to clipboard"),
    (
        "web.shell.copy_failed",
        "Could not copy automatically. Select the path and copy it manually.",
    ),
    (
        "web.shell.page_upcoming_title",
        "Coming in a follow-up update",
    ),
    (
        "web.shell.page_upcoming_body",
        "This section is reserved in the web shell and will be enabled in upcoming releases.",
    ),
    ("web.overview.keyring_title", "OS keyring"),
    ("web.overview.keyring_ready", "Available and unlocked."),
    (
        "web.overview.keyring_unknown",
        "Waiting for the Colab CLI check.",
    ),
    (
        "web.overview.helper_ready",
        "Account helper interpreter is available.",
    ),
    (
        "web.overview.helper_missing",
        "Account helper interpreter was not found.",
    ),
    ("web.overview.loading", "Loading overview…"),
    ("web.settings.saved", "Settings saved."),
    ("web.settings.unsaved", "You have unsaved changes."),
    ("web.settings.discard", "Discard changes"),
    ("web.settings.loading", "Loading settings…"),
    (
        "web.settings.update_available_generic",
        "A newer release is available on GitHub.",
    ),
    (
        "web.add.open_hint",
        "Open Google sign-in in a new tab, complete sign-in, and paste the authorization code below.",
    ),
    ("web.add.open_link", "Open Google sign-in"),
    (
        "web.add.expired_or_cancelled",
        "The sign-in timed out or was cancelled before a code was submitted.",
    ),
    (
        "web.add.cancelled_notice",
        "Sign-in cancelled. Your previous account is still active.",
    ),
    (
        "web.add.cancelling",
        "Cancelling sign-in and restoring your previous account…",
    ),
    (
        "web.add.in_progress_other",
        "Another sign-in is already active. Cancel it before starting a new one.",
    ),
    ("web.add.cancel_existing", "Cancel active sign-in"),
    ("web.switch.review_again", "Refresh impact"),
    (
        "web.shell.copy_link_failed",
        "Could not copy automatically. Select the link and copy it manually.",
    ),
    ("web.sessions.stop_all", "Stop all"),
    (
        "web.sessions.stop_all_title",
        "Stop all runtimes and verify?",
    ),
    ("web.sessions.stop_all_action", "Stop all and verify"),
    (
        "web.sessions.stop_all_web_note",
        "Stops every running Colab runtime and cancels in-flight creations. The Web Server keeps running.",
    ),
    (
        "web.sessions.stop_all_verified",
        "All runtimes stopped and verified gone.",
    ),
    (
        "web.sessions.stop_all_remaining",
        "Some runtimes could not be confirmed stopped:",
    ),
    ("web.sessions.watchdog_armed", "Watchdog armed"),
    ("web.sessions.auto_stop_extend_title", "Extend auto-stop"),
    ("web.sessions.auto_stop_set_title", "Set auto-stop"),
    (
        "web.sessions.auto_stop_extend_desc",
        "Add time to {name}'s auto-stop deadline.",
    ),
    (
        "web.sessions.auto_stop_set_desc",
        "Stop {name} automatically after this duration from now.",
    ),
    ("web.sessions.auto_stop_extend_by", "Extend by"),
    ("web.sessions.auto_stop_after", "Stop after"),
    ("web.sessions.auto_stop_apply", "Apply"),
    (
        "web.sessions.auto_stop_duration_required",
        "Enter a duration greater than zero.",
    ),
    ("web.sessions.template_loading", "Loading defaults…"),
    (
        "web.sessions.account_changed",
        "The active account changed while this dialog was open. Reopen it to start a session on the current account.",
    ),
    ("web.forward.bind_label", "Listen address"),
    ("web.forward.bind_loopback", "Loopback only (127.0.0.1)"),
    ("web.forward.bind_all", "All interfaces (0.0.0.0)"),
    ("web.forward.existing_title", "Active forwards on {name}"),
    (
        "web.forward.ports_invalid",
        "Enter port numbers between 1 and 65535.",
    ),
    (
        "web.forward.health_invalid",
        "Health check path must start with / and contain no spaces.",
    ),
    ("web.forward.bind_badge_all", "0.0.0.0"),
    ("web.plugins.manage_token", "Manage token"),
    ("web.plugins.replace_token", "Replace token"),
    ("web.plugins.token_required", "Enter a Hugging Face token."),
    (
        "web.plugins.source_required",
        "Enter a server folder path or a Git URL.",
    ),
    ("web.plugins.back_to_source", "Edit source"),
    ("web.plugins.empty_title", "No plugins installed"),
    (
        "web.plugins.empty_body",
        "Install a plugin from a server folder or a Git URL to run scripts on your Colab runtime.",
    ),
    (
        "web.plugins.hf_repo_required",
        "Enter a model repository (owner/name) first.",
    ),
    ("web.plugins.field_required", "Enter a value for {field}."),
    (
        "web.plugins.number_invalid",
        "{field} must be a valid number.",
    ),
    (
        "web.plugins.number_range",
        "{field} must be between {min} and {max}.",
    ),
    ("web.plugins.number_min", "{field} must be at least {min}."),
    ("web.plugins.number_max", "{field} must be at most {max}."),
    (
        "web.plugins.history_skipped",
        "Earlier log lines were dropped from the server buffer because output grew too fast.",
    ),
    (
        "web.plugins.endpoint_local_curl",
        "Run this command on the server host, or switch forwarding to all interfaces (0.0.0.0) to call it remotely.",
    ),
    (
        "web.plugins.endpoint_not_forwarded_note",
        "Turn on forwarding to reach this endpoint.",
    ),
    (
        "web.plugins.endpoint_copy_failed",
        "Could not copy automatically. Select the text and copy it manually.",
    ),
    ("web.plugins.run_loading", "Loading plugin form…"),
];

const SHELL_ZH_CN: Messages = &[
    ("web.login.title", "登录 Web 服务器"),
    (
        "web.login.subtitle",
        "请输入服务器终端首次启动时打印的 Web 访问密钥。",
    ),
    ("web.login.key_label", "Web 访问密钥"),
    ("web.login.key_placeholder", "粘贴 Web 访问密钥"),
    (
        "web.login.key_hint",
        "仅保存在当前标签页内存中，绝不写入 Cookie。",
    ),
    ("web.login.submit", "登录"),
    ("web.login.submitting", "正在登录…"),
    (
        "web.login.invalid_key",
        "Web 访问密钥无效。请核对 Web 服务器打印的密钥后重试。",
    ),
    (
        "web.login.unavailable",
        "Web 服务器暂时无法校验密钥，请稍后再试。",
    ),
    (
        "web.login.network_error",
        "无法连接到 Web 服务器。请确认服务仍在运行后重试。",
    ),
    (
        "web.login.session_expired",
        "登录会话已过期或 Web 访问密钥已轮换，请重新登录。",
    ),
    ("web.shell.sign_out", "退出登录"),
    ("web.shell.menu_open", "打开导航菜单"),
    ("web.shell.menu_close", "关闭导航菜单"),
    ("web.shell.primary_nav", "主导航"),
    ("web.shell.skip_to_content", "跳至主要内容"),
    ("web.shell.reconnecting", "连接已断开，正在重连…"),
    ("web.shell.shutting_down", "Web 服务器正在关闭。"),
    ("web.shell.copied", "已复制到剪贴板"),
    (
        "web.shell.copy_failed",
        "无法自动复制，请选中路径后手动复制。",
    ),
    ("web.shell.page_upcoming_title", "后续更新中提供"),
    (
        "web.shell.page_upcoming_body",
        "该页面入口已在网页外壳中预留，将在后续迭代中启用。",
    ),
    ("web.overview.keyring_title", "系统密钥环"),
    ("web.overview.keyring_ready", "可用且已解锁。"),
    ("web.overview.keyring_unknown", "等待 Colab CLI 检查完成。"),
    ("web.overview.helper_ready", "账号辅助解释器可用。"),
    ("web.overview.helper_missing", "未找到账号辅助解释器。"),
    ("web.overview.loading", "正在加载概览…"),
    ("web.settings.saved", "设置已保存。"),
    ("web.settings.unsaved", "有未保存的更改。"),
    ("web.settings.discard", "放弃更改"),
    ("web.settings.loading", "正在加载设置…"),
    (
        "web.settings.update_available_generic",
        "GitHub 上已有新版本可供下载。",
    ),
    (
        "web.add.open_hint",
        "点击下方按钮在新标签页打开 Google 登录，完成授权后将授权码粘贴到输入框。",
    ),
    ("web.add.open_link", "打开 Google 登录"),
    (
        "web.add.expired_or_cancelled",
        "本次登录在提交授权码前已超时或被取消。",
    ),
    (
        "web.add.cancelled_notice",
        "已取消登录，之前的账号仍保持活跃状态。",
    ),
    ("web.add.cancelling", "正在取消登录并恢复之前的账号…"),
    (
        "web.add.in_progress_other",
        "已有另一项登录流程正在进行，请先取消后再开始新的登录。",
    ),
    ("web.add.cancel_existing", "取消进行中的登录"),
    ("web.switch.review_again", "重新检查影响"),
    (
        "web.shell.copy_link_failed",
        "无法自动复制，请选中链接后手动复制。",
    ),
    ("web.sessions.stop_all", "停止全部"),
    ("web.sessions.stop_all_title", "停止全部运行时并核对结果？"),
    ("web.sessions.stop_all_action", "停止全部并核对"),
    (
        "web.sessions.stop_all_web_note",
        "将停止所有运行中的 Colab 运行时并取消进行中的创建任务，Web 服务器本身保持运行。",
    ),
    (
        "web.sessions.stop_all_verified",
        "已停止全部运行时并核对清空。",
    ),
    (
        "web.sessions.stop_all_remaining",
        "以下运行时未能确认已停止：",
    ),
    ("web.sessions.watchdog_armed", "Watchdog 已武装"),
    ("web.sessions.auto_stop_extend_title", "延期自动停机"),
    ("web.sessions.auto_stop_set_title", "设置自动停机"),
    (
        "web.sessions.auto_stop_extend_desc",
        "延长 {name} 的自动停机截止时间。",
    ),
    (
        "web.sessions.auto_stop_set_desc",
        "从现在起经过以下时长后自动停止 {name}。",
    ),
    ("web.sessions.auto_stop_extend_by", "延长时间"),
    ("web.sessions.auto_stop_after", "自动停机时长"),
    ("web.sessions.auto_stop_apply", "应用"),
    (
        "web.sessions.auto_stop_duration_required",
        "请输入大于 0 的时长。",
    ),
    ("web.sessions.template_loading", "正在加载默认配置…"),
    (
        "web.sessions.account_changed",
        "此弹窗打开期间活跃账号已切换，请重新打开后再在当前账号下创建会话。",
    ),
    ("web.forward.bind_label", "监听地址"),
    ("web.forward.bind_loopback", "仅回环地址（127.0.0.1）"),
    ("web.forward.bind_all", "所有网卡（0.0.0.0）"),
    ("web.forward.existing_title", "{name} 的已建转发"),
    (
        "web.forward.ports_invalid",
        "请输入 1 到 65535 之间的端口号。",
    ),
    (
        "web.forward.health_invalid",
        "健康检查路径必须以 / 开头且不能包含空格。",
    ),
    ("web.forward.bind_badge_all", "0.0.0.0"),
    ("web.plugins.manage_token", "管理令牌"),
    ("web.plugins.replace_token", "替换令牌"),
    ("web.plugins.token_required", "请输入 Hugging Face 令牌。"),
    (
        "web.plugins.source_required",
        "请输入服务器目录路径或 Git URL。",
    ),
    ("web.plugins.back_to_source", "修改来源"),
    ("web.plugins.empty_title", "尚未安装插件"),
    (
        "web.plugins.empty_body",
        "从服务器目录或 Git URL 安装插件，即可在 Colab 运行时上运行脚本。",
    ),
    (
        "web.plugins.hf_repo_required",
        "请先输入模型仓库（owner/name）。",
    ),
    ("web.plugins.field_required", "请填写 {field}。"),
    ("web.plugins.number_invalid", "{field} 必须是有效数字。"),
    (
        "web.plugins.number_range",
        "{field} 必须在 {min} 到 {max} 之间。",
    ),
    ("web.plugins.number_min", "{field} 不能小于 {min}。"),
    ("web.plugins.number_max", "{field} 不能大于 {max}。"),
    (
        "web.plugins.history_skipped",
        "由于日志输出过快，较早的日志已从服务器缓冲区移除。",
    ),
    (
        "web.plugins.endpoint_local_curl",
        "请在服务器本机运行此命令，或切换到所有网卡（0.0.0.0）转发后再远程调用。",
    ),
    (
        "web.plugins.endpoint_not_forwarded_note",
        "开启端口转发后即可访问此端点。",
    ),
    (
        "web.plugins.endpoint_copy_failed",
        "无法自动复制，请选中文本后手动复制。",
    ),
    ("web.plugins.run_loading", "正在加载插件表单…"),
];

const SHELL_ZH_TW: Messages = &[
    ("web.login.title", "登入 Web 伺服器"),
    (
        "web.login.subtitle",
        "請輸入伺服器終端機首次啟動時列印的 Web 存取金鑰。",
    ),
    ("web.login.key_label", "Web 存取金鑰"),
    ("web.login.key_placeholder", "貼上 Web 存取金鑰"),
    (
        "web.login.key_hint",
        "僅保存在目前分頁記憶體中，絕不寫入 Cookie。",
    ),
    ("web.login.submit", "登入"),
    ("web.login.submitting", "正在登入…"),
    (
        "web.login.invalid_key",
        "Web 存取金鑰無效。請核對 Web 伺服器列印的金鑰後再試。",
    ),
    (
        "web.login.unavailable",
        "Web 伺服器暫時無法驗證金鑰，請稍後再試。",
    ),
    (
        "web.login.network_error",
        "無法連線到 Web 伺服器。請確認服務仍在執行後重試。",
    ),
    (
        "web.login.session_expired",
        "工作階段已過期或 Web 存取金鑰已輪換，請重新登入。",
    ),
    ("web.shell.sign_out", "登出"),
    ("web.shell.menu_open", "開啟導覽選單"),
    ("web.shell.menu_close", "關閉導覽選單"),
    ("web.shell.primary_nav", "主要導覽"),
    ("web.shell.skip_to_content", "跳至主要內容"),
    ("web.shell.reconnecting", "連線已中斷，正在重新連線…"),
    ("web.shell.shutting_down", "Web 伺服器正在關閉。"),
    ("web.shell.copied", "已複製到剪貼簿"),
    (
        "web.shell.copy_failed",
        "無法自動複製，請選取路徑後手動複製。",
    ),
    ("web.shell.page_upcoming_title", "後續更新中提供"),
    (
        "web.shell.page_upcoming_body",
        "此頁面入口已在網頁外殼中預留，將於後續版本啟用。",
    ),
    ("web.overview.keyring_title", "系統鑰匙圈"),
    ("web.overview.keyring_ready", "可用且已解鎖。"),
    ("web.overview.keyring_unknown", "等待 Colab CLI 檢查完成。"),
    ("web.overview.helper_ready", "帳號輔助直譯器可用。"),
    ("web.overview.helper_missing", "找不到帳號輔助直譯器。"),
    ("web.overview.loading", "正在載入概覽…"),
    ("web.settings.saved", "設定已儲存。"),
    ("web.settings.unsaved", "有未儲存的變更。"),
    ("web.settings.discard", "放棄變更"),
    ("web.settings.loading", "正在載入設定…"),
    (
        "web.settings.update_available_generic",
        "GitHub 上已有新版本可供下載。",
    ),
    (
        "web.add.open_hint",
        "點選下方按鈕在新分頁開啟 Google 登入，完成授權後將授權碼貼上到輸入欄。",
    ),
    ("web.add.open_link", "開啟 Google 登入"),
    (
        "web.add.expired_or_cancelled",
        "這次登入在送出授權碼前已逾時或被取消。",
    ),
    (
        "web.add.cancelled_notice",
        "已取消登入，先前的帳號仍保持使用中。",
    ),
    ("web.add.cancelling", "正在取消登入並還原先前的帳號…"),
    (
        "web.add.in_progress_other",
        "已有另一個登入流程正在進行，請先取消再開始新的登入。",
    ),
    ("web.add.cancel_existing", "取消進行中的登入"),
    ("web.switch.review_again", "重新檢查影響"),
    (
        "web.shell.copy_link_failed",
        "無法自動複製，請選取連結後手動複製。",
    ),
    ("web.sessions.stop_all", "停止全部"),
    (
        "web.sessions.stop_all_title",
        "停止全部執行階段並核對結果？",
    ),
    ("web.sessions.stop_all_action", "停止全部並核對"),
    (
        "web.sessions.stop_all_web_note",
        "將停止所有執行中的 Colab 執行階段並取消進行中的建立作業，Web 伺服器本身會繼續運作。",
    ),
    (
        "web.sessions.stop_all_verified",
        "已停止全部執行階段並核對清空。",
    ),
    (
        "web.sessions.stop_all_remaining",
        "以下執行階段未能確認已停止：",
    ),
    ("web.sessions.watchdog_armed", "Watchdog 已武裝"),
    ("web.sessions.auto_stop_extend_title", "延長自動停機"),
    ("web.sessions.auto_stop_set_title", "設定自動停機"),
    (
        "web.sessions.auto_stop_extend_desc",
        "延長 {name} 的自動停機截止時間。",
    ),
    (
        "web.sessions.auto_stop_set_desc",
        "從現在起經過以下時間後自動停止 {name}。",
    ),
    ("web.sessions.auto_stop_extend_by", "延長時間"),
    ("web.sessions.auto_stop_after", "自動停機時長"),
    ("web.sessions.auto_stop_apply", "套用"),
    (
        "web.sessions.auto_stop_duration_required",
        "請輸入大於 0 的時長。",
    ),
    ("web.sessions.template_loading", "正在載入預設值…"),
    (
        "web.sessions.account_changed",
        "此對話框開啟期間活躍帳號已切換，請重新開啟後再於目前帳號下建立工作階段。",
    ),
    ("web.forward.bind_label", "監聽位址"),
    ("web.forward.bind_loopback", "僅迴路位址（127.0.0.1）"),
    ("web.forward.bind_all", "所有介面（0.0.0.0）"),
    ("web.forward.existing_title", "{name} 的已建轉發"),
    (
        "web.forward.ports_invalid",
        "請輸入 1 到 65535 之間的連接埠號。",
    ),
    (
        "web.forward.health_invalid",
        "健康檢查路徑必須以 / 開頭且不可包含空格。",
    ),
    ("web.forward.bind_badge_all", "0.0.0.0"),
    ("web.plugins.manage_token", "管理權杖"),
    ("web.plugins.replace_token", "取代權杖"),
    ("web.plugins.token_required", "請輸入 Hugging Face 權杖。"),
    (
        "web.plugins.source_required",
        "請輸入伺服器目錄路徑或 Git URL。",
    ),
    ("web.plugins.back_to_source", "修改來源"),
    ("web.plugins.empty_title", "尚未安裝外掛"),
    (
        "web.plugins.empty_body",
        "從伺服器目錄或 Git URL 安裝外掛，即可在 Colab 執行階段上執行腳本。",
    ),
    (
        "web.plugins.hf_repo_required",
        "請先輸入模型儲存庫（owner/name）。",
    ),
    ("web.plugins.field_required", "請填寫 {field}。"),
    ("web.plugins.number_invalid", "{field} 必須是有效數字。"),
    (
        "web.plugins.number_range",
        "{field} 必須介於 {min} 到 {max} 之間。",
    ),
    ("web.plugins.number_min", "{field} 不能小於 {min}。"),
    ("web.plugins.number_max", "{field} 不能大於 {max}。"),
    (
        "web.plugins.history_skipped",
        "由於日誌輸出過快，較早的日誌已從伺服器緩衝區移除。",
    ),
    (
        "web.plugins.endpoint_local_curl",
        "請在伺服器本機執行此命令，或切換到所有介面（0.0.0.0）轉發後再遠端呼叫。",
    ),
    (
        "web.plugins.endpoint_not_forwarded_note",
        "開啟連接埠轉發後即可存取此端點。",
    ),
    (
        "web.plugins.endpoint_copy_failed",
        "無法自動複製，請選取文字後手動複製。",
    ),
    ("web.plugins.run_loading", "正在載入外掛表單…"),
];

const SHELL_JA_JP: Messages = &[
    ("web.login.title", "Web サーバーにサインイン"),
    (
        "web.login.subtitle",
        "サーバー端末に一度だけ表示された Web アクセスキーを入力してください。",
    ),
    ("web.login.key_label", "Web アクセスキー"),
    ("web.login.key_placeholder", "Web アクセスキーを貼り付け"),
    (
        "web.login.key_hint",
        "このブラウザータブのメモリ内のみに保持され、Cookie には保存されません。",
    ),
    ("web.login.submit", "サインイン"),
    ("web.login.submitting", "サインイン中…"),
    (
        "web.login.invalid_key",
        "Web アクセスキーが受け付けられませんでした。Web サーバーが表示したキーを確認してもう一度お試しください。",
    ),
    (
        "web.login.unavailable",
        "現在 Web サーバーでキーを検証できません。しばらくしてからもう一度お試しください。",
    ),
    (
        "web.login.network_error",
        "Web サーバーに接続できませんでした。稼働中であることを確認してもう一度お試しください。",
    ),
    (
        "web.login.session_expired",
        "セッションの有効期限が切れたか、Web アクセスキーがローテーションされました。もう一度サインインしてください。",
    ),
    ("web.shell.sign_out", "サインアウト"),
    ("web.shell.menu_open", "ナビゲーションを開く"),
    ("web.shell.menu_close", "ナビゲーションを閉じる"),
    ("web.shell.primary_nav", "メイン"),
    ("web.shell.skip_to_content", "メインコンテンツへスキップ"),
    ("web.shell.reconnecting", "接続が切断されました。再接続中…"),
    ("web.shell.shutting_down", "Web サーバーを終了しています。"),
    ("web.shell.copied", "クリップボードにコピーしました"),
    (
        "web.shell.copy_failed",
        "自動コピーできませんでした。パスを選択して手動でコピーしてください。",
    ),
    (
        "web.shell.page_upcoming_title",
        "今後のアップデートで追加予定",
    ),
    (
        "web.shell.page_upcoming_body",
        "このセクションは Web シェルに予約されており、今後のリリースで有効になります。",
    ),
    ("web.overview.keyring_title", "OS キーリング"),
    (
        "web.overview.keyring_ready",
        "利用可能でロック解除されています。",
    ),
    (
        "web.overview.keyring_unknown",
        "Colab CLI の確認を待っています。",
    ),
    (
        "web.overview.helper_ready",
        "アカウントヘルパーのインタープリターが利用可能です。",
    ),
    (
        "web.overview.helper_missing",
        "アカウントヘルパーのインタープリターが見つかりませんでした。",
    ),
    ("web.overview.loading", "概要を読み込み中…"),
    ("web.settings.saved", "設定を保存しました。"),
    ("web.settings.unsaved", "未保存の変更があります。"),
    ("web.settings.discard", "変更を破棄"),
    ("web.settings.loading", "設定を読み込み中…"),
    (
        "web.settings.update_available_generic",
        "GitHub で新しいリリースが公開されています。",
    ),
    (
        "web.add.open_hint",
        "新しいタブで Google サインインを開き、認証完了後に表示された認証コードを下に貼り付けてください。",
    ),
    ("web.add.open_link", "Google サインインを開く"),
    (
        "web.add.expired_or_cancelled",
        "コードを送信する前にサインインがタイムアウトまたはキャンセルされました。",
    ),
    (
        "web.add.cancelled_notice",
        "サインインをキャンセルしました。以前のアカウントが引き続き有効です。",
    ),
    (
        "web.add.cancelling",
        "サインインをキャンセルして以前のアカウントを復元しています…",
    ),
    (
        "web.add.in_progress_other",
        "別のサインインが進行中です。新しく始める前にキャンセルしてください。",
    ),
    ("web.add.cancel_existing", "進行中のサインインをキャンセル"),
    ("web.switch.review_again", "影響を再確認"),
    (
        "web.shell.copy_link_failed",
        "自動コピーできませんでした。リンクを選択して手動でコピーしてください。",
    ),
    ("web.sessions.stop_all", "すべて停止"),
    (
        "web.sessions.stop_all_title",
        "すべてのランタイムを停止して確認しますか？",
    ),
    ("web.sessions.stop_all_action", "すべて停止して確認"),
    (
        "web.sessions.stop_all_web_note",
        "実行中のすべての Colab ランタイムを停止し、進行中の作成をキャンセルします。Web サーバーは稼働し続けます。",
    ),
    (
        "web.sessions.stop_all_verified",
        "すべてのランタイムを停止し、終了を確認しました。",
    ),
    (
        "web.sessions.stop_all_remaining",
        "停止を確認できなかったランタイムがあります：",
    ),
    ("web.sessions.watchdog_armed", "Watchdog 有効"),
    ("web.sessions.auto_stop_extend_title", "自動停止を延長"),
    ("web.sessions.auto_stop_set_title", "自動停止を設定"),
    (
        "web.sessions.auto_stop_extend_desc",
        "{name} の自動停止時刻を延長します。",
    ),
    (
        "web.sessions.auto_stop_set_desc",
        "現在から指定時間後に {name} を自動停止します。",
    ),
    ("web.sessions.auto_stop_extend_by", "延長時間"),
    ("web.sessions.auto_stop_after", "自動停止までの時間"),
    ("web.sessions.auto_stop_apply", "適用"),
    (
        "web.sessions.auto_stop_duration_required",
        "0 より大きい時間を入力してください。",
    ),
    (
        "web.sessions.template_loading",
        "デフォルト設定を読み込み中…",
    ),
    (
        "web.sessions.account_changed",
        "このダイアログを開いている間にアクティブなアカウントが変更されました。現在のアカウントでセッションを開始するには開き直してください。",
    ),
    ("web.forward.bind_label", "待ち受けアドレス"),
    ("web.forward.bind_loopback", "ループバックのみ (127.0.0.1)"),
    ("web.forward.bind_all", "すべてのインターフェース (0.0.0.0)"),
    ("web.forward.existing_title", "{name} のアクティブな転送"),
    (
        "web.forward.ports_invalid",
        "1 から 65535 のポート番号を入力してください。",
    ),
    (
        "web.forward.health_invalid",
        "ヘルスチェックパスは / で始まり、空白を含まないようにしてください。",
    ),
    ("web.forward.bind_badge_all", "0.0.0.0"),
    ("web.plugins.manage_token", "トークンを管理"),
    ("web.plugins.replace_token", "トークンを置き換える"),
    (
        "web.plugins.token_required",
        "Hugging Face トークンを入力してください。",
    ),
    (
        "web.plugins.source_required",
        "サーバー上のフォルダパスまたは Git URL を入力してください。",
    ),
    ("web.plugins.back_to_source", "ソースを編集"),
    (
        "web.plugins.empty_title",
        "プラグインはまだインストールされていません",
    ),
    (
        "web.plugins.empty_body",
        "サーバー上のフォルダまたは Git URL からプラグインをインストールして、Colab ランタイム上でスクリプトを実行できます。",
    ),
    (
        "web.plugins.hf_repo_required",
        "先にモデルリポジトリ（owner/name）を入力してください。",
    ),
    ("web.plugins.field_required", "{field} を入力してください。"),
    (
        "web.plugins.number_invalid",
        "{field} には有効な数値を入力してください。",
    ),
    (
        "web.plugins.number_range",
        "{field} は {min} から {max} の間で指定してください。",
    ),
    (
        "web.plugins.number_min",
        "{field} は {min} 以上で指定してください。",
    ),
    (
        "web.plugins.number_max",
        "{field} は {max} 以下で指定してください。",
    ),
    (
        "web.plugins.history_skipped",
        "出力が速すぎたため、古いログ行はサーバーのバッファから破棄されました。",
    ),
    (
        "web.plugins.endpoint_local_curl",
        "このコマンドはサーバーホスト上で実行するか、すべてのインターフェース (0.0.0.0) に切り替えてリモートから呼び出してください。",
    ),
    (
        "web.plugins.endpoint_not_forwarded_note",
        "このエンドポイントにアクセスするには転送を有効にしてください。",
    ),
    (
        "web.plugins.endpoint_copy_failed",
        "自動コピーできませんでした。テキストを選択して手動でコピーしてください。",
    ),
    ("web.plugins.run_loading", "プラグインフォームを読み込み中…"),
];

const SHELL_KO_KR: Messages = &[
    ("web.login.title", "웹 서버에 로그인"),
    (
        "web.login.subtitle",
        "서버 터미널에 한 번 출력된 Web 액세스 키를 입력하세요.",
    ),
    ("web.login.key_label", "Web 액세스 키"),
    ("web.login.key_placeholder", "Web 액세스 키 붙여넣기"),
    (
        "web.login.key_hint",
        "이 브라우저 탭의 메모리에만 보관되며 쿠키에는 절대 저장되지 않습니다.",
    ),
    ("web.login.submit", "로그인"),
    ("web.login.submitting", "로그인 중…"),
    (
        "web.login.invalid_key",
        "Web 액세스 키가 올바르지 않습니다. 웹 서버가 출력한 키를 확인하고 다시 시도하세요.",
    ),
    (
        "web.login.unavailable",
        "지금은 웹 서버가 키를 확인할 수 없습니다. 잠시 후 다시 시도하세요.",
    ),
    (
        "web.login.network_error",
        "웹 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하고 다시 시도하세요.",
    ),
    (
        "web.login.session_expired",
        "세션이 만료되었거나 Web 액세스 키가 교체되었습니다. 다시 로그인하세요.",
    ),
    ("web.shell.sign_out", "로그아웃"),
    ("web.shell.menu_open", "탐색 메뉴 열기"),
    ("web.shell.menu_close", "탐색 메뉴 닫기"),
    ("web.shell.primary_nav", "기본 탐색"),
    ("web.shell.skip_to_content", "본문으로 건너뛰기"),
    (
        "web.shell.reconnecting",
        "연결이 끊어졌습니다. 다시 연결 중…",
    ),
    ("web.shell.shutting_down", "웹 서버가 종료 중입니다."),
    ("web.shell.copied", "클립보드에 복사됨"),
    (
        "web.shell.copy_failed",
        "자동으로 복사할 수 없습니다. 경로를 선택해 직접 복사하세요.",
    ),
    (
        "web.shell.page_upcoming_title",
        "후속 업데이트에서 제공 예정",
    ),
    (
        "web.shell.page_upcoming_body",
        "이 섹션은 웹 셸에 예약되어 있으며 다음 릴리스에서 활성화됩니다.",
    ),
    ("web.overview.keyring_title", "OS 키링"),
    (
        "web.overview.keyring_ready",
        "사용 가능하며 잠금 해제되어 있습니다.",
    ),
    (
        "web.overview.keyring_unknown",
        "Colab CLI 확인을 기다리는 중입니다.",
    ),
    (
        "web.overview.helper_ready",
        "계정 도우미 인터프리터를 사용할 수 있습니다.",
    ),
    (
        "web.overview.helper_missing",
        "계정 도우미 인터프리터를 찾을 수 없습니다.",
    ),
    ("web.overview.loading", "개요 불러오는 중…"),
    ("web.settings.saved", "설정이 저장되었습니다."),
    (
        "web.settings.unsaved",
        "저장하지 않은 변경 사항이 있습니다.",
    ),
    ("web.settings.discard", "변경 취소"),
    ("web.settings.loading", "설정 불러오는 중…"),
    (
        "web.settings.update_available_generic",
        "GitHub에 새 릴리스가 있습니다.",
    ),
    (
        "web.add.open_hint",
        "새 탭에서 Google 로그인을 열고 인증을 마친 뒤 아래에 인증 코드를 붙여넣으세요.",
    ),
    ("web.add.open_link", "Google 로그인 열기"),
    (
        "web.add.expired_or_cancelled",
        "코드를 제출하기 전에 로그인이 시간 초과되었거나 취소되었습니다.",
    ),
    (
        "web.add.cancelled_notice",
        "로그인을 취소했습니다. 이전 계정이 계속 활성 상태입니다.",
    ),
    (
        "web.add.cancelling",
        "로그인을 취소하고 이전 계정을 복원하는 중…",
    ),
    (
        "web.add.in_progress_other",
        "다른 로그인이 이미 진행 중입니다. 새 로그인을 시작하기 전에 먼저 취소하세요.",
    ),
    ("web.add.cancel_existing", "진행 중인 로그인 취소"),
    ("web.switch.review_again", "영향 다시 확인"),
    (
        "web.shell.copy_link_failed",
        "자동으로 복사할 수 없습니다. 링크를 선택해 직접 복사하세요.",
    ),
    ("web.sessions.stop_all", "모두 중지"),
    (
        "web.sessions.stop_all_title",
        "모든 런타임을 중지하고 확인할까요?",
    ),
    ("web.sessions.stop_all_action", "모두 중지 및 확인"),
    (
        "web.sessions.stop_all_web_note",
        "실행 중인 모든 Colab 런타임을 중지하고 진행 중인 생성 작업을 취소합니다. 웹 서버는 계속 실행됩니다.",
    ),
    (
        "web.sessions.stop_all_verified",
        "모든 런타임을 중지하고 종료를 확인했습니다.",
    ),
    (
        "web.sessions.stop_all_remaining",
        "중지를 확인하지 못한 런타임이 있습니다:",
    ),
    ("web.sessions.watchdog_armed", "Watchdog 활성화됨"),
    ("web.sessions.auto_stop_extend_title", "자동 중지 연장"),
    ("web.sessions.auto_stop_set_title", "자동 중지 설정"),
    (
        "web.sessions.auto_stop_extend_desc",
        "{name}의 자동 중지 기한을 연장합니다.",
    ),
    (
        "web.sessions.auto_stop_set_desc",
        "지금부터 지정한 시간 후에 {name}을(를) 자동으로 중지합니다.",
    ),
    ("web.sessions.auto_stop_extend_by", "연장 시간"),
    ("web.sessions.auto_stop_after", "자동 중지 시간"),
    ("web.sessions.auto_stop_apply", "적용"),
    (
        "web.sessions.auto_stop_duration_required",
        "0보다 큰 시간을 입력하세요.",
    ),
    ("web.sessions.template_loading", "기본값 불러오는 중…"),
    (
        "web.sessions.account_changed",
        "이 대화 상자가 열려 있는 동안 활성 계정이 변경되었습니다. 현재 계정에서 세션을 시작하려면 다시 여세요.",
    ),
    ("web.forward.bind_label", "수신 주소"),
    ("web.forward.bind_loopback", "루프백 전용 (127.0.0.1)"),
    ("web.forward.bind_all", "모든 인터페이스 (0.0.0.0)"),
    ("web.forward.existing_title", "{name}의 활성 포워딩"),
    (
        "web.forward.ports_invalid",
        "1에서 65535 사이의 포트 번호를 입력하세요.",
    ),
    (
        "web.forward.health_invalid",
        "상태 확인 경로는 /로 시작하고 공백이 없어야 합니다.",
    ),
    ("web.forward.bind_badge_all", "0.0.0.0"),
    ("web.plugins.manage_token", "토큰 관리"),
    ("web.plugins.replace_token", "토큰 교체"),
    (
        "web.plugins.token_required",
        "Hugging Face 토큰을 입력하세요.",
    ),
    (
        "web.plugins.source_required",
        "서버 폴더 경로 또는 Git URL을 입력하세요.",
    ),
    ("web.plugins.back_to_source", "소스 수정"),
    ("web.plugins.empty_title", "설치된 플러그인이 없습니다"),
    (
        "web.plugins.empty_body",
        "서버 폴더 또는 Git URL에서 플러그인을 설치하여 Colab 런타임에서 스크립트를 실행할 수 있습니다.",
    ),
    (
        "web.plugins.hf_repo_required",
        "먼저 모델 저장소(owner/name)를 입력하세요.",
    ),
    ("web.plugins.field_required", "{field} 값을 입력하세요."),
    (
        "web.plugins.number_invalid",
        "{field}에는 올바른 숫자를 입력하세요.",
    ),
    (
        "web.plugins.number_range",
        "{field} 값은 {min}에서 {max} 사이여야 합니다.",
    ),
    (
        "web.plugins.number_min",
        "{field} 값은 {min} 이상이어야 합니다.",
    ),
    (
        "web.plugins.number_max",
        "{field} 값은 {max} 이하여야 합니다.",
    ),
    (
        "web.plugins.history_skipped",
        "출력이 너무 빨라 이전 로그 줄이 서버 버퍼에서 삭제되었습니다.",
    ),
    (
        "web.plugins.endpoint_local_curl",
        "이 명령은 서버 호스트에서 실행하거나 모든 인터페이스(0.0.0.0)로 전환한 후 원격에서 호출하세요.",
    ),
    (
        "web.plugins.endpoint_not_forwarded_note",
        "이 엔드포인트에 접근하려면 포워딩을 켜세요.",
    ),
    (
        "web.plugins.endpoint_copy_failed",
        "자동으로 복사할 수 없습니다. 텍스트를 선택해 직접 복사하세요.",
    ),
    ("web.plugins.run_loading", "플러그인 양식 불러오는 중…"),
];
