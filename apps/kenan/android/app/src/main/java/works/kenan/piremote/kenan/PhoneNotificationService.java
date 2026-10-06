package works.kenan.piremote.kenan;

import android.app.Notification;
import android.app.RemoteInput;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

public final class PhoneNotificationService extends NotificationListenerService {
    static volatile PhoneNotificationService current;
    private int remainingText;
    private boolean truncated;
    @Override public void onListenerConnected() { current = this; PhoneControlService.refresh(); }
    @Override public void onListenerDisconnected() { if (current == this) current = null; PhoneControlService.refresh(); }
    @Override public void onDestroy() { if (current == this) current = null; super.onDestroy(); }
    void dispatch(String command, JSONObject args, Consumer<PhoneResult> done) {
        try {
            var parsed = NativeState.parse(NativeState.NotificationCommand.class, command);
            if (parsed.isEmpty()) { done.accept(PhoneResult.error("unsupported", "Unknown notification command")); return; }
            NativeState.NotificationCommand kind = parsed.get();
            StatusBarNotification[] active = getActiveNotifications();
            if (active == null) { done.accept(PhoneResult.error("unavailable", "Notification listener is not connected")); return; }
            if (kind == NativeState.NotificationCommand.LIST) {
                JSONArray result = new JSONArray(); remainingText = 500000; truncated = active.length > 256;
                for (int notificationIndex = 0; notificationIndex < Math.min(active.length, 256); notificationIndex++) {
                    StatusBarNotification notification = active[notificationIndex];
                    Notification n = notification.getNotification();
                    JSONArray actions = new JSONArray();
                    if (n.actions != null && n.actions.length > 16) truncated = true;
                    if (n.actions != null) for (int i = 0; i < Math.min(n.actions.length, 16); i++) {
                        Notification.Action action = n.actions[i];
                        actions.put(new JSONObject().put("actionIndex", i).put("title", text(action.title)).put("reply", action.getRemoteInputs() != null));
                    }
                    result.put(new JSONObject().put("key", notification.getKey()).put("package", notification.getPackageName())
                        .put("id", notification.getId()).put("postTime", notification.getPostTime()).put("ongoing", notification.isOngoing())
                        .put("title", text(n.extras.getCharSequence(Notification.EXTRA_TITLE)))
                        .put("text", text(n.extras.getCharSequence(Notification.EXTRA_TEXT)))
                        .put("bigText", text(n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))).put("actions", actions));
                }
                done.accept(PhoneResult.success(new JSONObject().put("notifications", result).put("truncated", truncated))); return;
            }
            String key = args.getString("key");
            StatusBarNotification found = null;
            for (StatusBarNotification notification : active) if (notification.getKey().equals(key)) { found = notification; break; }
            if (found == null) { done.accept(PhoneResult.error("not_found", "Notification no longer exists")); return; }
            if (kind == NativeState.NotificationCommand.DISMISS) {
                if (!found.isClearable()) { done.accept(PhoneResult.error("unavailable", "Notification cannot be dismissed")); return; }
                cancelNotification(key);
                done.accept(PhoneResult.success(new JSONObject().put("requested", true))); return;
            }
            boolean replies = switch (kind) {
                case REPLY -> true;
                case ACTION -> false;
                case LIST, DISMISS -> throw new IllegalStateException("Notification command already handled: " + kind);
            };
            Notification.Action[] actions = found.getNotification().actions;
            int index = args.optInt("actionIndex", -1);
            if (replies && index == -1 && actions != null) {
                for (int i = 0; i < actions.length; i++) if (actions[i].getRemoteInputs() != null) { index = i; break; }
            }
            if (actions == null || index < 0 || index >= actions.length || actions[index].actionIntent == null) {
                done.accept(PhoneResult.error("invalid_args", "No matching notification action")); return;
            }
            Notification.Action action = actions[index];
            Intent fill = new Intent();
            if (replies) {
                RemoteInput[] inputs = action.getRemoteInputs();
                if (inputs == null || inputs.length == 0) { done.accept(PhoneResult.error("unsupported", "Action does not support text replies")); return; }
                String reply = args.getString("text");
                if (reply.length() > 10000) { done.accept(PhoneResult.error("invalid_args", "Reply exceeds 10000 characters")); return; }
                Bundle values = new Bundle();
                for (RemoteInput input : inputs) {
                    boolean allowed = input.getAllowFreeFormInput();
                    if (!allowed && input.getChoices() != null) for (CharSequence choice : input.getChoices()) if (reply.contentEquals(choice)) allowed = true;
                    if (allowed) values.putCharSequence(input.getResultKey(), reply);
                }
                if (values.isEmpty()) { done.accept(PhoneResult.error("invalid_args", "Reply is not allowed by this action")); return; }
                RemoteInput.addResultsToIntent(inputs, fill, values);
                RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT);
            }
            action.actionIntent.send(this, 0, fill);
            done.accept(PhoneResult.success(new JSONObject().put("sent", true)));
        } catch (android.app.PendingIntent.CanceledException failure) { done.accept(PhoneResult.error("unconfirmed", "Notification action was cancelled")); }
        catch (SecurityException failure) { done.accept(PhoneResult.error("permission_denied", failure.getMessage())); }
        catch (Exception failure) { done.accept(PhoneResult.error("invalid_args", failure.getMessage())); }
    }
    private String text(CharSequence text) {
        if (text == null) return "";
        int length = Math.min(text.length(), Math.min(4096, remainingText));
        if (length < text.length()) truncated = true;
        remainingText -= length;
        return text.subSequence(0, length).toString();
    }
}
