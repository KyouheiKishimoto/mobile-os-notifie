// 取得や通知の判断に使う純粋関数。スプレッドシートや通信は持たない。

function collapseSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, max) {
  const text = String(value || "");
  const limit = Number(max) || 0;
  if (!limit || text.length <= limit) return text;
  return text.slice(0, Math.max(limit - 1, 0)).trim() + "…";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, function (_, digits) {
      return String.fromCharCode(Number(digits));
    })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanDocument(value) {
  const withoutComment = String(value || "").replace(/<!--[\s\S]*?-->/g, " ");
  const withoutCode = withoutComment.replace(/```[\s\S]*?```/g, " ");
  const withoutHeadings = withoutCode.replace(/^#{1,6}\s+/gm, "");
  const withoutLinks = stripHtml(decodeXml(withoutHeadings)).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return collapseSpace(withoutLinks);
}

function asCell(value) {
  if (value == null) return "";
  const text = String(value);
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

function splitCsv(value) {
  return String(value == null ? "" : value)
    .split(/[,、]/)
    .map(function (part) { return part.trim(); })
    .filter(function (part) { return part.length > 0; });
}

function isOn(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return text === "on" || text === "true" || text === "1" || text === "yes" ||
    text === "有効" || text === "オン" || text === "○";
}

function joinList(values) {
  return (values || []).filter(function (value) { return String(value || "").trim(); }).join("、");
}

function hostOf(url) {
  const match = String(url || "").match(/^https:\/\/([^\/:?#]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function hostAllowed(url, allowedHosts) {
  const host = hostOf(url);
  if (!host) return false;
  return (allowedHosts || []).some(function (allowed) {
    const name = String(allowed || "").toLowerCase();
    return !!name && (host === name || host.slice(-(name.length + 1)) === "." + name);
  });
}

function tagInner(block, tag) {
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i");
  const match = String(block || "").match(re);
  return match ? match[1] : "";
}

function tagText(block, tag) {
  return collapseSpace(stripHtml(decodeXml(tagInner(block, tag))));
}

function extractHrefs(text) {
  const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const out = [];
  let match;
  const source = String(text || "");
  while ((match = re.exec(source))) {
    out.push(match[1] || match[2] || match[3]);
  }
  return out;
}

function toAbsolute(url, origin) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(origin || "https://developer.apple.com").replace(/\/$/, "");
  if (value.charAt(0) === "/") return base + value;
  return base + "/" + value;
}

function pickNotesLink(block) {
  const hrefs = extractHrefs(block);
  for (let i = 0; i < hrefs.length; i++) {
    if (/release-notes|\/go\/\?id=|-rn(?:\b|["'\s>]|$)/i.test(hrefs[i])) {
      return toAbsolute(hrefs[i], "https://developer.apple.com");
    }
  }
  return "";
}

function usefulBlurb(value) {
  const text = collapseSpace(stripHtml(decodeXml(value || "")));
  if (!text || /^view (downloads|release notes)/i.test(text)) return "";
  return text;
}

function atomLink(block) {
  const re = /<link\b([^>]*)\/?>/gi;
  let match;
  let fallback = "";
  while ((match = re.exec(String(block || "")))) {
    const attrs = match[1];
    const hrefMatch = attrs.match(/href\s*=\s*"([^"]+)"/i);
    if (!hrefMatch) continue;
    const relMatch = attrs.match(/rel\s*=\s*"([^"]+)"/i);
    if (!relMatch || relMatch[1] === "alternate") return hrefMatch[1];
    if (!fallback) fallback = hrefMatch[1];
  }
  return fallback;
}

function parseFeed(xml) {
  const source = String(xml || "");
  const blocks = source.match(/<item\b[\s\S]*?<\/item>/gi) ||
    source.match(/<entry\b[\s\S]*?<\/entry>/gi) ||
    [];
  return blocks.map(function (block) {
    const atom = /<entry\b/i.test(block);
    const title = tagText(block, "title");
    const link = atom ? atomLink(block) : tagText(block, "link");
    const id = tagText(block, atom ? "id" : "guid") || link || title;
    const published = tagText(block, "pubDate") || tagText(block, "published") || tagText(block, "updated");
    return {
      id: id,
      title: title,
      link: link,
      notesLink: pickNotesLink(block),
      published: published,
      summary: usefulBlurb(tagInner(block, "description") || tagInner(block, "summary") || "")
    };
  }).filter(function (item) { return item.id && item.title; });
}

function appleRedirectPath(html) {
  const match = String(html || "").match(/location\.replace\(\s*['"]([^'"]+)['"]\s*\)/);
  return match ? match[1] : "";
}

function markdownUrlFromHtml(html) {
  const source = String(html || "");
  const patterns = [
    /rel=["']alternate["'][^>]*type=["']text\/markdown["'][^>]*href=["']([^"']+)["']/i,
    /type=["']text\/markdown["'][^>]*href=["']([^"']+)["']/i,
    /href=["']([^"']+\.md)["'][^>]*type=["']text\/markdown["']/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = source.match(patterns[i]);
    if (match) return match[1];
  }
  return "";
}

function extractBulletinLinks(html) {
  const re = /href\s*=\s*["'](?:https:\/\/source\.android\.com)?(\/docs\/security\/bulletin\/(?:\d{4}\/\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}))["']/gi;
  const seen = {};
  const out = [];
  let match;
  const source = String(html || "");
  while ((match = re.exec(source))) {
    const path = match[1];
    if (seen[path]) continue;
    seen[path] = true;
    const date = path.split("/").pop();
    out.push({
      id: "android-asb:" + date,
      title: "Android セキュリティ公開情報 " + date,
      link: "https://source.android.com" + path,
      notesLink: "",
      published: date,
      summary: ""
    });
  }
  return out;
}

function extractArticleText(html) {
  const source = String(html || "");
  const start = source.search(/class=["']devsite-article-body/);
  if (start < 0) return "";
  const open = source.indexOf(">", start);
  if (open < 0) return "";
  let slice = source.slice(open + 1, open + 200000);
  const end = slice.search(/<footer\b|devsite-content-footer|id=["']gc-footer["']/i);
  if (end > 0) slice = slice.slice(0, end);
  return collapseSpace(stripHtml(decodeXml(slice)));
}

function uniqueCves(text) {
  const found = String(text || "").match(/CVE-\d{4}-\d+/g) || [];
  const seen = {};
  const out = [];
  found.forEach(function (id) {
    if (seen[id]) return;
    seen[id] = true;
    out.push(id);
  });
  return out;
}

function titleMatches(title, keywords) {
  if (!keywords || !keywords.length) return true;
  const hay = String(title || "").toLowerCase();
  return keywords.some(function (word) {
    const needle = String(word || "").trim().toLowerCase();
    return needle && hay.indexOf(needle) !== -1;
  });
}

function isBetaTitle(title) {
  return /beta|release candidate/i.test(String(title || ""));
}

function parsePublished(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(text + "T00:00:00Z");
  const date = new Date(text);
  if (isNaN(date.getTime())) return null;
  return date;
}

function isWithinDays(publishedText, now, days) {
  const date = parsePublished(publishedText);
  if (!date || !now) return false;
  const windowMs = (Number(days) || 0) * 24 * 60 * 60 * 1000;
  return now.getTime() - date.getTime() <= windowMs;
}

function disposition(item, options) {
  const opts = options || {};
  if (opts.seen) return "skip";
  const beta = isBetaTitle(item && item.title);
  if (!opts.initialized) {
    if (!isWithinDays(item && item.published, opts.now, opts.initialDays)) return "seen-only";
    if (beta && !opts.includeBeta) return "beta";
    return "active";
  }
  if (beta && !opts.includeBeta) return "beta";
  return "active";
}

function matchViewpoints(text, rules) {
  const hay = String(text || "").toLowerCase();
  const hits = [];
  (rules || []).forEach(function (rule) {
    const name = String(rule.name || "").trim();
    if (!name) return;
    const matched = (rule.keywords || []).some(function (keyword) {
      const needle = String(keyword || "").trim().toLowerCase();
      return needle && hay.indexOf(needle) !== -1;
    });
    if (matched && hits.indexOf(name) < 0) hits.push(name);
  });
  return hits;
}

function relevantViewpoints(appViewpoints, hitViewpoints) {
  const hits = hitViewpoints || [];
  if (!appViewpoints || !appViewpoints.length) return hits.slice();
  const allow = {};
  appViewpoints.forEach(function (name) { allow[name] = true; });
  return hits.filter(function (name) { return allow[name]; });
}

function estimateImpact(appViewpoints, hitViewpoints) {
  return relevantViewpoints(appViewpoints, hitViewpoints).length ? "要確認" : "影響なし";
}

function shouldSend(status, notifiedStatus, notifyStatuses) {
  const current = String(status || "").trim();
  if ((notifyStatuses || []).indexOf(current) < 0) return false;
  if (!String(notifiedStatus || "").trim()) return true;
  return String(notifiedStatus).trim() !== current;
}

function slackMention(value) {
  const text = String(value || "").trim();
  if (text === "@channel" || text === "@here" || text === "@everyone") {
    return "<!" + text.slice(1) + ">";
  }
  return text;
}

function buildNoticeText(notice) {
  const item = notice || {};
  const lines = [
    (item.mention ? slackMention(item.mention) + " " : "") + "*" + (item.status || "要確認") + "* " + (item.appName || ""),
    [item.os, item.title].filter(function (part) { return part; }).join(" / "),
    "",
    "*何が変わったか*",
    item.summary || item.title || "公式ページを確認してください。",
    "",
    "*公式情報*",
    item.link || "",
    "",
    "*要確認観点*",
    item.viewpoints || "キーワード一致なし。シートの観点列を確認してください。"
  ];
  if (item.reason) {
    lines.push("", "*理由*", item.reason);
  }
  return lines.join("\n");
}

function buildDigestText(items, sheetUrl, hasApps) {
  const list = items || [];
  const shown = list.slice(0, 15);
  const lines = [
    "新しいOS更新が " + list.length + " 件あります。スプレッドシートで、各アプリの判断を入れてください。"
  ];
  if (!hasApps) {
    lines.push("有効なアプリが未登録です。アプリのシートに担当アプリを足すと、次回から判断行が作られます。");
  }
  lines.push("");
  shown.forEach(function (item) {
    lines.push("• " + [item.os, item.title].filter(function (part) { return part; }).join(" / "));
    lines.push("  推定観点: " + (item.viewpoints || "キーワード一致なし"));
    if (item.url) lines.push("  " + item.url);
  });
  if (list.length > shown.length) {
    lines.push("", "ほか " + (list.length - shown.length) + " 件はシートを見てください。");
  }
  if (sheetUrl) lines.push("", sheetUrl);
  return lines.join("\n");
}
