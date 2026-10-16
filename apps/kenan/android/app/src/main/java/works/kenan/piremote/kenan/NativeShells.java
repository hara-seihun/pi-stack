package works.kenan.piremote.kenan;

import android.content.Context;
import android.graphics.Color;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

final class NativeShells {
    enum SignInState {
        ENTER_EMAIL("Sign in to Kenan with your invited email, then enter the email code."),
        REJECTED("Sign-in was not accepted. Please sign in with an invited email."),
        UNAVAILABLE("Could not reach Kenan. Check your connection and reload sign-in.");
        final String message;
        SignInState(String message) { this.message = message; }
    }

    enum EditorState {
        OPENING("Opening your editor…", "You can close this view and return to Files."),
        READY("", ""),
        HANDOFF_ENDED("Editor handoff ended", "Return to Files and open the editor again."),
        ACCESS_ENDED("Editor access ended", "Return to Files and unlock or open the editor again."),
        HTTP_ERROR("Editor could not open", "The editor service returned an error. Return to Files and try again."),
        CONNECTION_FAILED("Editor connection failed", "Check your connection, then open the editor again from Files."),
        VIEW_STOPPED("Editor view stopped", "Return to Files and open the editor again."),
        SESSION_UNAVAILABLE("Editor session could not be checked", "Check your connection, then open the editor again from Files.");
        final String title;
        final String detail;
        EditorState(String title, String detail) { this.title = title; this.detail = detail; }
    }
    record Editor(LinearLayout root, WebView web, LinearLayout status, TextView title, TextView detail, Button close) {
        void state(EditorState state) {
            title.setText(state.title);
            detail.setText(state.detail);
            status.setVisibility(state == EditorState.READY ? android.view.View.GONE : android.view.View.VISIBLE);
            web.setVisibility(state == EditorState.READY || state == EditorState.OPENING ? android.view.View.VISIBLE : android.view.View.GONE);
            web.setImportantForAccessibility(state == EditorState.READY ? android.view.View.IMPORTANT_FOR_ACCESSIBILITY_AUTO : android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
    }
    record SignIn(LinearLayout root, WebView web, TextView title, Button retry, Button cancel) {
        void state(SignInState state) { title.setText(state.message); }
    }

    static Editor editor(Context context, Runnable closeEditor) {
        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(11, 13, 16));
        Button close = new Button(context);
        close.setText("Close editor");
        close.setOnClickListener(view -> closeEditor.run());
        root.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        android.widget.FrameLayout viewport = new android.widget.FrameLayout(context);
        root.addView(viewport, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        WebView web = new WebView(context);
        viewport.addView(web, new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        LinearLayout status = new LinearLayout(context);
        status.setOrientation(LinearLayout.VERTICAL);
        status.setBackgroundColor(Color.rgb(11, 13, 16));
        status.setClickable(true);
        status.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        status.setGravity(android.view.Gravity.CENTER_VERTICAL);
        int padding = Math.round(24 * context.getResources().getDisplayMetrics().density);
        status.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(context);
        title.setTextColor(Color.WHITE);
        title.setTextSize(24);
        title.setAccessibilityLiveRegion(android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.addView(title);
        TextView detail = new TextView(context);
        detail.setTextColor(Color.rgb(205, 211, 219));
        detail.setTextSize(16);
        detail.setPadding(0, padding / 2, 0, 0);
        status.addView(detail);
        viewport.addView(status, new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        Editor shell = new Editor(root, web, status, title, detail, close);
        shell.state(EditorState.OPENING);
        return shell;
    }

    static SignIn signIn(Context context) {
        LinearLayout content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(Color.WHITE);
        TextView title = new TextView(context);
        title.setTextColor(Color.BLACK);
        float density = context.getResources().getDisplayMetrics().density;
        title.setPadding(Math.round(24 * density), Math.round(24 * density), Math.round(24 * density), Math.round(16 * density));
        content.addView(title);
        WebView web = new WebView(context);
        content.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        Button retry = new Button(context);
        retry.setText("Reload sign-in");
        content.addView(retry);
        Button dismiss = new Button(context);
        dismiss.setText("Cancel sign-in");
        content.addView(dismiss);
        SignIn shell = new SignIn(content, web, title, retry, dismiss);
        shell.state(SignInState.ENTER_EMAIL);
        return shell;
    }

    private NativeShells() {}
}
