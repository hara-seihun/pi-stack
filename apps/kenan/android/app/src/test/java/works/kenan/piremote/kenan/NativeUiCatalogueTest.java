package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Proxy;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class, qualifiers = "w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeUiCatalogueTest {
    enum OverlayCase {
        IDLE, THINKING, WORKING, BUBBLE_EMPTY, BUBBLE_SHORT, BUBBLE_LIMIT, BUBBLE_LEFT,
        POINT, RECTANGLE, TAP, SWIPE, DRAG, DISMISS, PANEL_EMPTY, PANEL_TRANSCRIPT, PANEL_DRAFT, PANEL_LIMIT,
        PANEL_LARGE_FONT, CAPTURE_HIDDEN, ACTION_ONLY, CLOSED
    }
    private final Map<String, org.json.JSONObject> rendered = new LinkedHashMap<>();
    private File output;

    private final class Windows {
        final Activity activity = Robolectric.buildActivity(Activity.class).setup().visible().get();
        final FrameLayout root = new FrameLayout(activity);
        Windows() { root.setBackgroundColor(0xff0b0d10); activity.setContentView(root); }
        WindowManager manager() {
            return (WindowManager) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{WindowManager.class}, (proxy, method, args) -> {
                switch (method.getName()) {
                    case "addView" -> { View view = (View) args[0]; root.addView(view, layout((WindowManager.LayoutParams) args[1])); }
                    case "updateViewLayout" -> ((View) args[0]).setLayoutParams(layout((WindowManager.LayoutParams) args[1]));
                    case "removeView", "removeViewImmediate" -> root.removeView((View) args[0]);
                    default -> throw new AssertionError("Unsupported fixture window operation: " + method.getName());
                }
                return null;
            });
        }
        FrameLayout.LayoutParams layout(WindowManager.LayoutParams at) {
            FrameLayout.LayoutParams result = new FrameLayout.LayoutParams(at.width, at.height, at.gravity);
            result.leftMargin = at.x; result.topMargin = at.y;
            return result;
        }
        void close() { activity.finish(); }
    }

    private void layout(View view) {
        int width = view.getResources().getDisplayMetrics().widthPixels;
        int height = view.getResources().getDisplayMetrics().heightPixels;
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, width, height);
    }

    private void image(String id, View view, String scope) throws Exception {
        layout(view);
        int width = view.getResources().getDisplayMetrics().widthPixels;
        int height = view.getResources().getDisplayMetrics().heightPixels;
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        view.draw(new Canvas(bitmap));
        try (FileOutputStream stream = new FileOutputStream(new File(output, id + ".png"))) { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)); }
        bitmap.recycle();
        rendered.put(id, new org.json.JSONObject().put("id", id).put("image", id + ".png").put("scope", scope).put("widthPixels", width).put("heightPixels", height));
    }

    private void touch(View dot, int action, float x, float y) {
        MotionEvent event = MotionEvent.obtain(100, 200, action, x, y, 0);
        dot.dispatchTouchEvent(event); event.recycle();
    }

    private void overlay(OverlayCase state, String suffix) throws Exception {
        Windows windows = new Windows();
        PhoneAccessibilityService service = Robolectric.buildService(PhoneAccessibilityService.class).get();
        PhoneControlService.settings(service).edit().putBoolean("overlayVisible", true).putBoolean("overlayRight", state != OverlayCase.BUBBLE_LEFT).putFloat("overlayY", .42f).apply();
        KenanOverlay overlay = new KenanOverlay(service, windows.manager(), state == OverlayCase.ACTION_ONLY);
        overlay.refresh();
        View dot = ReflectionHelpers.getField(overlay, "dot");
        switch (state) {
            case IDLE -> { }
            case THINKING -> overlay.state("thinking");
            case WORKING -> overlay.state("working");
            case BUBBLE_EMPTY -> {
                overlay.say("", 0);
                assertNull(ReflectionHelpers.getField(ReflectionHelpers.getField(overlay, "scene"), "words"));
            }
            case BUBBLE_SHORT, BUBBLE_LEFT -> overlay.say("The next step is ready.\nTap Kenan to continue.", 0);
            case BUBBLE_LIMIT -> overlay.say("Long unbroken content: " + "abcdefghij".repeat(197) + " 🎉", 0);
            case POINT -> { overlay.moveToTarget(180, 360, 0); overlay.highlight(null, 180, 360, 1500); }
            case RECTANGLE -> overlay.highlight(new Rect(36, 260, 300, 360));
            case TAP -> overlay.gesture(180, 360, 180, 360, 100, true);
            case SWIPE -> { overlay.gesture(60, 500, 280, 280, 300, false); Shadows.shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(150)); }
            case DRAG, DISMISS -> { touch(dot, MotionEvent.ACTION_DOWN, 20, 20); touch(dot, MotionEvent.ACTION_MOVE, state == OverlayCase.DISMISS ? -126 : -80, state == OverlayCase.DISMISS ? 440 : 100); }
            case PANEL_EMPTY, PANEL_TRANSCRIPT, PANEL_DRAFT, PANEL_LIMIT, PANEL_LARGE_FONT -> {
                if (state != OverlayCase.PANEL_EMPTY) for (int i = 0; i < 20; i++) overlay.say("Synthetic reply " + (i + 1) + " with a second line\nand a clear next action.", 0);
                if (state == OverlayCase.PANEL_LARGE_FONT) { service.getResources().getConfiguration().fontScale = 1.6f; service.getResources().getDisplayMetrics().scaledDensity = 1.6f; }
                touch(dot, MotionEvent.ACTION_DOWN, 20, 20); touch(dot, MotionEvent.ACTION_UP, 20, 20);
                EditText input = ReflectionHelpers.getField(overlay, "input");
                assertNotNull(input);
                android.widget.LinearLayout panel = ReflectionHelpers.getField(overlay, "panel");
                View send = panel.getChildAt(panel.getChildCount() - 1);
                assertFalse("Empty draft must not offer Send", send.isEnabled());
                input.setText(" \n "); assertFalse("Whitespace is not a message", send.isEnabled()); input.setText("");
                if (state == OverlayCase.PANEL_DRAFT) { input.setText("Please open the next synthetic step."); assertTrue(send.isEnabled()); }
                if (state == OverlayCase.PANEL_LIMIT) { input.setText("A message spanning lines.\n".repeat(350)); assertEquals(8000, input.length()); assertTrue(send.isEnabled()); }
                layout(windows.root);
                Shadows.shadowOf(Looper.getMainLooper()).idle();
            }
            case CAPTURE_HIDDEN -> overlay.suspendCapture();
            case ACTION_ONLY -> overlay.highlight(new Rect(36, 260, 300, 360));
            case CLOSED -> overlay.close();
        }
        image("overlay-" + state.name().toLowerCase(java.util.Locale.ROOT) + suffix, windows.root, "KenanOverlay actual owned Scene/Dot/Panel; synthetic windows, no IME or system compositor");
        overlay.close(); assertEquals(0, windows.root.getChildCount()); windows.close();
        service.getResources().getConfiguration().fontScale = 1;
        service.getResources().getDisplayMetrics().scaledDensity = 1;
    }

    @Test public void renderActualNativeViews() throws Exception {
        String path = System.getProperty("pi.native.catalogue.output");
        org.junit.Assume.assumeTrue("Run apps/kenan/native-ui/render with an explicit artifact directory", path != null);
        output = new File(path); assertTrue(output.isDirectory() || output.mkdirs());
        for (OverlayCase state : OverlayCase.values()) overlay(state, "");
        org.robolectric.RuntimeEnvironment.setQualifiers("w320dp-h480dp-mdpi");
        overlay(OverlayCase.PANEL_EMPTY, "-compact");
        overlay(OverlayCase.PANEL_LARGE_FONT, "-compact");
        org.robolectric.RuntimeEnvironment.setQualifiers("w640dp-h360dp-land-mdpi");
        overlay(OverlayCase.PANEL_TRANSCRIPT, "-landscape");
        overlay(OverlayCase.BUBBLE_LIMIT, "-landscape");
        org.robolectric.RuntimeEnvironment.setQualifiers("w360dp-h800dp-mdpi");
        Windows windows = new Windows();
        NativeShells.Editor editor = NativeShells.editor(windows.activity, () -> {});
        windows.root.addView(editor.root(), new FrameLayout.LayoutParams(-1, -1));
        image("editor-shell", windows.root, "Actual NativeShells.editor; WebView viewport blank because Robolectric does not render remote editor HTML");
        editor.web().destroy(); windows.root.removeAllViews();
        for (NativeShells.SignInState state : NativeShells.SignInState.values()) {
            NativeShells.SignIn signIn = NativeShells.signIn(windows.activity); signIn.state(state);
            windows.root.addView(signIn.root(), new FrameLayout.LayoutParams(-1, -1));
            image("access-" + state.name().toLowerCase(java.util.Locale.ROOT), windows.root, "Actual NativeShells.signIn; third-party Access HTML and Android Dialog compositor not rendered");
            signIn.web().destroy(); windows.root.removeAllViews();
        }
        windows.close();
        org.json.JSONArray states = new org.json.JSONArray();
        for (var entry : rendered.entrySet()) states.put(entry.getValue());
        try (FileOutputStream stream = new FileOutputStream(new File(output, "manifest.json"))) {
            stream.write(new org.json.JSONObject().put("renderer", "Robolectric 4.16 native Android Skia, API 28").put("widthDp", 360).put("heightDp", 800).put("states", states).toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
    }
}
