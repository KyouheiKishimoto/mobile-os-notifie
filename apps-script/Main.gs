// スプレッドシートに紐づく Apps Script。
// 初回: setup → アプリと Slack Webhook をシートに入れる → installDailyTrigger → checkUpdates

var SHEET_NAME = {
  settings: "設定",
  sources: "情報源",
  apps: "アプリ",
  rules: "観点キーワード",
  updates: "更新",
  judgments: "判断",
  seen: "既読",
  log: "実行ログ"
};

var HEADERS = {
  settings: ["項目", "値"],
  sources: ["有効", "名前", "OS", "種類", "URL", "タイトルに含む", "初期化済み"],
  apps: ["有効", "アプリ名", "見る観点", "メンション"],
  rules: ["観点", "キーワード"],
  updates: ["ID", "検知日時", "OS", "情報源", "タイトル", "URL", "公開日", "公式要約", "推定観点", "状態", "ダイジェスト日時"],
  judgments: ["更新ID", "アプリ名", "推定", "判断", "要約", "観点", "理由", "通知日時", "通知した判断"],
  seen: ["ID"],
  log: ["日時", "レベル", "内容"]
};

var JUDGMENT_VALUES = ["未判断", "影響なし", "要確認", "修正が必要"];
var FETCH_BUDGET = 12;
var SUMMARY_STORE_LIMIT = 1500;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("OS更新")
    .addItem("シートを用意する", "setup")
    .addItem("いま取得する", "checkUpdates")
    .addItem("判断済みをSlackへ送る", "notifyPending")
    .addItem("毎朝8時に動かす", "installDailyTrigger")
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone("Asia/Tokyo");
  const settings = ensureSheet(ss, SHEET_NAME.settings, HEADERS.settings);
  const sources = ensureSheet(ss, SHEET_NAME.sources, HEADERS.sources);
  const apps = ensureSheet(ss, SHEET_NAME.apps, HEADERS.apps);
  const rules = ensureSheet(ss, SHEET_NAME.rules, HEADERS.rules);
  const updates = ensureSheet(ss, SHEET_NAME.updates, HEADERS.updates);
  const judgments = ensureSheet(ss, SHEET_NAME.judgments, HEADERS.judgments);
  ensureSheet(ss, SHEET_NAME.seen, HEADERS.seen);
  ensureSheet(ss, SHEET_NAME.log, HEADERS.log);

  writeDefaultsIfEmpty(settings, [
    ["Slack Webhook URL", ""],
    ["未判断ダイジェスト", "オン"],
    ["通知する判断", "要確認,修正が必要"],
    ["ベータも判断する", "オフ"],
    ["要約の最大文字数", "400"],
    ["初回に取り込む日数", "45"]
  ]);
  writeDefaultsIfEmpty(sources, [
    ["オン", "Apple のリリース", "iOS", "rss", "https://developer.apple.com/news/releases/rss/releases.rss", "iOS,iPadOS", "オフ"],
    ["オン", "Android セキュリティ公開情報", "Android", "android-bulletin", "https://source.android.com/docs/security/bulletin/asb-overview", "", "オフ"]
  ]);
  writeDefaultsIfEmpty(apps, [
    ["オフ", "（例）担当アプリ", "権限、WebView、通知、セキュリティ", ""]
  ]);
  writeDefaultsIfEmpty(rules, [
    ["権限", "permission, permissions, entitlement, 権限, カメラ, 写真, マイク, 位置情報, tracking authorization, app tracking"],
    ["WebView", "webview, wkwebview, cookie"],
    ["通知", "notification, notifications, push notification, プッシュ, 通知"],
    ["セキュリティ", "security, vulnerability, cve-, certificate, tls, ats, セキュリティ"],
    ["プライバシー", "privacy manifest, nsprivacy, app tracking transparency, tracking"],
    ["バックグラウンド", "background mode, bgtask, backgroundtasks, foreground service, バックグラウンド"],
    ["APIの廃止", "deprecated, deprecation, no longer available, has been removed"],
    ["ストア", "minimum deployment, deployment target, target sdk, review guideline"]
  ]);

  noteWebhookCell(settings);
  applyJudgmentValidation(judgments);
  widen(updates, { "タイトル": 280, "URL": 320, "公式要約": 420, "推定観点": 180 });
  widen(judgments, { "要約": 420, "観点": 180, "理由": 240 });
  wrapColumns(updates, ["公式要約"]);
  wrapColumns(judgments, ["要約", "観点", "理由"]);
  if (!judgments.getFilter()) {
    judgments.getRange(1, 1, judgments.getMaxRows(), HEADERS.judgments.length).createFilter();
  }
  try { removeEmptyDefaultSheet(ss); } catch (error) {}
  try { orderSheets(ss); } catch (error) {}
  logLine(ss, "情報", "シートを用意しました。");
  alertSafe("シートを用意しました。\nアプリの名前を変えて有効をオンにし、設定の Slack Webhook URL を貼ってから「いま取得する」を実行してください。");
}

