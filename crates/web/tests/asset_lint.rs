use std::{collections::BTreeSet, fs, path::Path};

use colab_playground_shared::i18n::CATALOGS;
use colab_playground_web::assets::{INDEX, STATIC_ASSETS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rule {
    CopyText,
    Color,
    Inline,
    ExternalScript,
    UnsafeDom,
}

use Rule::{Color, CopyText, ExternalScript, Inline, UnsafeDom};

type Hits = Vec<(usize, Rule)>;

fn end_quote(text: &str, quote: u8, escapes: bool) -> usize {
    let mut bytes = text.bytes().enumerate();
    while let Some((offset, byte)) = bytes.next() {
        if escapes && byte == b'\\' {
            bytes.next();
        } else if byte == quote {
            return offset + 1;
        }
    }
    text.len()
}

fn text_attr(name: &str) -> bool {
    matches!(
        name,
        "title"
            | "alt"
            | "placeholder"
            | "label"
            | "aria-label"
            | "aria-description"
            | "aria-valuetext"
            | "aria-roledescription"
    )
}

fn color_attr(name: &str) -> bool {
    matches!(
        name,
        "color" | "bgcolor" | "fill" | "stroke" | "stop-color" | "flood-color" | "lighting-color"
    )
}

fn markup(path: &str, source: &str) -> Hits {
    let mut hits = Vec::new();
    let mut rest = source;
    let mut in_title = false;
    let brand = CATALOGS[0]
        .1
        .iter()
        .find(|(key, _)| *key == "app.name")
        .unwrap()
        .1;
    let offset = |rest: &str| source.len() - rest.len();

    while !rest.is_empty() {
        if let Some(comment) = rest.strip_prefix("<!--") {
            rest = comment.split_once("-->").map_or("", |(_, tail)| tail);
            continue;
        }
        let Some(tag) = rest.strip_prefix('<') else {
            let end = rest.find('<').unwrap_or(rest.len());
            let text = rest[..end].trim();
            // The tab shows the product name while the locale catalog is still loading.
            if !text.is_empty() && !(path == "index.html" && in_title && text == brand) {
                hits.push((offset(rest), CopyText));
            }
            rest = &rest[end..];
            continue;
        };
        let end = tag
            .find(|ch: char| ch.is_ascii_whitespace() || matches!(ch, '/' | '>'))
            .unwrap_or(tag.len());
        let name = tag[..end].to_ascii_lowercase();
        in_title = name == "title";
        rest = &tag[end..];
        if name.is_empty() || name.starts_with('!') {
            rest = rest.split_once('>').map_or("", |(_, tail)| tail);
            continue;
        }

        let mut src = None;
        let mut input_type = None;
        let mut input_value = None;
        loop {
            rest = rest.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == '/');
            if rest.is_empty() || rest.starts_with('>') {
                break;
            }
            let at = offset(rest);
            let end = rest
                .find(|ch: char| ch.is_ascii_whitespace() || matches!(ch, '=' | '/' | '>'))
                .unwrap_or(rest.len());
            let attr = rest[..end].to_ascii_lowercase();
            if end == 0 {
                rest = &rest[1..];
                continue;
            }
            rest = rest[end..].trim_start();
            let mut value = "";
            if let Some(rhs) = rest.strip_prefix('=') {
                let rhs = rhs.trim_start();
                let end = match rhs.as_bytes().first() {
                    Some(&quote @ (b'\'' | b'"')) => {
                        let end = end_quote(&rhs[1..], quote, false) + 1;
                        let quoted = &rhs[1..end];
                        value = quoted.strip_suffix(char::from(quote)).unwrap_or(quoted);
                        end
                    }
                    _ => {
                        let end = rhs
                            .find(|ch: char| ch.is_ascii_whitespace() || ch == '>')
                            .unwrap_or(rhs.len());
                        value = &rhs[..end];
                        end
                    }
                };
                rest = &rhs[end..];
            }
            if attr == "style" || attr == "srcdoc" || attr.starts_with("on") || script_url(value) {
                hits.push((at, Inline));
            }
            if text_attr(&attr) && !value.trim().is_empty() {
                hits.push((at, CopyText));
            }
            // The standalone favicon is fixed artwork. Its two existing paints are its palette.
            let favicon_paint = path == "favicon.svg"
                && matches!(
                    (attr.as_str(), value),
                    ("fill", "#181613" | "#fcfaf7") | ("stroke", "#fcfaf7")
                );
            if color_attr(&attr) && !favicon_paint && has_color(&lex(value, false)) {
                hits.push((at, Color));
            }
            match attr.as_str() {
                "src" => src = src.or(Some(value)),
                "type" if name == "input" => input_type = input_type.or(Some(value)),
                "value" if name == "input" && !value.trim().is_empty() => input_value = Some(at),
                _ => {}
            }
        }
        if let Some(at) = input_value
            && !["hidden", "radio", "checkbox", "range", "color"]
                .iter()
                .any(|kind| input_type.is_some_and(|value| value.eq_ignore_ascii_case(kind)))
        {
            hits.push((at, CopyText));
        }
        rest = rest.strip_prefix('>').unwrap_or(rest);
        if matches!(name.as_str(), "script" | "style") {
            let close = format!("</{name}");
            let end = rest.to_ascii_lowercase().find(&close).unwrap_or(rest.len());
            let src_is_embedded = src.is_some_and(|src| {
                STATIC_ASSETS.iter().any(|asset| {
                    asset.path.ends_with(".js") && src.strip_prefix("/assets/") == Some(asset.path)
                })
            });
            if name == "style" || !rest[..end].trim().is_empty() || end == rest.len() {
                hits.push((offset(rest), Inline));
            } else if !src_is_embedded {
                hits.push((offset(tag), ExternalScript));
            }
            rest = &rest[end..];
        }
    }
    hits
}

