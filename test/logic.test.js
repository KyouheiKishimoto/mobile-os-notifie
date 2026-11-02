const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = {};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../apps-script/Logic.gs"), "utf8"),
  context
);

const now = new Date("2026-11-02T00:00:00Z");
let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  console.log("ok", name);
}

check("Apple のRSSからリリースノートURLを取る", function () {
  const xml = fs.readFileSync(path.join(__dirname, "fixtures/apple-snippet.xml"), "utf8");
  const items = context.parseFeed(xml);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, "iOS 27.2 (24B91020)");
  assert.strictEqual(items[0].id, "https://developer.apple.com/news/releases/?id=10262026a");
  assert.strictEqual(items[0].notesLink, "https://developer.apple.com/go/?id=ios-27_2-rn");
  assert.strictEqual(items[0].summary, "");
  assert.strictEqual(items[0].published, "Mon, 26 Oct 2026 10:00:00 PDT");
});

check("iOS と iPadOS は別々に指定し、Xcode は拾わない", function () {
  assert.strictEqual(context.titleMatches("iPadOS 27.2 (24B119)", ["iOS"]), false);
  assert.strictEqual(context.titleMatches("iPadOS 27.2 (24B119)", ["iOS", "iPadOS"]), true);
  assert.strictEqual(context.titleMatches("iOS 27.2 (24B91020)", ["iOS", "iPadOS"]), true);
  assert.strictEqual(context.titleMatches("Xcode 27.2 (27B52)", ["iOS", "iPadOS"]), false);
  assert.strictEqual(context.titleMatches("何でも", []), true);
});

check("ベータは判断対象にせず、初回は45日より古いものを既読だけにする", function () {
  const recent = { title: "iOS 27.2 (24B91020)", published: "Mon, 26 Oct 2026 10:00:00 PDT" };
  const old = { title: "iOS 16.7.16 (20H392)", published: "Mon, 11 May 2026 10:00:00 PDT" };
  const beta = { title: "iOS 27.2 beta 3", published: "Mon, 26 Oct 2026 10:00:00 PDT" };
  const base = { seen: false, initialized: false, now: now, initialDays: 45, includeBeta: false };
  assert.strictEqual(context.disposition(recent, base), "active");
  assert.strictEqual(context.disposition(old, base), "seen-only");
  assert.strictEqual(context.disposition(beta, base), "beta");
  assert.strictEqual(context.disposition(old, Object.assign({}, base, { initialized: true })), "active");
  assert.strictEqual(context.disposition(recent, Object.assign({}, base, { seen: true })), "skip");
});

check("Apple の転送ページからMarkdownのURLを取る", function () {
  const redirect = '<script>window.setTimeout("window.location.replace(\'/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes\')", 1);</script>';
  assert.strictEqual(
    context.appleRedirectPath(redirect),
    "/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes"
  );
  const doc = '<link rel="alternate" type="text/markdown" href="https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes.md">';
  assert.strictEqual(
    context.markdownUrlFromHtml(doc),
    "https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes.md"
  );
  assert.strictEqual(context.hostAllowed(context.markdownUrlFromHtml(doc), ["developer.apple.com"]), true);
  assert.strictEqual(context.hostAllowed("https://developer.apple.com.evil.example/go", ["developer.apple.com"]), false);
});

check("Android の公開情報は日付つきのURLだけを重複なく取る", function () {
  const html = [
    '<a href="/docs/security/bulletin/asb-overview">overview</a>',
    '<a href="/docs/security/bulletin/2026/2026-10-01">Oct</a>',
    '<a href="https://source.android.com/docs/security/bulletin/2026/2026-10-01">dup</a>',
    '<a href="/docs/security/bulletin/2015-08-01">old</a>',
    '<a href="/docs/security/bulletin/pixel">pixel</a>'
  ].join("");
  const items = context.extractBulletinLinks(html);
  assert.strictEqual(items.map(function (item) { return String(item.id); }).join("\n"), [
    "android-asb:2026-10-01",
    "android-asb:2015-08-01"
  ].join("\n"));
  assert.strictEqual(items[0].link, "https://source.android.com/docs/security/bulletin/2026/2026-10-01");
  assert.strictEqual(context.isWithinDays(items[0].published, now, 45), true);
  assert.strictEqual(context.isWithinDays(items[1].published, now, 45), false);
});

check("公開情報の本文からナビゲーションを除く", function () {
  const html = '<div class="devsite-article-body clearfix"><p>WebView permission issue</p>CVE-2026-1111 CVE-2026-1111<footer>notification menu</footer>';
  const text = context.extractArticleText(html);
  assert.ok(text.indexOf("WebView permission issue") >= 0);
  assert.ok(text.indexOf("notification menu") < 0);
  assert.strictEqual(context.uniqueCves(text).map(String).join(","), "CVE-2026-1111");
});

check("アプリが見る観点と重なったときだけ要確認と推定する", function () {
  const rules = [
    { name: "WebView", keywords: ["webview", "cookie"] },
    { name: "セキュリティ", keywords: ["cve-", "security"] }
  ];
  const hits = context.matchViewpoints("System WebView cookie change. CVE-2026-1", rules);
  assert.strictEqual(hits.map(String).join(","), "WebView,セキュリティ");
  assert.strictEqual(context.estimateImpact(["権限", "WebView"], hits), "要確認");
  assert.strictEqual(context.estimateImpact(["通知"], hits), "影響なし");
  assert.strictEqual(context.relevantViewpoints(["権限", "WebView"], hits).map(String).join(","), "WebView");
});

check("Slackの文面は要約、公式リンク、観点を持つ", function () {
  const text = context.buildNoticeText({
    status: "修正が必要",
    appName: "店舗アプリ",
    os: "Android",
    title: "Android セキュリティ公開情報 2026-10-01",
    summary: "CVE 28件。System の権限昇格。",
    link: "https://source.android.com/docs/security/bulletin/2026/2026-10-01",
    viewpoints: "セキュリティ",
    mention: "@channel"
  });
  assert.ok(text.indexOf("<!channel>") >= 0);
  assert.ok(text.indexOf("*何が変わったか*") >= 0);
  assert.ok(text.indexOf("CVE 28件") >= 0);
  assert.ok(text.indexOf("*公式情報*") >= 0);
  assert.ok(text.indexOf("https://source.android.com/docs/security/bulletin/2026/2026-10-01") >= 0);
  assert.ok(text.indexOf("*要確認観点*") >= 0);
  assert.ok(text.indexOf("セキュリティ") >= 0);
});

check("同じ判断は再送せず、要確認から修正が必要へ変わったら送る", function () {
  const targets = ["要確認", "修正が必要"];
  assert.strictEqual(context.shouldSend("未判断", "", targets), false);
  assert.strictEqual(context.shouldSend("影響なし", "", targets), false);
  assert.strictEqual(context.shouldSend("要確認", "", targets), true);
  assert.strictEqual(context.shouldSend("要確認", "要確認", targets), false);
  assert.strictEqual(context.shouldSend("修正が必要", "要確認", targets), true);
});

check("リリースノートの見出し記号は要約から除く", function () {
  assert.strictEqual(context.cleanDocument("# iOS 27.2\n\n## Overview\n\nUpdate apps."), "iOS 27.2 Overview Update apps.");
});

check("数式とみなされる文字列はセルにそのまま入れない", function () {
  assert.strictEqual(context.asCell("=HYPERLINK()"), "'=HYPERLINK()");
  assert.strictEqual(context.asCell("iOS 27.2"), "iOS 27.2");
});

console.log(passed + " passed");