function checkUpdates() {
  withLock(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    requireSetup(ss);
    const settings = readSettings(ss);
    const rules = readRules(ss);
    const seen = seenMap(ss);
    sheetObjects(ss.getSheetByName(SHEET_NAME.sources)).forEach(function (source) {
      if (!isOn(source["有効"])) return;
      try {
        processSource(ss, source, settings, rules, seen);
      } catch (error) {
        logLine(ss, "エラー", String(source["名前"] || "情報源") + ": " + errorMessage(error));
      }
    });
    ensureJudgments(ss, settings);
    sendDigest(ss, settings);
    sendReadyNotices(ss, settings);
    alertSafe("取得が完了しました。実行ログと、更新・判断のシートを確認してください。");
  });
}

function notifyPending() {
  withLock(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    requireSetup(ss);
    const sent = sendReadyNotices(ss, readSettings(ss));
    alertSafe(sent ? sent + " 件を Slack に送りました。" : "送る対象はありません。判断列が「要確認」または「修正が必要」で、まだ通知していない行が対象です。");
  });
}

function installDailyTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone("Asia/Tokyo");
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "checkUpdates") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("checkUpdates")
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .inTimezone("Asia/Tokyo")
    .create();
  logLine(ss, "情報", "毎朝8時台（日本時間）の自動実行を設定しました。");
  alertSafe("毎朝8時台（日本時間）に、取得と判断済みの通知を行うよう設定しました。");
}

function processSource(ss, source, settings, rules, seen) {
  const kind = String(source["種類"] || "rss").trim().toLowerCase();
  const url = assertHttps(source["URL"]);
  const raw = fetchText(url);
  let items = [];
  if (kind === "rss") items = parseFeed(raw);
  else if (kind === "android-bulletin") items = extractBulletinLinks(raw);
  else throw new Error("種類は rss か android-bulletin にしてください: " + kind);

  if (!items.length) {
    logLine(ss, "警告", source["名前"] + ": 更新が0件でした。URLかページの形を確認してください。初期化済みにはしていません。");
    return;
  }

  const keywords = splitCsv(source["タイトルに含む"]);
  const initialized = isOn(source["初期化済み"]);
  const now = new Date();
  const state = { budget: FETCH_BUDGET, deferred: false };
  const seenRows = [];
  const updateRows = [];

  items.forEach(function (item) {
    if (keywords.length && !titleMatches(item.title, keywords)) return;
    if (seen[item.id]) return;
    const action = disposition(item, {
      seen: false,
      initialized: initialized,
      now: now,
      initialDays: settings.initialDays,
      includeBeta: settings.includeBeta
    });
    if (action === "seen-only") {
      remember(seen, seenRows, item.id);
      return;
    }
    if (action === "active" && state.budget <= 0) {
      state.deferred = true;
      return;
    }

    let enriched = {
      url: item.notesLink || item.link,
      summary: item.title,
      viewpoints: matchViewpoints(item.title, rules)
    };
    if (action === "active") {
      state.budget -= 1;
      try {
        enriched = kind === "android-bulletin"
          ? enrichBulletin(item, rules)
          : enrichRssItem(item, rules);
      } catch (error) {
        logLine(ss, "警告", item.title + " の本文は取れませんでした。タイトルとリンクだけ記録します。 " + errorMessage(error));
      }
    }

    remember(seen, seenRows, item.id);
    updateRows.push({
      "ID": item.id,
      "検知日時": nowText(),
      "OS": source["OS"],
      "情報源": source["名前"],
      "タイトル": item.title,
      "URL": enriched.url || item.link,
      "公開日": item.published,
      "公式要約": enriched.summary || item.title,
      "推定観点": joinList(enriched.viewpoints),
      "状態": action === "beta" ? "ベータ" : "新規",
      "ダイジェスト日時": action === "beta" ? "対象外" : ""
    });
  });

  appendObjects(ss.getSheetByName(SHEET_NAME.seen), seenRows);
  appendObjects(ss.getSheetByName(SHEET_NAME.updates), updateRows);
  const fresh = updateRows.filter(function (row) { return row["状態"] === "新規"; }).length;
  logLine(ss, "情報", source["名前"] + ": 判断対象 " + fresh + " 件、記録 " + updateRows.length + " 件。");
  if (!initialized && !state.deferred) {
    setCell(ss.getSheetByName(SHEET_NAME.sources), source._row, "初期化済み", "オン");
  }
  if (state.deferred) {
    logLine(ss, "情報", source["名前"] + ": 本文の取得が上限に達したため、残りは次回に回します。");
  }
}