fn script_url(value: &str) -> bool {
    value
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("javascript:")
}

#[derive(Clone, Copy)]
struct Token<'a> {
    text: &'a str,
    offset: usize,
}

impl<'a> Token<'a> {
    fn literal(self) -> Option<&'a str> {
        let quote = *self.text.as_bytes().first()?;
        if !matches!(quote, b'\'' | b'"' | b'`') || self.text.len() < 2 {
            return None;
        }
        Some(&self.text[1..self.text.len() - 1])
    }

    fn name(self) -> &'a str {
        self.literal().unwrap_or(self.text)
    }
}

fn word(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '-' | '$' | '\\')
}

fn lex(source: &str, js: bool) -> Vec<Token<'_>> {
    let mut tokens: Vec<Token<'_>> = Vec::new();
    let mut rest = source;
    while !rest.is_empty() {
        rest = rest.trim_start();
        let Some(ch) = rest.chars().next() else { break };
        if let Some(comment) = rest.strip_prefix("/*") {
            rest = comment.split_once("*/").map_or("", |(_, tail)| tail);
            continue;
        }
        if js && rest.starts_with("//") {
            rest = rest.split_once('\n').map_or("", |(_, tail)| tail);
            continue;
        }
        let len = match ch {
            '\'' | '"' => end_quote(&rest[1..], ch as u8, true) + 1,
            '`' if js => template(rest).0,
            '/' if js
                && tokens.last().is_none_or(|token| {
                    matches!(
                        token.text,
                        "(" | "," | "=" | "&" | "|" | "!" | "[" | ":" | "return"
                    )
                }) =>
            {
                end_quote(&rest[1..], b'/', true) + 1
            }
            '-' if js => 1,
            _ if word(ch) => rest
                .find(|c| !word(c) || js && c == '-')
                .unwrap_or(rest.len()),
            _ => ch.len_utf8(),
        };
        tokens.push(Token {
            text: &rest[..len],
            offset: source.len() - rest.len(),
        });
        rest = &rest[len..];
    }
    tokens
}

