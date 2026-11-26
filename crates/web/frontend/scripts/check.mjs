import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(FRONTEND_ROOT, "src");
const PUBLIC_DIR = path.join(FRONTEND_ROOT, "public");
const GENERATED_DIR = path.join(FRONTEND_ROOT, ".generated");
const I18N_MANIFEST = path.join(GENERATED_DIR, "i18n-keys.json");

const ALLOWED_TITLE = "Colab Playground";
const TOKENS_CSS_REL = "src/styles/tokens.css";
const FAVICON_SVG_REL = "public/favicon.svg";

const TEXT_ATTRS = new Set([
  "title",
  "alt",
  "placeholder",
  "label",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-roledescription",
]);

const COLOR_ATTRS = new Set([
  "color",
  "bgcolor",
  "fill",
  "stroke",
  "stop-color",
  "stopcolor",
  "flood-color",
  "floodcolor",
  "lighting-color",
  "lightingcolor",
]);

const HIDDEN_INPUT_TYPES = new Set([
  "hidden",
  "radio",
  "checkbox",
  "range",
  "color",
]);

const UNSAFE_DOM_NAMES = new Set([
  "dangerouslySetInnerHTML",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "srcdoc",
]);

const CSS_COLOR_FUNCTIONS = new Set([
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
]);