function enrichRssItem(item, rules) {
  const resolved = resolveAppleNotes(item);
  const full = resolved.full || item.summary || item.title;
  return {
    url: resolved.url || item.link,
    summary: truncateText(cleanDocument(full), SUMMARY_STORE_LIMIT) || item.title,
    viewpoints: matchViewpoints(item.title + "\n" + full, rules)
  };
}

function resolveAppleNotes(item) {
  if (!item.notesLink || !hostAllowed(item.notesLink, ["developer.apple.com"])) {
    return { url: item.link, full: item.summary || item.title };
  }
  const first = fetchText(item.notesLink);
  let markdownUrl = markdownUrlFromHtml(first);
  let pageUrl = item.notesLink;
  if (!markdownUrl) {
    const next = appleRedirectPath(first);
    if (next) {
      pageUrl = toAbsolute(next, "https://developer.apple.com");
      if (!hostAllowed(pageUrl, ["developer.apple.com"])) {
        return { url: item.notesLink, full: item.summary || item.title };
      }
      const second = fetchText(pageUrl);
      markdownUrl = markdownUrlFromHtml(second);
      if (!markdownUrl && /\/documentation\//.test(pageUrl)) {
        markdownUrl = pageUrl.replace(/\/$/, "") + ".md";
      }
    }
  }
  if (!markdownUrl || !hostAllowed(markdownUrl, ["developer.apple.com"])) {
    return { url: pageUrl || item.notesLink, full: item.summary || item.title };
  }
  return {
    url: markdownUrl.replace(/\.md(?:\?.*)?$/, ""),
    full: fetchText(markdownUrl)
  };
}

function enrichBulletin(item, rules) {
  if (!hostAllowed(item.link, ["source.android.com"])) {
    throw new Error("Android の公式ドメイン以外は取得しません: " + item.link);
  }
  const html = fetchText(item.link);
  const article = extractArticleText(html);
  const cves = uniqueCves(article || html);
  const full = article || item.title;
  const hits = matchViewpoints(item.title + "\n" + full, rules);
  if (cves.length && hits.indexOf("セキュリティ") < 0) hits.push("セキュリティ");
  const prefix = cves.length ? "CVE " + cves.length + "件。" : "";
  return {
    url: item.link,
    summary: truncateText(collapseSpace(prefix + " " + cleanDocument(full)), SUMMARY_STORE_LIMIT) || item.title,
    viewpoints: hits
  };
}

