use std::{
    env,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

const BUILD_HELP: &str = "pnpm --dir crates/web/frontend install --frozen-lockfile && pnpm --dir crates/web/frontend run build";

fn content_type(rel_path: &str) -> &'static str {
    match Path::new(rel_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => panic!("Unsupported frontend asset extension in crates/web/frontend/dist/{rel_path}"),
    }
}

fn normalized_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .expect("asset lies inside dist/")
        .components()
        .map(|part| part.as_os_str().to_str().expect("UTF-8 asset path"))
        .collect::<Vec<_>>()
        .join("/")
}

fn walk_dist(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", dir.display()))
        .map(|entry| entry.expect("readable dist entry").path())
        .collect();
    entries.sort();

    for path in entries {
        if path.is_dir() {
            walk_dist(root, &path, out);
        } else if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            let rel = normalized_relative(root, &path);
            if rel == "i18n" || rel.starts_with("i18n/") {
                panic!(
                    "Unexpected file under dist/i18n ({rel}): /assets/i18n/{{file}} is reserved for Rust's merged dictionary route."
                );
            }
            out.push((rel, path));
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist_dir = manifest_dir.join("frontend").join("dist");
    let index_path = dist_dir.join("index.html");

    println!("cargo:rerun-if-changed={}", dist_dir.display());
    println!("cargo:rerun-if-changed={}", index_path.display());

    if !index_path.is_file() {
        panic!(
            "Missing pre-built web frontend at {}.\n\
             Cargo never invokes pnpm during build. Build the frontend first:\n  {BUILD_HELP}",
            index_path.display()
        );
    }

    let mut files = Vec::new();
    walk_dist(&dist_dir, &dist_dir, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let favicon_path = files
        .iter()
        .find(|(rel, _)| rel == "favicon.svg")
        .map(|(_, abs)| abs.clone())
        .unwrap_or_else(|| {
            panic!(
                "Missing required favicon at {}.\nRebuild the frontend:\n  {BUILD_HELP}",
                dist_dir.join("favicon.svg").display()
            )
        });

    let mut generated = String::new();
    let index_abs = index_path.to_str().expect("UTF-8 index.html path");
    let favicon_abs = favicon_path.to_str().expect("UTF-8 favicon.svg path");

    writeln!(
        generated,
        "/// The HTML document served at `/`.\n\
         pub const INDEX: Asset = Asset {{\n\
             path: \"index.html\",\n\
             content_type: \"text/html; charset=utf-8\",\n\
             body: include_bytes!({index_abs:?}),\n\
         }};\n"
    )
    .unwrap();

    writeln!(
        generated,
        "/// The SVG icon served at `/assets/favicon.svg` and `/favicon.ico`.\n\
         pub const FAVICON: Asset = Asset {{\n\
             path: \"favicon.svg\",\n\
             content_type: \"image/svg+xml\",\n\
             body: include_bytes!({favicon_abs:?}),\n\
         }};\n"
    )
    .unwrap();

    writeln!(
        generated,
        "/// Every pre-built static file served under `/assets/{{path}}`.\n\
         pub const STATIC_ASSETS: &[Asset] = &["
    )
    .unwrap();

    for (rel, abs) in &files {
        if rel == "index.html" {
            continue;
        }
        if rel == "favicon.svg" {
            writeln!(generated, "    FAVICON,").unwrap();
            continue;
        }
        let mime = content_type(rel);
        let abs_str = abs.to_str().expect("UTF-8 asset path");
        writeln!(
            generated,
            "    Asset {{\n\
                 path: {rel:?},\n\
                 content_type: {mime:?},\n\
                 body: include_bytes!({abs_str:?}),\n\
             }},"
        )
        .unwrap();
    }
    writeln!(generated, "];").unwrap();

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("embedded_assets.rs"), generated)
        .expect("write OUT_DIR/embedded_assets.rs");
}
