package works.kenan.piremote.kenan.dev;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KenanRemotePlugin.class);
        super.onCreate(savedInstanceState);
        keepSharedClientBelowSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) keepSystemBarIconsVisible();
    }

    private void keepSharedClientBelowSystemBars() {
        int background = Color.rgb(11, 13, 16);
        getWindow().getDecorView().setBackgroundColor(background);
        keepSystemBarIconsVisible();
        getWindow().getDecorView().post(this::keepSystemBarIconsVisible);

        View webView = bridge.getWebView();
        ((View) webView.getParent()).setBackgroundColor(background);
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets status = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars());
            Insets cutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout());
            int top = Math.max(status.top, cutout.top);
            ViewGroup.MarginLayoutParams layout = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            if (layout.topMargin != top) {
                layout.topMargin = top;
                view.setLayoutParams(layout);
            }
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    private void keepSystemBarIconsVisible() {
        WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(
            getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
    }
}