function ensureJudgments(ss, settings) {
  const apps = enabledApps(ss);
  if (!apps.length) return 0;
  const updates = sheetObjects(ss.getSheetByName(SHEET_NAME.updates)).filter(function (row) {
    return row["状態"] === "新規";
  });
  const judgments = ss.getSheetByName(SHEET_NAME.judgments);
  const existing = {};
  sheetObjects(judgments).forEach(function (row) {
    existing[String(row["更新ID"]) + "\t" + String(row["アプリ名"]).trim()] = true;
  });
  const rows = [];
  updates.forEach(function (update) {
    const hits = splitCsv(update["推定観点"]);
    apps.forEach(function (app) {
      const name = String(app["アプリ名"]).trim();
      const key = String(update["ID"]) + "\t" + name;
      if (existing[key]) return;
      const appViews = splitCsv(app["見る観点"]);
      const relevant = relevantViewpoints(appViews, hits);
      rows.push({
        "更新ID": update["ID"],
        "アプリ名": name,
        "推定": estimateImpact(appViews, hits),
        "判断": "未判断",
        "要約": truncateText(update["公式要約"], settings.summaryLength) || update["タイトル"],
        "観点": joinList(relevant),
        "理由": "",
        "通知日時": "",
        "通知した判断": ""
      });
      existing[key] = true;
    });
  });
  appendObjects(judgments, rows);
  if (rows.length) applyJudgmentValidation(judgments);
  return rows.length;
}

function sendDigest(ss, settings) {
  const sheet = ss.getSheetByName(SHEET_NAME.updates);
  const pending = sheetObjects(sheet).filter(function (row) {
    return row["状態"] === "新規" && !String(row["ダイジェスト日時"] || "").trim();
  });
  if (!pending.length) return 0;
  if (!settings.digest) {
    pending.forEach(function (row) { setCell(sheet, row._row, "ダイジェスト日時", "送らない"); });
    return 0;
  }
  if (!webhookReady(settings.webhook)) {
    logLine(ss, "情報", "Slack Webhook URL が空、または Incoming Webhook の形ではないため、未判断の知らせは保留しています。");
    return 0;
  }
  const batch = pending.slice(0, 15);
  const text = buildDigestText(batch.map(function (row) {
    return { os: row["OS"], title: row["タイトル"], viewpoints: row["推定観点"], url: row["URL"] };
  }), ss.getUrl(), enabledApps(ss).length > 0);
  try {
    postSlack(settings.webhook, text);
  } catch (error) {
    logLine(ss, "エラー", "未判断の知らせに失敗しました。次回やり直します。 " + errorMessage(error));
    return 0;
  }
  const stamp = nowText();
  batch.forEach(function (row) { setCell(sheet, row._row, "ダイジェスト日時", stamp); });
  logLine(ss, "情報", "未判断の知らせを " + batch.length + " 件分送りました。");
  return batch.length;
}

function sendReadyNotices(ss, settings) {
  if (!webhookReady(settings.webhook)) {
    const waiting = readyJudgments(ss, settings);
    if (waiting.length) {
      logLine(ss, "情報", "通知対象が " + waiting.length + " 件ありますが、Slack Webhook URL が未設定です。");
    }
    return 0;
  }
  const updates = {};
  sheetObjects(ss.getSheetByName(SHEET_NAME.updates)).forEach(function (row) {
    updates[String(row["ID"])] = row;
  });
  const mentions = {};
  enabledApps(ss).forEach(function (app) {
    mentions[String(app["アプリ名"]).trim()] = app["メンション"];
  });
  const sheet = ss.getSheetByName(SHEET_NAME.judgments);
  const batch = readyJudgments(ss, settings).filter(function (row) {
    return Object.prototype.hasOwnProperty.call(mentions, String(row["アプリ名"]).trim());
  }).slice(0, 15);
  let sent = 0;
  batch.forEach(function (row) {
    const update = updates[String(row["更新ID"])] || {};
    const text = buildNoticeText({
      mention: mentions[String(row["アプリ名"]).trim()] || "",
      status: String(row["判断"]).trim(),
      appName: row["アプリ名"],
      os: update["OS"] || "",
      title: update["タイトル"] || "",
      summary: row["要約"] || update["公式要約"] || update["タイトル"],
      link: update["URL"] || "",
      viewpoints: row["観点"],
      reason: row["理由"]
    });
    try {
      postSlack(settings.webhook, text);
    } catch (error) {
      logLine(ss, "エラー", row["アプリ名"] + " への通知に失敗しました。 " + errorMessage(error));
      return;
    }
    const status = String(row["判断"]).trim();
    setCell(sheet, row._row, "通知日時", nowText());
    setCell(sheet, row._row, "通知した判断", status);
    sent += 1;
  });
  if (sent) logLine(ss, "情報", "判断の通知を " + sent + " 件送りました。");
  return sent;
}