// Split a template into literal segments and interpolations without treating nested quotes as text.
fn template(source: &str) -> (usize, Vec<&str>) {
    let mut parts = Vec::new();
    let mut rest = &source[1..];
    let mut start = rest;
    while let Some(ch) = rest.chars().next() {
        match ch {
            '`' => {
                parts.push(&start[..start.len() - rest.len()]);
                return (source.len() - rest.len() + 1, parts);
            }
            '$' if rest.starts_with("${") => {
                parts.push(&start[..start.len() - rest.len()]);
                rest = &rest[2..];
                let mut depth = 1;
                while let Some(ch) = rest.chars().next() {
                    let len = match ch {
                        '\'' | '"' => end_quote(&rest[1..], ch as u8, true) + 1,
                        '`' => template(rest).0,
                        '{' => {
                            depth += 1;
                            1
                        }
                        '}' => {
                            depth -= 1;
                            1
                        }
                        _ => ch.len_utf8(),
                    };
                    rest = &rest[len..];
                    if depth == 0 {
                        break;
                    }
                }
                start = rest;
            }
            '\\' => {
                rest = &rest[1..];
                if let Some(next) = rest.chars().next() {
                    rest = &rest[next.len_utf8()..];
                }
            }
            _ => rest = &rest[ch.len_utf8()..],
        }
    }
    (source.len(), parts)
}

