/**
 * Backend for 長町倫理_活動計画.
 *
 * Deploy as a Web App:
 *   - Execute as: Me (the account that owns this script / the Drive file)
 *   - Who has access: Anyone
 * That combination means every request runs with THIS account's Drive
 * access, regardless of who is calling it — nobody needs a Google account
 * or ever sees a Google sign-in screen. Access is gated purely by the PIN
 * checked in checkPin_().
 *
 * Set the PIN once via Project Settings -> Script Properties -> APP_PIN.
 * Rotating the PIN later is just editing that one property; no redeploy,
 * no code change.
 */

var FILE_NAME = "年間活動計画データ_仙台長町倫理法人会.json";

function getPin_() {
  return PropertiesService.getScriptProperties().getProperty("APP_PIN");
}

function checkPin_(pin) {
  var expected = getPin_();
  return !!expected && typeof pin === "string" && pin === expected;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function findFile_() {
  var it = DriveApp.getFilesByName(FILE_NAME);
  return it.hasNext() ? it.next() : null;
}

function listRevisions_(fileId) {
  var url = "https://www.googleapis.com/drive/v3/files/" + fileId +
    "/revisions?fields=revisions(id,modifiedTime)";
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return [];
  var json = JSON.parse(res.getContentText());
  return json.revisions || [];
}

function getRevisionContent_(fileId, revisionId) {
  var url = "https://www.googleapis.com/drive/v3/files/" + fileId +
    "/revisions/" + encodeURIComponent(revisionId) + "?alt=media";
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("revision fetch failed: " + res.getResponseCode());
  }
  return JSON.parse(res.getContentText());
}

function doGet(e) {
  return jsonOutput_({ ok: false, error: "use_post" });
}

function doPost(e) {
  try {
    var body = {};
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var pin = body.pin;
    var action = body.action;

    if (!checkPin_(pin)) {
      return jsonOutput_({ ok: false, error: "invalid_pin" });
    }

    if (action === "load") {
      var file = findFile_();
      if (!file) return jsonOutput_({ ok: true, exists: false });
      var content = JSON.parse(file.getBlob().getDataAsString("UTF-8"));
      return jsonOutput_({
        ok: true,
        exists: true,
        fileId: file.getId(),
        modifiedTime: file.getLastUpdated().toISOString(),
        content: content,
        revisions: listRevisions_(file.getId())
      });
    }

    if (action === "save") {
      var payload = body.payload;
      if (!payload) return jsonOutput_({ ok: false, error: "missing_payload" });
      var text = JSON.stringify(payload);
      var f = findFile_();
      if (f) {
        f.setContent(text);
      } else {
        f = DriveApp.createFile(FILE_NAME, text, "application/json");
      }
      return jsonOutput_({ ok: true, fileId: f.getId(), modifiedTime: new Date().toISOString() });
    }

    if (action === "loadRevision") {
      var fileId = body.fileId;
      var revisionId = body.revisionId;
      if (!fileId || !revisionId) return jsonOutput_({ ok: false, error: "missing_params" });
      var revContent = getRevisionContent_(fileId, revisionId);
      return jsonOutput_({ ok: true, content: revContent });
    }

    return jsonOutput_({ ok: false, error: "unknown_action" });
  } catch (err) {
    return jsonOutput_({ ok: false, error: "server_error", message: String(err && err.message || err) });
  }
}