function readyJudgments(ss, settings) {
  return sheetObjects(ss.getSheetByName(SHEET_NAME.judgments)).filter(function (row) {
    return shouldSend(row["判断"], row["通知した判断"], settings.notifyStatuses);
  });
}

function readSettings(ss) {
  const map = {};
  sheetObjects(ss.getSheetByName(SHEET_NAME.settings)).forEach(function (row) {
    map[String(row["項目"] || "").trim()] = row["値"];
  });
  const digestValue = map["未判断ダイジェスト"];
  return {
    webhook: String(map["Slack Webhook URL"] || "").trim(),
    digest: isOn(digestValue == null || String(digestValue).trim() === "" ? "オン" : digestValue),
    notifyStatuses: splitCsv(map["通知する判断"] || "要確認,修正が必要"),
    includeBeta: isOn(map["ベータも判断する"]),
    summaryLength: positiveNumber(map["要約の最大文字数"], 400),
    initialDays: positiveNumber(map["初回に取り込む日数"], 45)
  };
}

function readRules(ss) {
  return sheetObjects(ss.getSheetByName(SHEET_NAME.rules)).map(function (row) {
    return { name: String(row["観点"] || "").trim(), keywords: splitCsv(row["キーワード"]) };
  }).filter(function (rule) { return rule.name && rule.keywords.length; });
}

function enabledApps(ss) {
  return sheetObjects(ss.getSheetByName(SHEET_NAME.apps)).filter(function (row) {
    return isOn(row["有効"]) && String(row["アプリ名"] || "").trim();
  });
}

function seenMap(ss) {
  const map = {};
  sheetObjects(ss.getSheetByName(SHEET_NAME.seen)).forEach(function (row) {
    const id = String(row["ID"] || "").trim();
    if (id) map[id] = true;
  });
  return map;
}

function remember(seen, rows, id) {
  if (!id || seen[id]) return;
  seen[id] = true;
  rows.push({ "ID": id });
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const blank = current.every(function (cell) { return String(cell || "").trim() === ""; });
  if (blank) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }
  return sheet;
}

function writeDefaultsIfEmpty(sheet, rows) {
  if (sheet.getLastRow() >= 2) return;
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function sheetObjects(sheet) {
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0].map(function (cell) { return String(cell || "").trim(); });
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const blank = row.every(function (cell) { return String(cell == null ? "" : cell).trim() === ""; });
    if (blank) continue;
    const obj = { _row: i + 1 };
    headers.forEach(function (header, index) {
      if (header) obj[header] = row[index];
    });
    out.push(obj);
  }
  return out;
}

function headerList(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, width).getValues()[0].map(function (cell) {
    return String(cell || "").trim();
  });
}

function appendObjects(sheet, objects) {
  if (!objects.length) return;
  const headers = headerList(sheet);
  const start = Math.max(sheet.getLastRow(), 1) + 1;
  const values = objects.map(function (obj) {
    return headers.map(function (header) { return asCell(obj[header]); });
  });
  sheet.getRange(start, 1, values.length, headers.length).setValues(values);
}

