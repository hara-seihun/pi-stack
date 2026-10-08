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

    record Editor(LinearLayout root, WebView web) {}
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
        WebView web = new WebView(context);
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        return new Editor(root, web);
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
