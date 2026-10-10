package works.kenan.piremote.kenan;

import android.content.Context;
import android.graphics.Color;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

final class NativeShells {
    static final int BACKGROUND = 0xff0b0d10;
    static final int CARD = 0xff242b40;
    static final int ACCENT = 0xffb8c8ff;

    static android.graphics.drawable.GradientDrawable card(Context context, int color) {
        float density = context.getResources().getDisplayMetrics().density;
        var shape = new android.graphics.drawable.GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(20 * density);
        shape.setStroke(Math.round(density), 0xff46516f);
        return shape;
    }
    static Button button(Context context, String title, Runnable action) {
        float density = context.getResources().getDisplayMetrics().density;
        Button button = new Button(context);
        button.setText(title);
        button.setTextColor(Color.WHITE);
        button.setBackground(card(context, 0xff354261));
        button.setMinHeight(Math.round(48 * density));
        button.setPadding(Math.round(12 * density), Math.round(8 * density), Math.round(12 * density), Math.round(8 * density));
        button.setAllCaps(false);
        button.setOnClickListener(view -> action.run());
        return button;
    }
    record Setup(android.widget.ScrollView root, TextView detail, Button grant, Button stop) {}
    static Setup setup(Context context, Runnable grantAll, Runnable stopSetup) {
        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(android.view.Gravity.CENTER_VERTICAL);
        root.setBackgroundColor(BACKGROUND);
        root.setClickable(true);
        int padding = Math.round(24 * context.getResources().getDisplayMetrics().density);
        root.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(context);
        title.setText("Set up Kenan");
        title.setTextColor(Color.WHITE);
        title.setTextSize(24);
        root.addView(title);
        TextView explanation = new TextView(context);
        explanation.setText("All intentional phone permissions are required before entering Kenan. Android owns each approval; declining stays here. Device Owner and secure-settings provisioning are separate.");
        explanation.setTextColor(Color.WHITE);
        explanation.setTextSize(16);
        explanation.setPadding(0, padding, 0, padding);
        root.addView(explanation);
        TextView detail = new TextView(context);
        detail.setTextColor(ACCENT);
        detail.setTextSize(16);
        detail.setPadding(0, 0, 0, padding);
        detail.setAccessibilityLiveRegion(android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(detail);
        Button grant = button(context, "Grant all permissions", grantAll);
        root.addView(grant);
        Button stop = button(context, "Stop setup", stopSetup);
        root.addView(stop);
        android.widget.ScrollView viewport = new android.widget.ScrollView(context);
        viewport.setFillViewport(true);
        viewport.setBackgroundColor(BACKGROUND);
        viewport.addView(root, new android.widget.ScrollView.LayoutParams(-1, -2));
        return new Setup(viewport, detail, grant, stop);
    }

    record Conversation(android.widget.ScrollView scroll, TextView history, android.widget.EditText input) {}
    static Conversation conversation(Context context, LinearLayout root, String transcript, String draft,
                                     Runnable open, Runnable close, Runnable send) {
        float density = context.getResources().getDisplayMetrics().density;
        int padding = Math.round(16 * density);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padding, padding, padding, padding);
        root.setBackground(card(context, CARD));
        root.setElevation(12 * density);
        LinearLayout header = new LinearLayout(context);
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView title = new TextView(context);
        title.setText("Kenaznia");
        title.setTextColor(Color.WHITE);
        title.setTextSize(20);
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        header.addView(button(context, "Open", open));
        header.addView(button(context, "Close", close));
        root.addView(header);
        android.widget.ScrollView scroll = new android.widget.ScrollView(context);
        TextView history = new TextView(context);
        history.setTextColor(Color.WHITE);
        history.setTextSize(15);
        history.setText(transcript);
        history.setPadding(0, padding, 0, padding);
        scroll.addView(history);
        scroll.setVisibility(transcript.isEmpty() ? android.view.View.GONE : android.view.View.VISIBLE);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, Math.round(160 * density)));
        android.widget.EditText input = new android.widget.EditText(context);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(0xffb5bdd1);
        input.setHint("Message Kenaznia…");
        input.setTextSize(16);
        input.setMinLines(2);
        input.setMaxLines(4);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setBackgroundTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        input.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(8000) });
        input.setText(draft);
        root.addView(input);
        Button submit = button(context, "Send", send);
        Runnable readiness = () -> {
            boolean ready = !input.getText().toString().trim().isEmpty();
            submit.setEnabled(ready);
            submit.setAlpha(ready ? 1f : .45f);
        };
        input.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) { readiness.run(); }
            @Override public void afterTextChanged(android.text.Editable text) {}
        });
        readiness.run();
        root.addView(submit);
        return new Conversation(scroll, history, input);
    }

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