function setCell(sheet, rowNumber, headerName, value) {
  const headers = headerList(sheet);
  const index = headers.indexOf(headerName);
  if (index < 0) throw new Error("列がありません: " + headerName);
  sheet.getRange(rowNumber, index + 1).setValue(asCell(value));
}

function applyJudgmentValidation(sheet) {
  const headers = headerList(sheet);
  const index = headers.indexOf("判断");
  if (index < 0) return;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(JUDGMENT_VALUES, true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange(2, index + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

function noteWebhookCell(sheet) {
  const rows = sheetObjects(sheet);
  rows.forEach(function (row) {
    if (String(row["項目"]).trim() === "Slack Webhook URL") {
      sheet.getRange(row._row, 2).setNote("Slack の Incoming Webhook URL を貼る。空なら記録だけ行い、Slack には送らない。");
    }
  });
}

function wrapColumns(sheet, names) {
  const headers = headerList(sheet);
  names.forEach(function (name) {
    const index = headers.indexOf(name);
    if (index >= 0) sheet.getRange(1, index + 1, sheet.getMaxRows(), 1).setWrap(true);
  });
}

function widen(sheet, widths) {
  const headers = headerList(sheet);
  Object.keys(widths).forEach(function (name) {
    const index = headers.indexOf(name);
    if (index >= 0) sheet.setColumnWidth(index + 1, widths[name]);
  });
}

function orderSheets(ss) {
  const names = [
    SHEET_NAME.judgments,
    SHEET_NAME.updates,
    SHEET_NAME.apps,
    SHEET_NAME.settings,
    SHEET_NAME.sources,
    SHEET_NAME.rules,
    SHEET_NAME.log,
    SHEET_NAME.seen
  ];
  names.forEach(function (name, index) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(index + 1);
  });
  const first = ss.getSheetByName(SHEET_NAME.judgments);
  if (first) ss.setActiveSheet(first);
}

function removeEmptyDefaultSheet(ss) {
  ["シート1", "Sheet1"].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || ss.getSheets().length < 2) return;
    if (sheet.getLastRow() <= 1 && sheet.getLastColumn() <= 1) {
      try { ss.deleteSheet(sheet); } catch (error) {}
    }
  });
}

function requireSetup(ss) {
  if (!ss.getSheetByName(SHEET_NAME.settings)) {
    throw new Error("先にメニューの「シートを用意する」か、setup を実行してください。");
  }
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    try {
      logLine(SpreadsheetApp.getActiveSpreadsheet(), "情報", "別の実行が続いているため、今回はスキップしました。");
    } catch (error) {}
    return;
  }
  try {
    fn();
  } catch (error) {
    try {
      logLine(SpreadsheetApp.getActiveSpreadsheet(), "エラー", errorMessage(error));
    } catch (inner) {}
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function fetchText(url) {
  const target = assertHttps(url);
  const response = UrlFetchApp.fetch(target, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { "User-Agent": "OsUpdateWatch/1.0 (Google Apps Script)" }
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("取得失敗 " + code + " " + target);
  }
  return response.getContentText() || "";
}

function postSlack(webhookUrl, text) {
  if (!webhookReady(webhookUrl)) throw new Error("Slack Webhook URL が Incoming Webhook の形ではありません。");
  const response = UrlFetchApp.fetch(String(webhookUrl).trim(), {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({ text: text })
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Slack " + code + " " + String(response.getContentText() || "").slice(0, 180));
  }
}

function webhookReady(url) {
  return /^https:\/\/hooks\.slack\.com\//.test(String(url || "").trim());
}

function assertHttps(url) {
  const value = String(url || "").trim();
  if (!/^https:\/\/[a-z0-9.-]+(?:[:/]|$)/i.test(value)) {
    throw new Error("https のURLだけ取得します: " + value);
  }
  return value;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return number > 0 ? number : fallback;
}

function nowText() {
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
}

function alertSafe(message) {
  try { SpreadsheetApp.getUi().alert(message); } catch (error) {}
}

function errorMessage(error) {
  if (!error) return "";
  return String(error.stack || error.message || error).slice(0, 500);
}
