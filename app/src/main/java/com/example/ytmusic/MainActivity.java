package com.example.ytmusic;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.SearchManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.util.Patterns;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

import androidx.appcompat.app.AppCompatActivity;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.regex.Matcher;

public class MainActivity extends AppCompatActivity {

    private BackgroundWebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private ProgressBar progressBar;
    private ListenableFuture<MediaController> controllerFuture;

    private static final String YTMUSIC_URL = "https://music.youtube.com";
    private static final int REQ_NOTIFICATIONS = 100;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        progressBar = findViewById(R.id.progressBar);

        // Android 13+: the media notification needs this permission.
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQ_NOTIFICATIONS);
        }

        // Connect to the Media3 MediaSessionService. Binding starts it; Media3 then shows
        // the media notification and goes foreground by itself as soon as audio plays.
        SessionToken token = new SessionToken(this,
                new ComponentName(this, PlaybackService.class));
        controllerFuture = new MediaController.Builder(this, token).buildAsync();

        // Page <-> native player bridge.
        webView.addJavascriptInterface(new WebBridge(), "YTMBridge");
        webView.addJavascriptInterface(new GmBridge(webView), "YTMGm");
        WebPlayer.getInstance().setCommander((cmd, arg) -> {
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.__ytmBridge&&window.__ytmBridge.cmd('" + cmd + "'," + arg + ")",
                        null);
            }
        });

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setSupportMultipleWindows(true);              // target=_blank / window.open -> in-app
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        );

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("http://") || url.startsWith("https://")
                        || url.startsWith("about:") || url.startsWith("blob:")
                        || url.startsWith("data:") || url.startsWith("javascript:")) {
                    return false;   // google.com searches, logins, etc. all stay inside the app
                }
                openUrl(url);       // intent:, market:, mailto: ... go to the system
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                swipeRefresh.setRefreshing(false);
                injectAsset(view, "ytadblock.js");
                injectAsset(view, "ytbridge.js");
                injectAsset(view, "ytgm_shim.js");
                injectAsset(view, "sponsorblock.js");
                injectAsset(view, "ytbeautifier.js");
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
            }

            // Pop-ups / new tabs (window.open, target=_blank) open in this same WebView.
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                final WebView tmp = new WebView(MainActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    private boolean done = false;

                    private void forward(WebView v, String url) {
                        if (done || url == null || url.equals("about:blank")) return;
                        done = true;
                        openUrl(url);
                        v.post(() -> {
                            try { v.stopLoading(); v.destroy(); } catch (Exception ignored) { }
                        });
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                        forward(v, r.getUrl().toString());
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView v, String url, Bitmap f) {
                        forward(v, url);
                    }
                });
                WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
                t.setWebView(tmp);
                resultMsg.sendToTarget();
                return true;
            }
        });

        swipeRefresh.setOnRefreshListener(() -> webView.reload());

        String first = urlFromIntent(getIntent());
        webView.loadUrl(first != null ? first : YTMUSIC_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String u = urlFromIntent(intent);
        if (u != null && webView != null) webView.loadUrl(u);
    }

    // ---------- Open-in-app helpers ----------

    /** youtube.com/watch, /playlist and youtu.be links become music.youtube.com links. */
    private String mapUrl(String url) {
        if (url == null) return null;
        try {
            Uri u = Uri.parse(url);
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
            if (host.equals("youtu.be")) {
                String id = u.getLastPathSegment();
                if (id != null) {
                    String q = u.getEncodedQuery();
                    return YTMUSIC_URL + "/watch?v=" + Uri.encode(id) + (q == null ? "" : "&" + q);
                }
            }
            if (!host.equals("music.youtube.com")
                    && (host.equals("youtube.com") || host.endsWith(".youtube.com"))) {
                String path = u.getPath() == null ? "" : u.getPath();
                if (path.startsWith("/watch") || path.startsWith("/playlist")) {
                    String q = u.getEncodedQuery();
                    return YTMUSIC_URL + path + (q == null ? "" : "?" + q);
                }
            }
        } catch (Exception ignored) { }
        return url;
    }

    private String searchUrl(String q) {
        return YTMUSIC_URL + "/search?q=" + Uri.encode(q.trim());
    }

    /** Works out what to load from a VIEW / SEND / PROCESS_TEXT / WEB_SEARCH intent. */
    private String urlFromIntent(Intent i) {
        if (i == null) return null;
        String a = i.getAction();
        if (a == null) return null;
        try {
            if (Intent.ACTION_VIEW.equals(a) && i.getData() != null) {
                return mapUrl(i.getDataString());
            }
            if (Intent.ACTION_SEND.equals(a)) {
                String t = i.getStringExtra(Intent.EXTRA_TEXT);
                if (t != null && !t.trim().isEmpty()) {
                    Matcher m = Patterns.WEB_URL.matcher(t);
                    if (m.find()) {
                        String found = m.group();
                        if (!found.startsWith("http")) found = "https://" + found;
                        return mapUrl(found);
                    }
                    return searchUrl(t);
                }
            }
            if (Intent.ACTION_PROCESS_TEXT.equals(a)) {
                CharSequence t = i.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
                if (t != null && t.toString().trim().length() > 0) return searchUrl(t.toString());
            }
            if (Intent.ACTION_WEB_SEARCH.equals(a)
                    || "com.google.android.gms.actions.SEARCH_ACTION".equals(a)) {
                String q = i.getStringExtra(SearchManager.QUERY);
                if (q != null && q.trim().length() > 0) return searchUrl(q);
            }
        } catch (Exception ignored) { }
        return null;
    }

    private void openUrl(String url) {
        if (url == null || webView == null) return;
        if (url.startsWith("http://") || url.startsWith("https://")) {
            webView.loadUrl(url);
            return;
        }
        if (url.startsWith("about:") || url.startsWith("javascript:")
                || url.startsWith("blob:") || url.startsWith("data:")) return;
        try {
            Intent it = url.startsWith("intent:")
                    ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                    : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            it.addCategory(Intent.CATEGORY_BROWSABLE);
            it.setComponent(null);
            it.setSelector(null);
            startActivity(it);
        } catch (Exception ignored) { }
    }

    private void injectAsset(WebView view, String name) {
        try (InputStream is = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
            view.evaluateJavascript(out.toString("UTF-8"), null);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    protected void onDestroy() {
        // The WebView (and its audio) goes away with the activity, so drop the notification.
        WebPlayer.getInstance().setCommander(null);
        WebPlayer.getInstance().reset();
        if (controllerFuture != null) {
            MediaController.releaseFuture(controllerFuture);
            controllerFuture = null;
        }
        if (isFinishing()) {
            stopService(new Intent(this, PlaybackService.class));
            if (webView != null) {
                ViewGroup parent = (ViewGroup) webView.getParent();
                if (parent != null) parent.removeView(webView);
                webView.destroy();
                webView = null;
            }
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
