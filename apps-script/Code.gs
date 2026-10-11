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
var FOLDER_NAME = "長町倫理_活動計画データ";

// Committee handover documents served through this backend rather than via
// public Drive sharing — these files stay private (owner-only) on Drive, and
// are only reachable by someone who already has the app's PIN. Add new
// entries here as more committees' handover sheets get digitized; do NOT add
// an endpoint that accepts an arbitrary Drive file id from the client.
var COMMITTEE_FILES = {
  asachorei: { fileId: "1r-bNKBWUKa-NIY8KJA3E_DjZ8g3eSeJj", name: "朝礼委員会 引き継ぎシート" }
};

// 「参考資料（閲覧のみ）」タブの埋め込み元。以前はクライアント側で
// docs.google.com/drive.google.comのプレビューiframeを直接埋め込んでいたが、
// これは閲覧者自身のGoogleログインセッションに依存しており、Cookie状態次第で
// 「Googleアカウントにアクセスできません」となり表示できなくなっていた
// (このファイル群は「リンクを知っている全員」の公開共有ではなく、個別アカウント
// にのみ共有されているため)。COMMITTEE_FILESと同じ理由・同じ仕組みで、
// このスクリプトの実行アカウント経由でbase64取得する方式に統一する。
var REFERENCE_FILES = {
  schedule: { fileId: "1GIPWwSIB3cr30I-sFNsqPln2DbylRnTf4NsX7KlwxEY", name: "長町MS予定表" },
  roster: { fileId: "1YSOjTMw4JwTbjJtjJXWWIzBxSh9GJWJR", name: "長町R8普及拡充リスト" },
  committee: { fileId: "1TmTyD9nzc_NwoBRVaaUUbZLox725c5Aa", name: "委員会引き継ぎシート統一版" }
};

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

function getOrCreateFolder_() {
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

function isDirectChildOf_(file, folder) {
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) return true;
  }
  return false;
}

// Moves a file into `folder`, removing it from every other parent it's
// currently in (a fresh file has no parents to remove; an older file saved
// before FOLDER_NAME existed is typically sitting loose at the Drive root).
function moveIntoFolder_(file, folder) {
  var parents = file.getParents();
  while (parents.hasNext()) {
    var parent = parents.next();
    if (parent.getId() !== folder.getId()) parent.removeFile(file);
  }
  folder.addFile(file);
}

function findFile_(folder) {
  var inFolder = folder.getFilesByName(FILE_NAME);
  if (inFolder.hasNext()) return inFolder.next();

  // One-time migration: earlier versions of this script saved the file
  // wherever DriveApp.getFilesByName() happened to find/create it (usually
  // the Drive root). Adopt it into the folder instead of starting fresh.
  var elsewhere = DriveApp.getFilesByName(FILE_NAME);
  while (elsewhere.hasNext()) {
    var f = elsewhere.next();
    if (!isDirectChildOf_(f, folder)) {
      moveIntoFolder_(f, folder);
      return f;
    }
  }
  return null;
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

    // getReferenceFile is intentionally NOT behind the PIN check: the
    // 「参考資料」tab it backs was already visible to anyone before this PIN
    // app existed (plain client-side Google iframe embeds), so moving it
    // behind this backend must not newly require a PIN. Unlike
    // COMMITTEE_FILES (always PIN-gated), REFERENCE_FILES should stay
    // reachable with no PIN.
    if (action === "getReferenceFile") {
      var refKey = body.key;
      var refEntry = REFERENCE_FILES[refKey];
      if (!refEntry) return jsonOutput_({ ok: false, error: "unknown_file" });
      var refFile = DriveApp.getFileById(refEntry.fileId);
      var refBlob;
      try {
        // ネイティブのGoogleスプレッドシート/ドキュメントはgetBlob()できないため
        // PDFとしてエクスポートする(毎回最新の内容が取れる)。既にPDFの場合は
        // そのまま返る。
        refBlob = refFile.getAs(MimeType.PDF);
      } catch (convErr) {
        try {
          // PDF変換できない形式(例: .xlsxのままアップロードされたファイルは
          // Apps ScriptからPDFエクスポートできないことがある)は元のBlobを返す。
          refBlob = refFile.getBlob();
        } catch (blobErr) {
          return jsonOutput_({ ok: false, error: "preview_unsupported", name: refEntry.name });
        }
      }
      // getBlob()自体は例外を投げずに成功することがあっても、返ってきたBlobから
      // 実際にバイト列を取り出す(getBytes())段になって変換エラーが起きることが
      // 分かったため、この取り出し処理もtry/catchで保護する。
      try {
        return jsonOutput_({
          ok: true,
          name: refEntry.name,
          mimeType: refBlob.getContentType(),
          data: Utilities.base64Encode(refBlob.getBytes())
        });
      } catch (readErr) {
        // 両方失敗した場合はこの資料だけ「プレビュー不可」として明示的に返す。
        // クライアント側は既存の「Googleドライブで開く」リンクに誘導できる。
        return jsonOutput_({ ok: false, error: "preview_unsupported", name: refEntry.name });
      }
    }

    if (!checkPin_(pin)) {
      return jsonOutput_({ ok: false, error: "invalid_pin" });
    }

    if (action === "load") {
      var file = findFile_(getOrCreateFolder_());
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
      var folder = getOrCreateFolder_();
      var f = findFile_(folder);
      if (f) {
        f.setContent(text);
      } else {
        f = folder.createFile(FILE_NAME, text, "application/json");
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

    if (action === "getCommitteeFile") {
      var key = body.key;
      var entry = COMMITTEE_FILES[key];
      if (!entry) return jsonOutput_({ ok: false, error: "unknown_file" });
      var committeeFile = DriveApp.getFileById(entry.fileId);
      var blob = committeeFile.getBlob();
      return jsonOutput_({
        ok: true,
        name: entry.name,
        mimeType: blob.getContentType(),
        data: Utilities.base64Encode(blob.getBytes())
      });
    }

    return jsonOutput_({ ok: false, error: "unknown_action" });
  } catch (err) {
    return jsonOutput_({ ok: false, error: "server_error", message: String(err && err.message || err) });
  }
}