fn has_color(tokens: &[Token<'_>]) -> bool {
    // CSS named colors. Transparent, currentColor and system colors follow the environment.
    const NAMED: &str = "aliceblue antiquewhite aqua aquamarine azure beige bisque black         blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral         cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen         darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon         darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink         deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro         ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo         ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan         lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen         lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen         magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen         mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream         mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid         palegoldenrod palegreen paleturquoise palevioletred papayawhippuff peachpuff peru pink plum         powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown         seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen         steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen";
    const FUNCTIONS: &[&str] = &[
        "rgb",
        "rgba",
        "hsl",
        "hsla",
        "hwb",
        "lab",
        "lch",
        "oklab",
        "oklch",
        "color",
        "device-cmyk",
    ];
    let mut tokens = tokens.iter().peekable();
    while let Some(token) = tokens.next() {
        let next = tokens.peek().copied();
        if token.text.eq_ignore_ascii_case("url") && next.is_some_and(|next| next.text == "(") {
            for next in tokens.by_ref() {
                if next.text == ")" {
                    break;
                }
            }
            continue;
        }
        if token.text == "#"
            && next.is_some_and(|next| {
                next.offset == token.offset + 1
                    && matches!(next.text.len(), 3 | 4 | 6 | 8)
                    && next.text.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return true;
        }
        if FUNCTIONS
            .iter()
            .any(|name| token.text.eq_ignore_ascii_case(name))
            && next.is_some_and(|next| next.text == "(")
            || NAMED
                .split_ascii_whitespace()
                .any(|name| token.text.eq_ignore_ascii_case(name))
        {
            return true;
        }
    }
    false
}

fn prose(text: &str) -> bool {
    text.chars().any(char::is_alphabetic)
}

fn styles(path: &str, source: &str) -> Hits {
    let tokens = lex(source, false);
    let mut hits = Vec::new();
    let mut start = 0;
    let mut parens = 0;
    for (index, token) in tokens.iter().enumerate() {
        match token.text {
            "(" => parens += 1,
            ")" => parens -= 1,
            "{" if parens == 0 => start = index + 1,
            ";" | "}" if parens == 0 => {
                if let [property, Token { text: ":", .. }, value @ ..] = &tokens[start..index] {
                    let raw_token = path == "styles/tokens.css" && property.text.starts_with("--");
                    if !raw_token && has_color(value) {
                        hits.push((property.offset, Color));
                    }
                    if property.text.eq_ignore_ascii_case("content")
                        && value.iter().any(|token| token.literal().is_some_and(prose))
                    {
                        hits.push((property.offset, CopyText));
                    }
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    hits
}

fn top_level<'a, 's>(
    tokens: &'a [Token<'s>],
    separator: &'a str,
) -> impl Iterator<Item = &'a [Token<'s>]> {
    let mut depth = 0;
    tokens.split(move |token| match token.text {
        "(" | "[" | "{" => {
            depth += 1;
            false
        }
        ")" | "]" | "}" => {
            depth -= 1;
            depth < 0 && token.text == separator
        }
        text => depth == 0 && text == separator,
    })
}

fn enclosed<'a, 's>(tokens: &'a [Token<'s>]) -> &'a [Token<'s>] {
    let close = match tokens.first().map(|t| t.text) {
        Some("(") => ")",
        Some("[") => "]",
        Some("{") => "}",
        _ => return &[],
    };
    top_level(&tokens[1..], close).next().unwrap_or_default()
}

fn literal_copy(tokens: &[Token<'_>], hits: &mut Hits) {
    // A condition can compare a protocol value. Only the result reaches the DOM.
    let first = top_level(tokens, "?").next().unwrap_or_default();
    let result = tokens.get(first.len() + 1..).unwrap_or(first);
    for branch in top_level(result, ":") {
        if top_level(branch, "?")
            .next()
            .is_some_and(|part| part.len() < branch.len())
        {
            literal_copy(branch, hits);
            continue;
        }
        for term in top_level(branch, "|")
            .flat_map(|part| top_level(part, "&"))
            .flat_map(|part| top_level(part, "+"))
        {
            match term {
                [token] if token.literal().is_some() => {
                    let has_prose = if token.text.starts_with('`') {
                        template(token.text).1.into_iter().any(prose)
                    } else {
                        prose(token.name())
                    };
                    if has_prose {
                        hits.push((token.offset, CopyText));
                    }
                }
                [
                    Token {
                        text: "(" | "[", ..
                    },
                    ..,
                ] if matches!(term.last().unwrap().text, ")" | "]") => {
                    for part in top_level(enclosed(term), ",") {
                        literal_copy(part, hits);
                    }
                }
                _ => {}
            }
        }
    }
}

fn js_attr(key: Token<'_>, value: &[Token<'_>], hits: &mut Hits) {
    let name = key.name();
    let lower = name.to_ascii_lowercase();
    if text_attr(&lower) || matches!(name, "ariaLabel" | "confirmLabel" | "cancelLabel") {
        literal_copy(value, hits);
    }
    if let [token] = value
        && let Some(literal) = token.literal()
    {
        if lower.starts_with("on") || script_url(literal) {
            hits.push((key.offset, Inline));
        }
        if color_attr(&lower) && has_color(&lex(literal, false)) {
            hits.push((key.offset, Color));
        }
    }
    if matches!(lower.as_str(), "style" | "srcdoc") {
        hits.push((key.offset, Inline));
    }
}

fn script_element(tokens: &[Token<'_>]) -> bool {
    matches!(tokens, [tag] if tag.literal().is_some_and(|tag|
        tag.eq_ignore_ascii_case("script") || tag.eq_ignore_ascii_case("style")))
}

fn javascript(source: &str) -> Hits {
    let mut hits = Vec::new();
    let tokens = lex(source, true);
    for (index, &token) in tokens.iter().enumerate() {
        let tail = &tokens[index + 1..];
        let member = index > 0 && tokens[index - 1].text == ".";
        let bracket = index > 0
            && tokens[index - 1].text == "["
            && tail.first().is_some_and(|t| t.text == "]");
        let name = token.name();

        if matches!(
            name,
            "innerHTML" | "outerHTML" | "insertAdjacentHTML" | "EventSource"
        ) || (member || bracket) && name == "cookie"
        {
            hits.push((token.offset, UnsafeDom));
        }
        if (member || bracket) && name == "style" {
            hits.push((token.offset, Inline));
        }
        let tail = if bracket { &tail[1..] } else { tail };
        if (member || bracket)
            && let [Token { text: "=", .. }, value @ ..] = tail
        {
            let rhs = top_level(value, ";").next().unwrap_or_default();
            if matches!(name, "textContent" | "innerText") {
                literal_copy(rhs, &mut hits);
            }
            js_attr(token, rhs, &mut hits);
        }
        if !tail.first().is_some_and(|t| t.text == "(") {
            continue;
        }
        let args = || top_level(enclosed(tail), ",");
        match name {
            "el" => {
                let mut args = args();
                if args.next().is_some_and(script_element) {
                    hits.push((token.offset, Inline));
                }
                if let Some(attrs) = args
                    .next()
                    .filter(|attr| attr.first().is_some_and(|t| t.text == "{"))
                {
                    for property in top_level(enclosed(attrs), ",") {
                        if let [key, Token { text: ":", .. }, value @ ..] = property {
                            js_attr(*key, value, &mut hits);
                        }
                    }
                }
                for child in args {
                    literal_copy(child, &mut hits);
                }
            }
            "createElement" | "createElementNS" => {
                if args()
                    .nth(usize::from(name == "createElementNS"))
                    .is_some_and(script_element)
                {
                    hits.push((token.offset, Inline));
                }
            }
            "setAttribute" | "setAttributeNS" => {
                let mut args = args().skip(usize::from(name == "setAttributeNS"));
                if let (Some([key]), Some(value)) = (args.next(), args.next()) {
                    if key
                        .literal()
                        .is_some_and(|name| name.to_ascii_lowercase().starts_with("on"))
                    {
                        hits.push((key.offset, Inline));
                    } else if key.literal().is_some() {
                        js_attr(*key, value, &mut hits);
                    }
                }
            }
            "createTextNode" | "badge" | "announce" | "busyLine" | "alert" | "confirm" => {
                if let Some(text) = args().next() {
                    literal_copy(text, &mut hits);
                }
            }
            "append" | "prepend" | "replaceChildren" if member => {
                for text in args() {
                    literal_copy(text, &mut hits);
                }
            }
            "alertBox" | "toastCard" | "emptyState" | "inlineMessage" | "openConfirmDialog" => {
                if let Some(attrs) = args()
                    .next()
                    .filter(|attr| attr.first().is_some_and(|t| t.text == "{"))
                {
                    for property in top_level(enclosed(attrs), ",") {
                        if let [key, Token { text: ":", .. }, value @ ..] = property
                            && matches!(
                                key.name(),
                                "title" | "body" | "text" | "confirmLabel" | "cancelLabel"
                            )
                        {
                            literal_copy(value, &mut hits);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    hits
}

fn disk_assets(root: &Path, dir: &Path, files: &mut BTreeSet<String>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            disk_assets(root, &path, files);
        } else {
            files.insert(
                path.strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/"),
            );
        }
    }
}

#[test]
fn embedded_assets_follow_ui_rules() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let mut on_disk = BTreeSet::new();
    disk_assets(&root, &root, &mut on_disk);
    let mut scanned = BTreeSet::new();
    let mut diagnostics = Vec::new();
    for asset in std::iter::once(&INDEX).chain(STATIC_ASSETS) {
        assert!(
            scanned.insert(asset.path.to_owned()),
            "duplicate embedded path {}",
            asset.path
        );
        let hits = match asset.path.rsplit_once('.').map(|(_, ext)| ext) {
            Some("html" | "svg") => markup(asset.path, asset.body),
            Some("css") => styles(asset.path, asset.body),
            Some("js") => javascript(asset.body),
            _ => panic!("No asset scanner for {}", asset.path),
        };
        for (offset, rule) in hits {
            let line = 1 + asset.body[..offset].bytes().filter(|b| *b == b'\n').count();
            diagnostics.push(format!("{}:{line}: {rule:?}", asset.path));
        }
    }
    assert_eq!(scanned, on_disk, "asset files and embedded paths differ");
    assert!(
        diagnostics.is_empty(),
        "Embedded assets violate the UI rules:\n{}",
        diagnostics.join("\n")
    );
}

#[test]
fn markup_flags_visible_copy_colors_and_inline_code() {
    for (source, expected) in [
        ("<title>Welcome</title>", CopyText),
        ("<BODY class=login>\n<p>Sign in</p></BODY>", CopyText),
        ("<img alt = 'Model > details'>", CopyText),
        ("<INPUT PLACEHOLDER=Email>", CopyText),
        ("<input value='Send now' type=submit>", CopyText),
        ("<svg><path fill='rebeccapurple'/></svg>", Color),
        (
            "<SCRIPT\n SRC = '/assets/js/main.js'>noop()</SCRIPT>",
            Inline,
        ),
        ("<button OnPointerDown = 'noop()'></button>", Inline),
        ("<div style = 'display:block'></div>", Inline),
        ("<style>div{display:block}</style>", Inline),
        (
            "<script data-src='/assets/js/main.js'></script>",
            ExternalScript,
        ),
        (
            "<script src=//example.org/code.js></script>",
            ExternalScript,
        ),
    ] {
        assert_eq!(
            markup("index.html", source)
                .iter()
                .map(|hit| hit.1)
                .collect::<Vec<_>>(),
            [expected],
            "{source}"
        );
    }

    assert!(
        markup(
            "index.html",
            r#"
        <!-- <script>alert(1)</script> Example copy -->
        <input type=hidden value=internal>
        <div data-template="a>b"></div>
        <SCRIPT SRC = '/assets/js/main.js'></SCRIPT>
    "#
        )
        .is_empty()
    );
}

#[test]
fn css_flags_literal_colors_in_values_and_generated_copy() {
    for source in [
        "p { color: #abcf }",
        "p { box-shadow: 0 0 1px #AABBCC88; }",
        "p { color: /* keep this comment */\n RGB(255 0 0 / .5); }",
        "p { --other: var(--token, rebeccapurple) }",
        "p { background: linear-gradient(var(--token), hwb(10 30% 20%)) }",
        "p { background: color(display-p3 0.1 0.5 0.2) }",
    ] {
        assert_eq!(
            styles("main.css", source)
                .iter()
                .map(|hit| hit.1)
                .collect::<Vec<_>>(),
            [Color],
            "{source}"
        );
    }
    assert_eq!(
        styles("main.css", "a::after { content: ' Read more'; }"),
        [(11, CopyText)]
    );
    assert!(
        styles(
            "main.css",
            r#"
        /* color: red; #fff */
        #abc[data-mode="red"] { color: var(--raw-bg); fill: url(#abc); }
        a::after { content: "✓"; }
    "#
        )
        .is_empty()
    );
    assert!(styles("styles/tokens.css", ":root { --raw-bg: #abc; }").is_empty());
    assert_eq!(
        styles("styles/tokens.css", ":root { color: #abc; }"),
        [(8, Color)]
    );
}

#[test]
fn javascript_flags_literals_at_dom_and_component_calls() {
    for (source, expected) in [
        (
            r#"el("button", {className: "btn"}, "Save changes")"#,
            CopyText,
        ),
        (r#"el(tag, { "aria-label": "Open settings" })"#, CopyText),
        (
            r#"el("b", null, [t("ready"), enabled ? "Really ready" : null])"#,
            CopyText,
        ),
        (
            r#"node["textContent"] = error ? t("error") : `Welcome, ${user}`;"#,
            CopyText,
        ),
        (
            r#"node.textContent = ready ? t("ready") : pending ? t("pending") : "Try again";"#,
            CopyText,
        ),
        (
            r#"alertBox({ title: t("warning"), body: "Try again" })"#,
            CopyText,
        ),
        (
            r#"node.setAttribute("placeholder", "Enter a key")"#,
            CopyText,
        ),
        (r##"node.setAttribute("fill", "#abc")"##, Color),
        (r#"node.setAttribute("onfocus", handler)"#, Inline),
        (r#"el("button", {onClick: "noop()"})"#, Inline),
        (r#"document.createElement("script")"#, Inline),
        (r#"el("script", null, source)"#, Inline),
        (r#"node.style.color = t("color");"#, Inline),
        (r#"node ["innerHTML"] = source;"#, UnsafeDom),
    ] {
        assert_eq!(
            javascript(source)
                .iter()
                .map(|hit| hit.1)
                .collect::<Vec<_>>(),
            [expected],
            "{source}"
        );
    }

    assert!(
        javascript(
            r#"
        // node.textContent = "Copy"
        /* element.innerHTML = "ignored" */
        const url = "https://example.org";
        const match = /^\d+$/.test(value);
        el("button", {className: "btn", onClick: () => run()}, t("submit"));
        node.textContent = `${format(t("ready"))} · ${count}`;
        node.setAttribute("stroke", "currentColor");
    "#
        )
        .is_empty()
    );
}
