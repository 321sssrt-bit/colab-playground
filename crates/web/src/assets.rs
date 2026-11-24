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
];
