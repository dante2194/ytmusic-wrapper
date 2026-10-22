package com.example.ytmusic;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * Native helpers for page scripts (exposed to the page as YTMApp):
 *  - openInApp(url, target): open a YouTube link in the YouTube / YouTube Music app
 *  - setRefreshEnabled(on):  lock pull-to-refresh while the lyrics panel is scrolled
 */
public class AppBridge {

    private static final String PKG_MUSIC = "com.google.android.apps.youtube.music";
    private static final String PKG_YOUTUBE = "com.google.android.youtube";

    private final Context ctx;
    private final SwipeRefreshLayout refresh;
    private final Handler main = new Handler(Looper.getMainLooper());

    public AppBridge(Context ctx, SwipeRefreshLayout refresh) {
        this.ctx = ctx;
        this.refresh = refresh;
    }

    private static boolean allowed(Uri u) {
        String h = u.getHost();
        return "https".equals(u.getScheme()) && h != null
                && (h.equals("www.youtube.com") || h.equals("m.youtube.com")
                || h.equals("music.youtube.com") || h.equals("youtu.be"));
    }

    @JavascriptInterface
    public void openInApp(final String url, final String target) {
        main.post(() -> {
            try {
                Uri uri = Uri.parse(url);
                if (!allowed(uri)) return;
                String pkg = "music".equals(target) ? PKG_MUSIC : PKG_YOUTUBE;

                Intent in = new Intent(Intent.ACTION_VIEW, uri);
                in.setPackage(pkg);
                in.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(in);
                    return;
                } catch (ActivityNotFoundException ignored) {
                }

                // App not installed -> let the system pick (browser etc.)
                Intent fallback = new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://www.youtube.com/watch?v=" + uri.getQueryParameter("v")));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(fallback);
                } catch (Exception ignored) {
                }
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void setRefreshEnabled(final boolean on) {
        main.post(() -> {
            try {
                if (refresh != null) refresh.setEnabled(on);
            } catch (Exception ignored) {
            }
        });
    }
}
