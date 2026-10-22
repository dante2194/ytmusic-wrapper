package com.example.ytmusic;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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
        webView.addJavascriptInterface(new AppBridge(this, swipeRefresh), "YTMApp");
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
                view.loadUrl(request.getUrl().toString());
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
        });

        swipeRefresh.setOnRefreshListener(() -> webView.reload());

        webView.loadUrl(startUrl(getIntent()));
    }

    /** music.youtube.com links opened with this app load directly; otherwise the home page. */
    private String startUrl(Intent intent) {
        try {
            if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())
                    && intent.getData() != null) {
                Uri u = intent.getData();
                if ("https".equals(u.getScheme()) && "music.youtube.com".equals(u.getHost())) {
                    return u.toString();
                }
            }
        } catch (Exception ignored) {
        }
        return YTMUSIC_URL;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (webView != null && intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            webView.loadUrl(startUrl(intent));
        }
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