const CSS_NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black
  blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
  cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen
  darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
  darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
  deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
  ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo
  ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`
    .trim()
    .split(/\s+/),
);

const PROSE_RE = /\p{L}/u;
const HEX_COLOR_RE =
  /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F_-])/;

/** @typedef {{ file: string, line: number, rule: string, message: string }} Finding */
/** @typedef {{ parent: Scope | null, constInits: Map<string, ts.Expression>, finiteTables: Map<string, string[]> }} Scope */

/** @type {Finding[]} */
const findings = [];
/** @type {Set<string>} */
const i18nKeys = new Set();

function relPath(absPath) {
  return path.relative(FRONTEND_ROOT, absPath).split(path.sep).join("/");
}

function lineOfOffset(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function report(file, line, rule, message) {
  findings.push({ file, line, rule, message });
}

function reportNode(sourceFile, node, rule, message) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  report(relPath(sourceFile.fileName), line + 1, rule, message);
}

function isProse(text) {
  return PROSE_RE.test(text);
}

function isJavascriptUrl(text) {
  return text.trimStart().toLowerCase().startsWith("javascript:");
}

function stripCssUrls(value) {
  return value.replace(/url\s*\([^)]*\)/gi, "url()");
}

function hasHardcodedColor(value) {
  const cleaned = stripCssUrls(value);
  if (HEX_COLOR_RE.test(cleaned)) {
    return true;
  }
  const fnRe = /\b([a-zA-Z-]+)\s*\(/g;
  let match;
  while ((match = fnRe.exec(cleaned)) !== null) {
    if (CSS_COLOR_FUNCTIONS.has(match[1].toLowerCase())) {
      return true;
    }
  }
  // Ignore custom property names like --color-red or identifiers containing hyphens.
  const wordRe = /(?<![-\w])([a-zA-Z]+)(?![-\w])/g;
  while ((match = wordRe.exec(cleaned)) !== null) {
    if (CSS_NAMED_COLORS.has(match[1].toLowerCase())) {
      return true;
    }
  }
  return false;
}

function walkFiles(dir, exts) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out.sort();
}

function maskPreservingNewlines(source, regex) {
  return source.replace(regex, (match) => match.replace(/[^\n]/g, " "));
}

function checkMarkup(absPath) {
  const file = relPath(absPath);
  const raw = fs.readFileSync(absPath, "utf8");
  const source = maskPreservingNewlines(raw, /<!--[\s\S]*?-->/g);
  const isFavicon = file === FAVICON_SVG_REL;

  let cursor = 0;
  let inTitle = false;
  while (cursor < source.length) {
    const lt = source.indexOf("<", cursor);
    if (lt === -1) {
      const tail = source.slice(cursor).trim();
      if (tail && !isFavicon && !(file === "index.html" && inTitle && tail === ALLOWED_TITLE)) {
        report(file, lineOfOffset(source, cursor), "copy-text", `hardcoded text "${tail}"`);
      }
      break;
    }
    if (lt > cursor) {
      const text = source.slice(cursor, lt).trim();
      if (text && !isFavicon && !(file === "index.html" && inTitle && text === ALLOWED_TITLE)) {
        report(file, lineOfOffset(source, cursor), "copy-text", `hardcoded text "${text}"`);
      }
    }
    const gt = source.indexOf(">", lt + 1);
    if (gt === -1) {
      break;
    }
    const tagText = source.slice(lt + 1, gt);
    const trimmedTag = tagText.trim();
    if (!trimmedTag || trimmedTag.startsWith("!") || trimmedTag.startsWith("?")) {
      cursor = gt + 1;
      continue;
    }
    if (trimmedTag.startsWith("/")) {
      const closeName = trimmedTag.slice(1).trim().toLowerCase();
      if (closeName === "title") {
        inTitle = false;
      }
      cursor = gt + 1;
      continue;
    }

    const nameMatch = /^([a-zA-Z0-9:-]+)/.exec(trimmedTag);
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : "";
    inTitle = tagName === "title";
    const attrsSource = tagText.slice(
      tagText.indexOf(nameMatch ? nameMatch[1] : "") + tagName.length,
    );

    let scriptSrc = null;
    let inputType = "";
    let inputValueLine = null;

    const attrRe = /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrsSource)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
      const attrLine = lineOfOffset(source, lt + 1 + attrMatch.index);

      if (attrName === "style" || attrName === "srcdoc" || attrName.startsWith("on")) {
        report(file, attrLine, "inline-html", `forbidden attribute "${attrName}"`);
      }
      if (isJavascriptUrl(attrVal)) {
        report(file, attrLine, "javascript-url", `forbidden javascript: URL in "${attrName}"`);
      }
      if (TEXT_ATTRS.has(attrName) && attrVal.trim() !== "") {
        report(file, attrLine, "copy-text", `hardcoded text attribute "${attrName}"`);
      }
      if (!isFavicon && COLOR_ATTRS.has(attrName) && hasHardcodedColor(attrVal)) {
        report(file, attrLine, "color", `hardcoded color in "${attrName}"`);
      }
      if (attrName === "src") {
        scriptSrc = attrVal;
      }
      if (tagName === "input" && attrName === "type") {
        inputType = attrVal.toLowerCase();
      }
      if (tagName === "input" && attrName === "value" && attrVal.trim() !== "") {
        inputValueLine = attrLine;
      }
    }

    if (inputValueLine !== null && !HIDDEN_INPUT_TYPES.has(inputType)) {
      report(file, inputValueLine, "copy-text", "hardcoded visible input value");
    }

    cursor = gt + 1;
    if (tagName === "style" || tagName === "script") {
      const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
      const rest = source.slice(cursor);
      const closeMatch = closeRe.exec(rest);
      const body = closeMatch ? rest.slice(0, closeMatch.index) : rest;
      const tagLine = lineOfOffset(source, lt);

      if (tagName === "style") {
        report(file, tagLine, "inline-html", "inline <style> element is forbidden");
      } else {
        if (body.trim() !== "" || !closeMatch) {
          report(file, tagLine, "inline-html", "inline <script> body is forbidden");
        }
        if (!scriptSrc) {
          report(file, tagLine, "inline-html", "<script> must specify a same-origin src");
        } else if (
          !/^(?:\/(?!\/)|\.\/|%BASE_URL%)/.test(scriptSrc) ||
          isJavascriptUrl(scriptSrc)
        ) {
          report(
            file,
            tagLine,
            "external-script",
            `<script src="${scriptSrc}"> must be a same-origin asset`,
          );
        }
      }
      if (closeMatch) {
        cursor += closeMatch.index + closeMatch[0].length;
      } else {
        break;
      }
    }
  }
}

function extractCssStringLiterals(value) {
  /** @type {string[]} */
  const strings = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match;
  while ((match = re.exec(value)) !== null) {
    strings.push(match[1] ?? match[2] ?? "");
  }
  return strings;
}

function checkCss(absPath) {
  const file = relPath(absPath);
  const raw = fs.readFileSync(absPath, "utf8");
  const source = maskPreservingNewlines(raw, /\/\*[\s\S]*?\*\//g);
  const isTokens = file === TOKENS_CSS_REL;

  let parenDepth = 0;
  let quote = null;
  let declStart = 0;
  let insideRule = false;

  const inspectDecl = (start, end) => {
    const slice = source.slice(start, end);
    const trimmed = slice.trim();
    if (!trimmed || trimmed.startsWith("@")) {
      return;
    }
    const colon = slice.indexOf(":");
    if (colon === -1) {
      return;
    }
    const prop = slice.slice(0, colon).trim();
    const val = slice.slice(colon + 1).trim();
    if (!prop || !/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(prop)) {
      return;
    }
    const line = lineOfOffset(source, start + slice.indexOf(prop));
    const lowerProp = prop.toLowerCase();

    if (lowerProp === "content") {
      for (const literal of extractCssStringLiterals(val)) {
        if (isProse(literal)) {
          report(file, line, "css-content", `hardcoded prose in CSS content: "${literal}"`);
        }
      }
    }

    const allowTokenColor = isTokens && prop.startsWith("--");
    if (!allowTokenColor && hasHardcodedColor(val)) {
      report(file, line, "color", `hardcoded color in CSS property "${prop}: ${val}"`);
    }
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (parenDepth === 0) {
      if (ch === "{") {
        insideRule = true;
        declStart = i + 1;
      } else if (ch === ";") {
        if (insideRule) {
          inspectDecl(declStart, i);
        }
        declStart = i + 1;
      } else if (ch === "}") {
        if (insideRule) {
          inspectDecl(declStart, i);
        }
        declStart = i + 1;
      }
    }
  }
}

function unwrapExpression(expr) {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function getStaticString(expr) {
  const unwrapped = unwrapExpression(expr);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  return null;
}

/**
 * @param {Scope | null} parent
 * @returns {Scope}
 */
function createScope(parent) {
  return { parent, constInits: new Map(), finiteTables: new Map() };
}

function recordConstDeclList(scope, list) {
  if ((list.flags & ts.NodeFlags.Const) === 0) {
    return;
  }
  for (const decl of list.declarations) {
    if (!ts.isIdentifier(decl.name) || !decl.initializer) {
      continue;
    }
    const init = unwrapExpression(decl.initializer);
    scope.constInits.set(decl.name.text, init);
    if (ts.isObjectLiteralExpression(init)) {
      /** @type {string[]} */
      const values = [];
      let allStrings = init.properties.length > 0;
      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) {
          allStrings = false;
          break;
        }
        const str = getStaticString(prop.initializer);
        if (str === null) {
          allStrings = false;
          break;
        }
        values.push(str);
      }
      if (allStrings) {
        scope.finiteTables.set(decl.name.text, values);
      }
    } else if (ts.isArrayLiteralExpression(init)) {
      /** @type {string[]} */
      const values = [];
      let allStrings = init.elements.length > 0;
      for (const elem of init.elements) {
        const str = getStaticString(elem);
        if (str === null) {
          allStrings = false;
          break;
        }
        values.push(str);
      }
      if (allStrings) {
        scope.finiteTables.set(decl.name.text, values);
      }
    }
  }
}

function populateStatementScope(scope, statements) {
  for (const stmt of statements) {
    if (ts.isVariableStatement(stmt)) {
      recordConstDeclList(scope, stmt.declarationList);
    }
  }
}

/**
 * @param {Scope | null} scope
 * @param {string} name
 * @returns {{ expr: ts.Expression, scope: Scope } | undefined}
 */
function lookupConstInit(scope, name) {
  for (let cur = scope; cur; cur = cur.parent) {
    const expr = cur.constInits.get(name);
    if (expr) {
      return { expr, scope: cur };
    }
  }
  return undefined;
}

function lookupFiniteTable(scope, name) {
  for (let cur = scope; cur; cur = cur.parent) {
    if (cur.finiteTables.has(name)) {
      return cur.finiteTables.get(name);
    }
  }
  return undefined;
}

function checkRenderedStrings(expr, onLiteral) {
  const node = unwrapExpression(expr);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    onLiteral(node, node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    onLiteral(node, node.head.text);
    for (const span of node.templateSpans) {
      checkRenderedStrings(span.expression, onLiteral);
      onLiteral(span.literal, span.literal.text);
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    checkRenderedStrings(node.whenTrue, onLiteral);
    checkRenderedStrings(node.whenFalse, onLiteral);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      checkRenderedStrings(node.left, onLiteral);
      checkRenderedStrings(node.right, onLiteral);
    } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      checkRenderedStrings(node.right, onLiteral);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const elem of node.elements) {
      checkRenderedStrings(elem, onLiteral);
    }
  }
}

function checkNoProseInExpr(sourceFile, expr, context) {
  checkRenderedStrings(expr, (literalNode, text) => {
    if (isProse(text)) {
      reportNode(
        sourceFile,
        literalNode,
        "copy-text",
        `hardcoded visible copy in ${context}: "${text}"`,
      );
    }
  });
}

function checkNoJavascriptUrlInExpr(sourceFile, expr, context) {
  checkRenderedStrings(expr, (literalNode, text) => {
    if (isJavascriptUrl(text)) {
      reportNode(
        sourceFile,
        literalNode,
        "javascript-url",
        `forbidden javascript: URL in ${context}`,
      );
    }
  });
}

function checkNoColorInExpr(sourceFile, expr, context, scope, seen = new Set()) {
  const node = unwrapExpression(expr);
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        checkNoColorInExpr(sourceFile, prop.initializer, context, scope, seen);
      } else if (ts.isSpreadAssignment(prop)) {
        checkNoColorInExpr(sourceFile, prop.expression, context, scope, seen);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        checkNoColorInExpr(sourceFile, prop.name, context, scope, seen);
      }
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    checkNoColorInExpr(sourceFile, node.whenTrue, context, scope, seen);
    checkNoColorInExpr(sourceFile, node.whenFalse, context, scope, seen);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      checkNoColorInExpr(sourceFile, node.left, context, scope, seen);
      checkNoColorInExpr(sourceFile, node.right, context, scope, seen);
    } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      checkNoColorInExpr(sourceFile, node.right, context, scope, seen);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const elem of node.elements) {
      checkNoColorInExpr(sourceFile, elem, context, scope, seen);
    }
    return;
  }
  if (ts.isIdentifier(node)) {
    const binding = lookupConstInit(scope, node.text);
    if (binding && !seen.has(binding.expr)) {
      const nextSeen = new Set(seen);
      nextSeen.add(binding.expr);
      checkNoColorInExpr(sourceFile, binding.expr, context, binding.scope, nextSeen);
      return;
    }
  }
  checkRenderedStrings(node, (literalNode, text) => {
    if (hasHardcodedColor(text)) {
      reportNode(sourceFile, literalNode, "color", `hardcoded color in ${context}: "${text}"`);
    }
  });
}

function isServerProvidedKeyExpr(expr) {
  const node = unwrapExpression(expr);
  if (ts.isPropertyAccessExpression(node)) {
    const name = node.name.text;
    return name === "key" || name.endsWith("_key");
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const prop = getStaticString(node.argumentExpression);
    return prop !== null && (prop === "key" || prop.endsWith("_key"));
  }
  return false;
}

function extractI18nKeysFromExpr(sourceFile, expr, scope, seen = new Set()) {
  const node = unwrapExpression(expr);
  const literal = getStaticString(node);
  if (literal !== null) {
    i18nKeys.add(literal);
    return true;
  }
  if (ts.isConditionalExpression(node)) {
    const a = extractI18nKeysFromExpr(sourceFile, node.whenTrue, scope, seen);
    const b = extractI18nKeysFromExpr(sourceFile, node.whenFalse, scope, seen);
    return a && b;
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const a = extractI18nKeysFromExpr(sourceFile, node.left, scope, seen);
    const b = extractI18nKeysFromExpr(sourceFile, node.right, scope, seen);
    return a && b;
  }
  if (ts.isElementAccessExpression(node)) {
    const target = unwrapExpression(node.expression);
    if (ts.isIdentifier(target)) {
      const table = lookupFiniteTable(scope, target.text);
      if (table) {
        for (const key of table) {
          i18nKeys.add(key);
        }
        return true;
      }
    }
  }
  if (ts.isIdentifier(node)) {
    const binding = lookupConstInit(scope, node.text);
    if (binding && !seen.has(binding.expr)) {
      const nextSeen = new Set(seen);
      nextSeen.add(binding.expr);
      return extractI18nKeysFromExpr(sourceFile, binding.expr, binding.scope, nextSeen);
    }
  }
  if (isServerProvidedKeyExpr(node)) {
    return true;
  }
  reportNode(
    sourceFile,
    node,
    "i18n-dynamic-key",
    "t(...) key must be a string literal, an explicit const finite lookup table, or a server-provided *_key field",
  );
  return false;
}

function isWindowGlobal(expr) {
  const node = unwrapExpression(expr);
  return (
    ts.isIdentifier(node) &&
    (node.text === "window" || node.text === "globalThis" || node.text === "self")
  );
}

function getPropertyName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return getStaticString(node.argumentExpression);
  }
  return null;
}

function checkScript(absPath) {
  const source = fs.readFileSync(absPath, "utf8");
  const ext = path.extname(absPath);
  const scriptKind =
    ext === ".tsx"
      ? ts.ScriptKind.TSX
      : ext === ".ts"
        ? ts.ScriptKind.TS
        : ext === ".jsx"
          ? ts.ScriptKind.JSX
          : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  /**
   * @param {ts.Node} node
   * @param {Scope} scope
   */
  function visit(node, scope) {
    let activeScope = scope;
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      activeScope = createScope(scope);
      populateStatementScope(activeScope, node.statements);
    } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      activeScope = createScope(scope);
      populateStatementScope(activeScope, node.statements);
    } else if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node)
    ) {
      activeScope = createScope(scope);
      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        recordConstDeclList(activeScope, node.initializer);
      }
    }

    // Dangerous property/element accesses: innerHTML, outerHTML, insertAdjacentHTML, srcdoc, cookie, window.open
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const prop = getPropertyName(node);
      if (prop && UNSAFE_DOM_NAMES.has(prop)) {
        reportNode(sourceFile, node, "unsafe-dom", `forbidden DOM property "${prop}"`);
      }
      if (prop === "cookie") {
        reportNode(sourceFile, node, "unsafe-dom", "document.cookie access is forbidden");
      }
      if (prop === "open" && isWindowGlobal(node.expression)) {
        reportNode(
          sourceFile,
          node,
          "window-open",
          'window.open is forbidden; render a clickable <a target="_blank" rel="noopener noreferrer">',
        );
      }
      if (
        (prop === "write" || prop === "writeln") &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "document"
      ) {
        reportNode(sourceFile, node, "unsafe-dom", `document.${prop} is forbidden`);
      }
      if (prop === "eval" && isWindowGlobal(node.expression)) {
        reportNode(sourceFile, node, "eval", "eval is forbidden");
      }
    }

    // Direct calls: eval, Function, EventSource, createElement("script"|"style"), setAttribute, t(...)
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const args = node.arguments ?? [];

      if (ts.isIdentifier(callee)) {
        if (callee.text === "eval") {
          reportNode(sourceFile, node, "eval", "eval(...) is forbidden");
        } else if (callee.text === "Function") {
          reportNode(sourceFile, node, "eval", "Function(...) constructor is forbidden");
        } else if (callee.text === "EventSource") {
          reportNode(
            sourceFile,
            node,
            "unsafe-dom",
            "EventSource is forbidden; use fetch with Bearer header",
          );
        } else if (callee.text === "t" && ts.isCallExpression(node) && args.length >= 1) {
          extractI18nKeysFromExpr(sourceFile, args[0], activeScope);
        }
      } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const method = getPropertyName(callee);
        if (
          method === "t" &&
          ts.isCallExpression(node) &&
          args.length >= 1 &&
          ts.isIdentifier(callee.expression) &&
          (callee.expression.text === "i18n" || callee.expression.text === "props")
        ) {
          extractI18nKeysFromExpr(sourceFile, args[0], activeScope);
        } else if (method === "createElement" || method === "createElementNS") {
          const tagArg = args[method === "createElementNS" ? 1 : 0];
          const tag = tagArg ? getStaticString(tagArg)?.toLowerCase() : null;
          if (tag === "script" || tag === "style") {
            reportNode(
              sourceFile,
              node,
              "inline-html",
              `creating <${tag}> dynamically is forbidden`,
            );
          }
        } else if (method === "setAttribute" || method === "setAttributeNS") {
          const offset = method === "setAttributeNS" ? 1 : 0;
          const nameArg = args[offset];
          const valArg = args[offset + 1];
          const attrName = nameArg ? getStaticString(nameArg)?.toLowerCase() : null;
          if (attrName) {
            if (attrName === "style" || attrName === "srcdoc" || attrName.startsWith("on")) {
              reportNode(
                sourceFile,
                node,
                "inline-html",
                `setAttribute("${attrName}", ...) is forbidden`,
              );
            }
            if (valArg) {
              checkNoJavascriptUrlInExpr(sourceFile, valArg, `setAttribute("${attrName}")`);
              if (TEXT_ATTRS.has(attrName)) {
                checkNoProseInExpr(sourceFile, valArg, `setAttribute("${attrName}")`);
              }
              if (COLOR_ATTRS.has(attrName)) {
                checkNoColorInExpr(sourceFile, valArg, `setAttribute("${attrName}")`, activeScope);
              }
            }
          }
        }
      }
    }

    // Assignments to textContent, innerText, document.title, href, src, action, style
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      const lhs = node.left;
      if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) {
        const prop = getPropertyName(lhs);
        if (prop === "textContent" || prop === "innerText") {
          checkNoProseInExpr(sourceFile, node.right, prop);
        } else if (
          prop === "title" &&
          ts.isIdentifier(lhs.expression) &&
          lhs.expression.text === "document"
        ) {
          checkNoProseInExpr(sourceFile, node.right, "document.title");
        } else if (prop === "href" || prop === "src" || prop === "action") {
          checkNoJavascriptUrlInExpr(sourceFile, node.right, prop);
        } else if (prop === "style") {
          reportNode(sourceFile, node, "inline-html", "direct .style assignment violates CSP");
        } else if (
          (ts.isPropertyAccessExpression(lhs.expression) ||
            ts.isElementAccessExpression(lhs.expression)) &&
          getPropertyName(lhs.expression) === "style"
        ) {
          checkNoColorInExpr(sourceFile, node.right, "inline style", activeScope);
        }
      }
    }

    // JSX elements: <script>, <style>, attributes, text children, expression children
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = ts.isIdentifier(node.tagName) ? node.tagName.text : "";
      const lowerTag = tagName.toLowerCase();
      if (lowerTag === "script" || lowerTag === "style") {
        reportNode(sourceFile, node, "inline-html", `JSX <${tagName}> element is forbidden`);
      }

      let inputType = "";
      /** @type {ts.JsxAttribute[]} */
      const visibleValueAttrs = [];

      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) {
          continue;
        }
        const attrName = attr.name.getText(sourceFile);
        const lowerAttr = attrName.toLowerCase();

        if (UNSAFE_DOM_NAMES.has(attrName) || lowerAttr === "srcdoc") {
          reportNode(sourceFile, attr, "unsafe-dom", `JSX attribute "${attrName}" is forbidden`);
        }

        const init = attr.initializer;
        if (!init) {
          continue;
        }

        if (lowerAttr === "type" && lowerTag === "input") {
          if (ts.isStringLiteral(init)) {
            inputType = init.text.toLowerCase();
          } else if (ts.isJsxExpression(init) && init.expression) {
            inputType = (getStaticString(init.expression) ?? "").toLowerCase();
          }
        }
        if (lowerAttr === "value" || lowerAttr === "defaultvalue") {
          visibleValueAttrs.push(attr);
        }

        if (lowerAttr.startsWith("on") && ts.isStringLiteral(init)) {
          reportNode(
            sourceFile,
            attr,
            "inline-html",
            `string event handler "${attrName}" is forbidden`,
          );
        }

        if (lowerAttr === "style") {
          if (ts.isStringLiteral(init)) {
            reportNode(sourceFile, attr, "inline-html", "string style attribute is forbidden");
          } else if (ts.isJsxExpression(init) && init.expression) {
            checkNoColorInExpr(sourceFile, init.expression, "JSX style", activeScope);
          }
        }

        if (ts.isStringLiteral(init)) {
          if (isJavascriptUrl(init.text)) {
            reportNode(
              sourceFile,
              init,
              "javascript-url",
              `forbidden javascript: URL in "${attrName}"`,
            );
          }
          if (TEXT_ATTRS.has(lowerAttr) && isProse(init.text)) {
            reportNode(sourceFile, init, "copy-text", `hardcoded text attribute "${attrName}"`);
          }
          if (COLOR_ATTRS.has(lowerAttr) && hasHardcodedColor(init.text)) {
            reportNode(sourceFile, init, "color", `hardcoded color in "${attrName}"`);
          }
        } else if (ts.isJsxExpression(init) && init.expression) {
          checkNoJavascriptUrlInExpr(sourceFile, init.expression, `JSX attribute "${attrName}"`);
          if (TEXT_ATTRS.has(lowerAttr)) {
            checkNoProseInExpr(sourceFile, init.expression, `JSX attribute "${attrName}"`);
          }
          if (COLOR_ATTRS.has(lowerAttr)) {
            checkNoColorInExpr(
              sourceFile,
              init.expression,
              `JSX attribute "${attrName}"`,
              activeScope,
            );
          }
        }
      }

      if (
        visibleValueAttrs.length > 0 &&
        (lowerTag === "textarea" || (lowerTag === "input" && !HIDDEN_INPUT_TYPES.has(inputType)))
      ) {
        for (const valueAttr of visibleValueAttrs) {
          const init = valueAttr.initializer;
          if (!init) {
            continue;
          }
          const attrName = valueAttr.name.getText(sourceFile);
          if (ts.isStringLiteral(init) && isProse(init.text)) {
            reportNode(
              sourceFile,
              init,
              "copy-text",
              `hardcoded visible ${attrName} on <${tagName}>`,
            );
          } else if (ts.isJsxExpression(init) && init.expression) {
            checkNoProseInExpr(sourceFile, init.expression, `<${tagName} ${attrName}>`);
          }
        }
      }
    }

    // JSX text children
    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) {
      const trimmed = node.getText(sourceFile).trim();
      if (isProse(trimmed)) {
        reportNode(sourceFile, node, "copy-text", `hardcoded JSX text: "${trimmed}"`);
      }
    }

    // JSX expression children (direct children of JsxElement or JsxFragment)
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      checkNoProseInExpr(sourceFile, node.expression, "JSX child");
    }

    ts.forEachChild(node, (child) => visit(child, activeScope));
  }

  visit(sourceFile, createScope(null));
}

// 1. Check HTML & SVG markup
checkMarkup(path.join(FRONTEND_ROOT, "index.html"));
for (const svg of walkFiles(PUBLIC_DIR, [".svg"])) {
  checkMarkup(svg);
}

// 2. Check CSS files
for (const cssFile of walkFiles(SRC_DIR, [".css"])) {
  checkCss(cssFile);
}

// 3. Check TypeScript / TSX / JS files (including synchronous theme-init.js), excluding unit tests.
const isTestFile = (absPath) => /\.test\.[cm]?[jt]sx?$/.test(absPath);
const allSrcScripts = walkFiles(SRC_DIR, [".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const testFiles = allSrcScripts.filter(isTestFile);
const scriptFiles = [
  ...walkFiles(PUBLIC_DIR, [".js", ".mjs"]),
  ...allSrcScripts.filter((file) => !isTestFile(file)),
];
for (const scriptFile of scriptFiles) {
  checkScript(scriptFile);
}

if (findings.length > 0) {
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: [${f.rule}] ${f.message}`);
  }
  process.exit(1);
}

fs.mkdirSync(GENERATED_DIR, { recursive: true });
const sortedKeys = [...i18nKeys].sort();
fs.writeFileSync(I18N_MANIFEST, `${JSON.stringify({ keys: sortedKeys }, null, 2)}\n`, "utf8");
console.log(
  `Frontend static check passed (${scriptFiles.length} script(s), ${sortedKeys.length} i18n key(s) written to ${relPath(I18N_MANIFEST)}).`,
);

// 4. Run pure frontend state unit tests via Node's built-in test runner.
if (testFiles.length > 0) {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: FRONTEND_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
