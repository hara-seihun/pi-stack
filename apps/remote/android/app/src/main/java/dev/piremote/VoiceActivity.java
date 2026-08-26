package dev.piremote;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public final class VoiceActivity extends Activity {
    static final String EXTRA_SESSION_ID = "sessionId";
    static final String EXTRA_SESSION_NAME = "sessionName";
    private static final int MICROPHONE_PERMISSION = 71;
    private WebView webView;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) openVoice();
        else requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE_PERMISSION);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != MICROPHONE_PERMISSION) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) openVoice();
        // Refusing the microphone is an answer, not an error worth narrating; the call simply closes.
        else finish();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void openVoice() {
        String sessionId = getIntent().getStringExtra(EXTRA_SESSION_ID);
        if (sessionId == null || sessionId.isBlank()) { finish(); return; }
        Uri server = Uri.parse(BuildConfig.SERVER_URL);
        String trustedOrigin = server.getScheme() + "://" + server.getAuthority();
        webView = new WebView(this);
        webView.setBackgroundColor(0xff0b0d10);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.getSettings().setDomStorageEnabled(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                return !trustedOrigin.equals(target.getScheme() + "://" + target.getAuthority());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!trustedOrigin.equals(request.getOrigin().getScheme() + "://" + request.getOrigin().getAuthority())) {
                        request.deny(); return;
                    }
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                            return;
                        }
                    }
                    request.deny();
                });
            }
        });
        setContentView(webView);
        String name = getIntent().getStringExtra(EXTRA_SESSION_NAME);
        Uri url = Uri.parse(BuildConfig.SERVER_URL + "/voice.html").buildUpon()
            .appendQueryParameter("sessionId", sessionId)
            .appendQueryParameter("name", name == null ? "Agent" : name)
            .build();
        webView.loadUrl(url.toString());
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
