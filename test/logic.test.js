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

check("一覧では同じバージョンをまとめ、ビルド番号を出さず公開日と一文を付ける", function () {
  const url = "https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes";
  const text = context.buildDigestText([
    {
      os: "iOS",
      title: "iOS 27.2 (24B91020)",
      published: "Mon, 26 Oct 2026 10:00:00 PDT",
      summary: "写真アプリの権限確認が追加された。その他の修正。",
      url: url
    },
    {
      os: "iOS",
      title: "iOS 27.2 (24B119)",
      published: "Mon, 20 Oct 2026 10:00:00 PDT",
      summary: "iOS 27.2",
      url: url
    },
    {
      os: "iOS",
      title: "iPadOS 27.2 (24B119)",
      published: "Mon, 26 Oct 2026 10:00:00 PDT",
      summary: "写真アプリの権限確認が追加された。その他の修正。",
      url: url
    }
  ], "https://docs.example/sheet", true);
  assert.ok(text.indexOf("• iOS / iPadOS 27.2") >= 0);
  assert.ok(text.indexOf("24B91020") < 0);
  assert.ok(text.indexOf("推定観点") < 0);
  assert.ok(text.indexOf("公開: 2026-10-20 〜 2026-10-26") >= 0);
  assert.ok(text.indexOf("写真アプリの権限確認が追加された。") >= 0);
  assert.strictEqual(text.split(url).length - 1, 1);
});

check("タイトルにあるバージョンは、番号が違っても下に繰り返さない", function () {
  const url = "https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-28-release-notes";
  const text = context.buildDigestText([
    {
      os: "iOS",
      title: "iPadOS 28 (25A100)",
      published: "Mon, 02 Nov 2026 10:00:00 PDT",
      summary: "iPadOS 28.",
      url: url
    },
    {
      os: "iOS",
      title: "iOS 28 (25A100)",
      published: "Mon, 02 Nov 2026 10:00:00 PDT",
      summary: "iOS & iPadOS 28 Release Notes Overview 写真アプリの書き出しが変わった。",
      url: url
    }
  ], "", true);
  assert.ok(text.indexOf("• iOS / iPadOS 28") >= 0);
  assert.ok(text.indexOf("\n  iPadOS 28") < 0);
  assert.ok(text.indexOf("写真アプリの書き出しが変わった。") >= 0);
});

check("一覧はiOSとAndroidの見出しで分ける", function () {
  const text = context.buildDigestText([
    {
      os: "Android",
      title: "Android セキュリティ公開情報 2026-10-01",
      published: "2026-09-30",
      summary: "CVE 25件。",
      url: "https://source.android.com/docs/security/bulletin/2026/2026-10-01"
    },
    {
      os: "iOS",
      title: "iOS 27.2 (24B91020)",
      published: "Mon, 26 Oct 2026 10:00:00 PDT",
      summary: "Update your apps to use new features.",
      url: "https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes"
    }
  ], "", true);
  assert.ok(text.indexOf("*iOS*") < text.indexOf("*Android*"));
  assert.ok(text.indexOf("*iOS*") < text.indexOf("• iOS 27.2"));
  assert.ok(text.indexOf("*Android*") < text.indexOf("• Android セキュリティ公開情報 2026-10-01"));
  assert.ok(text.indexOf("CVE 25件。") > text.indexOf("*Android*"));
});

check("iOSとAndroidのあいだにSlackの仕切り線を入れる", function () {
  const blocks = context.buildDigestBlocks([
    {
      os: "iOS",
      title: "iOS 27.2 (24B91020)",
      published: "Mon, 26 Oct 2026 10:00:00 PDT",
      summary: "Update your apps to use new features.",
      url: "https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes"
    },
    {
      os: "Android",
      title: "Android セキュリティ公開情報 2026-10-01",
      published: "2026-09-30",
      summary: "CVE 25件。",
      url: "https://source.android.com/docs/security/bulletin/2026/2026-10-01"
    }
  ], "https://docs.example/sheet", true);
  const iosAt = blocks.findIndex(function (block) {
    return block.type === "section" && block.text.text.indexOf("*iOS*") >= 0;
  });
  const androidAt = blocks.findIndex(function (block) {
    return block.type === "section" && block.text.text.indexOf("*Android*") >= 0;
  });
  assert.ok(iosAt >= 0 && androidAt > iosAt);
  assert.strictEqual(blocks[androidAt - 1].type, "divider");
  assert.ok(blocks.some(function (block) { return block.type === "divider"; }));
  const footer = blocks[blocks.length - 1];
  assert.strictEqual(footer.type, "section");
  assert.ok(footer.text.text.indexOf("スプレッドシート\n\nhttps://docs.example/sheet") >= 0);
});

check("ビルド番号だけの繰り返しは一覧に出さない", function () {
  const text = context.buildDigestText([
    {
      os: "iOS",
      title: "iPadOS 26.7.2 (23H128)",
      published: "Mon, 26 Oct 2026 10:00:00 PDT",
      summary: "iPadOS 26.7.2 (23H128)",
      url: "https://developer.apple.com/"
    },
    {
      os: "iOS",
      title: "iPadOS 18.7.11 (22H384)",
      published: "Mon, 26 Oct 2026 10:00:00 PDT",
      summary: "iPadOS 18.7.11 (22H384)",
      url: ""
    },
    {
      os: "iOS",
      title: "iOS 18.7.11 (22H384)",
      published: "Mon, 26 Oct 2026 10:00:00 PDT",
      summary: "iPadOS 18.7.11 (22H384)",
      url: ""
    }
  ], "", true);
  assert.ok(text.indexOf("• iPadOS 26.7.2") >= 0);
  assert.ok(text.indexOf("• iOS / iPadOS 18.7.11") >= 0);
  assert.ok(text.indexOf("23H128") < 0);
  assert.ok(text.indexOf("22H384") < 0);
  assert.ok(text.indexOf("\n  iPadOS 26.7.2") < 0);
  assert.ok(text.indexOf("\n  iPadOS 18.7.11") < 0);
});

check("一覧の要約はバージョン名の繰り返しを出さない", function () {
  const text = context.buildDigestText([
    {
      os: "iOS",
      title: "iOS 27.0.1 (23A355)",
      published: "Mon, 28 Sep 2026 10:00:00 PDT",
      summary: "iOS & iPadOS 27.0.1 Release Notes Overview This update provides important bug fixes and security updates.",
      url: "https://developer.apple.com/news/releases/?id=09282026a"
    },
    {
      os: "iOS",
      title: "iPadOS 27.0.1 (23A355)",
      published: "Mon, 28 Sep 2026 10:00:00 PDT",
      summary: "iPadOS 27.",
      url: "https://developer.apple.com/"
    }
  ], "", true);
  assert.ok(text.indexOf("• iOS / iPadOS 27.0.1") >= 0);
  assert.ok(text.indexOf("\n  iPadOS 27.") < 0);
  assert.ok(text.indexOf("This update provides important bug fixes and security updates.") >= 0);
  assert.ok(text.indexOf("https://developer.apple.com\n") < 0);
  assert.ok(text.indexOf("https://developer.apple.com/news/releases/?id=09282026a") >= 0);
});

check("数式とみなされる文字列はセルにそのまま入れない", function () {
  assert.strictEqual(context.asCell("=HYPERLINK()"), "'=HYPERLINK()");
  assert.strictEqual(context.asCell("iOS 27.2"), "iOS 27.2");
});

console.log(passed + " passed");
