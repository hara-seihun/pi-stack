package works.kenan.piremote.kenan;

import org.json.JSONException;
import org.json.JSONObject;

final class PhoneResult {
    final boolean ok;
    final Object result;
    final String code;
    final String message;

    private PhoneResult(boolean ok, Object result, String code, String message) {
        this.ok = ok; this.result = result; this.code = code; this.message = message;
    }
    static PhoneResult success(Object result) { return new PhoneResult(true, result, null, null); }
    static PhoneResult error(String code, String message) { return new PhoneResult(false, null, code, message); }
    JSONObject envelope(String id) {
        try {
            JSONObject frame = new JSONObject().put("type", "result").put("id", id).put("ok", ok);
            if (ok) frame.put("result", result == null ? JSONObject.NULL : result);
            else frame.put("error", new JSONObject().put("code", code).put("message", message));
            return frame;
        } catch (JSONException defect) { throw new IllegalStateException(defect); }
    }
}
